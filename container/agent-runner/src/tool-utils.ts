import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const CHECKPOINTS_DIR = path.join(IPC_DIR, 'checkpoints');
const TASK_AUTORUN_COMMANDS =
  (process.env.TASK_AUTORUN_COMMANDS || 'true').toLowerCase() !== 'false';

interface ToolContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  allowProactiveMessage?: boolean;
  sourceTag?: string;
  runId?: string;
}

function isGitLikeCommand(command: string): boolean {
  return /\bgit\b/.test(command);
}

function hasExplicitCwd(command: string): boolean {
  return /\bcd\s+/.test(command);
}

function findSingleNestedGitRepo(baseDir: string): string | null {
  const projectsDir = path.join(baseDir, 'projects');
  if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) return null;
  const candidates = fs
    .readdirSync(projectsDir)
    .map((name) => path.join(projectsDir, name))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, '.git'));
      } catch {
        return false;
      }
    });
  return candidates.length === 1 ? candidates[0] : null;
}

function isNotGitRepoError(err: unknown): boolean {
  const e = err as { stderr?: string | Buffer; message?: string };
  const stderr =
    typeof e?.stderr === 'string'
      ? e.stderr
      : e?.stderr
        ? e.stderr.toString('utf8')
        : e?.message || '';
  return /not a git repository/i.test(stderr);
}

function looksLikeCodingTask(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /```/.test(text) ||
    /\b(code|coding|function|typescript|javascript|node|remix|refactor|bug|test|compile|build|api|sql|regex)\b/.test(
      lower,
    )
  );
}

function looksLowRiskCodingTask(text: string): boolean {
  const lower = text.toLowerCase();
  const highRisk =
    /\b(multi-file|architecture|migrate|migration|database|schema|auth|security|payment|production|deploy)\b/.test(
      lower,
    );
  const lowRisk =
    /\b(utility|helper|boilerplate|scaffold|small function|single function|draft|example|snippet)\b/.test(
      lower,
    );
  return looksLikeCodingTask(text) && !highRisk && (lowRisk || text.length < 700);
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

function summarizeOutput(text: string, max = 280): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function writeCommandCheckpoint(params: {
  ctx: ToolContext;
  provider: string;
  tool: string;
  command?: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}): void {
  if (!params.ctx.runId) return;
  writeIpcFile(CHECKPOINTS_DIR, {
    runId: params.ctx.runId,
    provider: params.provider,
    tool: params.tool,
    command: params.command,
    exitCode: params.exitCode,
    stdoutSummary: summarizeOutput(params.stdout || ''),
    stderrSummary: summarizeOutput(params.stderr || ''),
    groupFolder: params.ctx.groupFolder,
    chatJid: params.ctx.chatJid,
    timestamp: new Date().toISOString(),
  });
}

export function executeSharedTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  try {
    switch (name) {
      case 'bash': {
        if (!TASK_AUTORUN_COMMANDS) {
          return 'Command execution disabled by TASK_AUTORUN_COMMANDS=false';
        }
        const cmd = args.command as string;
        console.error(`[tool-utils] bash: ${cmd.slice(0, 100)}`);
        const runCommand = (cwd: string): string =>
          execSync(cmd, {
            cwd,
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        try {
          const output = runCommand('/workspace/group');
          writeCommandCheckpoint({
            ctx,
            provider: ctx.sourceTag || 'tool-utils',
            tool: 'bash',
            command: cmd,
            exitCode: 0,
            stdout: output || '',
          });
          return output || '(no output)';
        } catch (err) {
          // Auto-retry git commands in nested project repo when /workspace/group itself is not a git repo.
          if (isGitLikeCommand(cmd) && !hasExplicitCwd(cmd) && isNotGitRepoError(err)) {
            const nestedRepoCwd = findSingleNestedGitRepo('/workspace/group');
            if (nestedRepoCwd) {
              try {
                const output = runCommand(nestedRepoCwd);
                writeCommandCheckpoint({
                  ctx,
                  provider: ctx.sourceTag || 'tool-utils',
                  tool: 'bash',
                  command: `${cmd} [auto-cwd:${nestedRepoCwd}]`,
                  exitCode: 0,
                  stdout: output || '',
                });
                return output || '(no output)';
              } catch (retryErr) {
                err = retryErr;
              }
            }
          }

          const e = err as {
            status?: number;
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            message?: string;
          };
          const stdout =
            typeof e.stdout === 'string'
              ? e.stdout
              : e.stdout
                ? e.stdout.toString('utf8')
                : '';
          const stderr =
            typeof e.stderr === 'string'
              ? e.stderr
              : e.stderr
                ? e.stderr.toString('utf8')
                : e.message || '';
          writeCommandCheckpoint({
            ctx,
            provider: ctx.sourceTag || 'tool-utils',
            tool: 'bash',
            command: cmd,
            exitCode: typeof e.status === 'number' ? e.status : 1,
            stdout,
            stderr,
          });
          throw err;
        }
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
        if (ctx.allowProactiveMessage === false) {
          return 'send_message disabled in direct response mode; provide a complete final answer instead.';
        }
        const text = args.text as string;
        writeIpcFile(MESSAGES_DIR, {
          type: 'message',
          chatJid: ctx.chatJid,
          text,
          source: ctx.sourceTag,
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

      case 'delegate_to_local':
      case 'delegate_to_phi3': {
        const prompt = (args.prompt as string) || '';
        if (looksLikeCodingTask(prompt) && !looksLowRiskCodingTask(prompt)) {
          return 'Policy blocked: local delegate is only for low-risk coding subtasks. Use delegate_to_claude for full/critical coding.';
        }

        const withVerification = looksLikeCodingTask(prompt)
          ? `${prompt}\n\n[MANDATORY]\nThis is local-junior output. If you propose code, include a short verification checklist for the delegator: run typecheck/tests and fix failures before final delivery.`
          : prompt;

        writeIpcFile(TASKS_DIR, {
          type: 'delegate_agent',
          agent: 'phi3',
          prompt: withVerification,
          groupFolder: ctx.groupFolder,
          chatJid: ctx.chatJid,
          timestamp: new Date().toISOString(),
        });
        return 'Delegation to local fallback requested via IPC.';
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
