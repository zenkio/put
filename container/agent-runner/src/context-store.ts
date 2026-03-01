import fs from 'fs';
import path from 'path';

const CONTEXT_FILES = [
  '/workspace/global/llm-context.json',
  '/workspace/group/llm-context.json',
];
const MAX_ENTRIES = 40;
const CONTEXT_PROMPT_ENTRIES = 6;

export interface SharedContextEntry {
  timestamp: string;
  source: string;
  prompt: string;
  result: string;
  group?: string;
}

interface ContextFile {
  entries: SharedContextEntry[];
}

function readEntriesFromFile(file: string): SharedContextEntry[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const data: ContextFile = JSON.parse(raw);
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function canWriteToDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getWritableContextFile(): string | null {
  for (const file of CONTEXT_FILES) {
    if (canWriteToDir(path.dirname(file))) return file;
  }
  return null;
}

function readContextEntries(): SharedContextEntry[] {
  const merged: SharedContextEntry[] = [];
  for (const file of CONTEXT_FILES) {
    merged.push(...readEntriesFromFile(file));
  }
  return merged;
}

function writeContextEntries(file: string, entries: SharedContextEntry[]): void {
  try {
    const pruned = entries.slice(-MAX_ENTRIES);
    fs.writeFileSync(file, JSON.stringify({ entries: pruned }, null, 2));
  } catch {
    // Never fail a model response because context persistence is unavailable.
  }
}

function truncate(text: string, max = 240): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trim()}…`;
}

export function appendSharedContextRecord(record: Omit<SharedContextEntry, 'timestamp'>): void {
  const writableFile = getWritableContextFile();
  if (!writableFile) return;

  const entries = readEntriesFromFile(writableFile);
  entries.push({
    ...record,
    timestamp: new Date().toISOString(),
  });
  writeContextEntries(writableFile, entries);
}

export function buildSharedContextPrompt(): string {
  const entries = readContextEntries();
  if (entries.length === 0) return '';
  const recent = entries.slice(-CONTEXT_PROMPT_ENTRIES);
  const lines = ['### Shared Context (recent tasks)', 'Only consume this to remember what previous agents did.'];
  for (const entry of recent) {
    lines.push(
      `- [${entry.timestamp}] ${entry.source}${entry.group ? ` @ ${entry.group}` : ''}: Prompt=${truncate(
        entry.prompt,
      )} | Result=${truncate(entry.result)}`,
    );
  }
  return lines.join('\n');
}
