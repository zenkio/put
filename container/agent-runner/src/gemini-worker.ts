/**
 * Gemini Worker — callable by Claude via bash to delegate tasks with full tool access.
 *
 * Usage from Claude:
 *   echo '{"prompt":"search the web for..."}' | node /app/dist/gemini-worker.js
 *
 * Input: JSON with { prompt, chatJid?, groupFolder?, isMain? }
 * Output: plain text result (or error message to stderr)
 */
import fs from 'fs';
import { runGeminiFallback } from './gemini-fallback.js';

// Ensure env vars are loaded (entrypoint sets them but just in case)
function loadEnv(): void {
  if (process.env.GEMINI_API_KEY) return;
  const envFile = '/workspace/env-dir/env';
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
}

async function main() {
  loadEnv();

  // Hard timeout: 120s so we don't block Claude's container forever
  const timeout = setTimeout(() => {
    console.error('Gemini worker timeout (120s)');
    process.exit(1);
  }, 120_000);

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  let input: { prompt: string; chatJid?: string; groupFolder?: string; isMain?: boolean; model?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    // Treat raw text as the prompt directly
    input = { prompt: raw };
  }

  if (!input.prompt) {
    console.error('Error: no prompt provided');
    process.exit(1);
  }

  const result = await runGeminiFallback({
    prompt: input.prompt,
    chatJid: input.chatJid || 'worker',
    groupFolder: input.groupFolder || process.env.GROUP_FOLDER || 'main',
    isMain: input.isMain ?? true,
    model: input.model,
  });

  if (result.status === 'error') {
    console.error(`Gemini error: ${result.error}`);
    process.exit(1);
  }

  clearTimeout(timeout);
  // Output clean text for Claude to read
  process.stdout.write(result.result || '(no output)');
}

main().catch((err) => {
  console.error(`Worker failed: ${err.message}`);
  process.exit(1);
});
