#!/usr/bin/env node

import { spawn } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const CURRENT_MODEL =
  process.env.LOCAL_JUNIOR_CURRENT ||
  process.env.LOCAL_FALLBACK_MODEL ||
  process.env.PHI3_MODEL ||
  'qwen2.5-coder:3b';
const CANDIDATES = (process.env.LOCAL_JUNIOR_MODELS ||
  'qwen2.5-coder:3b,deepseek-coder:6.7b,starcoder2:3b,qwen2.5-coder:7b')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MODELS = [...new Set([CURRENT_MODEL, ...CANDIDATES])];
const PERF_RUNS = Number(process.env.MATRIX_PERF_RUNS || 2);
const QUALITY_RUNS = Number(process.env.MATRIX_QUALITY_RUNS || 1);
const HARD_TIMEOUT_MS = Number(
  process.env.LOCAL_BENCH_TIMEOUT_MS || process.env.PHI3_BENCH_TIMEOUT_MS || 180000,
);
const APPLY_PRUNE = process.env.APPLY_PRUNE === '1';
const LARGE_MODEL_PATTERN = /(6\.7b|7b|8b|13b|14b)/i;

const options = {
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
    id: 'safeJsonParse',
    functionName: 'safeJsonParse',
    prompt:
      'Write a TypeScript function safeJsonParse(input:string):unknown|null. Return parsed object for valid JSON, otherwise null. Return code only.',
    validate(fn) {
      const obj = fn('{"a":1,"b":[2]}');
      if (!obj || obj.a !== 1 || obj.b[0] !== 2) throw new Error('valid parse failed');
      if (fn('{bad}') !== null) throw new Error('invalid should return null');
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
    id: 'clamp',
    functionName: 'clamp',
    prompt:
      'Write TypeScript function clamp(value:number,min:number,max:number):number. Return min if below, max if above, otherwise value. Return code only.',
    validate(fn) {
      if (fn(5, 1, 10) !== 5) throw new Error('inside failed');
      if (fn(-2, 1, 10) !== 1) throw new Error('low failed');
      if (fn(22, 1, 10) !== 10) throw new Error('high failed');
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
  {
    id: 'uniqueBy',
    functionName: 'uniqueBy',
    prompt:
      'Write TypeScript function uniqueBy<T>(items:T[], key:(x:T)=>string):T[] that keeps first occurrence per key. Return code only.',
    validate(fn) {
      const out = fn(
        [{ id: 'a', v: 1 }, { id: 'a', v: 2 }, { id: 'b', v: 3 }],
        (x) => x.id,
      );
      if (!Array.isArray(out) || out.length !== 2) throw new Error('length failed');
      if (out[0].v !== 1 || out[1].v !== 3) throw new Error('first occurrence failed');
    },
  },
  {
    id: 'buildQueryString',
    functionName: 'buildQueryString',
    prompt:
      'Write TypeScript function buildQueryString(params:Record<string,string|number|boolean|null|undefined>):string that returns URL query string without leading ?. Skip null/undefined. URL-encode keys/values. Return code only.',
    validate(fn) {
      const out = fn({ q: 'hello world', page: 2, active: true, x: null });
      if (!out.includes('q=hello%20world')) throw new Error('encode failed');
      if (!out.includes('page=2')) throw new Error('number failed');
      if (!out.includes('active=true')) throw new Error('boolean failed');
      if (out.includes('x=')) throw new Error('null should be skipped');
    },
  },
  {
    id: 'parseNodeVersion',
    functionName: 'parseNodeVersion',
    prompt:
      'Write TypeScript function parseNodeVersion(v:string):{major:number,minor:number,patch:number} for strings like "v22.22.0" or "22.1.5". Throw Error on invalid input. Return code only.',
    validate(fn) {
      const a = fn('v22.22.0');
      if (a.major !== 22 || a.minor !== 22 || a.patch !== 0) throw new Error('v prefix failed');
      const b = fn('18.19.1');
      if (b.major !== 18 || b.minor !== 19 || b.patch !== 1) throw new Error('plain failed');
      let threw = false;
      try {
        fn('18');
      } catch {
        threw = true;
      }
      if (!threw) throw new Error('invalid should throw');
    },
  },
  {
    id: 'minutesBetweenISO',
    functionName: 'minutesBetweenISO',
    prompt:
      'Write TypeScript function minutesBetweenISO(a:string,b:string):number returning absolute whole-minute difference between two ISO timestamps. Throw Error if invalid date. Return code only.',
    validate(fn) {
      if (fn('2026-02-22T00:00:00Z', '2026-02-22T01:30:00Z') !== 90) throw new Error('diff failed');
      if (fn('2026-02-22T01:30:00Z', '2026-02-22T00:00:00Z') !== 90) throw new Error('abs failed');
    },
  },
  {
    id: 'remixPaginationFromRequest',
    functionName: 'remixPaginationFromRequest',
    prompt:
      'Write TypeScript function remixPaginationFromRequest(url:string, defaultLimit:number):{page:number,limit:number,offset:number} using search params page and limit. page min 1, limit min 1 max 100. Return code only.',
    validate(fn) {
      const a = fn('https://app.test/items?page=3&limit=20', 10);
      if (a.page !== 3 || a.limit !== 20 || a.offset !== 40) throw new Error('pagination failed');
      const b = fn('https://app.test/items?page=0&limit=999', 15);
      if (b.page !== 1 || b.limit !== 100 || b.offset !== 0) throw new Error('clamp failed');
    },
  },
  {
    id: 'nodeNormalizeHeaderMap',
    functionName: 'nodeNormalizeHeaderMap',
    prompt:
      'Write TypeScript function nodeNormalizeHeaderMap(h:Record<string,string|undefined>):Record<string,string> that lowercases keys, trims values, drops undefined/empty values. Return code only.',
    validate(fn) {
      const out = fn({ ' Content-Type ': ' application/json ', AUTH: ' Bearer x ', x: undefined, y: ' ' });
      if (out['content-type'] !== 'application/json') throw new Error('content-type failed');
      if (out['auth'] !== 'Bearer x') throw new Error('auth failed');
      if ('x' in out || 'y' in out) throw new Error('undefined/empty not dropped');
    },
  },
];

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
    });
  });
}

async function listModels() {
  const { stdout } = await runCmd('ollama', ['list']);
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return [];
  return lines
    .slice(1)
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

function stripCode(raw) {
  return String(raw || '')
    .replace(/^```(?:typescript|ts|javascript|js)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function getOptionsForModel(model) {
  const opt = { ...options };
  if (LARGE_MODEL_PATTERN.test(model)) {
    opt.num_thread = Number(process.env.LOCAL_JUNIOR_LARGE_NUM_THREAD || 1);
    opt.num_ctx = Number(process.env.LOCAL_JUNIOR_LARGE_NUM_CTX || 512);
    opt.num_predict = Number(process.env.LOCAL_JUNIOR_LARGE_NUM_PREDICT || 96);
  }
  if (/7b/i.test(model)) {
    opt.num_ctx = Number(process.env.LOCAL_JUNIOR_7B_NUM_CTX || Math.min(opt.num_ctx, 384));
    opt.num_predict = Number(
      process.env.LOCAL_JUNIOR_7B_NUM_PREDICT || Math.min(opt.num_predict, 80),
    );
    opt.num_thread = Number(process.env.LOCAL_JUNIOR_7B_NUM_THREAD || 1);
  }
  return opt;
}

async function askModel(model, prompt, modelOptions) {
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
        options: modelOptions,
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
  const modelOptions = getOptionsForModel(model);
  console.log(`Using options for ${model}: ${JSON.stringify(modelOptions)}`);
  let perfOk = 0;
  const perfTimes = [];
  const perfTps = [];
  for (let i = 0; i < PERF_RUNS; i++) {
    const r = await askModel(model, perfPrompt, modelOptions);
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
      const r = await askModel(model, t.prompt, modelOptions);
      if (!r.ok) continue;
      try {
        const fn = loadFunctionFromTs(r.content, t.functionName);
        t.validate(fn);
        qPass++;
      } catch {}
    }
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const p50 = perfTimes.length
    ? [...perfTimes].sort((a, b) => a - b)[Math.floor(perfTimes.length / 2)]
    : 0;
  return {
    model,
    perfSuccess: `${perfOk}/${PERF_RUNS}`,
    perfP50ms: Math.round(p50),
    perfMeanTps: Number(mean(perfTps).toFixed(2)),
    qualityPass: `${qPass}/${qTotal}`,
    qualityPassRate: `${Math.round((qPass * 100) / (qTotal || 1))}%`,
    qualityPassNum: qPass,
  };
}

async function ensurePulled(model, installed) {
  if (installed.includes(model)) return;
  console.log(`Pulling ${model}...`);
  await runCmd('ollama', ['pull', model]);
}

function isBetter(a, b) {
  return (
    a.qualityPassNum > b.qualityPassNum ||
    (a.qualityPassNum === b.qualityPassNum && a.perfMeanTps > b.perfMeanTps) ||
    (a.qualityPassNum === b.qualityPassNum &&
      a.perfMeanTps === b.perfMeanTps &&
      a.perfP50ms < b.perfP50ms)
  );
}

async function removeModel(model) {
  const installed = await listModels().catch(() => []);
  if (!installed.includes(model)) return;
  try {
    await runCmd('ollama', ['rm', model]);
    console.log(`Removed ${model}`);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/not found/i.test(msg)) return;
    console.warn(`Skip remove ${model}: ${msg}`);
  }
}

async function main() {
  console.log('Selecting local junior programmer model...');
  console.log(`Models: ${MODELS.join(', ')}`);
  console.log(`Options: ${JSON.stringify(options)}`);
  console.log(
    APPLY_PRUNE
      ? 'Mode: APPLY (keeps disk low by pruning losers during evaluation)'
      : 'Mode: DRY-RUN (no deletion)',
  );

  let installed = await listModels();

  const rows = [];
  let best = null;
  for (const model of MODELS) {
    try {
      await ensurePulled(model, installed);
      installed = await listModels();
    } catch (err) {
      console.warn(`Skip ${model}: pull failed: ${err.message || err}`);
      continue;
    }

    console.log(`Testing ${model}...`);
    const row = await benchmarkModel(model);
    rows.push(row);

    if (!best || isBetter(row, best)) {
      if (APPLY_PRUNE && best && best.model !== model) {
        console.log(`New leader ${model}; pruning previous leader ${best.model}...`);
        await removeModel(best.model);
      }
      best = row;
      console.log(`Leader: ${best.model}`);
    } else if (APPLY_PRUNE) {
      console.log(`Pruning loser ${model}...`);
      await removeModel(model);
    }
  }

  if (rows.length === 0) {
    throw new Error('No model benchmark completed. Check ollama connectivity and free disk.');
  }

  const ranked = [...rows].sort(
    (a, b) =>
      b.qualityPassNum - a.qualityPassNum ||
      b.perfMeanTps - a.perfMeanTps ||
      a.perfP50ms - b.perfP50ms,
  );
  const winner = ranked[0] || best;

  console.log('\nRanked results:');
  console.table(
    ranked.map((r) => ({
      model: r.model,
      qualityPass: r.qualityPass,
      qualityPassRate: r.qualityPassRate,
      perfSuccess: r.perfSuccess,
      perfP50ms: r.perfP50ms,
      perfMeanTps: r.perfMeanTps,
    })),
  );
  console.log(`Winner: ${winner.model}`);

  if (!APPLY_PRUNE) {
    console.log('\nDry-run mode: no model removed.');
    console.log('Run with APPLY_PRUNE=1 to keep only the winner among tested models.');
    return;
  }

  // Final sweep for any tested model still present besides the winner.
  for (const model of MODELS) {
    if (model === winner.model) continue;
    await removeModel(model);
  }
  console.log(`Done. Kept only winner: ${winner.model}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
