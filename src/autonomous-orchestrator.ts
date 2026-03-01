import {
  appendAutonomousSubsteps,
  completeAutonomousStep,
  failAutonomousStep,
  getAutonomousStepsForTask,
  getLatestAutonomousDecisionForTask,
  getRunnableAutonomousSteps,
  listPausedAutonomousTasks,
  logAutonomousDecision,
  markAutonomousStepInProgress,
  recoverStaleInProgressAutonomousSteps,
  requeueAutonomousStepWithInstructions,
  refreshAutonomousTaskStatus,
  setAutonomousTaskPausedWithReason,
} from './db.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, TASK_MAX_FILES_PER_STEP } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const AUTONOMOUS_POLL_INTERVAL_MS = 15000;
const STALE_IN_PROGRESS_RECOVERY_MS = 9 * 60 * 1000;
const MAINTENANCE_FLAG_PATH = path.join(DATA_DIR, 'maintenance.flag');
let loopRunning = false;

interface OrchestratorDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    forcedModel?: 'local' | 'claude' | 'gemini' | 'openrouter',
    messageCount?: number,
    chatMode?: 'default' | 'ateam' | 'claude',
    projectId?: string,
    allowForcedFallback?: boolean,
  ) => Promise<{ text: string; source: string } | null>;
  resolveGroupByFolder: (folder: string) => RegisteredGroup | undefined;
  getClaudeExecutionHealth: (
    groupFolder: string,
  ) => Promise<{
    healthy: boolean;
    mode: string;
    reason: string;
  }>;
}

interface PlannedSubstep {
  title: string;
  instructions: string;
  requiresVerification?: boolean;
  executor?: 'qwen' | 'gemini' | 'openrouter';
}

type VersionBumpLevel = 'none' | 'patch' | 'minor' | 'major' | 'invalid';

function truncate(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parseJsonBlock(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const arrStart = candidate.indexOf('[');
    const arrEnd = candidate.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      return JSON.parse(candidate.slice(arrStart, arrEnd + 1));
    }
    const objStart = candidate.indexOf('{');
    const objEnd = candidate.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      return JSON.parse(candidate.slice(objStart, objEnd + 1));
    }
    return null;
  }
}

function normalizeSubsteps(raw: unknown): PlannedSubstep[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { subtasks?: unknown[] }).subtasks)
      ? (raw as { subtasks: unknown[] }).subtasks
      : [];

  return arr
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => {
      const rawExecutor = String(s.executor || '').toLowerCase();
      const executor: 'qwen' | 'gemini' | 'openrouter' =
        rawExecutor === 'gemini'
          ? 'gemini'
          : rawExecutor === 'openrouter'
            ? 'openrouter'
            : 'qwen';
      return {
        title: String(s.title || '').trim(),
        instructions: String(s.instructions || s.prompt || '').trim(),
        requiresVerification: Boolean(s.requiresVerification),
        executor,
      };
    })
    .filter((s) => s.title.length > 0 && s.instructions.length > 0);
}

function shouldRequireVerification(text: string): boolean {
  const pattern =
    /\b(architect|architecture|tradeoff|schema|database design|infra|infrastructure|security model|api design|system design)\b/i;
  return pattern.test(text);
}

function isHighImpactDecision(text: string): boolean {
  return /\b(schema|migration|database|auth|security|api|endpoint|deploy|infrastructure|env|payment|permission|access control|multi-file|architecture)\b/i.test(
    text,
  );
}

function isAteamTask(projectName: string | null): boolean {
  return typeof projectName === 'string' && projectName.startsWith('ateam::');
}

function isClaudeOwnedTask(projectName: string | null): boolean {
  return typeof projectName === 'string' && projectName.startsWith('handler::claude::');
}

function normalizeProjectId(projectName: string | null, fallback: string): string {
  if (!projectName) return fallback;
  return projectName.replace(/^handler::claude::/, '');
}

function buildAteamDecisionPrompt(title: string, instructions: string): string {
  return [
    '[ATEAM:DECISION]',
    `Task title: ${title}`,
    '',
    'Return ONLY JSON:',
    '{"subtasks":[{"title":"...","instructions":"...","requiresVerification":false,"executor":"qwen|gemini|openrouter"}],"decision":"...","risks":["..."]}',
    '',
    'Rules:',
    '- 4 to 12 subtasks.',
    '- Prefer qwen for small code steps.',
    '- Use gemini/openrouter executor for heavy design, broad refactors, or steps likely too heavy for qwen.',
    '- Subtasks must be executable and ordered.',
    '- Focus on practical delivery.',
    '- No markdown.',
    '',
    `Task:\n${instructions}`,
  ].join('\n');
}

function buildAteamExecutionPrompt(
  stepTitle: string,
  stepInstructions: string,
  decision: string,
): string {
  return [
    '[ATEAM:EXECUTION]',
    `Execute step: ${stepTitle}`,
    '',
    'You are qwen/local autonomous developer.',
    'If step is too large, return JSON subtasks only:',
    '{"subtasks":[{"title":"...","instructions":"...","requiresVerification":false}]}',
    '',
    'Otherwise execute and return:',
    'Result',
    'Files changed',
    'Checks run',
    '',
    `Decision context:\n${decision || 'No external decision context.'}`,
    '',
    `Step instructions:\n${stepInstructions}`,
  ].join('\n');
}

function buildAteamSplitPrompt(
  stepTitle: string,
  stepInstructions: string,
): string {
  return [
    '[ATEAM:DECISION]',
    `Split this step into smaller subtasks executable on limited local model resources.`,
    `Step title: ${stepTitle}`,
    '',
    'Return ONLY JSON:',
    '{"subtasks":[{"title":"...","instructions":"...","requiresVerification":false,"executor":"qwen|gemini|openrouter"}]}',
    '',
    'Rules:',
    '- 2 to 8 subtasks.',
    '- Keep each subtask small, concrete, and testable.',
    '- Prefer qwen executor unless a step clearly needs stronger model reasoning.',
    '- No markdown.',
    '',
    `Step:\n${stepInstructions}`,
  ].join('\n');
}

function buildAteamReviewPrompt(
  stepTitle: string,
  stepInstructions: string,
  draft: string,
  changedFiles: string[],
  diffPatch: string,
): string {
  return [
    '[ATEAM:SENIOR_REVIEW]',
    'Review qwen output using diff-first approach (strict).',
    'You MUST evaluate only the listed changed files and provided diff.',
    'Respond in one of these forms:',
    'VERDICT: APPROVED - <short reason>',
    'VERDICT: REJECTED - <short actionable fixes>',
    'FILES_CHECKED: <comma-separated paths from changed files list>',
    'If no changed files: VERDICT: APPROVED - no_diff',
    'FILES_CHECKED: none',
    '',
    `Step: ${stepTitle}`,
    `Instructions:\n${stepInstructions}`,
    '',
    `Changed files:\n${changedFiles.length > 0 ? changedFiles.join('\n') : '(none)'}`,
    '',
    `Diff:\n${diffPatch || '(none)'}`,
    '',
    `Draft output:\n${draft}`,
  ].join('\n');
}

function parseReviewVerdict(text: string): {
  approved: boolean;
  note: string;
  filesChecked: string[];
} {
  const upper = text.toUpperCase();
  const filesLine = text
    .split('\n')
    .find((l) => l.toUpperCase().startsWith('FILES_CHECKED:'));
  const filesChecked = filesLine
    ? filesLine
        .split(':')
        .slice(1)
        .join(':')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (upper.includes('VERDICT: REJECTED')) {
    return { approved: false, note: truncate(text, 600), filesChecked };
  }
  if (upper.includes('VERDICT: APPROVED')) {
    return { approved: true, note: truncate(text, 600), filesChecked };
  }
  if (upper.includes('REJECT')) {
    return { approved: false, note: truncate(text, 600), filesChecked };
  }
  return { approved: true, note: truncate(text, 600), filesChecked };
}

function addExecutorPrefix(instructions: string, executor: 'qwen' | 'gemini' | 'openrouter'): string {
  return `[EXECUTOR:${executor}]\n${instructions}`;
}

function parseExecutorHint(instructions: string): {
  executor: 'qwen' | 'gemini' | 'openrouter';
  cleanInstructions: string;
} {
  const m = instructions.match(/^\s*\[EXECUTOR:(qwen|gemini|openrouter)\]\s*\n?/i);
  if (!m) return { executor: 'qwen', cleanInstructions: instructions };
  const executor = m[1].toLowerCase() as 'qwen' | 'gemini' | 'openrouter';
  const cleanInstructions = instructions.slice(m[0].length).trim();
  return { executor, cleanInstructions };
}

function normalizeStepIdentity(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

function isDegenerateSingleSplit(
  stepTitle: string,
  stepInstructions: string,
  substeps: PlannedSubstep[],
): boolean {
  if (substeps.length !== 1) return false;
  const child = substeps[0];
  const parentTitle = normalizeStepIdentity(stepTitle);
  const parentInstructions = normalizeStepIdentity(stepInstructions);
  const childTitle = normalizeStepIdentity(child.title);
  const childInstructions = normalizeStepIdentity(child.instructions);
  return childTitle === parentTitle && childInstructions === parentInstructions;
}

function isTooHeavyForQwen(stepTitle: string, stepInstructions: string): boolean {
  const text = `${stepTitle}\n${stepInstructions}`;
  if (text.length > 1400) return true;
  if ((text.match(/\b(and|then|also|plus)\b/gi) || []).length > 10) return true;
  return /\b(multi-file|across multiple files|major refactor|architecture|schema|migration|deploy|infra|security|auth)\b/i.test(
    text,
  );
}

function qwenSignaledOverload(text: string): boolean {
  return /\b(too (large|complex)|can't handle|cannot handle|out of memory|context length|token limit|overload)\b/i.test(
    text,
  );
}

function isClarificationOrBlockerError(text: string): boolean {
  return /\b(blocker|blocked|needs clarification|need clarification|clarify|required clarification|requires clarification|waiting for user|need your input|need guidance|missing required info)\b/i.test(
    text,
  );
}

function isTransientProviderError(text: string): boolean {
  return /\b(resource_exhausted|quota|rate-?limit|temporarily rate-limited|provider returned error|review unavailable|senior review unavailable|all models failed|try again later|timeout|network|503|429)\b/i.test(
    text,
  );
}

function isClaudeQuotaPauseReason(error: string | null): boolean {
  return typeof error === 'string' && error.startsWith('Paused: Claude unavailable');
}

async function maybeResumeQuotaPausedTasks(deps: OrchestratorDeps): Promise<void> {
  const pausedTasks = listPausedAutonomousTasks(20);
  for (const task of pausedTasks) {
    const steps = getAutonomousStepsForTask(task.id);
    const isQuotaPaused = steps.some(
      (s) => s.status === 'blocked' && isClaudeQuotaPauseReason(s.error),
    );
    if (!isQuotaPaused) continue;

    const health = await deps.getClaudeExecutionHealth(task.group_folder);
    if (!health.healthy) continue;

    const resumed = setAutonomousTaskPausedWithReason(task.id, false, 'auto-resume');
    if (!resumed) continue;
    await deps.sendMessage(
      task.chat_jid,
      `Put: Resumed task "${task.title}" because Claude is healthy again (${health.mode}).`,
    );
  }
}

function nextExecutorOnFailure(executor: 'qwen' | 'gemini' | 'openrouter'): 'qwen' | 'gemini' | 'openrouter' | null {
  if (executor === 'qwen') return 'gemini';
  if (executor === 'gemini') return 'openrouter';
  return null;
}

function maxAttemptsForExecutor(executor: 'qwen' | 'gemini' | 'openrouter'): number {
  if (executor === 'qwen') return 2;
  return 2;
}

function maybeRunTypecheckGate(groupFolder: string, changedFiles: string[]): { ok: boolean; message: string } {
  const hasCode = changedFiles.some((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
  if (!hasCode) return { ok: true, message: 'no-code-diff' };

  const root = process.cwd();
  const jambutterDir = `${root}/groups/${groupFolder}/projects/jambutter`;
  const groupDir = `${root}/groups/${groupFolder}`;

  let targetDir = '';
  if (fs.existsSync(`${jambutterDir}/package.json`)) {
    targetDir = jambutterDir;
  } else if (fs.existsSync(`${groupDir}/package.json`)) {
    targetDir = groupDir;
  } else {
    return { ok: true, message: 'no-package-for-typecheck' };
  }

  try {
    execSync('npm run -s typecheck', {
      cwd: targetDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 180000,
    });
    return { ok: true, message: `typecheck_passed@${targetDir}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `typecheck_failed@${targetDir}: ${truncate(msg, 400)}` };
  }
}

function isGitPublishRelatedStep(text: string): boolean {
  return /\b(github|git|repository|repo|remote|push|upload|tag)\b/i.test(text);
}

function maybeRunGitPublishGate(
  groupFolder: string,
  stepTitle: string,
  stepInstructions: string,
): { ok: boolean; message: string } {
  const text = `${stepTitle}\n${stepInstructions}`;
  if (!isGitPublishRelatedStep(text)) {
    return { ok: true, message: 'not-git-publish-step' };
  }

  const root = process.cwd();
  const groupDir = path.join(root, 'groups', groupFolder);
  if (!fs.existsSync(path.join(groupDir, '.git'))) {
    return { ok: false, message: `git_repo_missing@${groupDir}` };
  }

  const needsRemote = /\b(set remote|remote origin|create .*repo|create .*repository|push|upload|github)\b/i.test(
    text,
  );
  let remoteOrigin = '';
  try {
    remoteOrigin = execSync(`git -C ${JSON.stringify(groupDir)} remote get-url origin`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    remoteOrigin = '';
  }
  if (needsRemote && !remoteOrigin) {
    return { ok: false, message: `origin_remote_missing@${groupDir}` };
  }

  const needsUpstream = /\b(push|upload)\b/i.test(text);
  if (needsUpstream) {
    try {
      const upstream = execSync(
        `git -C ${JSON.stringify(groupDir)} rev-parse --abbrev-ref --symbolic-full-name @{u}`,
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      if (!upstream) {
        return { ok: false, message: `upstream_missing@${groupDir}` };
      }
    } catch {
      return { ok: false, message: `upstream_missing@${groupDir}` };
    }
  }

  const needsTag = /\b(tag|version tag)\b/i.test(text);
  if (needsTag) {
    const tags = execSync(`git -C ${JSON.stringify(groupDir)} tag --list`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tags.length === 0) {
      return { ok: false, message: `tag_missing@${groupDir}` };
    }
  }

  return { ok: true, message: `git_publish_ok@${groupDir}` };
}

function isCodeLikeFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|html|py|rb|go|rs|java|kt|swift|php|sh)$/i.test(
    filePath,
  );
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function detectVersionBump(previousVersion: string, currentVersion: string): VersionBumpLevel {
  const prev = parseSemver(previousVersion);
  const curr = parseSemver(currentVersion);
  if (!prev || !curr) return 'invalid';
  if (
    curr.major === prev.major &&
    curr.minor === prev.minor &&
    curr.patch === prev.patch
  ) {
    return 'none';
  }
  if (curr.major > prev.major) return 'major';
  if (curr.major === prev.major && curr.minor > prev.minor) return 'minor';
  if (
    curr.major === prev.major &&
    curr.minor === prev.minor &&
    curr.patch > prev.patch
  ) {
    return 'patch';
  }
  return 'invalid';
}

function isMajorBumpVerballyRequested(text: string): boolean {
  return /\b(major(\s+version|\s+bump)?|breaking(\s+change)?|bump\s+to\s+v?\d+\.0\.0)\b/i.test(
    text,
  );
}

function isFeatureWork(text: string): boolean {
  return /\b(new feature|feature\b|implement\b|add\b|introduce\b|create\b|build\b|support\b|enhancement\b|epic\b)\b/i.test(
    text,
  );
}

function isFixOrSmallChange(text: string): boolean {
  return /\b(fix\b|bug\b|hotfix\b|patch\b|small change\b|minor change\b|tweak\b|adjust\b|refactor\b|cleanup\b|polish\b)\b/i.test(
    text,
  );
}

function requiredBumpForTaskContext(text: string): 'patch' | 'minor' {
  if (isFeatureWork(text) && !isFixOrSmallChange(text)) return 'minor';
  return 'patch';
}

function meetsMinimumBump(
  detected: VersionBumpLevel,
  minimum: 'patch' | 'minor',
): boolean {
  if (minimum === 'patch') return detected === 'patch' || detected === 'minor' || detected === 'major';
  return detected === 'minor' || detected === 'major';
}

function readPackageVersion(packageJsonPath: string): {
  name: string;
  version: string;
} | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    const version = String(parsed.version || '').trim();
    if (!version) return null;
    const name = String(parsed.name || path.basename(path.dirname(packageJsonPath))).trim();
    return { name, version };
  } catch {
    return null;
  }
}

function readVersionFromHead(packageJsonRelPath: string): string | null {
  try {
    const raw = execSync(`git show HEAD:${packageJsonRelPath}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: process.cwd(),
    });
    const parsed = JSON.parse(raw) as { version?: string };
    const version = String(parsed.version || '').trim();
    return version || null;
  } catch {
    return null;
  }
}

function findNearestPackageJsonForFile(
  groupFolder: string,
  changedFile: string,
): string | null {
  const root = process.cwd();
  const groupRoot = path.join(root, 'groups', groupFolder);
  const absChanged = path.join(root, changedFile);
  let dir = absChanged;
  try {
    const stat = fs.existsSync(absChanged) ? fs.statSync(absChanged) : null;
    dir = stat?.isDirectory() ? absChanged : path.dirname(absChanged);
  } catch {
    dir = path.dirname(absChanged);
  }

  while (dir.startsWith(groupRoot)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      return path.relative(root, pkg).replace(/\\/g, '/');
    }
    if (dir === groupRoot) break;
    dir = path.dirname(dir);
  }
  return null;
}

function collectImpactedPackages(groupFolder: string, changedFiles: string[]): string[] {
  const packages = new Set<string>();
  for (const file of changedFiles) {
    if (!isCodeLikeFile(file)) continue;
    const nearest = findNearestPackageJsonForFile(groupFolder, file);
    if (nearest) packages.add(nearest);
  }
  return [...packages];
}

function collectVersionTags(groupFolder: string, changedFiles: string[]): string[] {
  const root = process.cwd();
  const impacted = collectImpactedPackages(groupFolder, changedFiles);
  const tags: string[] = [];
  for (const relPkgPath of impacted) {
    const absPkgPath = path.join(root, relPkgPath);
    const current = readPackageVersion(absPkgPath);
    if (!current) continue;
    tags.push(`${current.name}@${current.version}`);
  }
  return tags;
}

function maybeRunVersionGate(
  groupFolder: string,
  changedFiles: string[],
  minimumRequired: 'patch' | 'minor',
  allowMajor: boolean,
): { ok: boolean; message: string; versionTags: string[] } {
  const hasCode = changedFiles.some((f) => isCodeLikeFile(f));
  if (!hasCode) {
    return { ok: true, message: 'no-code-diff', versionTags: [] };
  }

  const root = process.cwd();
  const impacted = collectImpactedPackages(groupFolder, changedFiles);
  if (impacted.length === 0) {
    return { ok: true, message: 'no-package-for-version-gate', versionTags: [] };
  }

  const violations: string[] = [];
  const tags: string[] = [];
  for (const relPkgPath of impacted) {
    const absPkgPath = path.join(root, relPkgPath);
    const current = readPackageVersion(absPkgPath);
    if (!current) {
      violations.push(`${relPkgPath} (missing/invalid version)`);
      continue;
    }
    tags.push(`${current.name}@${current.version}`);

    const previousVersion = readVersionFromHead(relPkgPath);
    if (!previousVersion) {
      continue;
    }

    const bump = detectVersionBump(previousVersion, current.version);
    if (bump === 'invalid') {
      violations.push(
        `${relPkgPath} invalid bump (${previousVersion} -> ${current.version})`,
      );
      continue;
    }
    if (bump === 'none') {
      violations.push(`${relPkgPath} unchanged (${current.version})`);
      continue;
    }
    if (bump === 'major' && !allowMajor) {
      violations.push(
        `${relPkgPath} major bump not allowed without explicit request (${previousVersion} -> ${current.version})`,
      );
      continue;
    }
    if (!meetsMinimumBump(bump, minimumRequired)) {
      violations.push(
        `${relPkgPath} requires at least ${minimumRequired} bump (${previousVersion} -> ${current.version})`,
      );
    }
  }

  if (violations.length > 0) {
    return {
      ok: false,
      message: `version_policy_violation: ${violations.join(', ')}`,
      versionTags: tags,
    };
  }

  return {
    ok: true,
    message: `version_policy_ok(min=${minimumRequired},allowMajor=${allowMajor}): ${tags.join(', ')}`,
    versionTags: tags,
  };
}

async function runPreferredModel(
  deps: OrchestratorDeps,
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  model: 'local' | 'gemini' | 'openrouter',
  projectId: string,
): Promise<{ text: string; source: string } | null> {
  const out = await deps.runAgent(group, prompt, chatJid, model, 1, 'default', projectId);
  if (!out) return null;
  const source = out.source.toLowerCase();
  if (model === 'local') {
    if (source.includes('phi3') || source.includes('qwen') || source.includes('local')) return out;
    return null;
  }
  return source.includes(model) ? out : null;
}

function listGroupDiffFiles(groupFolder: string): string[] {
  try {
    const out = execSync(`git diff --name-only -- groups/${groupFolder}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: process.cwd(),
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getGroupDiffPatch(groupFolder: string): string {
  try {
    const out = execSync(`git diff --unified=2 -- groups/${groupFolder}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
    });
    return out.slice(0, 12000);
  } catch {
    return '';
  }
}

function buildPlanningPrompt(title: string, instructions: string): string {
  return [
    `You are planning autonomous execution for task: "${title}".`,
    '',
    'Return ONLY JSON with this shape:',
    '{"subtasks":[{"title":"...","instructions":"...","requiresVerification":false}]}',
    '',
    'Rules:',
    '- 3 to 8 subtasks.',
    '- Each subtask must be independently executable.',
    '- If a subtask is architectural/high-impact, set requiresVerification=true.',
    '- Do not include markdown or prose.',
    '',
    `Task:\n${instructions}`,
  ].join('\n');
}

function buildExecutionPrompt(stepTitle: string, stepInstructions: string): string {
  return [
    `Execute this autonomous step: "${stepTitle}"`,
    '',
    'If this step is still too large, return ONLY JSON in this shape:',
    '{"subtasks":[{"title":"...","instructions":"...","requiresVerification":false}]}',
    '',
    'Otherwise, complete the step directly and return the implementation/result summary.',
    'When making architecture-level decisions, explicitly include a short line beginning with "DECISION:".',
    '',
    `Step instructions:\n${stepInstructions}`,
  ].join('\n');
}

async function handlePlanStep(
  deps: OrchestratorDeps,
  group: RegisteredGroup,
  taskTitle: string,
  taskPrompt: string,
  stepId: string,
  taskId: string,
  chatJid: string,
  ateamMode: boolean,
  projectId: string,
  claudeOwned: boolean,
): Promise<void> {
  let response: { text: string; source: string } | null = null;
  let decisionSummary = '';
  const mustUseExternalDecision = isHighImpactDecision(
    `${taskTitle}\n${taskPrompt}`,
  );

  if (ateamMode) {
    response =
      (await runPreferredModel(deps, group, buildAteamDecisionPrompt(taskTitle, taskPrompt), chatJid, 'gemini', projectId)) ||
      (await runPreferredModel(deps, group, buildAteamDecisionPrompt(taskTitle, taskPrompt), chatJid, 'openrouter', projectId)) ||
      (mustUseExternalDecision
        ? null
        : await runPreferredModel(
            deps,
            group,
            buildAteamDecisionPrompt(taskTitle, taskPrompt),
            chatJid,
            'local',
            projectId,
          ));
    decisionSummary = response?.text || '';
    if (!response && mustUseExternalDecision) {
      throw new Error(
        'High-impact decision requires Gemini/OpenRouter but both are unavailable. Please provide direction in WhatsApp.',
      );
    }
  } else {
    if (claudeOwned) {
      response =
        (await deps.runAgent(
          group,
          buildPlanningPrompt(taskTitle, taskPrompt),
          chatJid,
          'claude',
          1,
          'default',
          projectId,
          true,
        )) ||
        (await deps.runAgent(
          group,
          buildPlanningPrompt(taskTitle, taskPrompt),
          chatJid,
          undefined,
          1,
          'default',
          projectId,
        ));
    } else {
      response =
        (await deps.runAgent(group, buildPlanningPrompt(taskTitle, taskPrompt), chatJid, 'local', 1, 'default', projectId)) ||
        (await deps.runAgent(group, buildPlanningPrompt(taskTitle, taskPrompt), chatJid, undefined, 1, 'default', projectId));
    }
  }

  if (!response) {
    throw new Error('Planner returned no response');
  }

  const parsed = parseJsonBlock(response.text);
  let substeps = normalizeSubsteps(parsed);
  if (substeps.length === 0) {
    substeps = [
      {
        title: `Execute task: ${taskTitle}`,
        instructions: taskPrompt,
        requiresVerification: shouldRequireVerification(taskPrompt),
      },
    ];
  }

  appendAutonomousSubsteps({
    taskId,
    parentStepId: stepId,
    substeps: substeps.map((s) => ({
      ...s,
      instructions: addExecutorPrefix(s.instructions, s.executor || 'qwen'),
    })),
  });

  completeAutonomousStep({
    stepId,
    summary: `Planned ${substeps.length} executable steps${ateamMode ? ` via ${response.source}` : ''}`,
    requiresVerification: false,
    verifiedBy: ateamMode
      ? response.source.includes('gemini')
        ? 'gemini'
        : response.source.includes('openrouter')
          ? 'openrouter'
          : 'phi3'
      : 'phi3',
    verificationStatus: 'not_required',
  });

  if (ateamMode && decisionSummary) {
    logAutonomousDecision({
      task_id: taskId,
      step_id: stepId,
      decision: truncate(decisionSummary, 800),
      confidence: 'medium',
      requires_verification: false,
      verified_by: response.source.includes('gemini')
        ? 'gemini'
        : response.source.includes('openrouter')
          ? 'openrouter'
          : 'phi3',
      verification_status: 'confirmed',
    });
  }

  await deps.sendMessage(
    chatJid,
    `Put: Plan created with ${substeps.length} steps for "${taskTitle}"${ateamMode ? ` [decision: ${response.source}]` : ''}.`,
  );
}

async function handleExecuteStep(
  deps: OrchestratorDeps,
  group: RegisteredGroup,
  step: { id: string; title: string; instructions: string; attempt_count: number; task_id: string },
  taskTitle: string,
  chatJid: string,
  ateamMode: boolean,
  projectId: string,
  claudeOwned: boolean,
  allowMajorVersionBump: boolean,
): Promise<void> {
  const latestDecision = getLatestAutonomousDecisionForTask(step.task_id);
  const decisionText = latestDecision?.decision || '';
  const parsedExecutor = parseExecutorHint(step.instructions);
  const stepInstructions = parsedExecutor.cleanInstructions;
  const hintedExecutor = parsedExecutor.executor;
  const stepNeedsExternalDecision = ateamMode && isHighImpactDecision(`${step.title}\n${stepInstructions}`);
  if (
    stepNeedsExternalDecision &&
    (!latestDecision || latestDecision.verified_by === 'phi3')
  ) {
    const stepDecision =
      (await runPreferredModel(
        deps,
        group,
        buildAteamDecisionPrompt(step.title, stepInstructions),
        chatJid,
        'gemini',
        projectId,
      )) ||
      (await runPreferredModel(
        deps,
        group,
        buildAteamDecisionPrompt(step.title, stepInstructions),
        chatJid,
        'openrouter',
        projectId,
      ));
    if (!stepDecision) {
      throw new Error(
        'Step needs high-impact decision but Gemini/OpenRouter unavailable. Please provide guidance in WhatsApp.',
      );
    }
    logAutonomousDecision({
      task_id: step.task_id,
      step_id: step.id,
      decision: truncate(stepDecision.text, 800),
      confidence: 'medium',
      requires_verification: false,
      verified_by: stepDecision.source.includes('gemini') ? 'gemini' : 'openrouter',
      verification_status: 'confirmed',
    });
  }
  const prompt = ateamMode
    ? buildAteamExecutionPrompt(step.title, stepInstructions, decisionText)
    : buildExecutionPrompt(step.title, stepInstructions);

  if (ateamMode && hintedExecutor === 'qwen' && isTooHeavyForQwen(step.title, stepInstructions)) {
    const split =
      (await runPreferredModel(deps, group, buildAteamSplitPrompt(step.title, stepInstructions), chatJid, 'gemini', projectId)) ||
      (await runPreferredModel(deps, group, buildAteamSplitPrompt(step.title, stepInstructions), chatJid, 'openrouter', projectId));
    if (split) {
      const splitParsed = parseJsonBlock(split.text);
      const splitSubsteps = normalizeSubsteps(splitParsed);
      if (splitSubsteps.length > 0) {
        appendAutonomousSubsteps({
          taskId: step.task_id,
          parentStepId: step.id,
          substeps: splitSubsteps.map((s) => ({
            ...s,
            instructions: addExecutorPrefix(s.instructions, s.executor || 'qwen'),
          })),
        });
        completeAutonomousStep({
          stepId: step.id,
          summary: `Split heavy step into ${splitSubsteps.length} subtasks`,
          requiresVerification: false,
          verifiedBy: split.source.includes('gemini') ? 'gemini' : 'openrouter',
          verificationStatus: 'not_required',
        });
        await deps.sendMessage(
          chatJid,
          `Put: Step "${step.title}" was heavy for qwen and split into ${splitSubsteps.length} smaller subtasks via ${split.source}.`,
        );
        return;
      }
    }
  }

  const response =
    hintedExecutor === 'gemini'
      ? await runPreferredModel(deps, group, prompt, chatJid, 'gemini', projectId)
      : hintedExecutor === 'openrouter'
        ? await runPreferredModel(deps, group, prompt, chatJid, 'openrouter', projectId)
        : claudeOwned
          ? (await deps.runAgent(
              group,
              prompt,
              chatJid,
              'claude',
              1,
              'default',
              projectId,
              true,
            )) ||
            (await deps.runAgent(group, prompt, chatJid, undefined, 1, 'default', projectId))
          : (await runPreferredModel(deps, group, prompt, chatJid, 'local', projectId)) ||
            (await deps.runAgent(group, prompt, chatJid, undefined, 1, 'default', projectId));

  if (!response) {
    throw new Error('Executor returned no response');
  }

  const parsed = parseJsonBlock(response.text);
  const substeps = normalizeSubsteps(parsed);
  if (substeps.length > 0) {
    if (isDegenerateSingleSplit(step.title, stepInstructions, substeps)) {
      throw new Error(
        'Degenerate split detected (single substep identical to parent step). Escalating executor.',
      );
    }
    appendAutonomousSubsteps({
      taskId: step.task_id,
      parentStepId: step.id,
      substeps: substeps.map((s) => ({
        ...s,
        instructions: addExecutorPrefix(s.instructions, s.executor || 'qwen'),
      })),
    });
    completeAutonomousStep({
      stepId: step.id,
      summary: `Split into ${substeps.length} substeps`,
      requiresVerification: false,
      verifiedBy: hintedExecutor === 'qwen' ? 'phi3' : hintedExecutor,
      verificationStatus: 'not_required',
    });
    await deps.sendMessage(
      chatJid,
      `Put: Step "${step.title}" was split into ${substeps.length} smaller steps and queued [exec: ${response.source}].`,
    );
    return;
  }

  if (ateamMode && hintedExecutor === 'qwen' && qwenSignaledOverload(response.text)) {
    const split =
      (await runPreferredModel(deps, group, buildAteamSplitPrompt(step.title, stepInstructions), chatJid, 'gemini', projectId)) ||
      (await runPreferredModel(deps, group, buildAteamSplitPrompt(step.title, stepInstructions), chatJid, 'openrouter', projectId));
    if (!split) {
      throw new Error(
        'Qwen reported overload and no decision model available to split further. Please provide guidance in WhatsApp.',
      );
    }
    const splitParsed = parseJsonBlock(split.text);
    const splitSubsteps = normalizeSubsteps(splitParsed);
    if (splitSubsteps.length === 0) {
      throw new Error(
        'Qwen reported overload and split attempt returned no actionable subtasks.',
      );
    }
    appendAutonomousSubsteps({
      taskId: step.task_id,
      parentStepId: step.id,
      substeps: splitSubsteps.map((s) => ({
        ...s,
        instructions: addExecutorPrefix(s.instructions, s.executor || 'qwen'),
      })),
    });
    completeAutonomousStep({
      stepId: step.id,
      summary: `Split overloaded step into ${splitSubsteps.length} subtasks`,
      requiresVerification: false,
      verifiedBy: split.source.includes('gemini') ? 'gemini' : 'openrouter',
      verificationStatus: 'not_required',
    });
    await deps.sendMessage(
      chatJid,
      `Put: Qwen flagged overload on "${step.title}". Split into ${splitSubsteps.length} subtasks via ${split.source}.`,
    );
    return;
  }

  let finalText = response.text;
  let reviewSource = '';
  let deferredAteamReview = false;
  let changedFilesForGate: string[] = listGroupDiffFiles(group.folder);
  let versionTags: string[] = [];
  if (ateamMode) {
    const changedFiles = changedFilesForGate;
    changedFilesForGate = changedFiles;
    if (
      hintedExecutor === 'qwen' &&
      changedFiles.length > TASK_MAX_FILES_PER_STEP
    ) {
      throw new Error(
        `Qwen step changed ${changedFiles.length} files (limit ${TASK_MAX_FILES_PER_STEP}). Split into smaller subtasks.`,
      );
    }
    const diffPatch = getGroupDiffPatch(group.folder);
    const reviewPrompt = buildAteamReviewPrompt(
      step.title,
      stepInstructions,
      finalText,
      changedFiles,
      diffPatch,
    );

    const reviewCandidates: Array<'openrouter' | 'gemini'> = ['openrouter', 'gemini'];
    let review: { text: string; source: string } | null = null;
    let verdict:
      | {
          approved: boolean;
          note: string;
          filesChecked: string[];
        }
      | null = null;

    for (const reviewer of reviewCandidates) {
      const candidate = await runPreferredModel(
        deps,
        group,
        reviewPrompt,
        chatJid,
        reviewer,
        projectId,
      );
      if (!candidate) continue;
      const parsedVerdict = parseReviewVerdict(candidate.text);
      const hasNoDiff = changedFiles.length === 0;
      const filesOk = hasNoDiff
        ? parsedVerdict.filesChecked.some((f) => f.toLowerCase() === 'none')
        : parsedVerdict.filesChecked.some((f) =>
            changedFiles.some(
              (cf) =>
                cf === f ||
                cf.endsWith(`/${f}`) ||
                cf.toLowerCase() === f.toLowerCase(),
            ),
          );
      if (!filesOk) {
        continue;
      }
      review = candidate;
      verdict = parsedVerdict;
      break;
    }

    if (!review || !verdict) {
      // Trust qwen/local output as last resort, but queue deferred senior review.
      deferredAteamReview = true;
      reviewSource = 'deferred-review';
      const deferredPayload = {
        kind: 'ateam_deferred_review' as const,
        stepTitle: step.title,
        stepInstructions: truncate(stepInstructions, 1800),
        draft: truncate(finalText, 4000),
        changedFiles: changedFiles.slice(0, 60),
        diffPatch: truncate(diffPatch, 9000),
      };
      logAutonomousDecision({
        task_id: step.task_id,
        step_id: step.id,
        decision: `ATEAM_DEFERRED_REVIEW:${JSON.stringify(deferredPayload)}`,
        confidence: 'low',
        requires_verification: true,
        verified_by: 'phi3',
        verification_status: 'pending',
      });
      await deps.sendMessage(
        chatJid,
        `Put: Reviewer unavailable right now. Accepting "${step.title}" provisionally and queuing deferred review when Gemini/OpenRouter/Claude is available.`,
      );
    }

    if (verdict && !verdict.approved) {
      const fixPrompt = [
        '[ATEAM:EXECUTION]',
        'Reviewer rejected previous output. Fix and return revised final output.',
        `Reviewer feedback:\n${verdict.note}`,
        '',
        `Step instructions:\n${stepInstructions}`,
      ].join('\n');
      const fixed =
        claudeOwned
          ? (await deps.runAgent(
              group,
              fixPrompt,
              chatJid,
              'claude',
              1,
              'default',
              projectId,
              true,
            )) ||
            (await deps.runAgent(group, fixPrompt, chatJid, undefined, 1, 'default', projectId))
          : (await runPreferredModel(deps, group, fixPrompt, chatJid, 'local', projectId)) ||
            (await deps.runAgent(group, fixPrompt, chatJid, undefined, 1, 'default', projectId));
      if (!fixed) {
        throw new Error(`Review rejected and fix pass failed: ${verdict.note}`);
      }
      finalText = fixed.text;
    }
  }

  if (ateamMode) {
    const gate = maybeRunTypecheckGate(group.folder, changedFilesForGate);
    if (!gate.ok) {
      throw new Error(`Quality gate failed: ${gate.message}`);
    }
  }

  const taskContextText = [
    taskTitle,
    step.title,
    stepInstructions,
  ].join('\n');
  const minBump: 'patch' | 'minor' = requiredBumpForTaskContext(taskContextText);
  const versionGate = maybeRunVersionGate(
    group.folder,
    changedFilesForGate,
    minBump,
    allowMajorVersionBump,
  );
  if (!versionGate.ok) {
    throw new Error(`Version gate failed: ${versionGate.message}`);
  }
  versionTags = versionGate.versionTags;

  const gitGate = maybeRunGitPublishGate(group.folder, step.title, stepInstructions);
  if (!gitGate.ok) {
    throw new Error(`Git publish gate failed: ${gitGate.message}`);
  }

  const requiresVerification = shouldRequireVerification(
    `${step.title}\n${stepInstructions}\n${finalText}`,
  ) || deferredAteamReview;

  completeAutonomousStep({
    stepId: step.id,
    summary: truncate(finalText, 300),
    requiresVerification,
    verifiedBy:
      hintedExecutor === 'gemini'
        ? 'gemini'
        : hintedExecutor === 'openrouter'
          ? 'openrouter'
          : 'phi3',
    verificationStatus: requiresVerification ? 'pending' : 'not_required',
  });

  if (requiresVerification && !deferredAteamReview) {
    logAutonomousDecision({
      task_id: step.task_id,
      step_id: step.id,
      decision: truncate(response.text, 500),
      confidence: 'medium',
      requires_verification: true,
      verified_by: 'phi3',
      verification_status: 'pending',
    });
  }

  const verificationTag = deferredAteamReview
    ? ' [provisional: deferred senior review queued]'
    : requiresVerification
      ? ' [needs Claude/Gemini verification]'
      : '';
  await deps.sendMessage(
    chatJid,
    `Put: Step done for "${taskTitle}" -> "${step.title}".${verificationTag}${ateamMode && reviewSource ? ` [review: ${reviewSource}]` : ''}${versionTags.length > 0 ? ` [version: ${versionTags.join(', ')}]` : ''} [exec: ${response.source}]\n${truncate(finalText, 500)}`,
  );
}

async function tick(deps: OrchestratorDeps): Promise<void> {
  if (fs.existsSync(MAINTENANCE_FLAG_PATH)) {
    logger.info('Autonomous loop paused by maintenance mode');
    return;
  }

  const staleBefore = new Date(Date.now() - STALE_IN_PROGRESS_RECOVERY_MS).toISOString();
  const recovered = recoverStaleInProgressAutonomousSteps(staleBefore, 20);
  if (recovered.length > 0) {
    const byChat = new Map<string, Array<{ taskTitle: string; stepTitle: string }>>();
    for (const item of recovered) {
      const arr = byChat.get(item.chatJid) || [];
      arr.push({ taskTitle: item.taskTitle, stepTitle: item.stepTitle });
      byChat.set(item.chatJid, arr);
    }
    for (const [chatJid, rows] of byChat.entries()) {
      const sample = rows[0];
      await deps.sendMessage(
        chatJid,
        `Put: Recovered ${rows.length} stale in-progress step(s) after runtime interruption. Resuming queue from "${sample.stepTitle}" in task "${sample.taskTitle}".`,
      );
    }
  }

  await maybeResumeQuotaPausedTasks(deps);
  const runnable = getRunnableAutonomousSteps(2);
  for (const item of runnable) {
    const health = await deps.getClaudeExecutionHealth(item.task.group_folder);
    if (!health.healthy) {
      const paused = setAutonomousTaskPausedWithReason(
        item.task.id,
        true,
        `Claude unavailable (${health.mode}: ${health.reason})`,
      );
      if (paused) {
        await deps.sendMessage(
          item.task.chat_jid,
          `Put: Paused task "${item.task.title}" because Claude is not healthy enough to safely continue (${health.mode}: ${health.reason}). I will auto-resume when healthy again.`,
        );
      }
      continue;
    }

    const group = deps.resolveGroupByFolder(item.task.group_folder);
    if (!group) {
      failAutonomousStep({
        stepId: item.step.id,
        error: `Group folder not found: ${item.task.group_folder}`,
        block: true,
      });
      refreshAutonomousTaskStatus(item.task.id);
      continue;
    }

    markAutonomousStepInProgress(item.step.id);
    const ateamMode = isAteamTask(item.task.project_name);
    const claudeOwned = isClaudeOwnedTask(item.task.project_name);
    const stepExecutor = parseExecutorHint(item.step.instructions).executor;
    await deps.sendMessage(
      item.task.chat_jid,
      `Put: Starting step "${item.step.title}" for task "${item.task.title}"${ateamMode ? ` [Ateam][worker:${stepExecutor}]` : claudeOwned ? ' [handler:claude]' : ''}.`,
    );

    try {
      const projectId = normalizeProjectId(
        item.task.project_name,
        item.task.group_folder,
      );
      if (item.step.step_type === 'plan') {
        await handlePlanStep(
          deps,
          group,
          item.task.title,
          item.task.original_prompt,
          item.step.id,
          item.task.id,
          item.task.chat_jid,
          ateamMode,
          projectId,
          claudeOwned,
        );
      } else {
        await handleExecuteStep(
          deps,
          group,
          item.step,
          item.task.title,
          item.task.chat_jid,
          ateamMode,
          projectId,
          claudeOwned,
          isMajorBumpVerballyRequested(
            `${item.task.title}\n${item.task.original_prompt}`,
          ),
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const currentAttempt = item.step.attempt_count + 1;
      const parsedExec = parseExecutorHint(item.step.instructions);
      const currentExecutor = parsedExec.executor;
      const maxAttempts = maxAttemptsForExecutor(currentExecutor);
      const ateamMode = isAteamTask(item.task.project_name);
      const retryAt = currentAttempt < maxAttempts
        ? new Date(Date.now() + 120000).toISOString()
        : null;

      if (retryAt) {
        failAutonomousStep({
          stepId: item.step.id,
          error: errorMsg,
          retryAt,
          block: false,
        });
      } else if (!ateamMode && isClarificationOrBlockerError(errorMsg)) {
        const paused = setAutonomousTaskPausedWithReason(
          item.task.id,
          true,
          `Needs clarification (${truncate(errorMsg, 180)})`,
        );
        if (paused) {
          await deps.sendMessage(
            item.task.chat_jid,
            `Put: Paused task "${item.task.title}" because it needs clarification/blocker resolution.\nReason: ${truncate(errorMsg, 260)}\nReply with guidance, then run "auto resume ${item.task.id}".`,
          );
        }
        continue;
      } else if (ateamMode && isTransientProviderError(errorMsg)) {
        requeueAutonomousStepWithInstructions({
          stepId: item.step.id,
          instructions: item.step.instructions,
          error: `Transient provider issue: ${errorMsg}`,
          retryAt: new Date(Date.now() + 180000).toISOString(),
          resetAttempts: true,
        });
        await deps.sendMessage(
          item.task.chat_jid,
          `Put: Step "${item.step.title}" hit a transient provider/review issue and was re-queued automatically. Retrying in about 3 minutes.`,
        );
        continue;
      } else if (ateamMode) {
        const nextExecutor = nextExecutorOnFailure(currentExecutor);
        if (nextExecutor) {
          requeueAutonomousStepWithInstructions({
            stepId: item.step.id,
            instructions: addExecutorPrefix(parsedExec.cleanInstructions, nextExecutor),
            error: `Circuit-breaker reassigned from ${currentExecutor} to ${nextExecutor}: ${errorMsg}`,
            retryAt: new Date(Date.now() + 30000).toISOString(),
            resetAttempts: true,
          });
          await deps.sendMessage(
            item.task.chat_jid,
            `Put: Step "${item.step.title}" exceeded retry budget on ${currentExecutor}. Reassigned to ${nextExecutor}.`,
          );
          continue;
        }
        failAutonomousStep({
          stepId: item.step.id,
          error: `All executor retries exhausted: ${errorMsg}`,
          block: true,
        });
      } else {
        failAutonomousStep({
          stepId: item.step.id,
          error: errorMsg,
          block: true,
        });
      }
      await deps.sendMessage(
        item.task.chat_jid,
        `Put: Step "${item.step.title}" failed (${errorMsg}).${retryAt ? ' Retrying soon.' : ' Marked blocked; please provide guidance in WhatsApp if needed.'}`,
      );
    }

    const nextStatus = refreshAutonomousTaskStatus(item.task.id);
    if (nextStatus === 'completed') {
      const completionTags = collectVersionTags(
        item.task.group_folder,
        listGroupDiffFiles(item.task.group_folder),
      );
      await deps.sendMessage(
        item.task.chat_jid,
        `Put: Autonomous task completed -> "${item.task.title}".${completionTags.length > 0 ? ` [version: ${completionTags.join(', ')}]` : ''}`,
      );
    } else if (nextStatus === 'failed') {
      const steps = getAutonomousStepsForTask(item.task.id);
      const blockedStep = [...steps]
        .reverse()
        .find((s) => s.status === 'blocked' && s.error);
      const reason = blockedStep?.error ? `\nReason: ${truncate(blockedStep.error, 320)}` : '';
      await deps.sendMessage(
        item.task.chat_jid,
        `Put: Autonomous task blocked -> "${item.task.title}".${reason}\nUse /ateam why-paused ${item.task.id} for details.`,
      );
    }
  }
}

export function startAutonomousLoop(deps: OrchestratorDeps): void {
  if (loopRunning) {
    logger.debug('Autonomous loop already running, skipping duplicate start');
    return;
  }
  loopRunning = true;
  logger.info('Autonomous orchestrator loop started');

  const loop = async () => {
    try {
      await tick(deps);
    } catch (err) {
      logger.error({ err }, 'Autonomous loop iteration failed');
    }
    setTimeout(loop, AUTONOMOUS_POLL_INTERVAL_MS);
  };

  loop();
}
