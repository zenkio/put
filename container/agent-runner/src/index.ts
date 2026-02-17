/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcp } from './ipc-mcp.js';
import { runGeminiFallback } from './gemini-fallback.js';
import { runOpenRouterFallback } from './openrouter-fallback.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: 'claude' | 'gemini' | 'openrouter';
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  // sessions-index.json is in the same directory as the transcript
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function isQuotaError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('429') || lower.includes('quota') || lower.includes('rate_limit') || lower.includes('overloaded');
}

async function runClaudeAgent(input: ContainerInput, prompt: string): Promise<ContainerOutput & { newSessionId?: string }> {
  const ipcMcp = createIpcMcp({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  });

  let result: string | null = null;
  let newSessionId: string | undefined;

  for await (const message of query({
    prompt,
    options: {
      cwd: '/workspace/group',
      resume: input.sessionId,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'mcp__nanoclaw__*',
        'mcp__gmail__*',
        'mcp__zen__*'
      ],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      mcpServers: {
        nanoclaw: ipcMcp,
        gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
        zen: { command: 'uvx', args: ['--from', 'git+https://github.com/jray2123/zen-mcp-server.git', 'zen-mcp-server'] }
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }]
      }
    }
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if ('result' in message && message.result) {
      result = message.result as string;
    }
  }

  return { status: 'success', result, newSessionId };
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}, model: ${input.model || 'claude'}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Add context for scheduled tasks
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__nanoclaw__send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  // Direct Gemini routing (when host knows Claude quota is exhausted)
  if (input.model === 'gemini') {
    log('Routed directly to Gemini fallback');
    const output = await runGeminiFallback({
      prompt,
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain
    });
    writeOutput(output);
    if (output.status === 'error') process.exit(1);
    return;
  }

  // Direct OpenRouter routing (emergency mode fallback)
  if (input.model === 'openrouter') {
    log('Routed directly to OpenRouter fallback');
    const output = await runOpenRouterFallback({
      prompt,
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain
    });

    if (output.status === 'success') {
      writeOutput(output);
      return;
    }

    // OpenRouter failed — try Gemini as backup
    log('OpenRouter failed, trying Gemini as backup...');
    const geminiOutput = await runGeminiFallback({
      prompt,
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain
    });
    writeOutput(geminiOutput);
    if (geminiOutput.status === 'error') process.exit(1);
    return;
  }

  // Default: try Claude first, fallback to Gemini on ANY error
  try {
    log('Starting Claude agent...');
    const output = await runClaudeAgent(input, prompt);
    log('Claude agent completed successfully');
    writeOutput({
      status: output.status,
      result: output.result,
      newSessionId: output.newSessionId
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Claude agent error: ${errorMessage}`);

    const quotaError = isQuotaError(errorMessage);
    const errorTag = quotaError ? 'claude_quota_exhausted' : 'claude_error';

    if (quotaError) {
      log('Claude quota/rate limit detected, falling back to Gemini...');
    } else {
      log('Claude crashed, falling back to Gemini so user gets a response...');
    }

    // Write IPC notification for quota alerts
    if (quotaError) {
      const ipcNotifyDir = path.join('/workspace/ipc', 'messages');
      fs.mkdirSync(ipcNotifyDir, { recursive: true });
      const notifyFile = path.join(ipcNotifyDir, `${Date.now()}-quota-alert.json`);
      fs.writeFileSync(notifyFile, JSON.stringify({
        type: 'message',
        chatJid: input.chatJid,
        text: '[QUOTA ALERT] Claude is resting. Switching to Gemini for this request.',
        groupFolder: input.groupFolder,
        timestamp: new Date().toISOString()
      }));
    }

    try {
      const geminiOutput = await runGeminiFallback({
        prompt,
        chatJid: input.chatJid,
        groupFolder: input.groupFolder,
        isMain: input.isMain
      });

      if (geminiOutput.status === 'success') {
        writeOutput({ ...geminiOutput, error: errorTag });
      } else if (geminiOutput.error?.includes('gemini_rate_limit')) {
        // Gemini also rate limited — try OpenRouter as last resort
        log('Gemini rate limited, trying OpenRouter as last resort...');
        try {
          const openRouterOutput = await runOpenRouterFallback({
            prompt,
            chatJid: input.chatJid,
            groupFolder: input.groupFolder,
            isMain: input.isMain
          });

          if (openRouterOutput.status === 'success') {
            writeOutput({ ...openRouterOutput, error: `${errorTag}|gemini_rate_limit|openrouter_used` });
          } else {
            writeOutput({ ...geminiOutput, error: `${errorTag}|${geminiOutput.error}|openrouter_failed` });
            process.exit(1);
          }
        } catch (orErr) {
          log(`OpenRouter fallback error: ${orErr instanceof Error ? orErr.message : String(orErr)}`);
          writeOutput({ ...geminiOutput, error: `${errorTag}|${geminiOutput.error}` });
          process.exit(1);
        }
      } else {
        writeOutput({ ...geminiOutput, error: `${errorTag}|${geminiOutput.error}` });
        process.exit(1);
      }
    } catch (geminiErr) {
      const geminiErrMsg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      log(`Gemini fallback also failed: ${geminiErrMsg}`);

      // Last resort: try OpenRouter (free models)
      const isGeminiRateLimit = geminiErrMsg.includes('429') || geminiErrMsg.toLowerCase().includes('rate');
      if (isGeminiRateLimit) {
        log('Gemini rate limited, trying OpenRouter as last resort...');
        try {
          const openRouterOutput = await runOpenRouterFallback({
            prompt,
            chatJid: input.chatJid,
            groupFolder: input.groupFolder,
            isMain: input.isMain
          });

          if (openRouterOutput.status === 'success') {
            writeOutput({ ...openRouterOutput, error: `${errorTag}|gemini_failed|openrouter_used` });
            return;
          }
          log(`OpenRouter also failed: ${openRouterOutput.error}`);
        } catch (orErr) {
          log(`OpenRouter fallback error: ${orErr instanceof Error ? orErr.message : String(orErr)}`);
        }
      }

      writeOutput({
        status: 'error',
        result: null,
        error: `${errorTag}|gemini_also_failed`
      });
      process.exit(1);
    }
  }
}

main();
