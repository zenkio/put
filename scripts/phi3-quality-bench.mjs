#!/usr/bin/env node

import vm from 'node:vm';
import ts from 'typescript';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL =
  process.env.LOCAL_FALLBACK_MODEL ||
  process.env.PHI3_MODEL ||
  'qwen2.5-coder:3b';
const RUNS = Number(process.env.LOCAL_QUALITY_RUNS || process.env.PHI3_QUALITY_RUNS || 1);
const HARD_TIMEOUT_MS = Number(
  process.env.LOCAL_BENCH_TIMEOUT_MS || process.env.PHI3_BENCH_TIMEOUT_MS || 180000,
);

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
    num_ctx: 1024,
    num_predict: 128,
    temperature: 0.2,
  },
  {
    name: 'higher-output',
    num_thread: 2,
    num_ctx: 1024,
    num_predict: 192,
    temperature: 0.2,
  },
];

const tasks = [
  {
    id: 'parseDuration',
    functionName: 'parseDuration',
    prompt:
      'Write a TypeScript function parseDuration(input:string):number that returns total seconds. Supported units: h,m,s. Accept 1h30m, 45m, 90s, 2m10s. Reject invalid strings by throwing Error. Return code only.',
    validate(fn) {
      const eq = (a, b, label) => {
        if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
      };
      eq(fn('1h30m'), 5400, '1h30m');
      eq(fn('45m'), 2700, '45m');
      eq(fn('90s'), 90, '90s');
      eq(fn('2m10s'), 130, '2m10s');
      let threw = false;
      try {
        fn('abc');
      } catch {
        threw = true;
      }
      if (!threw) throw new Error('abc should throw');
    },
  },
  {
    id: 'toKebabCase',
    functionName: 'toKebabCase',
    prompt:
      'Write a TypeScript function toKebabCase(input:string):string. Example: "HelloWorld Test" -> "hello-world-test". Return code only.',
    validate(fn) {
      const eq = (a, b, label) => {
        if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
      };
      eq(fn('HelloWorld Test'), 'hello-world-test', 'camel+space');
      eq(fn(' already__done  '), 'already-done', 'underscores');
      eq(fn('snake_case_value'), 'snake-case-value', 'snake');
    },
  },
  {
    id: 'sumBy',
    functionName: 'sumBy',
    prompt:
      'Write a TypeScript function sumBy<T>(items:T[], pick:(item:T)=>number):number. Return code only.',
    validate(fn) {
      const eq = (a, b, label) => {
        if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
      };
      eq(
        fn(
          [
            { p: 1.2 },
            { p: 2.3 },
            { p: 3.5 },
          ],
          (x) => x.p,
        ),
        7,
        'sum decimals',
      );
      eq(fn([], () => 10), 0, 'empty');
    },
  },
];

function stripCodeFences(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:typescript|ts|javascript|js)?\s*/i, '');
  text = text.replace(/\s*```$/i, '');
  return text.trim();
}

async function askModel(prompt, options) {
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
        messages: [
          {
            role: 'system',
            content:
              'Return only compilable TypeScript code. No markdown, no explanations.',
          },
          { role: 'user', content: prompt },
        ],
        options,
      }),
    });
    const elapsedMs = Date.now() - started;
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, elapsedMs, error: `HTTP ${res.status}: ${text}` };
    }
    const json = await res.json();
    const content = json?.message?.content || '';
    return { ok: true, elapsedMs, content: stripCodeFences(content) };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const msg =
      err?.name === 'AbortError'
        ? `timeout after ${HARD_TIMEOUT_MS}ms`
        : String(err?.message || err);
    return { ok: false, elapsedMs, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

function loadFunctionFromTs(code, functionName) {
  const transpiled = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      strict: false,
    },
  }).outputText;

  const context = {
    module: { exports: {} },
    exports: {},
  };
  vm.createContext(context);
  new vm.Script(transpiled).runInContext(context);

  const fromModule = context.module?.exports?.[functionName];
  const fromExports = context.exports?.[functionName];
  const fromGlobal = context[functionName];
  const fn = fromModule || fromExports || fromGlobal;
  if (typeof fn !== 'function') {
    throw new Error(`Function ${functionName} not found in output`);
  }
  return fn;
}

async function runScenario(scenario) {
  const rows = [];
  let pass = 0;
  let fail = 0;
  let totalMs = 0;

  for (let run = 1; run <= RUNS; run++) {
    for (const task of tasks) {
      const r = await askModel(task.prompt, {
        num_thread: scenario.num_thread,
        num_ctx: scenario.num_ctx,
        num_predict: scenario.num_predict,
        temperature: scenario.temperature,
      });
      totalMs += r.elapsedMs || 0;
      if (!r.ok) {
        fail++;
        rows.push({
          task: task.id,
          run,
          ok: false,
          latencyMs: r.elapsedMs,
          note: r.error,
        });
        continue;
      }

      try {
        const fn = loadFunctionFromTs(r.content, task.functionName);
        task.validate(fn);
        pass++;
        rows.push({
          task: task.id,
          run,
          ok: true,
          latencyMs: r.elapsedMs,
          note: 'pass',
        });
      } catch (err) {
        fail++;
        rows.push({
          task: task.id,
          run,
          ok: false,
          latencyMs: r.elapsedMs,
          note: String(err?.message || err).slice(0, 140),
        });
      }
    }
  }

  const total = pass + fail;
  return {
    name: scenario.name,
    rows,
    summary: {
      scenario: scenario.name,
      totalCases: total,
      pass,
      fail,
      passRate: `${((pass * 100) / (total || 1)).toFixed(0)}%`,
      avgLatencyMs: Math.round(totalMs / (total || 1)),
    },
  };
}

async function main() {
  console.log(
    `Phi3 quality benchmark against ${OLLAMA_URL}, model=${MODEL}, runs=${RUNS}, tasks=${tasks.length}`,
  );
  const all = [];
  for (const s of scenarios) {
    console.log(`\nScenario: ${s.name}`);
    const result = await runScenario(s);
    all.push(result);
    for (const row of result.rows) {
      console.log(
        `- ${row.task} run ${row.run}: ${row.ok ? 'PASS' : 'FAIL'} (${row.latencyMs}ms) ${row.note}`,
      );
    }
  }

  console.log('\nSummary:');
  console.table(all.map((x) => x.summary));

  const best = [...all]
    .sort(
      (a, b) =>
        b.summary.pass - a.summary.pass ||
        a.summary.avgLatencyMs - b.summary.avgLatencyMs,
    )[0];
  console.log(`Best scenario by quality: ${best.summary.scenario}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
