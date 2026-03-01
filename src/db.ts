import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { proto } from '@whiskeysockets/baileys';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import {
  AutonomousDecisionLog,
  AutonomousStep,
  AutonomousTask,
  NewMessage,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

export function initDatabase(): void {
  logger.info('Initializing database...');
  const dbPath = path.join(process.cwd(), 'data', 'nanoclaw.db');
  logger.info(`Database path: ${dbPath}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  logger.info('Database directory ensured.');

  db = new Database(dbPath);
  logger.info('Database instance created.');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS processed_emails (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      subject TEXT,
      processed_at TEXT NOT NULL,
      response_sent INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_email_thread ON processed_emails(thread_id);

    CREATE TABLE IF NOT EXISTS autonomous_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      project_name TEXT,
      title TEXT NOT NULL,
      original_prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_status ON autonomous_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_group ON autonomous_tasks(group_folder, status);

    CREATE TABLE IF NOT EXISTS autonomous_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      parent_step_id TEXT,
      step_type TEXT NOT NULL DEFAULT 'execute',
      step_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      requires_verification INTEGER NOT NULL DEFAULT 0,
      verified_by TEXT,
      verification_status TEXT NOT NULL DEFAULT 'pending',
      result_summary TEXT,
      error TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_autonomous_steps_status ON autonomous_steps(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_autonomous_steps_task_order ON autonomous_steps(task_id, step_order);

    CREATE TABLE IF NOT EXISTS autonomous_decision_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      confidence TEXT NOT NULL,
      requires_verification INTEGER NOT NULL DEFAULT 1,
      verified_by TEXT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES autonomous_tasks(id),
      FOREIGN KEY (step_id) REFERENCES autonomous_steps(id)
    );
    CREATE INDEX IF NOT EXISTS idx_autonomous_decisions_status ON autonomous_decision_logs(verification_status, created_at);

    CREATE TABLE IF NOT EXISTS project_memory (
      channel TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      project_id TEXT NOT NULL,
      goal TEXT,
      decisions TEXT NOT NULL DEFAULT '[]',
      constraints TEXT NOT NULL DEFAULT '[]',
      current_status TEXT,
      next_steps TEXT NOT NULL DEFAULT '[]',
      open_questions TEXT NOT NULL DEFAULT '[]',
      last_artifacts TEXT NOT NULL DEFAULT '[]',
      last_errors TEXT NOT NULL DEFAULT '[]',
      last_results TEXT NOT NULL DEFAULT '[]',
      last_checkpoints TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel, chat_jid, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_memory_updated ON project_memory(updated_at);
  `);
  logger.info('Tables created (if not existing).');

  // Add sender_name column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
    logger.info('Migration: Added sender_name to messages table.');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`sender_name column already exists or error: ${msg}`);
  }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
    logger.info('Migration: Added context_mode to scheduled_tasks table.');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`context_mode column already exists or error: ${msg}`);
  }

  try {
    db.exec(
      `ALTER TABLE project_memory ADD COLUMN last_checkpoints TEXT DEFAULT '[]'`,
    );
    logger.info('Migration: Added last_checkpoints to project_memory table.');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`last_checkpoints column already exists or error: ${msg}`);
  }
  logger.info('Database initialization complete.');
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(
  msg: proto.IWebMessageInfo,
  chatJid: string,
  isFromMe: boolean,
  pushName?: string,
): void {
  if (!msg.key) return;

  const content =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  // Skip storing empty messages (reactions, receipts, protocol messages, etc.)
  if (!content.trim()) return;

  const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
  const sender = msg.key.participant || msg.key.remoteJid || '';
  const senderName = pushName || sender.split('@')[0];
  const msgId = msg.key.id || '';

  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msgId,
    chatJid,
    sender,
    senderName,
    content,
    timestamp,
    isFromMe ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter out bot's own messages by checking content prefix (not is_from_me, since user shares the account)
  // Also filter out empty messages that may have slipped through
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND content NOT LIKE ? AND content != ''
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter out bot's own messages by checking content prefix
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function getTaskRunLogs(taskId: string, limit = 10): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `,
    )
    .all(taskId, limit) as TaskRunLog[];
}

// Email tracking functions
export function isEmailProcessed(messageId: string): boolean {
  const row = db.prepare('SELECT 1 FROM processed_emails WHERE message_id = ?').get(messageId);
  return !!row;
}

export function markEmailProcessed(messageId: string, threadId: string, sender: string, subject: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO processed_emails (message_id, thread_id, sender, subject, processed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(messageId, threadId, sender, subject, new Date().toISOString());
}

export function markEmailResponded(messageId: string): void {
  db.prepare('UPDATE processed_emails SET response_sent = 1 WHERE message_id = ?').run(messageId);
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAutonomousTask(params: {
  group_folder: string;
  chat_jid: string;
  project_name?: string | null;
  title: string;
  prompt: string;
}): AutonomousTask {
  const id = makeId('autotask');
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO autonomous_tasks (id, group_folder, chat_jid, project_name, title, original_prompt, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `,
  ).run(
    id,
    params.group_folder,
    params.chat_jid,
    params.project_name || null,
    params.title,
    params.prompt,
    now,
    now,
  );

  db.prepare(
    `
    INSERT INTO autonomous_steps (
      id, task_id, parent_step_id, step_type, step_order, title, instructions, status,
      attempt_count, requires_verification, verified_by, verification_status, result_summary,
      error, next_retry_at, created_at, updated_at
    )
    VALUES (?, ?, NULL, 'plan', 1, ?, ?, 'queued', 0, 0, NULL, 'not_required', NULL, NULL, NULL, ?, ?)
  `,
  ).run(
    makeId('autostep'),
    id,
    `Plan phases for: ${params.title}`,
    params.prompt,
    now,
    now,
  );

  return db.prepare('SELECT * FROM autonomous_tasks WHERE id = ?').get(id) as AutonomousTask;
}

export function getAutonomousTaskById(id: string): AutonomousTask | undefined {
  return db.prepare('SELECT * FROM autonomous_tasks WHERE id = ?').get(id) as AutonomousTask | undefined;
}

export function getAutonomousStepsForTask(taskId: string): AutonomousStep[] {
  return db
    .prepare('SELECT * FROM autonomous_steps WHERE task_id = ? ORDER BY step_order, created_at')
    .all(taskId) as AutonomousStep[];
}

export function getRunnableAutonomousSteps(limit = 3): Array<{
  task: AutonomousTask;
  step: AutonomousStep;
}> {
  const now = nowIso();
  const rows = db.prepare(
    `
    WITH candidates AS (
      SELECT
        s.id AS step_id,
        s.task_id AS step_task_id,
        s.parent_step_id AS step_parent_step_id,
        s.step_type AS step_step_type,
        s.step_order AS step_step_order,
        s.title AS step_title,
        s.instructions AS step_instructions,
        s.status AS step_status,
        s.attempt_count AS step_attempt_count,
        s.requires_verification AS step_requires_verification,
        s.verified_by AS step_verified_by,
        s.verification_status AS step_verification_status,
        s.result_summary AS step_result_summary,
        s.error AS step_error,
        s.next_retry_at AS step_next_retry_at,
        s.created_at AS step_created_at,
        s.updated_at AS step_updated_at,
        t.id AS task_id,
        t.group_folder AS task_group_folder,
        t.chat_jid AS task_chat_jid,
        t.project_name AS task_project_name,
        t.title AS task_title,
        t.original_prompt AS task_original_prompt,
        t.status AS task_status,
        t.created_at AS task_created_at,
        t.updated_at AS task_updated_at
      FROM autonomous_steps s
      JOIN autonomous_tasks t ON t.id = s.task_id
      WHERE
        s.status = 'queued'
        AND t.status IN ('active', 'queued')
        AND (s.next_retry_at IS NULL OR s.next_retry_at <= ?)
        AND (
          s.parent_step_id IS NULL
          OR EXISTS (
            SELECT 1 FROM autonomous_steps p
            WHERE p.id = s.parent_step_id AND p.status = 'completed'
          )
        )
    ),
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY step_step_order, step_created_at) AS task_rank
      FROM candidates
    )
    SELECT *
    FROM ranked
    WHERE task_rank = 1
    ORDER BY task_created_at, step_step_order
    LIMIT ?
  `,
  ).all(now, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    task: {
      id: r.task_id as string,
      group_folder: r.task_group_folder as string,
      chat_jid: r.task_chat_jid as string,
      project_name: (r.task_project_name as string | null) || null,
      title: r.task_title as string,
      original_prompt: r.task_original_prompt as string,
      status: r.task_status as AutonomousTask['status'],
      created_at: r.task_created_at as string,
      updated_at: r.task_updated_at as string,
    },
    step: {
      id: r.step_id as string,
      task_id: r.step_task_id as string,
      parent_step_id: (r.step_parent_step_id as string | null) || null,
      step_type: r.step_step_type as AutonomousStep['step_type'],
      step_order: r.step_step_order as number,
      title: r.step_title as string,
      instructions: r.step_instructions as string,
      status: r.step_status as AutonomousStep['status'],
      attempt_count: r.step_attempt_count as number,
      requires_verification: r.step_requires_verification as number,
      verified_by: (r.step_verified_by as AutonomousStep['verified_by']) || null,
      verification_status: r.step_verification_status as AutonomousStep['verification_status'],
      result_summary: (r.step_result_summary as string | null) || null,
      error: (r.step_error as string | null) || null,
      next_retry_at: (r.step_next_retry_at as string | null) || null,
      created_at: r.step_created_at as string,
      updated_at: r.step_updated_at as string,
    },
  }));
}

export function markAutonomousStepInProgress(stepId: string): void {
  const now = nowIso();
  db.prepare(
    `
    UPDATE autonomous_steps
    SET status = 'in_progress', attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ?
  `,
  ).run(now, stepId);
}

export function completeAutonomousStep(params: {
  stepId: string;
  summary: string;
  requiresVerification: boolean;
  verifiedBy: AutonomousStep['verified_by'];
  verificationStatus: AutonomousStep['verification_status'];
}): void {
  const now = nowIso();
  db.prepare(
    `
    UPDATE autonomous_steps
    SET status = 'completed',
        result_summary = ?,
        error = NULL,
        next_retry_at = NULL,
        requires_verification = ?,
        verified_by = ?,
        verification_status = ?,
        updated_at = ?
    WHERE id = ?
  `,
  ).run(
    params.summary,
    params.requiresVerification ? 1 : 0,
    params.verifiedBy,
    params.verificationStatus,
    now,
    params.stepId,
  );
}

export function failAutonomousStep(params: {
  stepId: string;
  error: string;
  retryAt?: string | null;
  block?: boolean;
}): void {
  const now = nowIso();
  const nextStatus: AutonomousStep['status'] = params.block
    ? 'blocked'
    : params.retryAt
      ? 'queued'
      : 'failed';
  db.prepare(
    `
    UPDATE autonomous_steps
    SET status = ?,
        error = ?,
        next_retry_at = ?,
        updated_at = ?
    WHERE id = ?
  `,
  ).run(
    nextStatus,
    params.error,
    params.retryAt || null,
    now,
    params.stepId,
  );
}

export function recoverStaleInProgressAutonomousSteps(
  staleBeforeIso: string,
  limit = 20,
): Array<{
  stepId: string;
  taskId: string;
  chatJid: string;
  taskTitle: string;
  stepTitle: string;
}> {
  const stale = db
    .prepare(
      `
      SELECT
        s.id AS step_id,
        s.task_id AS task_id,
        s.title AS step_title,
        t.chat_jid AS chat_jid,
        t.title AS task_title
      FROM autonomous_steps s
      JOIN autonomous_tasks t ON t.id = s.task_id
      WHERE
        s.status = 'in_progress'
        AND t.status IN ('active', 'queued')
        AND s.updated_at <= ?
      ORDER BY s.updated_at ASC
      LIMIT ?
    `,
    )
    .all(staleBeforeIso, limit) as Array<{
    step_id: string;
    task_id: string;
    step_title: string;
    chat_jid: string;
    task_title: string;
  }>;

  if (stale.length === 0) return [];

  const now = nowIso();
  const tx = db.transaction(() => {
    const updateStep = db.prepare(
      `
      UPDATE autonomous_steps
      SET status = 'queued',
          error = ?,
          next_retry_at = NULL,
          updated_at = ?
      WHERE id = ?
    `,
    );
    const updateTask = db.prepare(
      `UPDATE autonomous_tasks SET status = 'active', updated_at = ? WHERE id = ?`,
    );
    for (const row of stale) {
      updateStep.run('Recovered stale in_progress step after runtime interruption', now, row.step_id);
      updateTask.run(now, row.task_id);
    }
  });
  tx();

  return stale.map((r) => ({
    stepId: r.step_id,
    taskId: r.task_id,
    chatJid: r.chat_jid,
    taskTitle: r.task_title,
    stepTitle: r.step_title,
  }));
}

export function requeueAutonomousStepWithInstructions(params: {
  stepId: string;
  instructions: string;
  error: string;
  retryAt?: string | null;
  resetAttempts?: boolean;
}): void {
  const now = nowIso();
  const attemptsExpr = params.resetAttempts ? 'attempt_count = 0,' : '';
  db.prepare(
    `
    UPDATE autonomous_steps
    SET status = 'queued',
        instructions = ?,
        error = ?,
        next_retry_at = ?,
        ${attemptsExpr}
        updated_at = ?
    WHERE id = ?
  `,
  ).run(
    params.instructions,
    params.error,
    params.retryAt || null,
    now,
    params.stepId,
  );
}

export function appendAutonomousSubsteps(params: {
  taskId: string;
  parentStepId: string;
  substeps: Array<{
    title: string;
    instructions: string;
    requiresVerification?: boolean;
  }>;
}): number {
  if (params.substeps.length === 0) return 0;
  const now = nowIso();
  const row = db
    .prepare('SELECT COALESCE(MAX(step_order), 0) AS max_order FROM autonomous_steps WHERE task_id = ?')
    .get(params.taskId) as { max_order: number };
  let nextOrder = row.max_order + 1;

  const insert = db.prepare(
    `
    INSERT INTO autonomous_steps (
      id, task_id, parent_step_id, step_type, step_order, title, instructions, status,
      attempt_count, requires_verification, verified_by, verification_status, result_summary,
      error, next_retry_at, created_at, updated_at
    )
    VALUES (?, ?, ?, 'execute', ?, ?, ?, 'queued', 0, ?, NULL, ?, NULL, NULL, NULL, ?, ?)
  `,
  );

  const tx = db.transaction(() => {
    for (const s of params.substeps) {
      insert.run(
        makeId('autostep'),
        params.taskId,
        params.parentStepId,
        nextOrder++,
        s.title,
        s.instructions,
        s.requiresVerification ? 1 : 0,
        s.requiresVerification ? 'pending' : 'not_required',
        now,
        now,
      );
    }
  });
  tx();
  return params.substeps.length;
}

export function refreshAutonomousTaskStatus(taskId: string): AutonomousTask['status'] {
  const rows = db
    .prepare('SELECT status FROM autonomous_steps WHERE task_id = ?')
    .all(taskId) as Array<{ status: AutonomousStep['status'] }>;

  let next: AutonomousTask['status'] = 'active';
  if (rows.length === 0) {
    next = 'completed';
  } else if (rows.some((r) => r.status === 'blocked')) {
    next = 'failed';
  } else if (
    rows.some((r) => r.status === 'failed') &&
    !rows.some((r) => r.status === 'queued' || r.status === 'in_progress')
  ) {
    next = 'failed';
  } else if (rows.every((r) => r.status === 'completed')) {
    next = 'completed';
  } else {
    next = 'active';
  }

  db.prepare('UPDATE autonomous_tasks SET status = ?, updated_at = ? WHERE id = ?').run(
    next,
    nowIso(),
    taskId,
  );
  return next;
}

export function logAutonomousDecision(params: {
  task_id: string;
  step_id: string;
  decision: string;
  confidence: AutonomousDecisionLog['confidence'];
  requires_verification: boolean;
  verified_by: AutonomousDecisionLog['verified_by'];
  verification_status: AutonomousDecisionLog['verification_status'];
}): void {
  db.prepare(
    `
    INSERT INTO autonomous_decision_logs (
      id, task_id, step_id, decision, confidence, requires_verification,
      verified_by, verification_status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    makeId('autodecision'),
    params.task_id,
    params.step_id,
    params.decision,
    params.confidence,
    params.requires_verification ? 1 : 0,
    params.verified_by,
    params.verification_status,
    nowIso(),
  );
}

export function getLatestAutonomousDecisionForTask(taskId: string): AutonomousDecisionLog | undefined {
  return db
    .prepare(
      `
      SELECT *
      FROM autonomous_decision_logs
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(taskId) as AutonomousDecisionLog | undefined;
}

export function listAutonomousTasksForChat(
  chatJid: string,
  limit = 10,
): AutonomousTask[] {
  return db
    .prepare(
      `
      SELECT *
      FROM autonomous_tasks
      WHERE chat_jid = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(chatJid, limit) as AutonomousTask[];
}

export function getLatestAutonomousTaskForChat(
  chatJid: string,
): AutonomousTask | undefined {
  return db
    .prepare(
      `
      SELECT *
      FROM autonomous_tasks
      WHERE chat_jid = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get(chatJid) as AutonomousTask | undefined;
}

export function setAutonomousTaskPaused(taskId: string, paused: boolean): boolean {
  const task = getAutonomousTaskById(taskId);
  if (!task) return false;
  const now = nowIso();

  if (paused) {
    const pauseReason = 'Paused by user';
    db.prepare(
      `UPDATE autonomous_tasks SET status = 'paused', updated_at = ? WHERE id = ?`,
    ).run(now, taskId);
    db.prepare(
      `UPDATE autonomous_steps
       SET status = CASE WHEN status IN ('queued', 'in_progress') THEN 'blocked' ELSE status END,
           error = CASE WHEN status IN ('queued', 'in_progress') THEN ? ELSE error END,
           updated_at = ?
       WHERE task_id = ?`,
    ).run(pauseReason, now, taskId);
  } else {
    if (isTaskFullyCompleted(taskId)) {
      db.prepare(
        `UPDATE autonomous_tasks SET status = 'completed', updated_at = ? WHERE id = ?`,
      ).run(now, taskId);
      return false;
    }
    db.prepare(
      `UPDATE autonomous_tasks SET status = 'active', updated_at = ? WHERE id = ?`,
    ).run(now, taskId);
    db.prepare(
      `UPDATE autonomous_steps
       SET status = 'queued',
           error = NULL,
           updated_at = ?
       WHERE task_id = ? AND status = 'blocked' AND (error = 'Paused by user' OR error LIKE 'Paused:%')`,
    ).run(now, taskId);
  }
  return true;
}

function isTaskFullyCompleted(taskId: string): boolean {
  const counts = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total_steps,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_steps
      FROM autonomous_steps
      WHERE task_id = ?
    `,
    )
    .get(taskId) as { total_steps: number; completed_steps: number | null } | undefined;

  const total = counts?.total_steps ?? 0;
  const completed = counts?.completed_steps ?? 0;
  return total > 0 && completed === total;
}

export function setAutonomousTaskPausedWithReason(
  taskId: string,
  paused: boolean,
  reason: string,
): boolean {
  const task = getAutonomousTaskById(taskId);
  if (!task) return false;
  const now = nowIso();

  if (paused) {
    const pauseReason = reason.startsWith('Paused:') ? reason : `Paused: ${reason}`;
    db.prepare(
      `UPDATE autonomous_tasks SET status = 'paused', updated_at = ? WHERE id = ?`,
    ).run(now, taskId);
    db.prepare(
      `UPDATE autonomous_steps
       SET status = CASE WHEN status IN ('queued', 'in_progress') THEN 'blocked' ELSE status END,
           error = CASE WHEN status IN ('queued', 'in_progress') THEN ? ELSE error END,
           updated_at = ?
       WHERE task_id = ?`,
    ).run(pauseReason, now, taskId);
  } else {
    if (isTaskFullyCompleted(taskId)) {
      db.prepare(
        `UPDATE autonomous_tasks SET status = 'completed', updated_at = ? WHERE id = ?`,
      ).run(now, taskId);
      return false;
    }
    db.prepare(
      `UPDATE autonomous_tasks SET status = 'active', updated_at = ? WHERE id = ?`,
    ).run(now, taskId);
    db.prepare(
      `UPDATE autonomous_steps
       SET status = 'queued',
           error = NULL,
           updated_at = ?
       WHERE task_id = ? AND status = 'blocked' AND (error = 'Paused by user' OR error LIKE 'Paused:%')`,
    ).run(now, taskId);
  }
  return true;
}

export function listPausedAutonomousTasks(limit = 20): AutonomousTask[] {
  return db
    .prepare(
      `
      SELECT *
      FROM autonomous_tasks
      WHERE status = 'paused'
      ORDER BY updated_at ASC
      LIMIT ?
    `,
    )
    .all(limit) as AutonomousTask[];
}

export interface PendingDecisionVerification {
  decisionId: string;
  taskId: string;
  stepId: string;
  chatJid: string;
  groupFolder: string;
  taskTitle: string;
  decision: string;
  createdAt: string;
}

export function getPendingDecisionVerifications(
  limit = 5,
): PendingDecisionVerification[] {
  const rows = db
    .prepare(
      `
      SELECT
        d.id AS decision_id,
        d.task_id AS task_id,
        d.step_id AS step_id,
        d.decision AS decision,
        d.created_at AS decision_created_at,
        t.chat_jid AS task_chat_jid,
        t.group_folder AS task_group_folder,
        t.title AS task_title
      FROM autonomous_decision_logs d
      JOIN autonomous_tasks t ON t.id = d.task_id
      WHERE d.verification_status = 'pending' AND t.status IN ('active', 'completed')
      ORDER BY d.created_at ASC
      LIMIT ?
    `,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    decisionId: r.decision_id as string,
    taskId: r.task_id as string,
    stepId: r.step_id as string,
    chatJid: r.task_chat_jid as string,
    groupFolder: r.task_group_folder as string,
    taskTitle: r.task_title as string,
    decision: r.decision as string,
    createdAt: r.decision_created_at as string,
  }));
}

export function markDecisionVerificationResult(params: {
  decisionId: string;
  stepId: string;
  status: 'confirmed' | 'rejected';
  verifiedBy: 'claude' | 'gemini' | 'openrouter';
  note: string;
}): void {
  const now = nowIso();
  db.prepare(
    `
    UPDATE autonomous_decision_logs
    SET verification_status = ?, verified_by = ?, decision = ?, created_at = created_at
    WHERE id = ?
  `,
  ).run(params.status, params.verifiedBy, params.note, params.decisionId);

  db.prepare(
    `
    UPDATE autonomous_steps
    SET verification_status = ?, verified_by = ?, result_summary = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(params.status, params.verifiedBy, params.note, now, params.stepId);
}

export interface ProjectMemoryState {
  channel: string;
  chat_jid: string;
  project_id: string;
  goal: string | null;
  decisions: string[];
  constraints: string[];
  current_status: string | null;
  next_steps: string[];
  open_questions: string[];
  last_artifacts: string[];
  last_errors: string[];
  last_results: string[];
  last_checkpoints: string[];
  created_at: string;
  updated_at: string;
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean);
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((x) => String(x)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export function getProjectMemoryState(
  channel: string,
  chatJid: string,
  projectId: string,
): ProjectMemoryState {
  const row = db
    .prepare(
      `
      SELECT *
      FROM project_memory
      WHERE channel = ? AND chat_jid = ? AND project_id = ?
    `,
    )
    .get(channel, chatJid, projectId) as Record<string, unknown> | undefined;

  if (!row) {
    const now = nowIso();
    db.prepare(
      `
      INSERT INTO project_memory (
        channel, chat_jid, project_id, goal, decisions, constraints, current_status,
        next_steps, open_questions, last_artifacts, last_errors, last_results, last_checkpoints, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, '[]', '[]', NULL, '[]', '[]', '[]', '[]', '[]', '[]', ?, ?)
    `,
    ).run(channel, chatJid, projectId, now, now);
    return {
      channel,
      chat_jid: chatJid,
      project_id: projectId,
      goal: null,
      decisions: [],
      constraints: [],
      current_status: null,
      next_steps: [],
      open_questions: [],
      last_artifacts: [],
      last_errors: [],
      last_results: [],
      last_checkpoints: [],
      created_at: now,
      updated_at: now,
    };
  }

  return {
    channel: String(row.channel),
    chat_jid: String(row.chat_jid),
    project_id: String(row.project_id),
    goal: row.goal ? String(row.goal) : null,
    decisions: parseStringArray(row.decisions),
    constraints: parseStringArray(row.constraints),
    current_status: row.current_status ? String(row.current_status) : null,
    next_steps: parseStringArray(row.next_steps),
    open_questions: parseStringArray(row.open_questions),
    last_artifacts: parseStringArray(row.last_artifacts),
    last_errors: parseStringArray(row.last_errors),
    last_results: parseStringArray(row.last_results),
    last_checkpoints: parseStringArray(row.last_checkpoints),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function updateProjectMemoryState(params: {
  channel: string;
  chatJid: string;
  projectId: string;
  patch: Partial<
    Pick<
      ProjectMemoryState,
      | 'goal'
      | 'decisions'
      | 'constraints'
      | 'current_status'
      | 'next_steps'
      | 'open_questions'
      | 'last_artifacts'
      | 'last_errors'
      | 'last_results'
      | 'last_checkpoints'
    >
  >;
}): void {
  const current = getProjectMemoryState(
    params.channel,
    params.chatJid,
    params.projectId,
  );
  const next: ProjectMemoryState = {
    ...current,
    ...params.patch,
    updated_at: nowIso(),
  };

  db.prepare(
    `
    UPDATE project_memory
    SET
      goal = ?,
      decisions = ?,
      constraints = ?,
      current_status = ?,
      next_steps = ?,
      open_questions = ?,
      last_artifacts = ?,
      last_errors = ?,
      last_results = ?,
      last_checkpoints = ?,
      updated_at = ?
    WHERE channel = ? AND chat_jid = ? AND project_id = ?
  `,
  ).run(
    next.goal,
    JSON.stringify(next.decisions || []),
    JSON.stringify(next.constraints || []),
    next.current_status,
    JSON.stringify(next.next_steps || []),
    JSON.stringify(next.open_questions || []),
    JSON.stringify(next.last_artifacts || []),
    JSON.stringify(next.last_errors || []),
    JSON.stringify(next.last_results || []),
    JSON.stringify(next.last_checkpoints || []),
    next.updated_at,
    params.channel,
    params.chatJid,
    params.projectId,
  );
}

export interface ProviderReliabilityRow {
  provider: 'gemini' | 'openrouter';
  total: number;
  completed: number;
  blocked: number;
  failed: number;
  queued: number;
  in_progress: number;
}

export function getProviderReliabilityReport(
  startIso: string,
  endIso: string,
): ProviderReliabilityRow[] {
  const rows = db
    .prepare(
      `
      SELECT
        provider,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
      FROM (
        SELECT
          CASE
            WHEN instructions LIKE '[EXECUTOR:gemini]%' THEN 'gemini'
            WHEN instructions LIKE '[EXECUTOR:openrouter]%' THEN 'openrouter'
            ELSE NULL
          END AS provider,
          status
        FROM autonomous_steps
        WHERE updated_at >= ? AND updated_at < ?
      ) s
      WHERE provider IS NOT NULL
      GROUP BY provider
    `,
    )
    .all(startIso, endIso) as Array<Record<string, unknown>>;

  return rows
    .map((r) => ({
      provider: r.provider as 'gemini' | 'openrouter',
      total: Number(r.total || 0),
      completed: Number(r.completed || 0),
      blocked: Number(r.blocked || 0),
      failed: Number(r.failed || 0),
      queued: Number(r.queued || 0),
      in_progress: Number(r.in_progress || 0),
    }))
    .filter((r) => r.provider === 'gemini' || r.provider === 'openrouter');
}
