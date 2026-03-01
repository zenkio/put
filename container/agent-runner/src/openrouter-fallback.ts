/**
 * OpenRouter Fallback Agent for NanoClaw
 * Uses OpenRouter's free models (OpenAI-compatible API) as a delegation target.
 * Provides the same tools as the Gemini fallback (bash, file ops, IPC messaging).
 */

import fs from 'fs';
import path from 'path';
import { executeSharedTool } from './tool-utils.js';
import {
  appendSharedContextRecord,
  buildSharedContextPrompt,
} from './context-store.js';

const MAX_ITERATIONS = 15;
const OPENROUTER_IDLE_TIMEOUT_MS = Number(process.env.OPENROUTER_IDLE_TIMEOUT_MS || 90000);
const OPENROUTER_REQUEST_HARD_TIMEOUT_MS = Number(
  process.env.OPENROUTER_REQUEST_HARD_TIMEOUT_MS || 300000,
);
const OPENROUTER_SESSION_HARD_TIMEOUT_MS = Number(
  process.env.OPENROUTER_SESSION_HARD_TIMEOUT_MS || 420000,
);
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FREE_MODELS_CACHE = '/workspace/group/ai/.openrouter-free-models.json';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface OpenRouterInput {
  prompt: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  model?: string;
  runId?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
  modelUsed?: string;
  provider?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  error?: { message: string; code?: number };
}

function log(message: string): void {
  console.error(`[openrouter-fallback] ${message}`);
}

function stripOrchestration(content: string): string {
  const skipHeadings = ['Delegation & Quota', 'Before Every Response', 'Orchestration Protocol', 'MANDATORY: Read Quota'];
  const lines = content.split('\n');
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim();
      skipping = skipHeadings.some((h) => heading.startsWith(h));
    } else if (line.startsWith('---')) {
      skipping = false;
    }
    if (!skipping) result.push(line);
  }
  return result.join('\n').trim();
}

function loadSystemPrompt(isDirect: boolean): string {
  const parts: string[] = [];

  if (isDirect) {
    // Primary handler: user is talking directly to us via WhatsApp
    parts.push(
      '## PRIMARY MODE — You are the main assistant',
      'You are responding directly to a WhatsApp conversation. The user is talking to you.',
      'Be helpful, conversational, and complete. You are NOT a worker — you are the primary assistant.',
      'Token-efficiency: keep replies concise and avoid long reports unless requested.',
      '',
      'You have tools: bash, read_file, write_file, list_files, send_message, schedule_task, delegate_to_claude, delegate_to_gemini, delegate_to_local.',
      'Work directory: /workspace/group/',
      '',
      '- Respond naturally as a personal assistant',
      '- Prefer short, actionable answers over narrative summaries',
      '- Use send_message for long tasks to keep the user informed',
      '- If a task requires complex coding or deep analysis, use delegate_to_claude.',
      '- Use delegate_to_local only for low-risk coding subtasks (boilerplate/single utility draft).',
      '- If local code is used, require verification via typecheck/tests before final delivery.',
    );
  } else {
    // Worker mode: Claude delegated a specific task
    parts.push(
      '## WORKER MODE — READ THIS FIRST',
      'You are an OpenRouter worker. Claude delegated a specific task to you.',
      'Execute the task in the user prompt and return the result. That\'s it.',
      '- Do NOT read .usage.json or PROJECT_STATE.md',
      '- Do NOT delegate to other workers',
      '- Do NOT use send_message unless the task explicitly asks you to send a WhatsApp message',
      '- Do NOT modify PROJECT_STATE.md or TASK_QUEUE.md',
      '- Just do the task and respond with the answer',
      '',
      'You have tools: bash, read_file, write_file, list_files, send_message, schedule_task.',
      'Work directory: /workspace/group/',
      'Keep responses concise.',
      '',
      '## OUTPUT LIMITS',
      '- Maximum 200 lines of output.',
      '- Only modify a SINGLE file and a SINGLE function per task.',
      '- No full rewrites — patch only.',
    );
  }

  const globalPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalPath)) {
    parts.push(stripOrchestration(fs.readFileSync(globalPath, 'utf-8')));
  }

  const groupPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupPath)) {
    parts.push(stripOrchestration(fs.readFileSync(groupPath, 'utf-8')));
  }

  const sharedContext = buildSharedContextPrompt();
  if (sharedContext) {
    parts.push(sharedContext);
  }

  return parts.join('\n\n');
}

const toolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: 'Execute a bash command and return its output. Working directory is /workspace/group/.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List files in a directory. Returns filenames.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
          recursive: { type: 'boolean', description: 'If true, list recursively' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_message',
      description: 'Send a message to the current WhatsApp chat. Use this for proactive updates.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'schedule_task',
      description: 'Schedule a recurring or one-time task.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the agent should do when the task runs' },
          schedule_type: { type: 'string', description: 'cron, interval, or once' },
          schedule_value: { type: 'string', description: 'Cron expression, milliseconds, or ISO timestamp' },
          context_mode: { type: 'string', description: 'group or isolated' },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delegate_to_claude',
      description: 'Delegate a complex task to Claude for execution.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for Claude' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delegate_to_gemini',
      description: 'Delegate a task to Gemini for execution.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for Gemini' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delegate_to_local',
      description: 'Delegate a low-risk coding subtask to local fallback model.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The low-risk subtask for local model' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delegate_to_phi3',
      description: 'Backward-compatible alias of delegate_to_local.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The low-risk subtask for local model' },
        },
        required: ['prompt'],
      },
    },
  },
];

const WORKER_STATUS_FILE = '/workspace/group/ai/.worker-status.json';
const MODEL_STATUS_FILE = '/workspace/group/ai/.openrouter-model-status.json';

function readJsonFile(pathname: string): any {
  try {
    if (!fs.existsSync(pathname)) return {};
    return JSON.parse(fs.readFileSync(pathname, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJsonFile(pathname: string, data: any): void {
  try {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, JSON.stringify(data, null, 2));
  } catch {
    /* non-fatal */
  }
}

function getWorkerCooldownMs(worker: string): number | null {
  const data = readJsonFile(WORKER_STATUS_FILE);
  const entry = data?.[worker];
  const retryAt = entry?.retry_after || entry?.cooldown_until;
  if (!retryAt) return null;
  const retryMs = new Date(retryAt).getTime() - Date.now();
  return retryMs > 0 ? retryMs : null;
}

function getModelCooldownMs(model: string): number | null {
  const data = readJsonFile(MODEL_STATUS_FILE);
  const entry = data?.[model];
  const retryAt = entry?.retry_after || entry?.cooldown_until;
  if (!retryAt) return null;
  const retryMs = new Date(retryAt).getTime() - Date.now();
  return retryMs > 0 ? retryMs : null;
}

function updateWorkerStatus(worker: string, status: 'ok' | 'rate_limited' | 'error', details: {
  model?: string;
  error?: string;
  retryAfterMs?: number;
  cooldownMs?: number;
  limit?: string;
  remaining?: string;
  reset?: string;
}): void {
  try {
    const existing: Record<string, any> = readJsonFile(WORKER_STATUS_FILE);
    const now = new Date().toISOString();
    existing[worker] = {
      status,
      model: details.model,
      error: details.error?.slice(0, 200),
      limit: details.limit,
      remaining: details.remaining,
      reset: details.reset,
      updated_at: now,
      ...(status === 'ok' ? { last_success: now } : {}),
      ...(status === 'rate_limited' ? {
        retry_after: new Date(Date.now() + (details.retryAfterMs || 60000)).toISOString(),
      } : {}),
      ...(details.cooldownMs ? {
        cooldown_until: new Date(Date.now() + details.cooldownMs).toISOString(),
      } : {}),
    };
    writeJsonFile(WORKER_STATUS_FILE, existing);
  } catch { /* non-fatal */ }
}

function updateModelStatus(model: string, status: 'ok' | 'rate_limited' | 'error', details: {
  error?: string;
  retryAfterMs?: number;
  cooldownMs?: number;
  limit?: string;
  remaining?: string;
  reset?: string;
}): void {
  const existing: Record<string, any> = readJsonFile(MODEL_STATUS_FILE);
  const now = new Date().toISOString();
  existing[model] = {
    status,
    error: details.error?.slice(0, 200),
    limit: details.limit,
    remaining: details.remaining,
    reset: details.reset,
    updated_at: now,
    ...(status === 'ok' ? { last_success: now } : {}),
    ...(status === 'rate_limited' ? {
      retry_after: new Date(Date.now() + (details.retryAfterMs || 60000)).toISOString(),
    } : {}),
    ...(details.cooldownMs ? {
      cooldown_until: new Date(Date.now() + details.cooldownMs).toISOString(),
    } : {}),
  };
  writeJsonFile(MODEL_STATUS_FILE, existing);
}

function isOpenRouterProviderWideStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status >= 500;
}

function isOpenRouterProviderWideMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('invalid api key') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('insufficient credits') ||
    lower.includes('billing') ||
    lower.includes('account suspended') ||
    lower.includes('service unavailable') ||
    lower.includes('internal server error') ||
    lower.includes('bad gateway') ||
    lower.includes('gateway timeout') ||
    lower.includes('network error') ||
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound')
  );
}

interface FreeModelInfo {
  id: string;
  name: string;
  description?: string;
}

async function fetchFreeModels(apiKey: string, forceRefresh = false): Promise<FreeModelInfo[]> {
  // Check cache first
  try {
    if (!forceRefresh && fs.existsSync(FREE_MODELS_CACHE)) {
      const cached = JSON.parse(fs.readFileSync(FREE_MODELS_CACHE, 'utf-8'));
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        log(`Using cached free models list (${cached.models.length} models)`);
        return cached.models;
      }
    }
  } catch { /* cache miss */ }

  // Fetch from OpenRouter API
  log(forceRefresh ? 'Force-refreshing free models list from OpenRouter...' : 'Fetching free models list from OpenRouter...');
  try {
    const response = await fetch(MODELS_URL, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      log(`Failed to fetch models: ${response.status}`);
      // Fall back to stale cache if available
      try {
        const cached = JSON.parse(fs.readFileSync(FREE_MODELS_CACHE, 'utf-8'));
        return cached.models;
      } catch { return []; }
    }

    const data = await response.json() as {
      data: Array<{ id: string; name: string; description?: string }>;
    };
    const freeModels: FreeModelInfo[] = data.data
      .filter((m) => m.id.endsWith(':free'))
      .map((m) => ({ id: m.id, name: m.name, description: m.description }));

    log(`Found ${freeModels.length} free models`);

    // Cache to file
    try {
      fs.mkdirSync(path.dirname(FREE_MODELS_CACHE), { recursive: true });
      fs.writeFileSync(FREE_MODELS_CACHE, JSON.stringify({
        timestamp: Date.now(),
        models: freeModels,
      }));
    } catch { /* cache write failed, non-fatal */ }

    return freeModels;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error fetching models: ${msg}`);
    // Fall back to stale cache
    try {
      const cached = JSON.parse(fs.readFileSync(FREE_MODELS_CACHE, 'utf-8'));
      return cached.models;
    } catch { return []; }
  }
}

function inferOpenRouterRole(prompt: string): 'default' | 'decision' | 'senior' {
  const p = prompt.toLowerCase();
  if (p.includes('[ateam:decision]')) return 'decision';
  if (p.includes('[ateam:senior_review]')) return 'senior';
  return 'default';
}

function scoreModelForRole(model: FreeModelInfo, role: 'default' | 'decision' | 'senior'): number {
  const text = `${model.id} ${model.name} ${model.description || ''}`.toLowerCase();
  let score = 0;

  const hasAny = (keywords: string[]): boolean => keywords.some((k) => text.includes(k));

  const highEndSignals = [
    '405b', '120b', '90b', '80b', '72b', '70b', '34b', '32b', '27b', '24b',
    'pro', 'reasoning', 'deep', 'large', 'r1',
  ];
  const lowEndSignals = [
    'mini', 'small', 'lite', 'flash', '8b', '7b', '3b', '1.5b', '1b', '2b',
  ];

  if (role === 'decision') {
    if (hasAny(highEndSignals)) score += 4;
    if (text.includes('coder')) score += 2;
    if (hasAny(lowEndSignals)) score -= 2;
  } else if (role === 'senior') {
    if (hasAny(lowEndSignals)) score += 3;
    if (text.includes('flash') || text.includes('lite')) score += 2;
    if (hasAny(highEndSignals)) score -= 1;
    if (text.includes('coder')) score += 1;
  } else {
    if (text.includes('coder')) score += 1;
    if (hasAny(['70b', '24b', '32b', '27b'])) score += 1;
  }

  return score;
}

function selectFreeModel(
  requested: string | undefined,
  freeModels: FreeModelInfo[],
  role: 'default' | 'decision' | 'senior',
): string {
  // If user requested a specific model, try to find its :free variant
  if (requested && requested !== 'openrouter/auto') {
    // Already a free model
    if (requested.endsWith(':free')) {
      if (freeModels.some((m) => m.id === requested)) return requested;
    }
    // Try appending :free
    const freeVariant = requested + ':free';
    if (freeModels.some((m) => m.id === freeVariant)) return freeVariant;
    // Check if the exact ID exists as free (some IDs may not follow :free pattern)
    if (freeModels.some((m) => m.id === requested)) return requested;
    log(`Requested model ${requested} not found as free, falling back to default`);
  }

  // Pick role-aware defaults (ordered by expected reliability)
  const rolePreferred =
    role === 'decision'
      ? [
          'nousresearch/hermes-3-llama-3.1-405b:free',
          'meta-llama/llama-3.3-70b-instruct:free',
          'openai/gpt-oss-120b:free',
          'mistralai/mistral-small-3.1-24b-instruct:free',
          'qwen/qwen3-next-80b-a3b-instruct:free',
        ]
      : role === 'senior'
        ? [
            'google/gemma-3-12b-it:free',
            'google/gemini-2.5-flash:free',
            'google/gemma-3-27b-it:free',
            'mistralai/mistral-small-3.1-24b-instruct:free',
          ]
        : [];
  for (const p of rolePreferred) {
    if (freeModels.some((m) => m.id === p)) return p;
  }

  // Pick a good default from free models (ordered by tool-use reliability)
  const preferred = [
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'qwen/qwen3-coder:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-3-12b-it:free',
    'openai/gpt-oss-120b:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
  ];
  for (const p of preferred) {
    if (freeModels.some((m) => m.id === p)) return p;
  }

  // Role-aware scoring fallback using model id/name/description.
  if (freeModels.length > 0) {
    const sorted = [...freeModels]
      .map((m) => ({ model: m, score: scoreModelForRole(m, role) }))
      .sort((a, b) => b.score - a.score);
    if (sorted.length > 0) return sorted[0].model.id;
  }

  // Just pick the first available free model
  if (freeModels.length > 0) return freeModels[0].id;

  // Absolute fallback
  return 'google/gemini-2.5-flash:free';
}

function buildModelsToTry(
  requestedModel: string | undefined,
  freeModels: FreeModelInfo[],
  role: 'default' | 'decision' | 'senior',
  skip: Set<string>,
): string[] {
  if (freeModels.length === 0) return [];
  let primary = selectFreeModel(requestedModel, freeModels, role);
  if (skip.has(primary) || getModelCooldownMs(primary)) {
    const replacement = freeModels
      .map((m) => m.id)
      .find((id) => !skip.has(id) && !getModelCooldownMs(id));
    if (replacement) primary = replacement;
  }

  const fallbacks = freeModels
    .map((m) => m.id)
    .filter((id) => id !== primary)
    .filter((id) => !skip.has(id))
    .filter((id) => !getModelCooldownMs(id))
    .slice(0, 3);

  return [primary, ...fallbacks].filter((id, idx, arr) => !!id && arr.indexOf(id) === idx);
}

export async function runOpenRouterFallback(input: OpenRouterInput): Promise<ContainerOutput> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    updateWorkerStatus('openrouter', 'error', { error: 'OPENROUTER_API_KEY not set' });
    return { status: 'error', result: null, error: 'OPENROUTER_API_KEY not set' };
  }

  const cooldownMs = getWorkerCooldownMs('openrouter');
  if (cooldownMs) {
    const msg = `openrouter_provider_cooldown: retry in ${Math.ceil(cooldownMs / 1000)}s`;
    log(msg);
    return { status: 'error', result: null, error: msg };
  }

  const freeModels = await fetchFreeModels(apiKey);
  const role = inferOpenRouterRole(input.prompt);
  // Detect if this is a direct WhatsApp conversation (primary handler) vs worker delegation
  const isDirect = input.prompt.trimStart().startsWith('<messages>');
  const systemPrompt = loadSystemPrompt(isDirect);
  const ctx = {
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    allowProactiveMessage: !isDirect,
    runId: input.runId,
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: input.prompt },
  ];

  // Build a list of models to try (primary + fallbacks)
  const triedModels = new Set<string>();
  let modelsToTry = buildModelsToTry(input.model, freeModels, role, triedModels);

  for (const model of modelsToTry) {
    triedModels.add(model);
    const result = await tryModel(model, messages, ctx, apiKey, input.prompt);
    if (result.status === 'success') return result;
    if (result.error && !result.error.includes('404') && !result.error.includes('rate_limit') && !result.error.includes('429')) {
      // Non-retriable error
      return result;
    }
    log(`Model ${model} failed, trying next...`);
  }

  // If all cached candidates failed, refetch model list once and retry with any newly available models.
  const refreshedModels = await fetchFreeModels(apiKey, true);
  const secondPass = buildModelsToTry(input.model, refreshedModels, role, triedModels);
  if (secondPass.length > 0) {
    log(`Retrying OpenRouter with refreshed model list (${secondPass.length} candidates)`);
    modelsToTry = [...modelsToTry, ...secondPass];
    for (const model of secondPass) {
      triedModels.add(model);
      const result = await tryModel(model, messages, ctx, apiKey, input.prompt);
      if (result.status === 'success') return result;
      if (result.error && !result.error.includes('404') && !result.error.includes('rate_limit') && !result.error.includes('429')) {
        return result;
      }
      log(`Model ${model} failed after refresh, trying next...`);
    }
  }

  return { status: 'error', result: null, error: `All free models failed. Tried: ${[...triedModels].join(', ')}` };
}

async function tryModel(
  model: string,
  messages: ChatMessage[],
  ctx: { chatJid: string; groupFolder: string; isMain: boolean; allowProactiveMessage: boolean; runId?: string },
  apiKey: string,
  prompt: string,
): Promise<ContainerOutput> {
  log(`Starting OpenRouter agent loop (model: ${model})`);
  const modelStartedAt = Date.now();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (Date.now() - modelStartedAt > OPENROUTER_SESSION_HARD_TIMEOUT_MS) {
      return {
        status: 'error',
        result: null,
        error: `openrouter hard timeout after ${OPENROUTER_SESSION_HARD_TIMEOUT_MS}ms`,
      };
    }

    let data: OpenRouterResponse;
    let timedOutByIdle = false;
    let timedOutByHardLimit = false;
    try {
      const controller = new AbortController();
      const requestHardTimeout = setTimeout(() => {
        timedOutByHardLimit = true;
        controller.abort();
      }, OPENROUTER_REQUEST_HARD_TIMEOUT_MS);

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          tools: toolDefinitions,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader
          ? (isNaN(Number(retryAfterHeader))
            ? Math.max(0, new Date(retryAfterHeader).getTime() - Date.now())
            : Number(retryAfterHeader) * 1000)
          : undefined;
        const limit = response.headers.get('x-ratelimit-limit') || undefined;
        const remaining = response.headers.get('x-ratelimit-remaining') || undefined;
        const reset = response.headers.get('x-ratelimit-reset') || undefined;
        if (response.status === 429) {
          updateModelStatus(model, 'rate_limited', { error: text, retryAfterMs, limit, remaining, reset });
        } else if (response.status === 404) {
          updateModelStatus(model, 'error', { error: text, cooldownMs: 24 * 60 * 60 * 1000 });
        } else if (response.status >= 500) {
          updateModelStatus(model, 'error', { error: text, cooldownMs: 10 * 60 * 1000 });
        }
        if (isOpenRouterProviderWideStatus(response.status)) {
          updateWorkerStatus('openrouter', 'error', {
            model,
            error: text,
            cooldownMs: 2 * 60 * 1000,
            limit,
            remaining,
            reset,
          });
        }
        log(`OpenRouter API error ${response.status}: ${text}`);
        return { status: 'error', result: null, error: `${response.status}: ${text}` };
      }

      if (!response.body) {
        return { status: 'error', result: null, error: 'OpenRouter returned empty stream body' };
      }

      const limit = response.headers.get('x-ratelimit-limit') || undefined;
      const remaining = response.headers.get('x-ratelimit-remaining') || undefined;
      const reset = response.headers.get('x-ratelimit-reset') || undefined;
      if (limit || remaining || reset) {
        updateModelStatus(model, 'ok', { limit, remaining, reset });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastStreamActivityMs = Date.now();
      const contentParts: string[] = [];
      const toolCallMap = new Map<number, ToolCall>();
      let finishReason = 'stop';
      let streamError: string | null = null;

      const idleGuard = setInterval(() => {
        if (Date.now() - lastStreamActivityMs > OPENROUTER_IDLE_TIMEOUT_MS) {
          timedOutByIdle = true;
          controller.abort();
        }
      }, 1000);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;

          lastStreamActivityMs = Date.now();
          buffer += decoder.decode(value, { stream: true });

          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (!line || !line.startsWith('data:')) {
              newlineIndex = buffer.indexOf('\n');
              continue;
            }

            const payload = line.slice(5).trim();
            if (!payload) {
              newlineIndex = buffer.indexOf('\n');
              continue;
            }
            if (payload === '[DONE]') {
              newlineIndex = -1;
              break;
            }

            try {
              const chunk = JSON.parse(payload) as {
                error?: { message?: string };
                choices?: Array<{
                  delta?: {
                    content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      type?: 'function';
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string | null;
                }>;
              };
              if (chunk.error?.message) {
                streamError = chunk.error.message;
                newlineIndex = -1;
                break;
              }
              const choice = chunk.choices?.[0];
              const delta = choice?.delta;
              if (choice?.finish_reason) finishReason = choice.finish_reason;
              if (delta?.content) contentParts.push(delta.content);
              if (Array.isArray(delta?.tool_calls)) {
                for (const toolCallPart of delta.tool_calls) {
                  const idx = toolCallPart.index ?? 0;
                  const existing = toolCallMap.get(idx) || {
                    id: toolCallPart.id || `tool_${idx}`,
                    type: 'function' as const,
                    function: { name: '', arguments: '' },
                  };
                  if (toolCallPart.id) existing.id = toolCallPart.id;
                  if (toolCallPart.function?.name) {
                    existing.function.name += toolCallPart.function.name;
                  }
                  if (toolCallPart.function?.arguments) {
                    existing.function.arguments += toolCallPart.function.arguments;
                  }
                  toolCallMap.set(idx, existing);
                }
              }
            } catch {
              // Ignore malformed stream chunks.
            }

            newlineIndex = buffer.indexOf('\n');
          }
        }
      } finally {
        clearInterval(idleGuard);
        clearTimeout(requestHardTimeout);
      }

      if (streamError) {
        data = {
          choices: [],
          error: { message: streamError },
        };
      } else {
        const toolCalls = [...toolCallMap.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, value]) => value);
        data = {
          choices: [
            {
              message: {
                content: contentParts.join('') || null,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: finishReason,
            },
          ],
        };
      }

    } catch (err) {
      if (timedOutByIdle) {
        const msg = `openrouter idle timeout after ${OPENROUTER_IDLE_TIMEOUT_MS}ms`;
        log(msg);
        return { status: 'error', result: null, error: msg };
      }
      if (timedOutByHardLimit) {
        const msg = `openrouter hard timeout after ${OPENROUTER_REQUEST_HARD_TIMEOUT_MS}ms`;
        log(msg);
        return { status: 'error', result: null, error: msg };
      }
      const msg = err instanceof Error ? err.message : String(err);
      log(`OpenRouter fetch error: ${msg}`);
      if (isOpenRouterProviderWideMessage(msg)) {
        updateWorkerStatus('openrouter', 'error', {
          model,
          error: msg,
          cooldownMs: 2 * 60 * 1000,
        });
      }
      return { status: 'error', result: null, error: msg };
    }

    if (data.error) {
      log(`OpenRouter API error: ${data.error.message}`);
      if (data.error.message?.toLowerCase().includes('rate') || data.error.message?.includes('429')) {
        updateModelStatus(model, 'rate_limited', { error: data.error.message, retryAfterMs: 60000 });
      } else if (isOpenRouterProviderWideMessage(data.error.message || '')) {
        updateWorkerStatus('openrouter', 'error', {
          model,
          error: data.error.message,
          cooldownMs: 2 * 60 * 1000,
        });
      }
      return { status: 'error', result: null, error: data.error.message };
    }

    const choice = data.choices?.[0];
    if (!choice) {
      log('No choices in OpenRouter response');
      return { status: 'error', result: null, error: 'Empty OpenRouter response' };
    }

    const assistantMessage = choice.message;
    const toolCalls = assistantMessage.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // Final text response
      const result = assistantMessage.content || null;
      log(`OpenRouter completed after ${i + 1} iterations (model: ${model})`);
      updateModelStatus(model, 'ok', {});
      appendSharedContextRecord({
        source: model,
        prompt,
        result: assistantMessage.content || '',
        group: ctx.groupFolder,
      });
      return { status: 'success', result, modelUsed: model, provider: 'openrouter' };
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: assistantMessage.content ?? undefined,
      tool_calls: toolCalls,
    });

    // Execute each tool call and add results
    for (const toolCall of toolCalls) {
      const fnName = toolCall.function.name;
      log(`Tool call: ${fnName}`);

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        log(`Failed to parse tool args for ${fnName}`);
      }

      const resultWithSource = executeSharedTool(fnName, args, {
        ...ctx,
        sourceTag: `openrouter:${model}`,
      });
      const truncated =
        resultWithSource.length > 10000
          ? resultWithSource.slice(0, 10000) + '\n...(truncated)'
          : resultWithSource;

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: truncated,
      });
    }
  }

  log('Max iterations reached');
  return { status: 'error', result: null, error: 'OpenRouter agent reached max iterations' };
}
