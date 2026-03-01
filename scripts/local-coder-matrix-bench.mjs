#!/usr/bin/env node

import vm from 'node:vm';
import ts from 'typescript';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODELS = (process.env.LOCAL_CODER_MODELS ||
  'qwen2.5-coder:3b,deepseek-coder:6.7b,starcoder2:3b,qwen2.5-coder:7b')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PERF_RUNS = Number(process.env.MATRIX_PERF_RUNS || 2);
const QUALITY_RUNS = Number(process.env.MATRIX_QUALITY_RUNS || 1);
const HARD_TIMEOUT_MS = Number(
  process.env.LOCAL_BENCH_TIMEOUT_MS || process.env.PHI3_BENCH_TIMEOUT_MS || 180000,
);

const scenario = {
  num_thread: Number(process.env.LOCAL_FALLBACK_NUM_THREAD || process.env.PHI3_NUM_THREAD || 2),
  num_ctx: Number(process.env.LOCAL_FALLBACK_NUM_CTX || process.env.PHI3_NUM_CTX || 768),
  num_predict: Number(process.env.LOCAL_FALLBACK_NUM_PREDICT || process.env.PHI3_NUM_PREDICT || 128),
  temperature: Number(process.env.LOCAL_FALLBACK_TEMPERATURE || process.env.PHI3_TEMPERATURE || 0.2),
};

const perfPrompt =
  'Reply with exactly 3 short bullet points about practice consistency for violin students.';

const qualityTasks = [
  {
    id: 'parseDuration',
    functionName: 'parseDuration',
    prompt:
      'Write a TypeScript function parseDuration(input:string):number that returns total seconds. Supported units: h,m,s. Accept 1h30m, 45m, 90s, 2m10s. Reject invalid strings by throwing Error. Return code only.',
    validate(fn) {
      if (fn('1h30m') !== 5400) throw new Error('1h30m failed');
      if (fn('45m') !== 2700) throw new Error('45m failed');
      if (fn('90s') !== 90) throw new Error('90s failed');
      if (fn('2m10s') !== 130) throw new Error('2m10s failed');
    },
  },
  {
    id: 'toKebabCase',
    functionName: 'toKebabCase',
    prompt:
      'Write a TypeScript function toKebabCase(input:string):string. Example: "HelloWorld Test" -> "hello-world-test". Return code only.',
    validate(fn) {
      if (fn('HelloWorld Test') !== 'hello-world-test') throw new Error('camel+space failed');
      if (fn('snake_case_value') !== 'snake-case-value') throw new Error('snake failed');
    },
  },
  {
    id: 'sumBy',
    functionName: 'sumBy',
    prompt:
      'Write a TypeScript function sumBy<T>(items:T[], pick:(item:T)=>number):number. Return code only.',
    validate(fn) {
      const out = fn([{ p: 1.2 }, { p: 2.3 }, { p: 3.5 }], (x) => x.p);
      if (out !== 7) throw new Error('sum failed');
    },
  },
];

function stripCode(raw) {
  return String(raw || '')
    .replace(/^```(?:typescript|ts|javascript|js)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

async function askModel(model, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: 'Return only plain answer/code. No markdown explanations.' },
          { role: 'user', content: prompt },
        ],
        options: scenario,
      }),
    });
    const elapsedMs = Date.now() - started;
    if (!res.ok) return { ok: false, elapsedMs, error: `HTTP ${res.status}` };
    const json = await res.json();
    const evalCount = Number(json.eval_count || 0);
    const evalDurationNs = Number(json.eval_duration || 0);
    const tps = evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : 0;
    return { ok: true, elapsedMs, tps, content: stripCode(json?.message?.content || '') };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const msg = err?.name === 'AbortError' ? `timeout ${HARD_TIMEOUT_MS}ms` : String(err?.message || err);
    return { ok: false, elapsedMs, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

function loadFunctionFromTs(code, functionName) {
  const transpiled = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, strict: false },
  }).outputText;
  const context = { module: { exports: {} }, exports: {} };
  vm.createContext(context);
  new vm.Script(transpiled).runInContext(context);
  const fn = context.module?.exports?.[functionName] || context.exports?.[functionName] || context[functionName];
  if (typeof fn !== 'function') throw new Error(`missing ${functionName}`);
  return fn;
}

async function benchmarkModel(model) {
  let perfOk = 0;
  const perfTimes = [];
  const perfTps = [];
  for (let i = 0; i < PERF_RUNS; i++) {
    const r = await askModel(model, perfPrompt);
    if (r.ok) {
      perfOk++;
      perfTimes.push(r.elapsedMs);
      perfTps.push(r.tps || 0);
    }
  }

  let qPass = 0;
  let qTotal = 0;
  for (let run = 0; run < QUALITY_RUNS; run++) {
    for (const t of qualityTasks) {
      qTotal++;
      const r = await askModel(model, t.prompt);
      if (!r.ok) continue;
      try {
        const fn = loadFunctionFromTs(r.content, t.functionName);
        t.validate(fn);
        qPass++;
      } catch {}
    }
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  return {
    model,
    perfSuccess: `${perfOk}/${PERF_RUNS}`,
    perfP50ms: perfTimes.length ? Math.round(perfTimes.sort((a, b) => a - b)[Math.floor(perfTimes.length / 2)]) : 0,
    perfMeanTps: Number(mean(perfTps).toFixed(2)),
    qualityPassRate: `${Math.round((qPass * 100) / (qTotal || 1))}%`,
    qualityPass: `${qPass}/${qTotal}`,
  };
}

async function main() {
  console.log(`Local coder matrix @ ${OLLAMA_URL}`);
  console.log(`models=${MODELS.join(', ')}`);
  console.log(`scenario=${JSON.stringify(scenario)} perfRuns=${PERF_RUNS} qualityRuns=${QUALITY_RUNS}`);
  const rows = [];
  for (const model of MODELS) {
    console.log(`\nTesting ${model}...`);
    rows.push(await benchmarkModel(model));
  }
  console.log('\nRanked results:');
  const ranked = [...rows].sort((a, b) => {
    const qa = Number(a.qualityPass.split('/')[0]);
    const qb = Number(b.qualityPass.split('/')[0]);
    return qb - qa || b.perfMeanTps - a.perfMeanTps || a.perfP50ms - b.perfP50ms;
  });
  console.table(ranked);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
