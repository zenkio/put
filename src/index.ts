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
  POLL_INTERVAL,
  STORE_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllTasks,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  initDatabase,
  isEmailProcessed,
  markEmailProcessed,
  markEmailResponded,
  setLastGroupSync,
  storeChatMetadata,
  storeMessage,
  updateChatName,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { checkForNewEmails, sendEmailReply, getContextKey, EmailMessage } from './email-channel.js';
import { classifyMessage } from './message-classifier.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
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
// Claude credentials path for OAuth usage API
const CLAUDE_CREDENTIALS_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.claude',
  '.credentials.json',
);

/**
 * Fetch real Claude usage from Anthropic API and write quota file for the agent.
 */
/**
 * Calculate budget mode from usage % and time until reset.
 *
 * SPEND:    reset < 1h away AND usage < 80% → use Claude freely, don't waste subscription
 * NORMAL:   usage < 50% → Claude handles most, delegates bulk/repetitive to Gemini
 * CONSERVE: usage 50-85% → Claude orchestrates, delegates most execution to Gemini
 * GUARDIAN: usage 85-95% → Claude only for decisions, bounded Gemini delegation
 * LOCKED:   usage >= 95% → log tasks only
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

  if (effectivePct >= 95) {
    return { mode: 'LOCKED', reason: `${effectivePct}% used`, hoursUntil5hReset, hoursUntil7dReset };
  }
  if (effectivePct >= 85) {
    return { mode: 'GUARDIAN', reason: `${effectivePct}% used`, hoursUntil5hReset, hoursUntil7dReset };
  }
  if (effectivePct >= 50) {
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

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
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

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  if (!content) return; // Skip empty messages (reactions, receipts, protocol msgs)

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(
    msg.chat_jid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  const lines = missedMessages.map((m) => {
    // Escape XML special characters in content
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  await setTyping(msg.chat_jid, true);
  const response = await runAgent(group, prompt, msg.chat_jid);
  await setTyping(msg.chat_jid, false);

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${response}`);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
): Promise<string | null> {
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
  const isClaudeAvailable = budgetMode !== 'LOCKED' && !claudeQuotaExhaustedAt;

  // 3. Sequential Escalation Loop
  const modelsToTry: Array<'phi3' | 'claude' | 'gemini' | 'openrouter'> = ['phi3'];
  
  if (isClaudeAvailable) {
    modelsToTry.push('claude');
  }
  modelsToTry.push('gemini');
  modelsToTry.push('openrouter');

  let lastResult: string | null = null;
  let lastError: string | undefined;

  for (const model of modelsToTry) {
    logger.info({ group: group.name, model }, `Attempting task with model`);
    
    try {
      const input = {
        prompt,
        sessionId: model === 'claude' ? sessionId : undefined, // Sessions primarily for Claude
        groupFolder: group.folder,
        chatJid,
        isMain,
        model,
      };

      const output = await runContainerAgent(group, input);

      if (output.status === 'success' && output.result) {
        if (output.newSessionId && model === 'claude') {
          sessions[group.folder] = output.newSessionId;
          saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
        }
        
        // If Phi-3 was used and it didn't explicitly ask for escalation, we're done
        if (model === 'phi3' && output.result.includes('ESCALATE_TO_PREMIUM')) {
          logger.info({ group: group.name }, 'Phi-3 requested escalation');
          continue;
        }

        return output.result;
      }

      lastError = output.error;
      
      // Track Claude quota exhaustion specifically
      if (model === 'claude' && lastError?.includes('claude_quota_exhausted')) {
        claudeQuotaExhaustedAt = Date.now();
        logger.warn('Claude quota exhausted during run');
      }

    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error({ group: group.name, model, err }, 'Model attempt failed with exception');
    }
  }

  // If we're here, everything failed
  await sendMessage(chatJid, `${ASSISTANT_NAME}: I encountered an issue processing your request across all available systems. Please try again later.`);
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
                  await sendMessage(
                    data.chatJid,
                    `${ASSISTANT_NAME}: ${data.text}`,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
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
          // Do not wait for response, as it will block the IPC watcher
          runAgent(groupToRun, data.prompt, data.chatJid, data.agent as any)
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
      startIpcWatcher();
      startMessageLoop();
      startEmailLoop();
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

      // Only store full message content for registered groups
      if (registeredGroups[chatJid]) {
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
