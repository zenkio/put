import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

interface ToolContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
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

export function executeSharedTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  try {
    switch (name) {
      case 'bash': {
        const cmd = args.command as string;
        console.error(`[tool-utils] bash: ${cmd.slice(0, 100)}`);
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

      case 'delegate_to_claude': {
        const prompt = args.prompt as string;
        writeIpcFile(TASKS_DIR, {
          type: 'delegate_agent',
          agent: 'claude',
          prompt,
          groupFolder: ctx.groupFolder,
          chatJid: ctx.chatJid,
          timestamp: new Date().toISOString(),
        });
        return 'Delegation to Claude requested via IPC.';
      }

      case 'delegate_to_gemini': {
        const prompt = args.prompt as string;
        const inputObj = { prompt, chatJid: ctx.chatJid, groupFolder: ctx.groupFolder, isMain: ctx.isMain };
        const inputPath = `/tmp/worker-input-${Date.now()}.json`;
        fs.writeFileSync(inputPath, JSON.stringify(inputObj));
        const out = execSync(`node /app/dist/gemini-worker.js < ${inputPath}`, { encoding: 'utf-8' });
        fs.unlinkSync(inputPath);
        return out;
      }

      case 'delegate_to_openrouter': {
        const prompt = args.prompt as string;
        const inputObj = { prompt, chatJid: ctx.chatJid, groupFolder: ctx.groupFolder, isMain: ctx.isMain };
        const inputPath = `/tmp/worker-input-${Date.now()}.json`;
        fs.writeFileSync(inputPath, JSON.stringify(inputObj));
        const out = execSync(`node /app/dist/openrouter-worker.js < ${inputPath}`, { encoding: 'utf-8' });
        fs.unlinkSync(inputPath);
        return out;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tool-utils] Tool error (${name}): ${msg}`);
    return `Error: ${msg}`;
  }
}
