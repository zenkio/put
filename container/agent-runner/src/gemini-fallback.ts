/**
 * Gemini Fallback Agent for NanoClaw
 * Uses Gemini 2.5 Flash as a tool-use agent when Claude quota is exhausted.
 * Provides the same tools as the Claude agent (bash, file ops, IPC messaging).
 */

import { GoogleGenAI, Type } from '@google/genai';
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MAX_ITERATIONS = 15;

interface GeminiInput {
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

function log(message: string): void {
  console.error(`[gemini-fallback] ${message}`);
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
      'You are a Gemini worker. Claude delegated a specific task to you.',
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

  // Load group context (personality, memory, formatting) but strip orchestration
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

export async function runGeminiFallback(input: GeminiInput): Promise<ContainerOutput> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    updateWorkerStatus('gemini', 'error', { error: 'GEMINI_API_KEY not set' });
    return { status: 'error', result: null, error: 'GEMINI_API_KEY not set' };
  }

  const ai = new GoogleGenAI({ apiKey });
  // Detect if this is a direct WhatsApp conversation (primary handler) vs worker delegation
  const isDirect = input.prompt.trimStart().startsWith('<messages>');
  const systemPrompt = loadSystemPrompt(isDirect);
  const ctx = { chatJid: input.chatJid, groupFolder: input.groupFolder, isMain: input.isMain };
  const model = input.model || 'gemini-2.5-flash';

  const contents: Content[] = [
    { role: 'user', parts: [{ text: input.prompt }] },
  ];

  log(`Starting Gemini agent loop (model: ${model})`);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: toolDeclarations }],
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Gemini API error: ${msg}`);
      if (msg.includes('429') || msg.toLowerCase().includes('rate')) {
        // Parse retry delay from error if available
        const retryMatch = msg.match(/retry\s+in\s+([\d.]+)s/i);
        const retryMs = retryMatch ? parseFloat(retryMatch[1]) * 1000 : 60000;
        updateWorkerStatus('gemini', 'rate_limited', { model, error: msg, retryAfterMs: retryMs });
        return { status: 'error', result: null, error: `gemini_rate_limit: ${msg}` };
      }
      updateWorkerStatus('gemini', 'error', { model, error: msg });
      return { status: 'error', result: null, error: msg };
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
      updateWorkerStatus('gemini', 'ok', { model });
      return { status: 'success', result: result || null };
    }

    // Add assistant message with function calls
    contents.push({ role: 'model', parts });

    // Execute each function call and collect results
    const functionResponses: Part[] = [];
    for (const part of functionCalls) {
      const fc = part.functionCall!;
      log(`Tool call: ${fc.name}`);
      const result = executeTool(fc.name!, fc.args || {}, ctx);
      // Truncate large results
      const truncated = result.length > 10000 ? result.slice(0, 10000) + '\n...(truncated)' : result;
      functionResponses.push({
        functionResponse: { name: fc.name!, response: { result: truncated } },
      });
    }

    // Feed results back
    contents.push({ role: 'user', parts: functionResponses });
  }

  log('Max iterations reached');
  updateWorkerStatus('gemini', 'error', { model, error: 'Max iterations reached' });
  return { status: 'error', result: null, error: 'Gemini agent reached max iterations' };
}
