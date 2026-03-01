/**
 * Gemini Fallback Agent for NanoClaw
 * Uses Gemini 2.5 Flash as a tool-use agent when Claude quota is exhausted.
 * Provides the same tools as the Claude agent (bash, file ops, IPC messaging).
 */

import { GoogleGenAI, Type } from '@google/genai';
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { executeSharedTool } from './tool-utils.js';
import {
  appendSharedContextRecord,
  buildSharedContextPrompt,
} from './context-store.js';

const MAX_ITERATIONS = 15;
const GEMINI_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 90000);
const GEMINI_HARD_TIMEOUT_MS = Number(process.env.GEMINI_HARD_TIMEOUT_MS || 360000);
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS_CACHE = '/workspace/group/ai/.gemini-models.json';
const GEMINI_MODELS_CACHE_TTL_MS = Number(
  process.env.GEMINI_MODELS_CACHE_TTL_MS || 6 * 60 * 60 * 1000,
);

interface GeminiInput {
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

interface GeminiModelsResponse {
  models?: Array<{
    name?: string;
    supportedGenerationMethods?: string[];
  }>;
}

function log(message: string): void {
  console.error(`[gemini-fallback] ${message}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function stripOrchestration(content: string): string {
  // Remove sections meant for Claude orchestration, not workers
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
      'You have tools: bash, read_file, write_file, list_files, send_message, schedule_task, delegate_to_claude, delegate_to_openrouter, delegate_to_local.',
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
      'You are a Gemini worker. Claude delegated a specific task to you.',
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

  // Load group context (personality, memory, formatting) but strip orchestration
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

const toolDeclarations: FunctionDeclaration[] = [
  {
    name: 'bash',
    description: 'Execute a bash command and return its output. Working directory is /workspace/group/.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: 'The bash command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Absolute path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating directories as needed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Absolute path to the file' },
        content: { type: Type.STRING, description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory. Returns filenames.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Directory path to list' },
        recursive: { type: Type.BOOLEAN, description: 'If true, list recursively' },
      },
      required: ['path'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to the current WhatsApp chat. Use this for proactive updates.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'Message text to send' },
      },
      required: ['text'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a recurring or one-time task.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'What the agent should do when the task runs' },
        schedule_type: { type: Type.STRING, description: 'cron, interval, or once' },
        schedule_value: { type: Type.STRING, description: 'Cron expression, milliseconds, or ISO timestamp' },
        context_mode: { type: Type.STRING, description: 'group or isolated' },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
  },
  {
    name: 'delegate_to_claude',
    description: 'Delegate a complex task to Claude for execution.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'The task for Claude' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'delegate_to_openrouter',
    description: 'Delegate a task to OpenRouter for execution.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'The task for OpenRouter' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'delegate_to_local',
    description: 'Delegate a low-risk coding subtask to local fallback model.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'The low-risk subtask for local model' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'delegate_to_phi3',
    description: 'Backward-compatible alias of delegate_to_local.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'The low-risk subtask for local model' },
      },
      required: ['prompt'],
    },
  },
];

const WORKER_STATUS_FILE = '/workspace/group/ai/.worker-status.json';

function getWorkerCooldownMs(worker: string): number | null {
  try {
    if (!fs.existsSync(WORKER_STATUS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(WORKER_STATUS_FILE, 'utf-8'));
    const entry = data?.[worker];
    const retryAt = entry?.retry_after || entry?.cooldown_until;
    if (!retryAt) return null;
    const retryMs = new Date(retryAt).getTime() - Date.now();
    return retryMs > 0 ? retryMs : null;
  } catch {
    return null;
  }
}

function getModelCooldownMs(model: string): number | null {
  try {
    if (!fs.existsSync(WORKER_STATUS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(WORKER_STATUS_FILE, 'utf-8'));
    const entry = data?.gemini_models?.[model];
    const retryAt = entry?.retry_after || entry?.cooldown_until;
    if (!retryAt) return null;
    const retryMs = new Date(retryAt).getTime() - Date.now();
    return retryMs > 0 ? retryMs : null;
  } catch {
    return null;
  }
}

function updateModelStatus(model: string, status: 'ok' | 'rate_limited' | 'error', details: {
  error?: string;
  retryAfterMs?: number;
  cooldownMs?: number;
}): void {
  try {
    let existing: Record<string, any> = {};
    if (fs.existsSync(WORKER_STATUS_FILE)) {
      existing = JSON.parse(fs.readFileSync(WORKER_STATUS_FILE, 'utf-8'));
    }
    const now = new Date().toISOString();
    const models = existing.gemini_models || {};
    models[model] = {
      status,
      error: details.error?.slice(0, 200),
      updated_at: now,
      ...(status === 'ok' ? { last_success: now } : {}),
      ...(status === 'rate_limited'
        ? {
            retry_after: new Date(
              Date.now() + (details.retryAfterMs || 60000),
            ).toISOString(),
          }
        : {}),
      ...(details.cooldownMs
        ? {
            cooldown_until: new Date(
              Date.now() + details.cooldownMs,
            ).toISOString(),
          }
        : {}),
    };
    existing.gemini_models = models;
    fs.mkdirSync(path.dirname(WORKER_STATUS_FILE), { recursive: true });
    fs.writeFileSync(WORKER_STATUS_FILE, JSON.stringify(existing, null, 2));
  } catch {
    // non-fatal
  }
}

function updateWorkerStatus(worker: string, status: 'ok' | 'rate_limited' | 'error', details: {
  model?: string;
  error?: string;
  retryAfterMs?: number;
  cooldownMs?: number;
}): void {
  try {
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(WORKER_STATUS_FILE)) {
      existing = JSON.parse(fs.readFileSync(WORKER_STATUS_FILE, 'utf-8'));
    }
    const now = new Date().toISOString();
    existing[worker] = {
      status,
      model: details.model,
      error: details.error?.slice(0, 200),
      updated_at: now,
      ...(status === 'ok' ? { last_success: now } : {}),
      ...(status === 'rate_limited' ? {
        retry_after: new Date(Date.now() + (details.retryAfterMs || 60000)).toISOString(),
      } : {}),
      ...(details.cooldownMs ? {
        cooldown_until: new Date(Date.now() + details.cooldownMs).toISOString(),
      } : {}),
    };
    fs.mkdirSync(path.dirname(WORKER_STATUS_FILE), { recursive: true });
    fs.writeFileSync(WORKER_STATUS_FILE, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal */ }
}

function isGeminiProviderWideError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('api key') ||
    lower.includes('invalid key') ||
    lower.includes('permission denied') ||
    lower.includes('unauthenticated') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('billing') ||
    lower.includes('quota project') ||
    lower.includes('service unavailable') ||
    lower.includes('internal server error') ||
    lower.includes('backend error') ||
    lower.includes('network error') ||
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound')
  );
}

function normalizeGeminiModelId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

function scoreGeminiModelForRole(model: string, role: 'default' | 'decision' | 'senior'): number {
  const text = model.toLowerCase();
  let score = 0;

  if (role === 'decision') {
    if (text.includes('pro')) score += 4;
    if (text.includes('flash')) score += 1;
    if (text.includes('lite')) score -= 2;
    if (text.includes('preview')) score += 1;
  } else if (role === 'senior') {
    if (text.includes('flash')) score += 3;
    if (text.includes('lite')) score += 2;
    if (text.includes('pro')) score -= 1;
  } else {
    if (text.includes('flash')) score += 2;
    if (text.includes('lite')) score += 1;
    if (text.includes('pro')) score += 1;
  }

  return score;
}

async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  try {
    if (fs.existsSync(GEMINI_MODELS_CACHE)) {
      const cached = JSON.parse(fs.readFileSync(GEMINI_MODELS_CACHE, 'utf-8')) as {
        timestamp?: number;
        models?: string[];
      };
      if (
        typeof cached.timestamp === 'number' &&
        Array.isArray(cached.models) &&
        Date.now() - cached.timestamp < GEMINI_MODELS_CACHE_TTL_MS
      ) {
        log(`Using cached Gemini models list (${cached.models.length} models)`);
        return cached.models;
      }
    }
  } catch {
    // Cache miss/corruption is non-fatal.
  }

  log('Fetching Gemini models list...');
  try {
    const url = `${GEMINI_MODELS_URL}?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);
    if (!response.ok) {
      log(`Failed to fetch Gemini models: ${response.status}`);
      try {
        const stale = JSON.parse(fs.readFileSync(GEMINI_MODELS_CACHE, 'utf-8')) as {
          models?: string[];
        };
        if (Array.isArray(stale.models)) return stale.models;
      } catch {
        // Ignore stale cache read errors.
      }
      return [];
    }

    const data = (await response.json()) as GeminiModelsResponse;
    const models = (data.models || [])
      .filter((m) => {
        const methods = m.supportedGenerationMethods || [];
        return methods.length === 0 || methods.includes('generateContent');
      })
      .map((m) => normalizeGeminiModelId(m.name || ''))
      .filter((m) => m.startsWith('gemini-'));

    const unique = [...new Set(models)];
    log(`Found ${unique.length} Gemini models`);

    try {
      fs.mkdirSync(path.dirname(GEMINI_MODELS_CACHE), { recursive: true });
      fs.writeFileSync(
        GEMINI_MODELS_CACHE,
        JSON.stringify({ timestamp: Date.now(), models: unique }, null, 2),
      );
    } catch {
      // Cache write failures are non-fatal.
    }

    return unique;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error fetching Gemini models: ${msg}`);
    try {
      const stale = JSON.parse(fs.readFileSync(GEMINI_MODELS_CACHE, 'utf-8')) as {
        models?: string[];
      };
      if (Array.isArray(stale.models)) return stale.models;
    } catch {
      // Ignore stale cache read errors.
    }
    return [];
  }
}

export async function runGeminiFallback(input: GeminiInput): Promise<ContainerOutput> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    updateWorkerStatus('gemini', 'error', { error: 'GEMINI_API_KEY not set' });
    return { status: 'error', result: null, error: 'GEMINI_API_KEY not set' };
  }

  const workerCooldownMs = getWorkerCooldownMs('gemini');
  if (workerCooldownMs) {
    const msg = `gemini_provider_cooldown: retry in ${Math.ceil(workerCooldownMs / 1000)}s`;
    log(msg);
    return { status: 'error', result: null, error: msg };
  }

  const ai = new GoogleGenAI({ apiKey });
  const discoveredModels = await fetchGeminiModels(apiKey);
  // Detect if this is a direct WhatsApp conversation (primary handler) vs worker delegation
  const isDirect = input.prompt.trimStart().startsWith('<messages>');
  const systemPrompt = loadSystemPrompt(isDirect);
  const ctx = {
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    allowProactiveMessage: !isDirect,
    runId: input.runId,
  } as const;
  const lowerPrompt = input.prompt.toLowerCase();
  const role =
    lowerPrompt.includes('[ateam:decision]')
      ? 'decision'
      : lowerPrompt.includes('[ateam:senior_review]')
        ? 'senior'
        : 'default';
  const defaultModelCandidates =
    role === 'decision'
      ? [
          'gemini-3-pro-preview',
          'gemini-2.5-pro',
          'gemini-3-flash-preview',
          'gemini-2.5-flash',
          'gemini-2.5-flash-lite',
        ]
      : role === 'senior'
        ? [
            'gemini-2.5-flash-lite',
            'gemini-2.5-flash',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-3-pro-preview',
          ]
        : [
            'gemini-3-flash-preview',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.5-pro',
            'gemini-3-pro-preview',
          ];
  const envCandidates = process.env.GEMINI_MODEL_CANDIDATES
    ? process.env.GEMINI_MODEL_CANDIDATES.split(',').map((m) => m.trim()).filter(Boolean)
    : [];

  const normalizedDiscovered = discoveredModels.map(normalizeGeminiModelId).filter(Boolean);
  const baselineCandidates = envCandidates.length > 0 ? envCandidates : defaultModelCandidates;
  const normalizedBaseline = baselineCandidates.map(normalizeGeminiModelId).filter(Boolean);

  const discoveredRanked = [...normalizedDiscovered]
    .sort((a, b) => scoreGeminiModelForRole(b, role) - scoreGeminiModelForRole(a, role));

  const discoveredPreferred = discoveredRanked.filter((m) => normalizedBaseline.includes(m));
  const discoveredFallback = discoveredRanked.filter((m) => !normalizedBaseline.includes(m));

  const modelCandidates = [
    ...(input.model ? [normalizeGeminiModelId(input.model)] : []),
    ...normalizedBaseline,
    ...discoveredPreferred,
    ...discoveredFallback,
  ].filter((m, i, arr) => !!m && arr.indexOf(m) === i);

  const baseContents: Content[] = [
    { role: 'user', parts: [{ text: input.prompt }] },
  ];

  let attemptedAtLeastOneModel = false;
  const startedAt = Date.now();
  for (const model of modelCandidates) {
    const modelCooldownMs = getModelCooldownMs(model);
    if (modelCooldownMs) {
      log(`Skipping cooldown model ${model} (${Math.ceil(modelCooldownMs / 1000)}s remaining)`);
      continue;
    }
    attemptedAtLeastOneModel = true;
    log(`Starting Gemini agent loop (model: ${model})`);
    const contents: Content[] = [...baseContents];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (Date.now() - startedAt > GEMINI_HARD_TIMEOUT_MS) {
        const msg = `gemini hard timeout after ${GEMINI_HARD_TIMEOUT_MS}ms`;
        log(msg);
        return { status: 'error', result: null, error: msg };
      }
      let response;
      try {
        response = await withTimeout(
          ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: systemPrompt,
              tools: [{ functionDeclarations: toolDeclarations }],
            },
          }),
          GEMINI_REQUEST_TIMEOUT_MS,
          'gemini request timeout',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Gemini API error: ${msg}`);
        if (msg.includes('429') || msg.toLowerCase().includes('rate')) {
          // Parse retry delay from error if available
          const retryMatch = msg.match(/retry\s+in\s+([\d.]+)s/i);
          const retryMs = retryMatch ? parseFloat(retryMatch[1]) * 1000 : 60000;
          updateModelStatus(model, 'rate_limited', { error: msg, retryAfterMs: retryMs });
          // Switch to next model while preserving context so work can continue
          break;
        }
        // If the model is unavailable, try the next candidate
        if (
          msg.toLowerCase().includes('model') &&
          (msg.toLowerCase().includes('not found') ||
            msg.toLowerCase().includes('unavailable') ||
            msg.includes('404'))
        ) {
          updateModelStatus(model, 'error', { error: msg, cooldownMs: 60 * 60 * 1000 });
          break;
        }

        if (isGeminiProviderWideError(msg)) {
          updateWorkerStatus('gemini', 'error', {
            model,
            error: msg,
            cooldownMs: 2 * 60 * 1000,
          });
          return { status: 'error', result: null, error: msg };
        }

        updateModelStatus(model, 'error', { error: msg, cooldownMs: 5 * 60 * 1000 });
        break;
      }

      const candidate = response.candidates?.[0];
      if (!candidate?.content?.parts) {
        log('No content in Gemini response');
        return { status: 'error', result: null, error: 'Empty Gemini response' };
      }

      const parts = candidate.content.parts;

      // Check for function calls
      const functionCalls = parts.filter((p: Part) => p.functionCall);

      if (functionCalls.length === 0) {
        // Final text response
        const textParts = parts
          .filter((p: Part) => p.text)
          .map((p: Part) => p.text as string);
        const result = textParts.join('');
        log(`Gemini completed after ${i + 1} iterations`);
        updateModelStatus(model, 'ok', {});
        const source = `${model}`;
        appendSharedContextRecord({
          source,
          prompt: input.prompt,
          result: result || '',
          group: input.groupFolder,
        });
        return { status: 'success', result: result || null, modelUsed: model, provider: 'gemini' };
      }

      // Add assistant message with function calls
      contents.push({ role: 'model', parts });

      // Execute each function call and collect results
      const functionResponses: Part[] = [];
      for (const part of functionCalls) {
        const fc = part.functionCall!;
        log(`Tool call: ${fc.name}`);
        const result = executeSharedTool(fc.name!, fc.args || {}, {
          ...ctx,
          sourceTag: `gemini:${model}`,
        });
        // Truncate large results
        const truncated = result.length > 10000 ? result.slice(0, 10000) + '\n...(truncated)' : result;
        functionResponses.push({
          functionResponse: { name: fc.name!, response: { result: truncated } },
        });
      }

      // Feed results back
      contents.push({ role: 'user', parts: functionResponses });
    }
  }

  if (!attemptedAtLeastOneModel) {
    const msg = 'gemini_rate_limit_cached: all candidate models currently in cooldown';
    log(msg);
    return { status: 'error', result: null, error: msg };
  }

  log('Max iterations reached or all models failed');
  updateWorkerStatus('gemini', 'error', { error: 'Max iterations reached' });
  return { status: 'error', result: null, error: 'Gemini agent reached max iterations' };
}
