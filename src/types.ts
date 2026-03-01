export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath: string; // Path inside container (under /workspace/extra/)
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  env?: Record<string, string>;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
}

export interface Session {
  [folder: string]: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface EmailChannelConfig {
  enabled: boolean;
  triggerMode: 'label' | 'address' | 'subject';
  triggerValue: string;  // Label name, address pattern, or subject prefix
  contextMode: 'thread' | 'sender' | 'single';
  pollIntervalMs: number;
  replyPrefix?: string;  // Optional prefix for replies
}

export interface AutonomousTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  project_name: string | null;
  title: string;
  original_prompt: string;
  status: 'queued' | 'active' | 'completed' | 'failed' | 'paused';
  created_at: string;
  updated_at: string;
}

export interface AutonomousStep {
  id: string;
  task_id: string;
  parent_step_id: string | null;
  step_type: 'plan' | 'execute';
  step_order: number;
  title: string;
  instructions: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  attempt_count: number;
  requires_verification: number;
  verified_by: 'phi3' | 'claude' | 'gemini' | 'openrouter' | null;
  verification_status: 'pending' | 'confirmed' | 'rejected' | 'not_required';
  result_summary: string | null;
  error: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutonomousDecisionLog {
  id: string;
  task_id: string;
  step_id: string;
  decision: string;
  confidence: 'low' | 'medium' | 'high';
  requires_verification: number;
  verified_by: 'phi3' | 'claude' | 'gemini' | 'openrouter';
  verification_status: 'pending' | 'confirmed' | 'rejected';
  created_at: string;
}
