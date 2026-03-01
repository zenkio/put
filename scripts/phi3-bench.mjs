#!/usr/bin/env node

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL =
  process.env.LOCAL_FALLBACK_MODEL ||
  process.env.PHI3_MODEL ||
  'qwen2.5-coder:3b';
const RUNS = Number(process.env.LOCAL_BENCH_RUNS || process.env.PHI3_BENCH_RUNS || 3);
const HARD_TIMEOUT_MS = Number(
  process.env.LOCAL_BENCH_TIMEOUT_MS || process.env.PHI3_BENCH_TIMEOUT_MS || 180000,
);

const prompt =
  process.env.LOCAL_BENCH_PROMPT ||
  process.env.PHI3_BENCH_PROMPT ||
  'Reply with exactly 3 short bullet points about practice consistency for violin students.';

const scenarios = [
  {
    name: 'safe-low-mem',
    num_thread: 2,
    num_ctx: 768,
    num_predict: 128,
    temperature: 0.2,
  },
  {
    name: 'current-default',
    num_thread: 2,
    num_ctx: 768,
    num_predict: 192,
    temperature: 0.2,
  },
  {
    name: 'higher-output',
    num_thread: 2,
    num_ctx: 1024,
    num_predict: 256,
    temperature: 0.2,
  },
];

async function chatOnce(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        options,
      }),
    });
    const elapsedMs = Date.now() - started;
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, elapsedMs, error: `HTTP ${res.status}: ${text}` };
    }
    const json = await res.json();
    const evalCount = Number(json.eval_count || 0);
    const evalDurationNs = Number(json.eval_duration || 0);
    const tps = evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : 0;
    return {
      ok: true,
      elapsedMs,
      evalCount,
      evalDurationNs,
      tps,
    };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const msg = err?.name === 'AbortError' ? `timeout after ${HARD_TIMEOUT_MS}ms` : String(err?.message || err);
    return { ok: false, elapsedMs, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(name, runs) {
  const okRuns = runs.filter((r) => r.ok);
  const failRuns = runs.filter((r) => !r.ok);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const p = (arr, pct) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const i = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));
    return sorted[i];
  };
  const elapsed = okRuns.map((r) => r.elapsedMs);
  const tps = okRuns.map((r) => r.tps || 0);

  return {
    scenario: name,
    runs: runs.length,
    success: okRuns.length,
    fail: failRuns.length,
    successRate: `${((okRuns.length * 100) / runs.length).toFixed(0)}%`,
    p50ms: Math.round(p(elapsed, 50)),
    p95ms: Math.round(p(elapsed, 95)),
    meanTps: Number(mean(tps).toFixed(2)),
    failReason: failRuns[0]?.error || '',
  };
}

async function main() {
  console.log(`Phi3 benchmark against ${OLLAMA_URL}, model=${MODEL}, runs=${RUNS}`);
  console.log(`Prompt: ${prompt}`);
  const results = [];

  for (const s of scenarios) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await chatOnce({
        num_thread: s.num_thread,
        num_ctx: s.num_ctx,
        num_predict: s.num_predict,
        temperature: s.temperature,
      });
      runs.push(r);
      const status = r.ok ? `ok ${r.elapsedMs}ms ${r.tps?.toFixed(2) || 0} tok/s` : `fail ${r.elapsedMs}ms ${r.error}`;
      console.log(`- ${s.name} run ${i + 1}/${RUNS}: ${status}`);
    }
    results.push(summarize(s.name, runs));
  }

  console.log('\nSummary:');
  console.table(results);
  const winner = [...results]
    .filter((r) => r.success > 0)
    .sort((a, b) => b.success - a.success || b.meanTps - a.meanTps || a.p50ms - b.p50ms)[0];
  if (winner) {
    console.log(`Best scenario: ${winner.scenario}`);
  } else {
    console.log('No successful scenario. Keep lower num_ctx/num_predict and check Ollama memory/availability.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
