import {
  appendAutonomousSubsteps,
  getPendingDecisionVerifications,
  markDecisionVerificationResult,
  PendingDecisionVerification,
  refreshAutonomousTaskStatus,
} from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const VERIFICATION_POLL_INTERVAL_MS = 45000;
let verificationRunning = false;

interface VerificationDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  resolveGroupByFolder: (folder: string) => RegisteredGroup | undefined;
  runWithModel: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    model: 'claude' | 'gemini' | 'openrouter',
  ) => Promise<string | null>;
}

interface DeferredReviewPayload {
  kind: 'ateam_deferred_review';
  stepTitle: string;
  stepInstructions: string;
  draft: string;
  changedFiles: string[];
  diffPatch: string;
}

function truncate(text: string, max = 280): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildVerificationPrompt(item: PendingDecisionVerification): string {
  const deferred = parseDeferredReviewPayload(item.decision);
  if (deferred) {
    return [
      '[ATEAM:SENIOR_REVIEW]',
      'Review qwen output using diff-first approach.',
      'Respond exactly with:',
      'VERDICT: APPROVED - <short reason>',
      'or',
      'VERDICT: REJECTED - <short actionable fixes>',
      '',
      `Step: ${deferred.stepTitle}`,
      `Instructions:\n${deferred.stepInstructions}`,
      '',
      `Changed files:\n${deferred.changedFiles.length > 0 ? deferred.changedFiles.join('\n') : '(none)'}`,
      '',
      `Diff:\n${deferred.diffPatch || '(none)'}`,
      '',
      `Draft output:\n${deferred.draft}`,
    ].join('\n');
  }

  return [
    'You are verifying an architecture/technical decision made by Phi3.',
    'Respond with one line only in this format:',
    'VERDICT: CONFIRMED - <short reason>',
    'or',
    'VERDICT: REJECTED - <short reason>',
    '',
    `Task: ${item.taskTitle}`,
    `Decision to verify:\n${item.decision}`,
  ].join('\n');
}

function parseDeferredReviewPayload(text: string): DeferredReviewPayload | null {
  if (!text.startsWith('ATEAM_DEFERRED_REVIEW:')) return null;
  const raw = text.slice('ATEAM_DEFERRED_REVIEW:'.length).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<DeferredReviewPayload>;
    if (parsed.kind !== 'ateam_deferred_review') return null;
    return {
      kind: 'ateam_deferred_review',
      stepTitle: String(parsed.stepTitle || ''),
      stepInstructions: String(parsed.stepInstructions || ''),
      draft: String(parsed.draft || ''),
      changedFiles: Array.isArray(parsed.changedFiles)
        ? parsed.changedFiles.map((f) => String(f)).filter(Boolean)
        : [],
      diffPatch: String(parsed.diffPatch || ''),
    };
  } catch {
    return null;
  }
}

function parseVerdict(text: string): {
  status: 'confirmed' | 'rejected';
  note: string;
} {
  const upper = text.toUpperCase();
  if (upper.includes('VERDICT: REJECTED')) {
    return { status: 'rejected', note: truncate(text, 500) };
  }
  if (upper.includes('VERDICT: CONFIRMED')) {
    return { status: 'confirmed', note: truncate(text, 500) };
  }
  if (upper.includes('REJECT')) {
    return { status: 'rejected', note: truncate(text, 500) };
  }
  return { status: 'confirmed', note: truncate(text, 500) };
}

async function verifyOne(
  deps: VerificationDeps,
  item: PendingDecisionVerification,
): Promise<void> {
  const group = deps.resolveGroupByFolder(item.groupFolder);
  if (!group) {
    logger.warn({ taskId: item.taskId, group: item.groupFolder }, 'Verification skipped: group not found');
    return;
  }

  const prompt = buildVerificationPrompt(item);
  const deferred = parseDeferredReviewPayload(item.decision);
  const geminiResult = await deps.runWithModel(group, prompt, item.chatJid, 'gemini');
  const openrouterResult =
    geminiResult || (await deps.runWithModel(group, prompt, item.chatJid, 'openrouter'));
  const claudeResult =
    openrouterResult || (await deps.runWithModel(group, prompt, item.chatJid, 'claude'));
  const final = geminiResult || openrouterResult || claudeResult;

  if (!final) {
    logger.warn({ decisionId: item.decisionId }, 'Verification skipped: no model response');
    return;
  }

  const verdict = parseVerdict(final);
  const verifiedBy = geminiResult ? 'gemini' : openrouterResult ? 'openrouter' : 'claude';
  markDecisionVerificationResult({
    decisionId: item.decisionId,
    stepId: item.stepId,
    status: verdict.status,
    verifiedBy,
    note: verdict.note,
  });

  await deps.sendMessage(
    item.chatJid,
    `Put: Decision verification (${verifiedBy}) for "${item.taskTitle}" -> ${verdict.status.toUpperCase()}\n${verdict.note}`,
  );

  // For deferred A-team code reviews, auto-queue a targeted fix step when reviewer rejects.
  if (deferred && verdict.status === 'rejected') {
    appendAutonomousSubsteps({
      taskId: item.taskId,
      parentStepId: item.stepId,
      substeps: [
        {
          title: `Apply deferred review fixes: ${deferred.stepTitle}`,
          instructions:
            `[EXECUTOR:qwen]\n` +
            `A senior reviewer rejected this step. Apply fixes exactly as requested.\n` +
            `Reviewer feedback:\n${verdict.note}\n\n` +
            `Original step:\n${deferred.stepInstructions}`,
          requiresVerification: true,
        },
      ],
    });
    const next = refreshAutonomousTaskStatus(item.taskId);
    await deps.sendMessage(
      item.chatJid,
      `Put: Deferred review requested fixes for "${deferred.stepTitle}". A follow-up fix step was queued automatically (task status: ${next}).`,
    );
  }
}

export function startDecisionVerificationLoop(deps: VerificationDeps): void {
  if (verificationRunning) {
    logger.debug('Decision verification loop already running, skipping duplicate start');
    return;
  }
  verificationRunning = true;
  logger.info('Decision verification loop started');

  const loop = async () => {
    try {
      const pending = getPendingDecisionVerifications(3);
      for (const item of pending) {
        try {
          await verifyOne(deps, item);
        } catch (err) {
          logger.error({ err, decisionId: item.decisionId }, 'Decision verification failed');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Decision verification loop tick failed');
    }
    setTimeout(loop, VERIFICATION_POLL_INTERVAL_MS);
  };

  loop();
}
