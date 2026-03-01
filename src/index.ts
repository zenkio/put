import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  EMAIL_CHANNEL,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  MEMORY_MAX_HISTORY_STEPS,
  MEMORY_MAX_RESULTS,
  POLL_INTERVAL,
  ROUTING_ESCALATION_ORDER,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import {
  AvailableGroup,
  CommandCheckpoint,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createAutonomousTask,
  getAllChats,
  getAllTasks,
  getAutonomousStepsForTask,
  getAutonomousTaskById,
  getProviderReliabilityReport,
  getProjectMemoryState,
  getLastGroupSync,
  getLatestAutonomousTaskForChat,
  listAutonomousTasksForChat,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  initDatabase,
  isEmailProcessed,
  markEmailProcessed,
  markEmailResponded,
  setAutonomousTaskPaused,
  setLastGroupSync,
  storeChatMetadata,
  storeMessage,
  updateProjectMemoryState,
  updateChatName,
} from './db.js';
import { startAutonomousLoop } from './autonomous-orchestrator.js';
import { startDecisionVerificationLoop } from './decision-verification-loop.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { checkForNewEmails, sendEmailReply, getContextKey, EmailMessage } from './email-channel.js';
import { classifyMessage } from './message-classifier.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAINTENANCE_FLAG_PATH = path.join(DATA_DIR, 'maintenance.flag');
const LOCAL_FALLBACK_DEFAULT_CONCURRENCY = Math.max(
  1,
  Number.isFinite(Number(process.env.LOCAL_FALLBACK_MAX_CONCURRENT))
    ? Number(process.env.LOCAL_FALLBACK_MAX_CONCURRENT)
    : Number.isFinite(Number(process.env.PHI3_MAX_CONCURRENT))
      ? Number(process.env.PHI3_MAX_CONCURRENT)
    : 2,
);

let phi3ActiveSlots = 0;
const phi3SlotWaiters: Array<(release: () => void) => void> = [];

function createPhi3Release(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    phi3ActiveSlots = Math.max(0, phi3ActiveSlots - 1);
    if (phi3SlotWaiters.length > 0) {
      phi3ActiveSlots++;
      const next = phi3SlotWaiters.shift()!;
      next(createPhi3Release());
    }
  };
}

function requestPhi3Slot(): Promise<() => void> {
  if (phi3ActiveSlots < LOCAL_FALLBACK_DEFAULT_CONCURRENCY) {
    phi3ActiveSlots++;
    return Promise.resolve(createPhi3Release());
  }
  return new Promise((resolve) => {
    phi3SlotWaiters.push((release) => resolve(release));
  });
}

let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let forcedModelByChat: Record<string, 'local' | 'claude' | 'gemini' | 'openrouter'> = {};
let groundedModeByChat: Record<string, boolean> = {};
let chatModeByChat: Record<string, 'default' | 'ateam' | 'claude'> = {};
// LID to phone number mapping (WhatsApp now sends LID JIDs for self-chats)
let lidToPhoneMap: Record<string, string> = {};
// Guards to prevent duplicate loops on WhatsApp reconnect
let messageLoopRunning = false;
let ipcWatcherRunning = false;
let groupSyncTimerStarted = false;
// Reconnect backoff: prevents flooding WhatsApp with reconnect attempts
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000; // 5 min max
// Claude quota tracking for Gemini failover
let claudeQuotaExhaustedAt: number | null = null;
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const USAGE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const AUTOMATION_SAFE_BUDGET_MODES = new Set(['SPEND', 'NORMAL', 'CONSERVE']);
const OAUTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const OAUTH_EXPIRY_SOON_MS = 60 * 60 * 1000; // 1 hour
const usageBudgetCache: Record<string, { mode: string | null; checkedAt: number }> =
  {};
let oauthExpiryMonitorStarted = false;
let lastOauthAlertKey = '';
let lastOauthAlertAt = 0;
// Claude credentials path for OAuth usage API
const CLAUDE_CREDENTIALS_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.claude',
  '.credentials.json',
);

function getMainChatJid(): string | null {
  const entry = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === MAIN_GROUP_FOLDER,
  );
  return entry?.[0] || null;
}

async function maybeSendOauthAlert(alertKey: string, text: string): Promise<void> {
  const now = Date.now();
  if (
    alertKey === lastOauthAlertKey &&
    now - lastOauthAlertAt < OAUTH_ALERT_COOLDOWN_MS
  ) {
    return;
  }
  const mainChatJid = getMainChatJid();
  if (!mainChatJid) return;
  lastOauthAlertKey = alertKey;
  lastOauthAlertAt = now;
  await sendMessage(mainChatJid, `${ASSISTANT_NAME}: ${text}`);
}

function parseClaudeOauthExpiryMs(): number | null {
  try {
    if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) return null;
    const raw = fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8');
    const data = JSON.parse(raw) as {
      claudeAiOauth?: { expiresAt?: number };
    };
    const expiry = data?.claudeAiOauth?.expiresAt;
    if (!expiry || Number.isNaN(expiry)) return null;
    return expiry;
  } catch {
    return null;
  }
}

function getClaudeOAuthTokenFromEnv(): string | null {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return token ? token : null;
}

function isClaudeQuotaCoolingDown(): boolean {
  if (!claudeQuotaExhaustedAt) return false;
  const elapsed = Date.now() - claudeQuotaExhaustedAt;
  if (elapsed >= QUOTA_COOLDOWN_MS) {
    claudeQuotaExhaustedAt = null;
    return false;
  }
  return true;
}

function getClaudeAuthState(): {
  source: 'credentials' | 'env' | 'missing';
  expiryMs: number | null;
} {
  const expiryMs = parseClaudeOauthExpiryMs();
  if (expiryMs) {
    return { source: 'credentials', expiryMs };
  }
  if (getClaudeOAuthTokenFromEnv()) {
    return { source: 'env', expiryMs: null };
  }
  return { source: 'missing', expiryMs: null };
}

function isClaudeOauthExpiredError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes('oauth token has expired') ||
    lower.includes('authentication_error') ||
    lower.includes('invalid bearer token') ||
    lower.includes('authentication_failed') ||
    lower.includes('failed to authenticate') ||
    (lower.includes('401') && lower.includes('oauth'))
  );
}

async function checkClaudeOAuthStatusAndNotify(trigger: string): Promise<void> {
  const fixSteps =
    `Fix steps (host terminal):\n` +
    `1) cd /home/zenkio/nanoclaw\n` +
    `2) claude setup-token (or re-login flow you normally use)\n` +
    `3) npm run svc:restart\n` +
    `4) Send a test message and check [source: ...] tag`;

  const authState = getClaudeAuthState();
  if (authState.source === 'missing') {
    await maybeSendOauthAlert(
      'claude-oauth-missing',
      `Claude OAuth credentials are missing/unreadable (${trigger}). Claude fallback may fail.\n\n${fixSteps}`,
    );
    return;
  }

  // Token provided via env var is valid auth, but expiry cannot be inferred locally.
  if (authState.source === 'env') {
    return;
  }

  const expiryMs = authState.expiryMs;
  if (!expiryMs) return;

  const now = Date.now();
  if (expiryMs <= now) {
    await maybeSendOauthAlert(
      'claude-oauth-expired',
      `Claude OAuth has expired. High-end fallback (Claude) is currently unavailable.\n\n${fixSteps}`,
    );
    return;
  }

  if (expiryMs - now <= OAUTH_EXPIRY_SOON_MS) {
    await maybeSendOauthAlert(
      'claude-oauth-expiring-soon',
      `Claude OAuth will expire soon (about ${Math.ceil(
        (expiryMs - now) / 60000,
      )} minutes). Refresh now to avoid fallback failures.\n\n${fixSteps}`,
    );
  }
}

/**
 * Fetch real Claude usage from Anthropic API and write quota file for the agent.
 */
/**
 * Calculate budget mode from usage % and time until reset.
 *
 * SPEND:    reset < 1h away AND usage < 80% → use Claude freely, don't waste subscription
 * NORMAL:   usage < 70% → Claude handles most tasks
 * CONSERVE: usage 70-90% → Claude handles key tasks, keeps responses tighter
 * GUARDIAN: usage 90-98% → near limit, avoid starting long autonomous steps
 * LOCKED:   usage >= 98% → stop Claude execution until recovered
 */
function calcBudgetMode(
  fiveHour: { utilization: number; resets_at: string | null } | undefined,
  sevenDay: { utilization: number; resets_at: string | null } | undefined,
): { mode: string; reason: string; hoursUntil5hReset: number; hoursUntil7dReset: number } {
  const now = Date.now();
  const fivePct = fiveHour?.utilization ?? 0;
  const sevenPct = sevenDay?.utilization ?? 0;
  const effectivePct = Math.max(fivePct, sevenPct);

  const hoursUntil5hReset = fiveHour?.resets_at
    ? Math.max(0, (new Date(fiveHour.resets_at).getTime() - now) / 3_600_000)
    : 5;
  const hoursUntil7dReset = sevenDay?.resets_at
    ? Math.max(0, (new Date(sevenDay.resets_at).getTime() - now) / 3_600_000)
    : 168;

  // Near reset with quota left → spend it
  if (hoursUntil5hReset < 1 && fivePct < 80) {
    return { mode: 'SPEND', reason: `5h resets in ${hoursUntil5hReset.toFixed(1)}h, only ${fivePct}% used`, hoursUntil5hReset, hoursUntil7dReset };
  }

  if (effectivePct >= 98) {
    return { mode: 'LOCKED', reason: `${effectivePct}% used`, hoursUntil5hReset, hoursUntil7dReset };
  }
  if (effectivePct >= 90) {
    return { mode: 'GUARDIAN', reason: `${effectivePct}% used`, hoursUntil5hReset, hoursUntil7dReset };
  }
  if (effectivePct >= 70) {
    return { mode: 'CONSERVE', reason: `${effectivePct}% used`, hoursUntil5hReset, hoursUntil7dReset };
  }

  return { mode: 'NORMAL', reason: `${effectivePct}% used`, hoursUntil5hReset, hoursUntil7dReset };
}

async function trackUsage(groupFolder: string, _model?: string | undefined): Promise<string | null> {
  const usageFile = path.join(GROUPS_DIR, groupFolder, 'ai', '.usage.json');
  try {
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });

    // Read OAuth token
    const creds = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) {
      logger.debug('No OAuth token found, skipping usage tracking');
      return null;
    }

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (!res.ok) {
      logger.debug({ status: res.status }, 'Usage API returned non-OK');
      return null;
    }

    const data = await res.json() as {
      five_hour?: { utilization: number; resets_at: string };
      seven_day?: { utilization: number; resets_at: string };
    };

    const budget = calcBudgetMode(data.five_hour, data.seven_day);
    if (budget.mode !== 'LOCKED' && claudeQuotaExhaustedAt) {
      claudeQuotaExhaustedAt = null;
    }

    fs.writeFileSync(usageFile, JSON.stringify({
      five_hour_pct: data.five_hour?.utilization ?? 0,
      five_hour_resets_at: data.five_hour?.resets_at ?? null,
      hours_until_5h_reset: Math.round(budget.hoursUntil5hReset * 10) / 10,
      seven_day_pct: data.seven_day?.utilization ?? 0,
      seven_day_resets_at: data.seven_day?.resets_at ?? null,
      hours_until_7d_reset: Math.round(budget.hoursUntil7dReset * 10) / 10,
      budget_mode: budget.mode,
      budget_reason: budget.reason,
      exhausted: claudeQuotaExhaustedAt ? new Date(claudeQuotaExhaustedAt).toISOString() : null,
      updated_at: new Date().toISOString(),
    }, null, 2));

    logger.info(
      {
        fiveHour: data.five_hour?.utilization,
        sevenDay: data.seven_day?.utilization,
        budgetMode: budget.mode,
      },
      'Usage tracked',
    );

    return budget.mode;
  } catch (err) {
    logger.debug({ err }, 'Failed to track usage');
    return null;
  }
}

async function getBudgetModeCached(groupFolder: string): Promise<string | null> {
  const now = Date.now();
  const cached = usageBudgetCache[groupFolder];
  if (cached && now - cached.checkedAt < USAGE_CACHE_TTL_MS) {
    return cached.mode;
  }
  const mode = await trackUsage(groupFolder, undefined).catch(() => null);
  usageBudgetCache[groupFolder] = {
    mode,
    checkedAt: now,
  };
  return mode;
}

async function getClaudeExecutionHealth(
  groupFolder: string,
): Promise<{ healthy: boolean; mode: string; reason: string }> {
  const budgetMode = await getBudgetModeCached(groupFolder);
  const cooldownActive = isClaudeQuotaCoolingDown();
  const mode = budgetMode || 'UNKNOWN';
  if (cooldownActive) {
    return {
      healthy: false,
      mode,
      reason: 'recent quota/rate-limit event (cooldown active)',
    };
  }
  if (budgetMode && !AUTOMATION_SAFE_BUDGET_MODES.has(budgetMode)) {
    return {
      healthy: false,
      mode,
      reason: 'budget mode is too close to limit for safe autonomous continuation',
    };
  }
  return {
    healthy: true,
    mode,
    reason: 'ok',
  };
}

/**
 * Translate a JID from LID format to phone format if we have a mapping.
 * Returns the original JID if no mapping exists.
 */
function translateJid(jid: string): string {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = jid.split('@')[0].split(':')[0];
  const phoneJid = lidToPhoneMap[lidUser];
  if (phoneJid) {
    logger.debug({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
    return phoneJid;
  }
  return jid;
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  try {
    await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
  }
}

function startTypingHeartbeat(
  jid: string,
  intervalMs: number = 10000,
): () => Promise<void> {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    await setTyping(jid, true);
  };

  // Send immediately, then refresh periodically so the typing indicator stays visible.
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await setTyping(jid, false);
  };
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
    forced_model_by_chat?: Record<string, 'phi3' | 'local' | 'claude' | 'gemini' | 'openrouter'>;
    grounded_mode_by_chat?: Record<string, boolean>;
    chat_mode_by_chat?: Record<string, 'default' | 'ateam' | 'claude'>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  const loadedForced = state.forced_model_by_chat || {};
  forcedModelByChat = Object.fromEntries(
    Object.entries(loadedForced).map(([jid, model]) => [
      jid,
      model === 'phi3' ? 'local' : model,
    ]),
  ) as Record<string, 'local' | 'claude' | 'gemini' | 'openrouter'>;
  groundedModeByChat = state.grounded_mode_by_chat || {};
  chatModeByChat = state.chat_mode_by_chat || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
    forced_model_by_chat: forcedModelByChat,
    grounded_mode_by_chat: groundedModeByChat,
    chat_mode_by_chat: chatModeByChat,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Sync group metadata from WhatsApp.
 * Fetches all participating groups and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  try {
    logger.info('Syncing group metadata from WhatsApp...');
    const groups = await sock.groupFetchAllParticipating();

    let count = 0;
    for (const [jid, metadata] of Object.entries(groups)) {
      if (metadata.subject) {
        updateChatName(jid, metadata.subject);
        count++;
      }
    }

    setLastGroupSync();
    logger.info({ count }, 'Group metadata synced');
  } catch (err) {
    logger.error({ err }, 'Failed to sync group metadata');
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

function getRegisteredGroupByFolder(folder: string): RegisteredGroup | undefined {
  return Object.values(registeredGroups).find((g) => g.folder === folder);
}

function parseAutonomousRequest(content: string): {
  projectName: string | null;
  title: string;
  prompt: string;
} | null {
  const trimmed = content.trim();

  const autoPrefix = /^auto\s*:\s*/i;
  const directedPrefix = new RegExp(`^@${ASSISTANT_NAME}\\b\\s+auto\\s*:\\s*`, 'i');
  const projectPrefix = /^project\s+([^\n:]+)\s*:\s*/i;
  const directedProjectPrefix = new RegExp(`^@${ASSISTANT_NAME}\\b\\s+project\\s+([^\\n:]+)\\s*:\\s*`, 'i');

  let payload = trimmed;
  let projectName: string | null = null;

  if (autoPrefix.test(payload)) {
    payload = payload.replace(autoPrefix, '').trim();
  } else if (directedPrefix.test(payload)) {
    payload = payload.replace(directedPrefix, '').trim();
  } else if (projectPrefix.test(payload)) {
    const m = payload.match(projectPrefix);
    projectName = m?.[1]?.trim() || null;
    payload = payload.replace(projectPrefix, '').trim();
  } else if (directedProjectPrefix.test(payload)) {
    const m = payload.match(directedProjectPrefix);
    projectName = m?.[1]?.trim() || null;
    payload = payload.replace(directedProjectPrefix, '').trim();
  } else {
    // Natural-language intent for autonomous execution
    const lowered = payload.toLowerCase();
    const hasAutonomousVerb =
      /\b(work on|build|implement|finish|complete|continue|proceed with|execute|handle|do|create|make|develop)\b/.test(
        lowered,
      );
    const hasTaskNoun =
      /\b(project|task|feature|phase|step|subtask|milestone|jambutter)\b/.test(
        lowered,
      );
    const hasAssignmentFraming =
      /\b(please|can you|could you|i want you to|let's|lets|start|need you to)\b/.test(
        lowered,
      );
    const likelyControl =
      /\b(list|show|pause|resume|stop|status)\b/.test(lowered) &&
      /\b(task|tasks|autonomous)\b/.test(lowered);

    if ((hasAutonomousVerb && hasTaskNoun) || (hasAssignmentFraming && hasTaskNoun)) {
      if (!likelyControl) {
        const projectMatch = payload.match(/\bproject\s+([a-zA-Z0-9_-]+)/i);
        projectName = projectMatch?.[1] || null;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  if (!payload) return null;
  const title = payload.split('\n')[0].slice(0, 100);
  return { projectName, title, prompt: payload };
}

function renderAutonomousTaskList(
  chatJid: string,
  handlerFilter: 'claude' | 'auto' | 'all' = 'all',
): string {
  const tasks = listAutonomousTasksForChat(chatJid, 8);
  const filtered = tasks.filter((t) =>
    handlerFilter === 'all'
      ? true
      : getTaskHandlerFromProjectName(t.project_name) === handlerFilter,
  );
  if (filtered.length === 0) {
    const scope = handlerFilter === 'all' ? '' : ` for handler=${handlerFilter}`;
    return `${ASSISTANT_NAME}: No autonomous tasks found${scope}.`;
  }
  const lines = filtered.map(
    (t) =>
      `- ${t.id} | ${t.status} | handler=${getTaskHandlerFromProjectName(
        t.project_name,
      )} | ${t.title}${t.project_name ? ` [${stripTaskHandlerPrefix(t.project_name)}]` : ''}`,
  );
  const label =
    handlerFilter === 'all'
      ? 'Autonomous tasks'
      : `Autonomous tasks (handler=${handlerFilter})`;
  return `${ASSISTANT_NAME}: ${label}:\n${lines.join('\n')}`;
}

function parseAteamTaskDetailCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!/^\/ateam\s+task\b/i.test(trimmed) || !/\bdetail\s*$/i.test(trimmed)) {
    return null;
  }
  return extractTaskIdFromText(trimmed);
}

function parseClaudeTaskDetailCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!/^\/claude\s+task\b/i.test(trimmed) || !/\bdetail\s*$/i.test(trimmed)) {
    return null;
  }
  return extractTaskIdFromText(trimmed);
}

function parseExecutorFromStepInstructions(instructions: string): 'qwen' | 'gemini' | 'openrouter' {
  const m = instructions.match(/^\s*\[EXECUTOR:(qwen|gemini|openrouter)\]/i);
  if (!m) return 'qwen';
  return m[1].toLowerCase() as 'qwen' | 'gemini' | 'openrouter';
}

function renderAutonomousTaskDetail(taskId: string, chatJid: string): string {
  const task = getAutonomousTaskById(taskId);
  if (!task || task.chat_jid !== chatJid) {
    return `${ASSISTANT_NAME}: Task not found: ${taskId}`;
  }
  const steps = getAutonomousStepsForTask(taskId);
  const lines = steps.slice(0, 20).map((s) => {
    const executor = parseExecutorFromStepInstructions(s.instructions || '');
    const err = s.error ? ` | err: ${String(s.error).slice(0, 80)}` : '';
    return `- ${s.id} | ${s.status} | exec=${executor} | try=${s.attempt_count} | ${s.title}${err}`;
  });
  return (
    `${ASSISTANT_NAME}: Task detail ${task.id}\n` +
    `- status: ${task.status}\n` +
    `- handler: ${getTaskHandlerFromProjectName(task.project_name)}\n` +
    `- title: ${task.title}\n` +
    `- steps: ${steps.length}\n` +
    `${lines.join('\n')}`
  );
}

function renderAutonomousPauseReason(taskId: string, chatJid: string): string {
  const task = getAutonomousTaskById(taskId);
  if (!task || task.chat_jid !== chatJid) {
    return `${ASSISTANT_NAME}: Task not found: ${taskId}`;
  }
  const steps = getAutonomousStepsForTask(taskId);
  const pausedLines = steps
    .filter((s) => s.status === 'blocked' && !!s.error)
    .map((s) => `- ${s.title}: ${normalizeLine(String(s.error), 220)}`)
    .slice(0, 6);

  if (task.status !== 'paused') {
    return (
      `${ASSISTANT_NAME}: Task ${task.id} is not paused.\n` +
      `- status: ${task.status}\n` +
      `${pausedLines.length > 0 ? pausedLines.join('\n') : '- no pause/block reason recorded'}`
    );
  }

  return (
    `${ASSISTANT_NAME}: Why paused (${task.id})\n` +
    `- title: ${task.title}\n` +
    `- status: ${task.status}\n` +
    `${pausedLines.length > 0 ? pausedLines.join('\n') : '- pause reason not found in step logs'}`
  );
}

function responseLooksUnfinished(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\bnext\s*:\s*/i.test(text)) return true;
  if (/\b(todo|remaining|pending|not finished|incomplete|to do)\b/.test(lower)) return true;
  if (/\bphase\s*(1|one)\b/.test(lower)) return true;
  if (/\bwill continue|continue in follow-up|follow-up session\b/.test(lower)) return true;
  return false;
}

function hasActiveAutonomousTask(chatJid: string): boolean {
  const tasks = listAutonomousTasksForChat(chatJid, 20);
  return tasks.some((t) => t.status === 'active' || t.status === 'queued' || t.status === 'paused');
}

function normalizeLine(s: string, max = 180): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseProviderReportCommand(content: string): {
  startIso: string;
  endIso: string;
  label: string;
} | null {
  const trimmed = content.trim();
  const m = trimmed.match(/^\/provider\s+report(?:\s+([a-z0-9-]+))?$/i);
  if (!m) return null;
  const arg = (m[1] || 'yesterday').toLowerCase();
  const now = new Date();
  const todayStart = startOfUtcDay(now);

  if (arg === 'yesterday') {
    const start = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    return {
      startIso: start.toISOString(),
      endIso: todayStart.toISOString(),
      label: start.toISOString().slice(0, 10),
    };
  }

  if (arg === 'today') {
    const end = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    return {
      startIso: todayStart.toISOString(),
      endIso: end.toISOString(),
      label: todayStart.toISOString().slice(0, 10),
    };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    const start = new Date(`${arg}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return {
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      label: arg,
    };
  }

  return null;
}

function isProviderReportLike(content: string): boolean {
  return /^\/provider\s+report\b/i.test(content.trim());
}

function renderProviderReport(content: string): string | null {
  const parsed = parseProviderReportCommand(content);
  if (!parsed) return null;
  const rows = getProviderReliabilityReport(parsed.startIso, parsed.endIso);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  const renderLine = (provider: 'gemini' | 'openrouter'): string => {
    const row = byProvider.get(provider) || {
      provider,
      total: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
      queued: 0,
      in_progress: 0,
    };
    const successRate = row.total > 0 ? ((row.completed / row.total) * 100).toFixed(1) : '0.0';
    return `- ${provider}: total=${row.total}, completed=${row.completed}, blocked=${row.blocked}, failed=${row.failed}, queued=${row.queued}, in_progress=${row.in_progress}, success=${successRate}%`;
  };

  return (
    `${ASSISTANT_NAME}: Provider report (UTC ${parsed.label})\n` +
    `${renderLine('gemini')}\n` +
    `${renderLine('openrouter')}`
  );
}

function normalizeTaskIdCandidate(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('autotask-')) return cleaned;
  if (cleaned.startsWith('task-')) return `autotask-${cleaned.slice('task-'.length)}`;
  return null;
}

function extractTaskIdFromText(text: string): string | null {
  const match = text.match(/\b(?:autotask|task)-[a-z0-9-]+\b/i);
  if (!match) return null;
  return normalizeTaskIdCandidate(match[0]);
}

function buildProjectMemoryPromptBundle(params: {
  channel: string;
  chatJid: string;
  projectId: string;
  currentTask: string;
}): string {
  const state = getProjectMemoryState(
    params.channel,
    params.chatJid,
    params.projectId,
  );
  const projectState = {
    goal: state.goal,
    decisions: state.decisions.slice(-MEMORY_MAX_HISTORY_STEPS),
    constraints: state.constraints.slice(-MEMORY_MAX_HISTORY_STEPS),
    current_status: state.current_status,
    next_steps: state.next_steps.slice(0, MEMORY_MAX_HISTORY_STEPS),
    open_questions: state.open_questions.slice(0, MEMORY_MAX_HISTORY_STEPS),
    last_artifacts: state.last_artifacts.slice(-8),
    last_errors: state.last_errors.slice(-5),
  };
  const lastResults = state.last_results.slice(-3);
  const lowerTask = params.currentTask.toLowerCase();
  const isStatusOrRecentChangeQuery =
    /\b(status|progress|summary|what'?s next|next step|where are we)\b/.test(lowerTask) ||
    /\b(recent|latest|what changed|changes|update|updates)\b/.test(lowerTask);

  const statusChecksSection = isStatusOrRecentChangeQuery
    ? [
        '',
        '[MANDATORY_STATUS_CHECKS]',
        'For status/recent-change requests, do these checks before answering:',
        '- Read /workspace/group/ai/PROJECT_STATE.md if it exists.',
        '- Read /workspace/group/ai/TASK_QUEUE.md if it exists.',
        '- Run: cd /workspace/group && git status --short',
        '- Run: cd /workspace/group && git diff --name-only',
        'If a file/repo is missing, say that explicitly.',
        'In the final answer, include a short "Sources used:" line.',
      ].join('\n')
    : '';

  return [
    '[SYSTEM]',
    'You are stateless. Use PROJECT_STATE as the source of continuity.',
    'Keep output concise and actionable.',
    '',
    '[PROJECT_STATE]',
    '```json',
    JSON.stringify(projectState),
    '```',
    '',
    '[LAST_RESULT]',
    lastResults.length > 0 ? lastResults.join('\n') : '(none)',
    statusChecksSection,
    '',
    '[CURRENT_TASK]',
    params.currentTask,
  ].join('\n');
}

function persistProjectMemoryFromRun(params: {
  channel: string;
  chatJid: string;
  projectId: string;
  prompt: string;
  responseText?: string;
  errorText?: string;
  sourceTag?: string;
}): void {
  const state = getProjectMemoryState(params.channel, params.chatJid, params.projectId);
  const nextResults = [...state.last_results];
  const nextErrors = [...state.last_errors];

  if (params.responseText) {
    const summary = normalizeLine(params.responseText, 260);
    nextResults.push(
      `${new Date().toISOString()} | ${params.sourceTag || 'model'} | ${summary}`,
    );
  }
  if (params.errorText) {
    nextErrors.push(
      `${new Date().toISOString()} | ${normalizeLine(params.errorText, 260)}`,
    );
  }

  const currentTaskHead = normalizeLine(params.prompt.split('\n')[0] || params.prompt, 140);
  updateProjectMemoryState({
    channel: params.channel,
    chatJid: params.chatJid,
    projectId: params.projectId,
    patch: {
      current_status: params.responseText
        ? `Processed: ${currentTaskHead}`
        : `Error while processing: ${currentTaskHead}`,
      last_results: nextResults.slice(-MEMORY_MAX_RESULTS),
      last_errors: nextErrors.slice(-MEMORY_MAX_RESULTS),
    },
  });
}

function parseSection(text: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${name}\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n\\s*[A-Z_]{3,}\\s*:?\\s*\\n|$)`,
    'i',
  );
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

function parseListLines(section: string | null): string[] {
  if (!section) return [];
  return section
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

function parseJsonLoose(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function applyProjectStatePatchFromResponse(params: {
  channel: string;
  chatJid: string;
  projectId: string;
  responseText: string;
}): void {
  const patchRaw =
    parseSection(params.responseText, 'UPDATE_PROJECT_STATE') ||
    parseSection(params.responseText, 'PROJECT_STATE_PATCH');
  const patch = parseJsonLoose(patchRaw);
  if (!patch) return;

  const toStrArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];

  updateProjectMemoryState({
    channel: params.channel,
    chatJid: params.chatJid,
    projectId: params.projectId,
    patch: {
      goal: typeof patch.goal === 'string' ? patch.goal : undefined,
      current_status:
        typeof patch.current_status === 'string' ? patch.current_status : undefined,
      decisions: patch.decisions !== undefined ? toStrArray(patch.decisions) : undefined,
      constraints:
        patch.constraints !== undefined ? toStrArray(patch.constraints) : undefined,
      next_steps: patch.next_steps !== undefined ? toStrArray(patch.next_steps) : undefined,
      open_questions:
        patch.open_questions !== undefined ? toStrArray(patch.open_questions) : undefined,
      last_artifacts:
        patch.last_artifacts !== undefined ? toStrArray(patch.last_artifacts) : undefined,
      last_errors:
        patch.last_errors !== undefined ? toStrArray(patch.last_errors) : undefined,
      last_results:
        patch.last_results !== undefined
          ? toStrArray(patch.last_results).slice(-MEMORY_MAX_RESULTS)
          : undefined,
    },
  });
}

function checkpointProjectStateFromContract(params: {
  channel: string;
  chatJid: string;
  projectId: string;
  responseText: string;
}): void {
  const state = getProjectMemoryState(params.channel, params.chatJid, params.projectId);
  const nextArtifacts = [...state.last_artifacts];
  const nextQuestions = [...state.open_questions];
  const nextSteps = [...state.next_steps];

  const fileChanges = parseListLines(parseSection(params.responseText, 'FILE_CHANGES'));
  const commands = parseListLines(parseSection(params.responseText, 'COMMANDS'));
  const questions = parseListLines(parseSection(params.responseText, 'QUESTIONS')).slice(0, 2);
  const nextStepLine = parseSection(params.responseText, 'NEXT_STEP');
  const summary = parseSection(params.responseText, 'SUMMARY');

  for (const f of fileChanges) nextArtifacts.push(`file:${normalizeLine(f, 180)}`);
  for (const c of commands) nextArtifacts.push(`cmd:${normalizeLine(c, 220)}`);
  if (nextStepLine) nextSteps.unshift(normalizeLine(nextStepLine, 220));
  for (const q of questions) nextQuestions.push(normalizeLine(q, 220));

  updateProjectMemoryState({
    channel: params.channel,
    chatJid: params.chatJid,
    projectId: params.projectId,
    patch: {
      current_status: summary ? normalizeLine(summary, 220) : state.current_status,
      next_steps: nextSteps.slice(0, 10),
      open_questions: nextQuestions.slice(0, 10),
      last_artifacts: nextArtifacts.slice(-MEMORY_MAX_RESULTS),
    },
  });
}

function persistExecutionCheckpoints(params: {
  channel: string;
  chatJid: string;
  projectId: string;
  checkpoints?: CommandCheckpoint[];
}): void {
  if (!params.checkpoints || params.checkpoints.length === 0) return;
  const state = getProjectMemoryState(params.channel, params.chatJid, params.projectId);
  const artifacts = [...state.last_artifacts];
  const errors = [...state.last_errors];
  const checkpoints = [...state.last_checkpoints];

  for (const cp of params.checkpoints) {
    const cmd = cp.command ? normalizeLine(cp.command, 140) : '(tool)';
    artifacts.push(
      `checkpoint:${cp.provider}:${cp.tool}:exit=${cp.exitCode}:cmd=${cmd}`,
    );
    checkpoints.push(
      JSON.stringify({
        provider: cp.provider,
        tool: cp.tool,
        command: cp.command || '',
        exitCode: cp.exitCode,
        stdout: cp.stdoutSummary || '',
        stderr: cp.stderrSummary || '',
        timestamp: cp.timestamp,
      }),
    );
    if (cp.stdoutSummary) {
      artifacts.push(`stdout:${normalizeLine(cp.stdoutSummary, 180)}`);
    }
    if (cp.stderrSummary) {
      if (cp.exitCode === 0) {
        artifacts.push(`stderr:${normalizeLine(cp.stderrSummary, 180)}`);
      } else {
        errors.push(`cmd=${cmd} exit=${cp.exitCode} err=${normalizeLine(cp.stderrSummary, 180)}`);
      }
    }

    const combined = `${cp.stdoutSummary || ''}\n${cp.stderrSummary || ''}`;
    const urlMatch = combined.match(/https?:\/\/[^\s)]+/i);
    if (urlMatch) {
      artifacts.push(`preview_url:${normalizeLine(urlMatch[0], 220)}`);
    }
    const cmdLower = (cp.command || '').toLowerCase();
    if (/\b(build|typecheck|test|preview)\b/.test(cmdLower)) {
      const kind = cmdLower.includes('typecheck')
        ? 'typecheck'
        : cmdLower.includes('test')
          ? 'test'
          : cmdLower.includes('preview')
            ? 'preview'
            : 'build';
      artifacts.push(`${kind}_result:${cp.exitCode === 0 ? 'passed' : 'failed'}`);
    }
  }

  const last = params.checkpoints[params.checkpoints.length - 1];
  updateProjectMemoryState({
    channel: params.channel,
    chatJid: params.chatJid,
    projectId: params.projectId,
    patch: {
      last_artifacts: artifacts.slice(-MEMORY_MAX_RESULTS),
      last_errors: errors.slice(-MEMORY_MAX_RESULTS),
      last_checkpoints: checkpoints.slice(-MEMORY_MAX_RESULTS),
      current_status: `Last command checkpoint: ${last.provider}/${last.tool} exit=${last.exitCode}`,
    },
  });
}

function isProgressQuery(content: string): boolean {
  // Command mode is slash-only. Non-slash content should be handled as task input.
  return false;
}

function renderMemoryStatus(channel: string, chatJid: string, projectId: string): string {
  const state = getProjectMemoryState(channel, chatJid, projectId);
  const next = state.next_steps[0] || '(none)';
  const open = state.open_questions.slice(0, 2);
  return (
    `${ASSISTANT_NAME}: Project status\n` +
    `- goal: ${state.goal || '(unset)'}\n` +
    `- current: ${state.current_status || '(unset)'}\n` +
    `- next: ${next}\n` +
    `- open questions: ${open.length > 0 ? open.join(' | ') : '(none)'}`
  );
}

function renderMemoryCheckpointStatus(
  channel: string,
  chatJid: string,
  projectId: string,
): string {
  const state = getProjectMemoryState(channel, chatJid, projectId);
  const lastRaw = state.last_checkpoints[state.last_checkpoints.length - 1];
  if (!lastRaw) {
    return `${ASSISTANT_NAME}: Memory checkpoint status\n- no command checkpoints yet`;
  }

  try {
    const cp = JSON.parse(lastRaw) as {
      provider?: string;
      tool?: string;
      command?: string;
      exitCode?: number;
      stderr?: string;
      timestamp?: string;
    };
    return (
      `${ASSISTANT_NAME}: Memory checkpoint status\n` +
      `- timestamp: ${cp.timestamp || '(unknown)'}\n` +
      `- provider/tool: ${cp.provider || 'unknown'}/${cp.tool || 'unknown'}\n` +
      `- exit: ${typeof cp.exitCode === 'number' ? cp.exitCode : '(unknown)'}\n` +
      `- command: ${cp.command ? normalizeLine(cp.command, 180) : '(none)'}\n` +
      `- stderr: ${cp.stderr ? normalizeLine(cp.stderr, 180) : '(none)'}`
    );
  } catch {
    return (
      `${ASSISTANT_NAME}: Memory checkpoint status\n` +
      `- unable to parse latest checkpoint record`
    );
  }
}

function parseAutonomousControlCommand(content: string): {
  command: 'list' | 'pause' | 'resume' | 'why-paused';
  taskId?: string;
} | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;

  if (/^\/task\s+list$/i.test(trimmed)) {
    return { command: 'list' };
  }

  const pauseMatch = trimmed.match(/^\/task\s+pause\s+([a-z0-9-]+)$/i);
  if (pauseMatch) {
    return { command: 'pause', taskId: normalizeTaskIdCandidate(pauseMatch[1]) || pauseMatch[1] };
  }

  const resumeMatch = trimmed.match(/^\/task\s+resume\s+([a-z0-9-]+)$/i);
  if (resumeMatch) {
    return { command: 'resume', taskId: normalizeTaskIdCandidate(resumeMatch[1]) || resumeMatch[1] };
  }

  const whyPausedMatch =
    trimmed.match(new RegExp(`^@${ASSISTANT_NAME}\\b\\s+auto\\s+why-paused(?:\\s+([a-z0-9-]+))?$`, 'i')) ||
    trimmed.match(/^\/task\s+why-paused(?:\s+([a-z0-9-]+))?$/i) ||
    trimmed.match(/^\/ateam\s+why-paused(?:\s+([a-z0-9-]+))?$/i) ||
    trimmed.match(/^\/claude\s+why-paused(?:\s+([a-z0-9-]+))?$/i);
  if (whyPausedMatch) {
    const inferred = normalizeTaskIdCandidate(whyPausedMatch[1] || '') || extractTaskIdFromText(trimmed) || undefined;
    return { command: 'why-paused', taskId: inferred };
  }
  if (/^\/(?:ateam|claude|task)\s+why-paused\b/i.test(trimmed)) {
    const inferred = extractTaskIdFromText(trimmed) || undefined;
    return { command: 'why-paused', taskId: inferred };
  }

  return null;
}

function parseClaudeAuthIntent(content: string): 'start' | 'check' | null {
  const lowered = content.trim().toLowerCase();

  if (
    /\b(refresh|renew|reconnect|re-auth|reauth|setup)\b/.test(lowered) &&
    /\b(claude|oauth|token|auth)\b/.test(lowered)
  ) {
    return 'start';
  }

  if (
    /\b(claude auth done|oauth done|token done|i finished auth|auth completed)\b/.test(
      lowered,
    ) ||
    (/\b(check|verify|status)\b/.test(lowered) &&
      /\b(claude auth|oauth|token)\b/.test(lowered))
  ) {
    return 'check';
  }

  return null;
}

function getClaudeOauthStatusSummary(): string {
  const authState = getClaudeAuthState();
  if (authState.source === 'env') {
    return 'Claude OAuth status: configured via CLAUDE_CODE_OAUTH_TOKEN (expiry not locally visible).';
  }
  if (authState.source === 'missing' || !authState.expiryMs) {
    return 'Claude OAuth status: missing/unreadable credentials.';
  }
  const expiryMs = authState.expiryMs;
  const now = Date.now();
  const mins = Math.round((expiryMs - now) / 60000);
  if (mins <= 0) {
    return `Claude OAuth status: expired (${Math.abs(mins)} min ago).`;
  }
  return `Claude OAuth status: valid for about ${mins} minutes (until ${new Date(
    expiryMs,
  ).toISOString()}).`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTaskHandlerFromProjectName(projectName: string | null): 'claude' | 'auto' {
  if (typeof projectName !== 'string') return 'auto';
  return projectName.startsWith('handler::claude::') ? 'claude' : 'auto';
}

function stripTaskHandlerPrefix(projectName: string): string {
  return projectName.replace(/^handler::claude::/, '');
}

function withTaskHandlerPrefix(
  projectName: string | null,
  handler: 'claude' | 'auto',
): string | null {
  if (!projectName) return handler === 'claude' ? 'handler::claude::general' : null;
  const base = stripTaskHandlerPrefix(projectName);
  return handler === 'claude' ? `handler::claude::${base}` : base;
}

function matchesGroupTrigger(content: string, group: RegisteredGroup, isMainGroup: boolean): boolean {
  if (isMainGroup) return true;
  const trigger = (group.trigger || '').trim();
  if (!trigger) return true;
  const triggerPattern = new RegExp(`^${escapeRegex(trigger)}\\b`, 'i');
  return triggerPattern.test(content);
}

function hasRecurringScheduleIntent(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    /\b(schedule|recurr|repeat|every|daily|weekly|monthly|hourly|each day|each week)\b/.test(
      lowered,
    ) ||
    /\b(remind|report|update)\b/.test(lowered) && /\b(every|daily|weekly|monthly)\b/.test(lowered)
  );
}

function buildHelpText(
  pinnedModel?: 'local' | 'claude' | 'gemini' | 'openrouter',
  groundedMode: boolean = false,
  mode: 'default' | 'ateam' | 'claude' = 'default',
): string {
  const pinnedLabel = pinnedModel
    ? pinnedModel === 'local'
      ? 'qwen/local'
      : pinnedModel
    : 'auto';
  return (
    `Commands:\n` +
    `- /help : show this help\n` +
    `- /model claude|gemini|openrouter|qwen|auto : set default model for this chat\n` +
    `- /claude <request> : one-off request to Claude\n` +
    `- /gemini <request> : one-off request to Gemini\n` +
    `- /openrouter <request> : one-off request to OpenRouter\n` +
    `- /qwen <request> : one-off request to local fallback model\n` +
    `- /mode claude|Ateam|default : switch chat orchestration mode\n` +
    `- /claude status : show Claude-handler autonomous queue status\n` +
    `- /claude task <id> detail : show per-step details for Claude-handler task\n` +
    `- /ateam status : show Ateam/autonomous queue status\n` +
    `- /ateam task <id> detail : show per-step task details\n` +
    `- /task why-paused [id] : show why a task is paused\n` +
    `- /provider report [yesterday|today|YYYY-MM-DD] : provider reliability summary (UTC)\n` +
    `- /memory status : show latest execution checkpoint from memory\n` +
    `- /grounded on|off : require grounded, non-invented answers\n` +
    `\nCurrent:\n` +
    `- default model: ${pinnedLabel}\n` +
    `- mode: ${mode}\n` +
    `- grounded mode: ${groundedMode ? 'ON' : 'OFF'}`
  );
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  if (!content) return; // Skip empty messages (reactions, receipts, protocol msgs)

  if (fs.existsSync(MAINTENANCE_FLAG_PATH)) {
    logger.info({ chat: msg.chat_jid }, 'Skipping message during maintenance mode');
    return;
  }
  let adhocForcedModel: 'local' | 'claude' | 'gemini' | 'openrouter' | undefined;
  let adhocPrompt: string | undefined;

  if (/^\/help(?:\s+.*)?$/i.test(content)) {
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: ${buildHelpText(
        forcedModelByChat[msg.chat_jid],
        Boolean(groundedModeByChat[msg.chat_jid]),
        chatModeByChat[msg.chat_jid] || 'default',
      )}`,
    );
    return;
  }

  const modelControl = parseModelControlCommand(content);
  if (modelControl) {
    if (modelControl.action === 'clear') {
      delete forcedModelByChat[msg.chat_jid];
      await sendMessage(
        msg.chat_jid,
        `${ASSISTANT_NAME}: Model routing reset to auto.`,
      );
    } else if (modelControl.model) {
      forcedModelByChat[msg.chat_jid] = modelControl.model;
      const label = modelControl.model === 'local' ? 'qwen/local' : modelControl.model;
      await sendMessage(
        msg.chat_jid,
        `${ASSISTANT_NAME}: Model pinned to ${label} for this chat. If it fails, local fallback will be used.`,
      );
    }
    return;
  }
  if (isModelControlLike(content)) {
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Invalid model command. Use /model claude | /model gemini | /model openrouter | /model qwen | /model auto`,
    );
    return;
  }

  const modeControl = parseModeControlCommand(content);
  if (modeControl) {
    chatModeByChat[msg.chat_jid] = modeControl.mode;
    saveState();
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Chat mode set to ${modeControl.mode}.`,
    );
    return;
  }
  if (isModeControlLike(content)) {
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Invalid mode command. Use /mode claude | /mode Ateam | /mode default`,
    );
    return;
  }

  const adhocModel = parseAdhocModelCommand(content);
  if (adhocModel) {
    adhocForcedModel = adhocModel.model;
    adhocPrompt = adhocModel.prompt;
  } else if (isAdhocModelLike(content) && !isClaudeControlCommand(content)) {
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Invalid ad-hoc model command. Use /claude <request> | /gemini <request> | /openrouter <request> | /qwen <request>`,
    );
    return;
  }

  const groundedControl = parseGroundedControlCommand(content);
  if (groundedControl) {
    groundedModeByChat[msg.chat_jid] = groundedControl.enabled;
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Grounded mode ${groundedControl.enabled ? 'ON' : 'OFF'} for this chat.`,
    );
    return;
  }
  if (isGroundedControlLike(content)) {
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Invalid grounded command. Use /grounded on or /grounded off`,
    );
    return;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const chatMode = chatModeByChat[msg.chat_jid] || 'default';
  const pinnedModel = forcedModelByChat[msg.chat_jid];
  const projectId = group.folder;

  // Main group always responds. Non-main groups:
  // - empty trigger => respond to all messages
  // - non-empty trigger => require prefix match
  if (!matchesGroupTrigger(content, group, isMainGroup)) return;

  const control = parseAutonomousControlCommand(content);
  if (control) {
    if (control.command === 'list') {
      await sendMessage(msg.chat_jid, renderAutonomousTaskList(msg.chat_jid));
      return;
    }
    if (control.command === 'why-paused') {
      const targetId = control.taskId || getLatestAutonomousTaskForChat(msg.chat_jid)?.id;
      if (!targetId) {
        await sendMessage(
          msg.chat_jid,
          `${ASSISTANT_NAME}: No task found. Use /ateam status to list tasks.`,
        );
        return;
      }
      await sendMessage(msg.chat_jid, renderAutonomousPauseReason(targetId, msg.chat_jid));
      return;
    }

    if (control.taskId) {
      const ok = setAutonomousTaskPaused(
        control.taskId,
        control.command === 'pause',
      );
      if (!ok) {
        const task = getAutonomousTaskById(control.taskId);
        const taskSteps = task ? getAutonomousStepsForTask(task.id) : [];
        const fullyCompleted =
          taskSteps.length > 0 &&
          taskSteps.every((step) => step.status === 'completed');
        await sendMessage(
          msg.chat_jid,
          task
            ? fullyCompleted && control.command === 'resume'
              ? `${ASSISTANT_NAME}: Task ${control.taskId} is already fully completed and cannot be resumed.`
              : `${ASSISTANT_NAME}: Unable to ${control.command} task ${control.taskId}.`
            : `${ASSISTANT_NAME}: Task not found: ${control.taskId}`,
        );
      } else {
        await sendMessage(
          msg.chat_jid,
          `${ASSISTANT_NAME}: Task ${control.taskId} ${control.command === 'pause' ? 'paused' : 'resumed'}.`,
        );
      }
      return;
    }
    if (control.command === 'pause' || control.command === 'resume') {
      const latest = getLatestAutonomousTaskForChat(msg.chat_jid);
      if (!latest) {
        await sendMessage(
          msg.chat_jid,
          `${ASSISTANT_NAME}: No task found to ${control.command}.`,
        );
        return;
      }
      const ok = setAutonomousTaskPaused(
        latest.id,
        control.command === 'pause',
      );
      if (ok) {
        await sendMessage(
          msg.chat_jid,
          `${ASSISTANT_NAME}: Task ${latest.id} ${control.command === 'pause' ? 'paused' : 'resumed'}.`,
        );
      } else {
        const taskSteps = getAutonomousStepsForTask(latest.id);
        const fullyCompleted =
          taskSteps.length > 0 &&
          taskSteps.every((step) => step.status === 'completed');
        await sendMessage(
          msg.chat_jid,
          fullyCompleted && control.command === 'resume'
            ? `${ASSISTANT_NAME}: Task ${latest.id} is already fully completed and cannot be resumed.`
            : `${ASSISTANT_NAME}: Unable to ${control.command} task ${latest.id}.`,
        );
      }
      return;
    }
  }

  if (/^\/ateam\s+status$/i.test(content)) {
    await sendMessage(msg.chat_jid, renderAutonomousTaskList(msg.chat_jid));
    return;
  }
  if (/^\/claude\s+status$/i.test(content)) {
    await sendMessage(msg.chat_jid, renderAutonomousTaskList(msg.chat_jid, 'claude'));
    return;
  }
  const taskDetailId = parseAteamTaskDetailCommand(content);
  if (taskDetailId) {
    await sendMessage(msg.chat_jid, renderAutonomousTaskDetail(taskDetailId, msg.chat_jid));
    return;
  }
  const claudeTaskDetailId = parseClaudeTaskDetailCommand(content);
  if (claudeTaskDetailId) {
    await sendMessage(msg.chat_jid, renderAutonomousTaskDetail(claudeTaskDetailId, msg.chat_jid));
    return;
  }
  if (isAteamControlLike(content)) {
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Ateam control command not recognized.\n` +
        `Use:\n` +
        `- /ateam status\n` +
        `- /ateam task <autotask-id> detail\n` +
        `- /ateam why-paused [autotask-id]\n` +
        `Tip: task IDs can be like autotask-...`,
    );
    return;
  }
  if (/^\/memory\s+status$/i.test(content)) {
    await sendMessage(
      msg.chat_jid,
      `${renderMemoryCheckpointStatus('whatsapp', msg.chat_jid, projectId)}\n\n[source: memory:checkpoint-shortcut]`,
    );
    return;
  }
  const providerReport = renderProviderReport(content);
  if (providerReport) {
    await sendMessage(msg.chat_jid, providerReport);
    return;
  }
  if (isProviderReportLike(content)) {
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Invalid provider report command.\n` +
        `Use: /provider report [yesterday|today|YYYY-MM-DD]`,
    );
    return;
  }
  if (isProgressQuery(content)) {
    await sendMessage(
      msg.chat_jid,
      `${renderMemoryStatus('whatsapp', msg.chat_jid, projectId)}\n\n[source: memory:status-shortcut]`,
    );
    return;
  }

  if (isMainGroup) {
    const authIntent = parseClaudeAuthIntent(content);
    if (authIntent === 'start') {
      await sendMessage(
        msg.chat_jid,
        `${ASSISTANT_NAME}: To refresh Claude OAuth now:\n` +
          `1) On host terminal run: cd /home/zenkio/nanoclaw\n` +
          `2) Run: claude setup-token\n` +
          `3) Complete browser flow and paste token in that terminal\n` +
          `4) Run: npm run svc:restart\n` +
          `5) Reply here: "claude auth done"\n\n` +
          `Note: I cannot safely complete this flow fully inside WhatsApp because setup-token needs local interactive callback/browser handling.`,
      );
      return;
    }

    if (authIntent === 'check') {
      await checkClaudeOAuthStatusAndNotify('user-check');
      await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${getClaudeOauthStatusSummary()}`);
      return;
    }

    const autonomous = parseAutonomousRequest(content);
    if (autonomous) {
      const handler: 'claude' | 'auto' = pinnedModel === 'claude' ? 'claude' : 'auto';
      const task = createAutonomousTask({
        group_folder: group.folder,
        chat_jid: msg.chat_jid,
        project_name: withTaskHandlerPrefix(autonomous.projectName, handler),
        title: autonomous.title,
        prompt: autonomous.prompt,
      });
      updateProjectMemoryState({
        channel: 'whatsapp',
        chatJid: msg.chat_jid,
        projectId: projectId,
        patch: {
          goal: autonomous.projectName || autonomous.title,
          current_status: `Queued autonomous task ${task.id}`,
          next_steps: [autonomous.title],
        },
      });
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      await sendMessage(
        msg.chat_jid,
        `${ASSISTANT_NAME}: Autonomous task queued (${task.id}) for "${autonomous.title}" (handler=${handler}). I will execute and report each completed step.`,
      );
      return;
    }
  }

  if (chatMode === 'ateam' && !adhocForcedModel && !pinnedModel) {
    const autonomous = parseAutonomousRequest(content) || {
      projectName: null,
      title: normalizeLine(content, 100),
      prompt: content,
    };
    const taggedProject = `ateam::${autonomous.projectName || 'general'}`;
    const task = createAutonomousTask({
      group_folder: group.folder,
      chat_jid: msg.chat_jid,
      project_name: taggedProject,
      title: autonomous.title,
      prompt: autonomous.prompt,
    });
    updateProjectMemoryState({
      channel: 'whatsapp',
      chatJid: msg.chat_jid,
      projectId: taggedProject,
      patch: {
        goal: autonomous.projectName || autonomous.title,
        current_status: `Queued Ateam task ${task.id}`,
        next_steps: [autonomous.title],
        constraints: ['local model first', 'small executable subtasks'],
      },
    });
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    await sendMessage(
      msg.chat_jid,
      `${ASSISTANT_NAME}: Ateam task queued (${task.id}) for "${autonomous.title}". Qwen will execute step-by-step with decision/review loop and report progress.`,
    );
    return;
  }

  if (chatMode === 'claude' && !adhocForcedModel && !pinnedModel) {
    const autonomous = parseAutonomousRequest(content);
    if (autonomous) {
      const task = createAutonomousTask({
        group_folder: group.folder,
        chat_jid: msg.chat_jid,
        project_name: withTaskHandlerPrefix(autonomous.projectName || projectId, 'claude'),
        title: autonomous.title,
        prompt: autonomous.prompt,
      });
      updateProjectMemoryState({
        channel: 'whatsapp',
        chatJid: msg.chat_jid,
        projectId: projectId,
        patch: {
          goal: autonomous.projectName || autonomous.title,
          current_status: `Queued Claude task ${task.id}`,
          next_steps: [autonomous.title],
        },
      });
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      await sendMessage(
        msg.chat_jid,
        `${ASSISTANT_NAME}: Claude task queued (${task.id}) for "${autonomous.title}". I will execute step-by-step and report progress.`,
      );
      return;
    }
  }

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(
    msg.chat_jid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  const lines = missedMessages.map((m) => {
    const messageContent = adhocPrompt && m.id === msg.id ? adhocPrompt : m.content;
    // Escape XML special characters in content
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(messageContent)}</message>`;
  });
  const basePrompt = `<messages>\n${lines.join('\n')}\n</messages>`;
  const modeForcesClaude = chatMode === 'claude' && !adhocForcedModel && !forcedModelByChat[msg.chat_jid];
  const forcedModel =
    adhocForcedModel || forcedModelByChat[msg.chat_jid] || (modeForcesClaude ? 'claude' : undefined);
  const groundedMode = Boolean(groundedModeByChat[msg.chat_jid]);
  const groundingPrefix = groundedMode
    ? `[GROUNDING MODE]\nUse only information explicitly present in user messages, files, and tool outputs.\nIf required info is missing, say so explicitly and ask for the exact file/document.\nDo not invent facts.\n\n`
    : '';
  const prompt = `${groundingPrefix}${basePrompt}`;

  if (!prompt) return;

  logger.info(
    { group: group.name, messageCount: missedMessages.length, forcedModel, chatMode, groundedMode },
    'Processing message',
  );

  const stopTyping = startTypingHeartbeat(msg.chat_jid);
  try {
    const response = await runAgent(
      group,
      prompt,
      msg.chat_jid,
      forcedModel,
      missedMessages.length,
      chatMode,
      projectId,
      modeForcesClaude,
    );

    if (response) {
      const verifiedResponse = maybeVerifyJamButterPreviewClaim(
        group,
        prompt,
        response,
      );
      const shouldQueueFollowup =
        !adhocForcedModel &&
        responseLooksUnfinished(verifiedResponse.text) &&
        !hasActiveAutonomousTask(msg.chat_jid);
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      await sendMessage(
        msg.chat_jid,
        `${ASSISTANT_NAME}: ${verifiedResponse.text}\n\n[source: ${verifiedResponse.source}]`,
      );

      if (shouldQueueFollowup) {
        const handler: 'claude' | 'auto' =
          forcedModel === 'claude' ||
          chatMode === 'claude' ||
          verifiedResponse.source.toLowerCase().includes('claude')
            ? 'claude'
            : 'auto';
        const userIntent =
          adhocPrompt ||
          missedMessages
            .filter((m) => m.sender_name.toLowerCase() !== ASSISTANT_NAME.toLowerCase())
            .map((m) => m.content)
            .join('\n')
            .trim() ||
          msg.content;
        const followupPrompt =
          `Continue until the task is fully complete.\n\n` +
          `Original user request:\n${userIntent}\n\n` +
          `Previous partial response:\n${verifiedResponse.text}\n\n` +
          `Requirements:\n` +
          `- Complete remaining items from "Next"/pending list.\n` +
          `- If blocked, stop and ask for clarification.\n` +
          `- Update progress after each completed step.`;
        const followupTitle = `Continue: ${normalizeLine(userIntent || msg.content, 80)}`;
        const task = createAutonomousTask({
          group_folder: group.folder,
          chat_jid: msg.chat_jid,
          project_name: withTaskHandlerPrefix(projectId, handler),
          title: followupTitle,
          prompt: followupPrompt,
        });
        updateProjectMemoryState({
          channel: 'whatsapp',
          chatJid: msg.chat_jid,
          projectId,
          patch: {
            current_status: `Auto-queued continuation task ${task.id}`,
            next_steps: [followupTitle],
          },
        });
        await sendMessage(
          msg.chat_jid,
          `${ASSISTANT_NAME}: I detected unfinished work and queued continuation task ${task.id} (handler=${handler}).`,
        );
      }
    }
  } finally {
    await stopTyping();
  }
}

interface AgentRunResult {
  text: string;
  source: string;
}

function maybeVerifyJamButterPreviewClaim(
  group: RegisteredGroup,
  prompt: string,
  response: AgentRunResult,
): AgentRunResult {
  if (group.folder !== 'jambutter-project') return response;
  const lowerPrompt = prompt.toLowerCase();
  const lowerReply = response.text.toLowerCase();
  const deployIntent = lowerPrompt.includes('deploy') || lowerPrompt.includes('preview');
  const successClaim =
    lowerReply.includes('deployed') ||
    lowerReply.includes('deploy success') ||
    lowerReply.includes('successfully deployed');
  if (!deployIntent || !successClaim) return response;

  try {
    const projectRoot = path.dirname(DATA_DIR);
    const pkgPath = path.join(
      projectRoot,
      'groups',
      'jambutter-project',
      'projects',
      'jambutter',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    const expectedVersion = String(pkg.version || '').trim();
    const previewRoots = [
      path.join(projectRoot, 'groups', 'jambutter-project', '.data', 'preview'),
      path.join(projectRoot, 'data', 'preview'),
    ];

    let activeProject = '';
    let versionFound = false;
    let verifiedRoot = '';

    for (const root of previewRoots) {
      const activePath = path.join(root, '.active');
      const active = fs.existsSync(activePath)
        ? fs.readFileSync(activePath, 'utf-8').trim()
        : '';
      const previewAssetsDir = path.join(root, 'jambutter', 'assets');
      const assetFiles = fs.existsSync(previewAssetsDir)
        ? fs.readdirSync(previewAssetsDir).filter((f) => f.startsWith('settings-') && f.endsWith('.js'))
        : [];
      let found = false;
      for (const file of assetFiles) {
        const content = fs.readFileSync(path.join(previewAssetsDir, file), 'utf-8');
        if (expectedVersion && content.includes(expectedVersion)) {
          found = true;
          break;
        }
      }

      if (active === 'jambutter' && found) {
        activeProject = active;
        versionFound = true;
        verifiedRoot = root;
        break;
      }

      if (!activeProject && active) activeProject = active;
    }

    if (activeProject === 'jambutter' && versionFound) {
      return {
        text: response.text,
        source: response.source,
      };
    }

    return {
      text:
        `Preview verification failed after claimed deploy.\n` +
        `- expected version: ${expectedVersion || '(missing)'}\n` +
        `- active project: ${activeProject || '(missing)'}\n` +
        `- version found in preview assets: ${versionFound ? 'yes' : 'no'}\n` +
        `- checked roots: ${previewRoots.join(', ')}\n` +
        `${verifiedRoot ? `- verified root: ${verifiedRoot}\n` : ''}` +
        `Please redeploy with: bash /workspace/group/preview-jambutter.sh and re-verify before claiming success.`,
      source: response.source,
    };
  } catch (err) {
    return {
      text:
        `Preview verification check failed on host: ${err instanceof Error ? err.message : String(err)}.\n` +
        `Do not claim deploy success until verification passes.`,
      source: response.source,
    };
  }
}

function buildSourceTag(model: string, modelUsed?: string): string {
  const used = (modelUsed || '').trim();
  if (!used) return model;
  if (used === model) return model;
  if (used.startsWith(`${model}:`)) return used;
  if (used.includes(':')) return used;
  return `${model}:${used}`;
}

function parseModelControlCommand(content: string): {
  action: 'set' | 'clear';
  model?: 'local' | 'claude' | 'gemini' | 'openrouter';
} | null {
  const trimmed = content.trim().toLowerCase();
  const m = trimmed.match(/^\/model\s+([a-z0-9:_-]+)\s*$/i);
  if (!m) return null;
  const raw = m[1];
  if (raw === 'auto' || raw === 'default' || raw === 'off') return { action: 'clear' };
  if (raw === 'qwen' || raw === 'local' || raw === 'phi3') {
    return { action: 'set', model: 'local' };
  }
  if (raw === 'claude' || raw === 'gemini' || raw === 'openrouter') {
    return { action: 'set', model: raw };
  }
  return null;
}

function parseAdhocModelCommand(content: string): {
  model: 'local' | 'claude' | 'gemini' | 'openrouter';
  prompt: string;
} | null {
  const trimmed = content.trim();
  const m = trimmed.match(/^\/(claude|gemini|openrouter|qwen|local|phi3)\s+([\s\S]+)$/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const prompt = m[2].trim();
  if (!prompt) return null;
  if (
    raw === 'claude' &&
    (/^status\s*$/i.test(prompt) ||
      /^task\s+[a-z0-9-]+\s+detail$/i.test(prompt) ||
      /^why-paused(?:\s+[a-z0-9-]+)?$/i.test(prompt))
  ) {
    return null;
  }
  const model =
    raw === 'qwen' || raw === 'local'
      ? 'local'
      : raw === 'phi3'
        ? 'local'
        : (raw as 'local' | 'claude' | 'gemini' | 'openrouter');
  return { model, prompt };
}

function isAdhocModelLike(content: string): boolean {
  return /^\/(claude|gemini|openrouter|qwen|local|phi3)\b/i.test(
    content.trim(),
  );
}

function isClaudeControlCommand(content: string): boolean {
  const trimmed = content.trim();
  return (
    /^\/claude\s+status$/i.test(trimmed) ||
    /^\/claude\s+task\b[\s\S]*\bdetail$/i.test(trimmed) ||
    /^\/claude\s+why-paused(?:\s+[a-z0-9-]+)?$/i.test(trimmed)
  );
}

function isAteamControlLike(content: string): boolean {
  const trimmed = content.trim();
  return (
    /^\/ateam\b/i.test(trimmed) ||
    /^\/task\b/i.test(trimmed)
  );
}

function isModelControlLike(content: string): boolean {
  return /^\/model\b/i.test(content.trim());
}

function parseGroundedControlCommand(content: string): { enabled: boolean } | null {
  const trimmed = content.trim().toLowerCase();
  const m = trimmed.match(/^\/grounded\s+(on|off)\s*$/i);
  if (!m) return null;
  return { enabled: m[1] === 'on' };
}

function isGroundedControlLike(content: string): boolean {
  return /^\/grounded\b/i.test(content.trim());
}

function parseModeControlCommand(content: string): { mode: 'default' | 'ateam' | 'claude' } | null {
  const trimmed = content.trim().toLowerCase();
  const m = trimmed.match(/^\/mode\s+([a-z0-9_-]+)\s*$/i);
  if (!m) return null;
  const raw = m[1];
  if (raw === 'claude' || raw === 'claude-only' || raw === 'claude_only') return { mode: 'claude' };
  if (raw === 'ateam' || raw === 'a-team') return { mode: 'ateam' };
  if (raw === 'auto' || raw === 'default' || raw === 'normal') return { mode: 'default' };
  return null;
}

function isModeControlLike(content: string): boolean {
  return /^\/mode\b/i.test(content.trim());
}

function looksLikeProviderFailureText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('rate limited') ||
    lower.includes('rate-limited') ||
    lower.includes('gemini_rate_limit') ||
    lower.includes('openrouter_rate_limit') ||
    lower.includes('all free models failed') ||
    lower.includes('failed to authenticate') ||
    lower.includes('oauth token has expired') ||
    lower.includes('i encountered an issue processing your request')
  );
}

function isLowValueAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Heading-only or label-only style replies (e.g. "Reporting status:")
  if (/^#{1,6}\s*[^\n]+$/.test(trimmed)) return true;
  if (/^[A-Za-z0-9 _-]{3,80}:\s*$/.test(trimmed)) return true;

  // Ignore markdown punctuation and require meaningful body text.
  const normalized = trimmed
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;
  if (normalized.length < 24) return true;
  if (normalized.split(' ').filter(Boolean).length < 4) return true;

  return false;
}

function isLikelyCodingTask(prompt: string, signals: string[] = []): boolean {
  if (signals.some((s) => s === 'code-block' || s.startsWith('tech-keyword('))) {
    return true;
  }

  const lower = prompt.toLowerCase();
  return (
    /\b(code|coding|program|function|typescript|javascript|python|bug|debug|refactor|build|compile|test|unit test|tsc|npm|docker|api|endpoint|sql|schema|regex)\b/.test(
      lower,
    ) ||
    /```/.test(prompt)
  );
}

async function runAteamFlow(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  isMain: boolean,
): Promise<AgentRunResult | null> {
  const decisionPrompt =
    `[ATEAM:DECISION]\n` +
    `You are the decision maker for a software task.\n` +
    `Return only: Goal, Constraints, Plan (max 6), Risks (max 3).\n\n` +
    `${prompt}`;

  let decisionText = '';
  let decisionSource = '';
  const decisionOrder: Array<'gemini' | 'openrouter' | 'local'> = [
    'gemini',
    'openrouter',
    'local',
  ];

  for (const model of decisionOrder) {
    let releasePhi3Slot: (() => void) | null = null;
    try {
      if (model === 'local') {
        releasePhi3Slot = await requestPhi3Slot();
      }
      const out = await runContainerAgent(group, {
        prompt: decisionPrompt,
        groupFolder: group.folder,
        chatJid,
        isMain,
        model,
      });
      if (
        out.status === 'success' &&
        out.result &&
        !isLowValueAssistantText(out.result) &&
        !looksLikeProviderFailureText(out.result)
      ) {
        decisionText = out.result;
        decisionSource = buildSourceTag(model, out.modelUsed);
        break;
      }
    } catch {
      // Try next decision model
    } finally {
      releasePhi3Slot?.();
    }
  }

  const qwenPrompt =
    `[ATEAM:EXECUTION]\n` +
    `You are the autonomous developer. Execute directly.\n` +
    `Output format:\n` +
    `Result\nFiles changed\nChecks run\n\n` +
    `Decision context:\n${decisionText || 'No external decision available. Decide and proceed yourself.'}\n\n` +
    `Task:\n${prompt}`;

  let releasePhi3Slot: (() => void) | null = null;
  let qwenDraft = '';
  try {
    releasePhi3Slot = await requestPhi3Slot();
    const qwenOut = await runContainerAgent(group, {
      prompt: qwenPrompt,
      groupFolder: group.folder,
      chatJid,
      isMain,
      model: 'local',
    });
    if (
      qwenOut.status === 'success' &&
      qwenOut.result &&
      !looksLikeProviderFailureText(qwenOut.result)
    ) {
      qwenDraft = qwenOut.result;
    } else {
      return {
        text:
          `Ateam mode failed to execute with qwen/local.\n` +
          `Decision source: ${decisionSource || 'none'}\n` +
          `Error: ${qwenOut.error || 'no result'}`,
        source: 'ateam:qwen-error',
      };
    }
  } finally {
    releasePhi3Slot?.();
  }

  const seniorPrompt =
    `[ATEAM:SENIOR_REVIEW]\n` +
    `You are the senior programmer reviewer. Improve the draft only where needed.\n` +
    `Keep output concise with sections: Result / Files changed / Checks run.\n\n` +
    `Task:\n${prompt}\n\nDecision:\n${decisionText || 'n/a'}\n\nDraft:\n${qwenDraft}`;

  try {
    const seniorOut = await runContainerAgent(group, {
      prompt: seniorPrompt,
      groupFolder: group.folder,
      chatJid,
      isMain,
      model: 'openrouter',
    });
    if (
      seniorOut.status === 'success' &&
      seniorOut.result &&
      !isLowValueAssistantText(seniorOut.result) &&
      !looksLikeProviderFailureText(seniorOut.result)
    ) {
      return {
        text: seniorOut.result,
        source: `ateam:${decisionSource || 'qwen'}+${buildSourceTag('openrouter', seniorOut.modelUsed)}+qwen`,
      };
    }
  } catch {
    // OpenRouter not available; try Gemini next
  }

  try {
    const seniorOutGemini = await runContainerAgent(group, {
      prompt: seniorPrompt,
      groupFolder: group.folder,
      chatJid,
      isMain,
      model: 'gemini',
    });
    if (
      seniorOutGemini.status === 'success' &&
      seniorOutGemini.result &&
      !isLowValueAssistantText(seniorOutGemini.result) &&
      !looksLikeProviderFailureText(seniorOutGemini.result)
    ) {
      return {
        text: seniorOutGemini.result,
        source: `ateam:${decisionSource || 'qwen'}+${buildSourceTag('gemini', seniorOutGemini.modelUsed)}+qwen`,
      };
    }
  } catch {
    // Gemini not available; keep qwen draft
  }

  return {
    text: qwenDraft,
    source: `ateam:${decisionSource || 'qwen'}+qwen`,
  };
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  forcedModel?: 'local' | 'claude' | 'gemini' | 'openrouter',
  messageCount: number = 1,
  chatMode: 'default' | 'ateam' | 'claude' = 'default',
  projectId: string = group.folder,
  allowForcedFallback: boolean = false,
): Promise<AgentRunResult | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // 1. Snapshot tasks and groups for the container
  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map(t => ({
    id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
    schedule_type: t.schedule_type, schedule_value: t.schedule_value,
    status: t.status, next_run: t.next_run,
  })));

  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  // 2. Track Claude usage
  const budgetMode = await trackUsage(group.folder, undefined).catch(() => null);
  const isClaudeAvailable = budgetMode !== 'LOCKED' && !isClaudeQuotaCoolingDown();

  const memoryPrompt = buildProjectMemoryPromptBundle({
    channel: 'whatsapp',
    chatJid,
    projectId,
    currentTask: prompt,
  });

  if (!forcedModel && chatMode === 'ateam') {
    const ateam = await runAteamFlow(group, memoryPrompt, chatJid, isMain);
    if (ateam) {
      persistProjectMemoryFromRun({
        channel: 'whatsapp',
        chatJid,
        projectId,
        prompt,
        responseText: ateam.text,
        sourceTag: ateam.source,
      });
      applyProjectStatePatchFromResponse({
        channel: 'whatsapp',
        chatJid,
        projectId,
        responseText: ateam.text,
      });
      checkpointProjectStateFromContract({
        channel: 'whatsapp',
        chatJid,
        projectId,
        responseText: ateam.text,
      });
      return ateam;
    }
  }

  // 3. Sequential Escalation Loop
  const modelsToTry: Array<'local' | 'claude' | 'gemini' | 'openrouter'> = [];

  if (forcedModel) {
    modelsToTry.push(forcedModel);
  } else {
    const classification = classifyMessage(prompt, messageCount);
    const codingTask = isLikelyCodingTask(prompt, classification.signals);
    logger.info(
      {
        group: group.name,
        complexity: classification.complexity,
        score: classification.score,
        signals: classification.signals,
        codingTask,
      },
      'Routing classification',
    );

    const ordered = ROUTING_ESCALATION_ORDER.length > 0
      ? ROUTING_ESCALATION_ORDER
      : (['local', 'gemini', 'openrouter', 'claude'] as const);
    const available = ordered.filter((m) => m !== 'claude' || isClaudeAvailable);
    if (codingTask) {
      // Keep local at the end for coding quality safety while still allowing it as last-resort.
      const nonLocal = available.filter((m) => m !== 'local');
      const local = available.includes('local') ? ['local' as const] : [];
      modelsToTry.push(...nonLocal, ...local);
    } else {
      modelsToTry.push(...available);
      if (
        classification.complexity === 'complex' &&
        isClaudeAvailable &&
        !modelsToTry.includes('claude')
      ) {
        modelsToTry.push('claude');
      }
    }
  }

  let lastResult: string | null = null;
  let lastError: string | undefined;
  let localFallbackEscalationReason: string | undefined;

  for (const model of modelsToTry) {
    logger.info({ group: group.name, model }, `Attempting task with model`);
    
    let releasePhi3Slot: (() => void) | null = null;
    try {
      if (model === 'local') {
        releasePhi3Slot = await requestPhi3Slot();
      }
      const input = {
        prompt,
        sessionId: model === 'claude' ? sessionId : undefined, // Sessions primarily for Claude
        groupFolder: group.folder,
        chatJid,
        isMain,
        model,
      };

      const output = await runContainerAgent(group, {
        ...input,
        prompt: memoryPrompt,
      });
      persistExecutionCheckpoints({
        channel: 'whatsapp',
        chatJid,
        projectId,
        checkpoints: output.checkpoints,
      });

      if (output.status === 'success' && output.result) {
        if (isLowValueAssistantText(output.result)) {
          lastError = `low_value_or_empty_text_from_${model}`;
          logger.warn(
            { group: group.name, model, result: output.result.slice(0, 160) },
            'Model returned low-value/empty-looking text; continuing fallback chain',
          );
          continue;
        }

        if (looksLikeProviderFailureText(output.result)) {
          lastError = `provider_error_text_from_${model}: ${output.result}`;
          logger.warn(
            { group: group.name, model, result: output.result.slice(0, 240) },
            'Model returned failure-like text; continuing fallback chain',
          );
          continue;
        }

        if (output.newSessionId && model === 'claude') {
          sessions[group.folder] = output.newSessionId;
          saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
        }
        
        // If local fallback was used and it returned an escalation signal, continue the loop
        if (model === 'local' && output.result.startsWith('ESCALATE_TO_PREMIUM:')) {
          localFallbackEscalationReason = output.result.substring('ESCALATE_TO_PREMIUM:'.length).trim();
          logger.info({ group: group.name, reason: localFallbackEscalationReason }, 'Local fallback requested escalation');
          lastError = output.result; // Store the escalation reason as an error for potential logging
          continue; // Try the next model in modelsToTry
        }

        const source = buildSourceTag(model, output.modelUsed);
        persistProjectMemoryFromRun({
          channel: 'whatsapp',
          chatJid,
          projectId,
          prompt,
          responseText: output.result,
          sourceTag: source,
        });
        applyProjectStatePatchFromResponse({
          channel: 'whatsapp',
          chatJid,
          projectId,
          responseText: output.result,
        });
        checkpointProjectStateFromContract({
          channel: 'whatsapp',
          chatJid,
          projectId,
          responseText: output.result,
        });
        return { text: output.result, source };
      }

      lastError = output.error || 'No specific error reported';
      if (output.checkpoints && output.checkpoints.length > 0) {
        persistExecutionCheckpoints({
          channel: 'whatsapp',
          chatJid,
          projectId,
          checkpoints: output.checkpoints,
        });
      }
      if (model === 'claude' && lastError && isClaudeOauthExpiredError(lastError)) {
        await checkClaudeOAuthStatusAndNotify('claude-run-error');
      }
      
      // Track Claude quota exhaustion specifically
      if (model === 'claude' && lastError?.includes('claude_quota_exhausted')) {
        claudeQuotaExhaustedAt = Date.now();
        usageBudgetCache[group.folder] = { mode: 'LOCKED', checkedAt: Date.now() };
        logger.warn('Claude quota exhausted during run');
      }

    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (model === 'claude' && lastError && isClaudeOauthExpiredError(lastError)) {
        await checkClaudeOAuthStatusAndNotify('claude-run-exception');
      }
      logger.error({ group: group.name, model, err }, 'Model attempt failed with exception');
    } finally {
      releasePhi3Slot?.();
    }
  }

  if (forcedModel === 'claude' && !allowForcedFallback) {
    const errorText = lastError || 'unknown_claude_error';
    return {
      text:
        `Claude was pinned for this chat, but Claude failed.\n` +
        `Error: ${errorText}\n` +
        `Fallback coding was intentionally skipped.\n` +
        `Use /model auto or send /qwen <request> if you want local execution.`,
      source: 'claude-error-report',
    };
  }

  // Last-resort local attempt: ask the local fallback model for a best-effort response without escalation.
  // This helps avoid hard failure when cloud providers are unavailable/quota-limited.
  try {
    const fallbackPrompt =
      `${prompt}\n\n` +
      `[LAST_RESORT_MODE]\n` +
      `Cloud models are currently unavailable. Do NOT escalate.\n` +
      `Give the best possible answer with no external tools.\n` +
      `If the task is large, split it into clear phases and provide phase 1 now.`;
    const fallbackMemoryPrompt = buildProjectMemoryPromptBundle({
      channel: 'whatsapp',
      chatJid,
      projectId,
      currentTask: fallbackPrompt,
    });

    logger.info({ group: group.name, priorReason: localFallbackEscalationReason }, 'Attempting last-resort local fallback response');
    const lastResortRelease = await requestPhi3Slot();
    let lastResort;
    try {
      lastResort = await runContainerAgent(group, {
        prompt: fallbackMemoryPrompt,
        groupFolder: group.folder,
        chatJid,
        isMain,
        model: 'local',
      });
      persistExecutionCheckpoints({
        channel: 'whatsapp',
        chatJid,
        projectId,
        checkpoints: lastResort.checkpoints,
      });
    } finally {
      lastResortRelease();
    }

    if (lastResort.status === 'success' && lastResort.result) {
      if (lastResort.result.startsWith('ESCALATE_TO_PREMIUM:')) {
        const stripped = lastResort.result.substring('ESCALATE_TO_PREMIUM:'.length).trim();
        if (stripped.length > 0) {
          persistProjectMemoryFromRun({
            channel: 'whatsapp',
            chatJid,
            projectId,
            prompt,
            responseText: `[Best effort mode] ${stripped}`,
            sourceTag: 'local-last-resort',
          });
          checkpointProjectStateFromContract({
            channel: 'whatsapp',
            chatJid,
            projectId,
            responseText: stripped,
          });
          return { text: `[Best effort mode] ${stripped}`, source: 'local-last-resort' };
        }
      } else {
        persistProjectMemoryFromRun({
          channel: 'whatsapp',
          chatJid,
          projectId,
          prompt,
          responseText: lastResort.result,
          sourceTag: 'local-last-resort',
        });
        applyProjectStatePatchFromResponse({
          channel: 'whatsapp',
          chatJid,
          projectId,
          responseText: lastResort.result,
        });
        checkpointProjectStateFromContract({
          channel: 'whatsapp',
          chatJid,
          projectId,
          responseText: lastResort.result,
        });
        return { text: lastResort.result, source: 'local-last-resort' };
      }
    }

    if (lastResort.error) {
      lastError = lastResort.error;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err: msg }, 'Last-resort local fallback attempt failed');
    lastError = msg;
  }

  // If we're here, everything failed including last-resort local mode.
  const finalErrorMsg = lastError || 'Unknown error occurred.';
  persistProjectMemoryFromRun({
    channel: 'whatsapp',
    chatJid,
    projectId,
    prompt,
    errorText: finalErrorMsg,
  });
  await sendMessage(chatJid, `${ASSISTANT_NAME}: I encountered an issue processing your request across all available systems. Last error: ${finalErrorMsg}. Please try again later.`);
  return null;
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    await sock.sendMessage(jid, { text });
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const source =
                    typeof data.source === 'string' && data.source.trim().length > 0
                      ? data.source.trim()
                      : sourceGroup;
                  const hasSourceTag = /\[source:\s*[^\]]+\]\s*$/i.test(data.text);
                  const textWithSource = hasSourceTag
                    ? data.text
                    : `${data.text}\n\n[source: ${source}]`;
                  await sendMessage(
                    data.chatJid,
                    `${ASSISTANT_NAME}: ${textWithSource}`,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, source },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    agent?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const {
    createTask,
    updateTask,
    deleteTask,
    getTaskById: getTask,
  } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.groupFolder
      ) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup,
        )?.[0];

        if (!targetJid) {
          logger.warn(
            { targetGroup },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        // Safety: recurring schedules must be explicitly requested by user language.
        // Prevents accidental minute-level spam from autonomous fallback behavior.
        if (scheduleType !== 'once') {
          const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const recent = getMessagesSince(targetJid, since, ASSISTANT_NAME);
          const latestUserMsg = recent.length > 0 ? recent[recent.length - 1]?.content || '' : '';
          const recurringIntent =
            hasRecurringScheduleIntent(latestUserMsg) ||
            hasRecurringScheduleIntent(data.prompt);

          if (!recurringIntent) {
            logger.warn(
              { sourceGroup, targetGroup, scheduleType, prompt: data.prompt.slice(0, 120) },
              'Blocked recurring schedule without explicit user intent',
            );
            await sendMessage(
              targetJid,
              `${ASSISTANT_NAME}: I skipped creating a recurring task because no explicit schedule request was detected. Ask clearly like "daily summary at 9am" to enable it.`,
            );
            break;
          }
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetGroup, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'delegate_agent':
      if (data.agent && data.prompt && data.groupFolder && data.chatJid) {
        // Authorization: ensure source group is allowed to delegate to this agent
        const targetGroup = registeredGroups[data.chatJid];
        if (!isMain && (!targetGroup || targetGroup.folder !== data.groupFolder)) {
          logger.warn(
            { sourceGroup, targetAgent: data.agent, targetGroup: data.groupFolder },
            'Unauthorized delegate_agent attempt blocked',
          );
          break;
        }

        logger.info(
          { sourceGroup, targetAgent: data.agent, targetGroup: data.groupFolder },
          'Delegating task via IPC',
        );

        // Re-run agent with the delegated model
        const groupToRun = Object.values(registeredGroups).find(g => g.folder === data.groupFolder);
        if (groupToRun) {
          // Fire-and-forget for IPC throughput, but send delegated result back to chat on completion.
          runAgent(groupToRun, data.prompt, data.chatJid, data.agent as any)
            .then(async (delegatedResult) => {
              if (!delegatedResult) return;
              const verifiedDelegatedResult = maybeVerifyJamButterPreviewClaim(
                groupToRun,
                data.prompt || '',
                delegatedResult,
              );
              await sendMessage(
                data.chatJid!,
                `${ASSISTANT_NAME}: ${verifiedDelegatedResult.text}\n\n[source: delegated-${verifiedDelegatedResult.source}]`,
              );
              logger.info(
                {
                  sourceGroup,
                  targetAgent: data.agent,
                  targetGroup: data.groupFolder,
                  source: verifiedDelegatedResult.source,
                },
                'Delegated agent completed and result sent',
              );
            })
            .catch(err => logger.error({ err }, 'Delegated agent run failed'));
        } else {
          logger.error(
            { targetGroup: data.groupFolder },
            'Could not find registered group for delegated agent',
          );
        }
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        const { writeGroupsSnapshot: writeGroups } =
          await import('./container-runner.js');
        writeGroups(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(STORE_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // Fetch latest WA Web version to avoid version mismatch disconnects
  let waVersion: [number, number, number] | undefined;
  try {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    logger.info({ version: version.join('.') }, 'Fetched WA Web version');
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch WA version, using Baileys default');
  }

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0'],
    ...(waVersion ? { version: waVersion } : {}),
    connectTimeoutMs: 60000, // Increase timeout for WSL2 NAT latency
    retryRequestDelayMs: 5000, // Longer retry delay for WSL2
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const msg =
        'WhatsApp authentication required. Run /setup in Claude Code.';
      logger.error(msg);
      // Exit so systemd can restart — don't spin in a loop requesting QR codes
      setTimeout(() => process.exit(1), 1000);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      logger.info({ reason, reconnectAttempts }, 'Connection closed');

      if (reason === DisconnectReason.loggedOut) {
        logger.error('Logged out by WhatsApp. Clearing auth and exiting. Run /setup to re-authenticate.');
        // Wipe auth so next startup goes straight to QR/pairing
        fs.rmSync(authDir, { recursive: true, force: true });
        process.exit(1);
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 64s, ... capped at 5 min
      const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
      reconnectAttempts++;
      logger.info({ delay, attempt: reconnectAttempts }, 'Reconnecting with backoff...');
      setTimeout(() => connectWhatsApp(), delay);
    } else if (connection === 'open') {
      reconnectAttempts = 0; // Reset backoff on successful connection
      logger.info('Connected to WhatsApp');
      
      // Build LID to phone mapping from auth state for self-chat translation
      if (sock.user) {
        const phoneUser = sock.user.id.split(':')[0];
        const lidUser = sock.user.lid?.split(':')[0];
        if (lidUser && phoneUser) {
          lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
          logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
        }
      }
      
      // Sync group metadata on startup (respects 24h cache)
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Initial group sync failed'),
      );
      // Set up daily sync timer (only once)
      if (!groupSyncTimerStarted) {
        groupSyncTimerStarted = true;
        setInterval(() => {
          syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Periodic group sync failed'),
          );
        }, GROUP_SYNC_INTERVAL_MS);
      }
      startSchedulerLoop({
        sendMessage,
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions,
      });
      startAutonomousLoop({
        sendMessage: (jid, text) => sendMessage(jid, text),
        runAgent: (
          groupArg,
          prompt,
          chatJid,
          forcedModel,
          messageCount,
          chatModeArg,
          projectId,
          allowForcedFallback,
        ) =>
          runAgent(
            groupArg,
            prompt,
            chatJid,
            forcedModel,
            messageCount,
            chatModeArg,
            projectId,
            allowForcedFallback,
          ),
        resolveGroupByFolder: (folder) => getRegisteredGroupByFolder(folder),
        getClaudeExecutionHealth: (groupFolder) =>
          getClaudeExecutionHealth(groupFolder),
      });
      startDecisionVerificationLoop({
        sendMessage: (jid, text) => sendMessage(jid, text),
        resolveGroupByFolder: (folder) => getRegisteredGroupByFolder(folder),
        runWithModel: async (groupArg, prompt, chatJid, model) => {
          const output = await runContainerAgent(groupArg, {
            prompt,
            sessionId: model === 'claude' ? sessions[groupArg.folder] : undefined,
            groupFolder: groupArg.folder,
            chatJid,
            isMain: groupArg.folder === MAIN_GROUP_FOLDER,
            model,
          });
          if (output.status === 'success' && output.result) {
            if (output.newSessionId && model === 'claude') {
              sessions[groupArg.folder] = output.newSessionId;
              saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
            }
            return output.result;
          }
          return null;
        },
      });
      startIpcWatcher();
      startMessageLoop();
      startEmailLoop();
      checkClaudeOAuthStatusAndNotify('startup').catch((err) =>
        logger.debug({ err }, 'OAuth startup check failed'),
      );
      if (!oauthExpiryMonitorStarted) {
        oauthExpiryMonitorStarted = true;
        setInterval(() => {
          checkClaudeOAuthStatusAndNotify('periodic').catch((err) =>
            logger.debug({ err }, 'OAuth periodic check failed'),
          );
        }, 15 * 60 * 1000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === 'status@broadcast') continue;

      // Translate LID JID to phone JID if applicable
      const chatJid = translateJid(rawJid);
      
      const timestamp = new Date(
        Number(msg.messageTimestamp) * 1000,
      ).toISOString();

      // Always store chat metadata for group discovery
      storeChatMetadata(chatJid, timestamp);

      if (registeredGroups[chatJid]) {
        // Log messageStubParameters if it exists, to help debug parsing errors
        const stubParams = (msg.message as any)?.messageStubParameters;
        if (stubParams) {
          logger.debug(
            { stubParams },
            'WhatsApp messageStubParameters found',
          );
        }
        storeMessage(
          msg,
          chatJid,
          msg.key.fromMe || false,
          msg.pushName || undefined,
        );
      }
    }
  });
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0)
        logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

async function runEmailAgent(
  contextKey: string,
  prompt: string,
  email: EmailMessage
): Promise<string | null> {
  // Email uses either main group context or dynamic folders per thread/sender
  const groupFolder = EMAIL_CHANNEL.contextMode === 'single'
    ? MAIN_GROUP_FOLDER  // Use main group context
    : `email/${contextKey}`;  // Isolated email context

  // Ensure folder exists
  const groupDir = path.join(process.cwd(), 'groups', groupFolder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Create minimal CLAUDE.md for email groups if it doesn't exist
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, `# Email Channel\n\nYou are responding to emails. Your responses will be sent as email replies.\n\n## Guidelines\n\n- Be professional and clear\n- Keep responses concise but complete\n- Use proper email formatting (greetings, sign-off)\n- If the email requires action you can't take, explain what the user should do\n\n## Context\n\nEach email thread has its own conversation history.\n`);
  }

  // Create minimal registered group for email
  const emailGroup: RegisteredGroup = {
    name: contextKey,
    folder: groupFolder,
    trigger: '',  // No trigger for email
    added_at: new Date().toISOString()
  };

  try {
    // Use existing runContainerAgent
    const output = await runContainerAgent(emailGroup, {
      prompt,
      sessionId: sessions[groupFolder],
      groupFolder,
      chatJid: `email:${email.from}`,  // Use email: prefix for JID
      isMain: false,
      isScheduledTask: false
    });

    if (output.newSessionId) {
      sessions[groupFolder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    return output.status === 'success' ? output.result : null;
  } catch (err) {
    logger.error({ err, email: email.from }, 'Email agent failed');
    return null;
  }
}

async function startEmailLoop(): Promise<void> {
  if (!EMAIL_CHANNEL.enabled) {
    logger.info('Email channel disabled');
    return;
  }

  logger.info(`Email channel running (trigger: ${EMAIL_CHANNEL.triggerMode}:${EMAIL_CHANNEL.triggerValue})`);

  // Run email polling loop
  while (true) {
    try {
      const emails = await checkForNewEmails();

      for (const email of emails) {
        if (isEmailProcessed(email.id)) continue;

        logger.info({ from: email.from, subject: email.subject }, 'Processing email');
        markEmailProcessed(email.id, email.threadId, email.from, email.subject);

        // Determine which group/context to use
        const contextKey = getContextKey(email);

        // Build prompt with email content
        const prompt = `<email>
<from>${email.from}</from>
<subject>${email.subject}</subject>
<body>${email.body}</body>
</email>

Respond to this email. Your response will be sent as an email reply.`;

        // Run agent with email context
        const response = await runEmailAgent(contextKey, prompt, email);

        if (response) {
          await sendEmailReply(email.threadId, email.from, email.subject, response);
          markEmailResponded(email.id);
          logger.info({ to: email.from }, 'Email reply sent');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in email loop');
    }

    await new Promise(resolve => setTimeout(resolve, EMAIL_CHANNEL.pollIntervalMs));
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe' });
    logger.debug('Docker is running');
  } catch {
    logger.error('Docker is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker is not running                                  ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                    ║',
    );
    console.error(
      '║  1. Start Docker daemon: sudo dockerd &                       ║',
    );
    console.error(
      '║  2. Or on systemd: sudo systemctl start docker                ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                          ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker is required but not running');
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  await connectWhatsApp();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
