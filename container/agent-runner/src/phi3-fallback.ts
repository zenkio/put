/**
 * Phi3 Fallback Agent for NanoClaw
 * Uses phi3:mini via Ollama as a tool-use agent.
 * Provides the same tools as the Claude/Gemini agents, plus delegation tools.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MAX_ITERATIONS = 10;
const OLLAMA_URL = 'http://host.docker.internal:11434/api/chat';

interface Phi3Input {
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
  console.error(`[phi3-fallback] ${message}`);
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

function loadSystemPrompt(isDirect: boolean): string {
  const parts: string[] = [];

  if (isDirect) {
    parts.push(
      '## PRIMARY MODE — You are the main assistant (Phi3)',
      'You are responding directly to a WhatsApp conversation. The user is talking to you.',
      'Be helpful, conversational, and complete.',
      '',
      'You have tools: bash, read_file, write_file, list_files, send_message, schedule_task, delegate_to_claude, delegate_to_gemini, delegate_to_openrouter.',
      'Work directory: /workspace/group/',
      '',
      '- If a task is complex (coding, deep analysis), use delegate_to_claude.',
      '- If you need to search the web or do large-scale processing, use delegate_to_gemini.',
      '- Use send_message to keep the user informed.',
    );
  } else {
    parts.push(
      '## WORKER MODE',
      'You are a Phi3 worker. Execute the task in the user prompt.',
      'Keep responses concise.',
    );
  }

  // Load group context
  const globalPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalPath)) {
    parts.push(fs.readFileSync(globalPath, 'utf-8'));
  }

  const groupPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupPath)) {
    parts.push(fs.readFileSync(groupPath, 'utf-8'));
  }

  return parts.join('\\n\\n');
}

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command and return its output.',
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
    type: 'function',
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
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file.',
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
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
          recursive: { type: 'boolean' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to the current WhatsApp chat.',
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
    type: 'function',
    function: {
      name: 'delegate_to_claude',
      description: 'Delegate a complex task to Claude.',
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
    type: 'function',
    function: {
      name: 'delegate_to_gemini',
      description: 'Delegate a task to Gemini (good for web search, large context).',
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
    type: 'function',
    function: {
      name: 'delegate_to_openrouter',
      description: 'Delegate a task to OpenRouter (alternative fallback).',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for OpenRouter' },
        },
        required: ['prompt'],
      },
    },
  }
];

async function executeTool(
  name: string,
  args: any,
  ctx: { chatJid: string; groupFolder: string; isMain: boolean }
): Promise<string> {
  try {
    switch (name) {
      case 'bash':
        return execSync(args.command, { cwd: '/workspace/group', encoding: 'utf-8' }) || '(no output)';
      case 'read_file':
        return fs.readFileSync(args.path, 'utf-8');
      case 'write_file':
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
        fs.writeFileSync(args.path, args.content);
        return `Written to ${args.path}`;
      case 'list_files':
        return fs.readdirSync(args.path).join('\\n') || '(empty)';
      case 'send_message':
        writeIpcFile(MESSAGES_DIR, {
          type: 'message',
          chatJid: ctx.chatJid,
          text: args.text,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return 'Message queued.';
      case 'escalate_to_premium':
        // Return a special marker that the host will recognize
        return 'SIGNAL: ESCALATE_TO_PREMIUM. Reason: ' + (args.reason || 'Task too complex for local AI');
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

export async function runPhi3Fallback(input: Phi3Input): Promise<ContainerOutput> {
  const model = input.model || 'phi3:mini';
  const isDirect = input.prompt.includes('<messages>');
  const systemPrompt = loadSystemPrompt(isDirect) + '\n\nIMPORTANT: If you encounter a task that requires advanced coding, deep reasoning, or complex creative writing beyond your capabilities, use the escalate_to_premium tool immediately.';
  
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: input.prompt }
  ];

  const ctx = { chatJid: input.chatJid, groupFolder: input.groupFolder, isMain: input.isMain };

  log(`Starting Phi3 agent loop (model: ${model}, threads: 2, limit: 500)`);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    try {
      const response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: [
            ...toolDefinitions.filter(t => !['delegate_to_claude', 'delegate_to_gemini', 'delegate_to_openrouter'].includes(t.function.name)),
            {
              type: 'function',
              function: {
                name: 'escalate_to_premium',
                description: 'Call this if the task is too complex for you to handle safely or accurately.',
                parameters: {
                  type: 'object',
                  properties: { reason: { type: 'string' } }
                }
              }
            }
          ],
          options: {
            num_thread: 2,
            num_predict: 500,
            temperature: 0.7
          },
          stream: false
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { status: 'error', result: null, error: `Ollama error: ${response.status} ${errorText}` };
      }

      const data: any = await response.json();
      const message = data.message;
      messages.push(message);

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          log(`Tool call: ${toolCall.function.name}`);
          const result = await executeTool(toolCall.function.name, toolCall.function.arguments, ctx);
          
          if (result.startsWith('SIGNAL: ESCALATE_TO_PREMIUM')) {
             return { status: 'success', result: 'ESCALATE_TO_PREMIUM: ' + result };
          }

          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: toolCall.id
          });
        }
        continue;
      }

      return { status: 'success', result: message.content };
    } catch (err: any) {
      log(`Phi3 API error: ${err.message}`);
      return { status: 'error', result: null, error: err.message };
    }
  }

  return { status: 'error', result: null, error: 'Phi3 agent reached max iterations' };
}
