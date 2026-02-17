/**
 * OpenRouter Fallback Agent for NanoClaw
 * Uses OpenRouter's free models (OpenAI-compatible API) as a delegation target.
 * Provides the same tools as the Gemini fallback (bash, file ops, IPC messaging).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MAX_ITERATIONS = 15;
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
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
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

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
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
      '',
      'You have tools: bash, read_file, write_file, list_files, send_message, schedule_task.',
      'Work directory: /workspace/group/',
      '',
      '- Respond naturally as a personal assistant',
      '- Use send_message for long tasks to keep the user informed',
      '- Do NOT delegate to other workers or call gemini-worker/openrouter-worker',
      '- Do NOT read .usage.json — you are already handling this because Claude is unavailable',
    );
  } else {
    // Worker mode: Claude delegated a specific task
    parts.push(
      '## WORKER MODE — READ THIS FIRST',
      'You are an OpenRouter worker. Claude delegated a specific task to you.',
      'Execute the task in the user prompt and return the result. That\'s it.',
      '- Do NOT read .usage.json or PROJECT_STATE.md',
      '- Do NOT delegate to other workers or call gemini-worker/openrouter-worker',
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
];

function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { chatJid: string; groupFolder: string; isMain: boolean },
): string {
  try {
    switch (name) {
      case 'bash': {
        const cmd = args.command as string;
        log(`bash: ${cmd.slice(0, 100)}`);
        const output = execSync(cmd, {
          cwd: '/workspace/group',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output || '(no output)';
      }

      case 'read_file': {
        const filePath = args.path as string;
        if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
        return fs.readFileSync(filePath, 'utf-8');
      }

      case 'write_file': {
        const filePath = args.path as string;
        const content = args.content as string;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return `Written to ${filePath}`;
      }

      case 'list_files': {
        const dirPath = args.path as string;
        if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`;
        const recursive = args.recursive as boolean;
        if (recursive) {
          const result: string[] = [];
          const walk = (dir: string, prefix: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), rel);
              } else {
                result.push(rel);
              }
            }
          };
          walk(dirPath, '');
          return result.join('\n') || '(empty directory)';
        }
        const entries = fs.readdirSync(dirPath);
        return entries.join('\n') || '(empty directory)';
      }

      case 'send_message': {
        const text = args.text as string;
        writeIpcFile(MESSAGES_DIR, {
          type: 'message',
          chatJid: ctx.chatJid,
          text,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return 'Message queued for delivery.';
      }

      case 'schedule_task': {
        writeIpcFile(TASKS_DIR, {
          type: 'schedule_task',
          prompt: args.prompt as string,
          schedule_type: args.schedule_type as string,
          schedule_value: args.schedule_value as string,
          context_mode: (args.context_mode as string) || 'group',
          groupFolder: ctx.groupFolder,
          chatJid: ctx.chatJid,
          timestamp: new Date().toISOString(),
        });
        return 'Task scheduled.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Tool error (${name}): ${msg}`);
    return `Error: ${msg}`;
  }
}

const WORKER_STATUS_FILE = '/workspace/group/ai/.worker-status.json';

function updateWorkerStatus(worker: string, status: 'ok' | 'rate_limited' | 'error', details: {
  model?: string;
  error?: string;
  retryAfterMs?: number;
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
    };
    fs.mkdirSync(path.dirname(WORKER_STATUS_FILE), { recursive: true });
    fs.writeFileSync(WORKER_STATUS_FILE, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal */ }
}

interface FreeModelInfo {
  id: string;
  name: string;
}

async function fetchFreeModels(apiKey: string): Promise<FreeModelInfo[]> {
  // Check cache first
  try {
    if (fs.existsSync(FREE_MODELS_CACHE)) {
      const cached = JSON.parse(fs.readFileSync(FREE_MODELS_CACHE, 'utf-8'));
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        log(`Using cached free models list (${cached.models.length} models)`);
        return cached.models;
      }
    }
  } catch { /* cache miss */ }

  // Fetch from OpenRouter API
  log('Fetching free models list from OpenRouter...');
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

    const data = await response.json() as { data: Array<{ id: string; name: string }> };
    const freeModels: FreeModelInfo[] = data.data
      .filter((m) => m.id.endsWith(':free'))
      .map((m) => ({ id: m.id, name: m.name }));

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

function selectFreeModel(requested: string | undefined, freeModels: FreeModelInfo[]): string {
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

  // Just pick the first available free model
  if (freeModels.length > 0) return freeModels[0].id;

  // Absolute fallback
  return 'google/gemini-2.5-flash:free';
}

export async function runOpenRouterFallback(input: OpenRouterInput): Promise<ContainerOutput> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    updateWorkerStatus('openrouter', 'error', { error: 'OPENROUTER_API_KEY not set' });
    return { status: 'error', result: null, error: 'OPENROUTER_API_KEY not set' };
  }

  const freeModels = await fetchFreeModels(apiKey);
  // Detect if this is a direct WhatsApp conversation (primary handler) vs worker delegation
  const isDirect = input.prompt.trimStart().startsWith('<messages>');
  const systemPrompt = loadSystemPrompt(isDirect);
  const ctx = { chatJid: input.chatJid, groupFolder: input.groupFolder, isMain: input.isMain };

  // Build a list of models to try (primary + fallbacks)
  const primary = selectFreeModel(input.model, freeModels);
  const fallbacks = freeModels
    .map((m) => m.id)
    .filter((id) => id !== primary)
    .slice(0, 3);

  const modelsToTry = [primary, ...fallbacks];

  for (const model of modelsToTry) {
    const result = await tryModel(model, systemPrompt, input.prompt, ctx, apiKey);
    if (result.status === 'success') return result;
    if (result.error && !result.error.includes('404') && !result.error.includes('rate_limit') && !result.error.includes('429')) {
      // Non-retriable error
      return result;
    }
    log(`Model ${model} failed, trying next...`);
  }

  updateWorkerStatus('openrouter', 'rate_limited', {
    error: `All free models failed: ${modelsToTry.join(', ')}`,
    retryAfterMs: 300000,  // 5 min cooldown
  });
  return { status: 'error', result: null, error: `All free models failed. Tried: ${modelsToTry.join(', ')}` };
}

async function tryModel(
  model: string,
  systemPrompt: string,
  prompt: string,
  ctx: { chatJid: string; groupFolder: string; isMain: boolean },
  apiKey: string,
): Promise<ContainerOutput> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  log(`Starting OpenRouter agent loop (model: ${model})`);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let data: OpenRouterResponse;
    try {
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
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        log(`OpenRouter API error ${response.status}: ${text}`);
        return { status: 'error', result: null, error: `${response.status}: ${text}` };
      }

      data = await response.json() as OpenRouterResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`OpenRouter fetch error: ${msg}`);
      return { status: 'error', result: null, error: msg };
    }

    if (data.error) {
      log(`OpenRouter API error: ${data.error.message}`);
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
      updateWorkerStatus('openrouter', 'ok', { model });
      return { status: 'success', result };
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

      const result = executeTool(fnName, args, ctx);
      const truncated = result.length > 10000 ? result.slice(0, 10000) + '\n...(truncated)' : result;

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
