import os from 'os';
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Put';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Message Router Configuration
export const SIMPLE_MAX_CHARS = 50;
export const COMPLEX_MIN_CHARS = 200;

export const SIMPLE_KEYWORD_PATTERNS = [
  /^(hi|hello|hey|hola|yo|sup)\b/i,
  /^(good\s*(morning|afternoon|evening|night))/i,
  /^(thanks?|thank\s*you|thx|ty)\b/i,
  /^(ok|okay|sure|got\s*it|alright|noted|cool|nice|great|awesome)\b/i,
  /^(yes|no|yep|nope|yeah|nah)\b/i,
  /^(bye|goodbye|see\s*ya|later|gn)\b/i,
  /^(lol|haha|lmao|😂|👍|❤️|🙏|👏)/i,
];

export const COMPLEX_KEYWORD_PATTERNS = [
  /\b(debug|refactor|implement|deploy|migrate|optimize)\b/i,
  /\b(function|class|interface|module|api|endpoint)\b/i,
  /\b(database|query|schema|migration|table)\b/i,
  /\b(error|bug|fix|crash|exception|stack\s*trace)\b/i,
  /\b(docker|container|kubernetes|server|nginx)\b/i,
  /\b(git|commit|merge|branch|rebase|pull\s*request)\b/i,
  /\b(test|spec|coverage|ci|cd|pipeline)\b/i,
  /\b(npm|yarn|pip|cargo|package|dependency)\b/i,
  /\b(typescript|javascript|python|rust|golang)\b/i,
  /\b(regex|algorithm|parse|compile|build)\b/i,
];

export const TOOL_REQUIRING_PATTERNS = [
  /\b(search\s*(the\s*)?web|look\s*up|google)\b/i,
  /\b(edit|create|write|modify|update)\s*(the\s*)?(file|code|script)\b/i,
  /\b(read|open|check)\s*(the\s*)?(file|log|config)\b/i,
  /\b(run|execute|start|stop|restart)\s*(the\s*)?(command|script|service|server)\b/i,
  /\b(install|uninstall|upgrade)\s/i,
  /\b(schedule|cron|task|automate)\b/i,
  /\b(send\s*(an?\s*)?(email|message|notification))\b/i,
  /\b(tweet|post\s*(to|on)\s*(x|twitter))\b/i,
];

export const MULTI_STEP_INDICATORS = [
  /\b(first|then|next|after\s*that|finally|step\s*\d)\b/i,
  /\b(also|and\s*also|additionally|moreover)\b/i,
  /\d+\.\s+\w/,  // numbered lists like "1. do this"
];

export const ROUTER_CONFIG = {
  enabled: true,
  complexityThreshold: 40,
};

// Email Channel Configuration
import type { EmailChannelConfig } from './types.js';
export const EMAIL_CHANNEL: EmailChannelConfig = {
  enabled: true,
  triggerMode: 'address',
  triggerValue: 'zenkio+son@gmail.com',
  contextMode: 'thread',
  pollIntervalMs: 60000,  // Check every minute
  replyPrefix: '[Andy] '
};
