export type MemoryType = 'world' | 'experience' | 'observation';

export interface MemoryBank {
  id: string;
  name: string;
  mission: string;
  directives: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemorySource {
  kind: 'chat' | 'tool' | 'profile-migration' | 'summary-migration' | 'manual';
  messageId?: string;
  action?: string;
  target?: string;
}

export interface MemoryRecord {
  id: string;
  bankId: string;
  type: MemoryType;
  text: string;
  normalizedText: string;
  entities: string[];
  tags: string[];
  source: MemorySource;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  mentionedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
  supersedes?: string[];
  evidenceIds?: string[];
}

export interface MemoryRecallRequest {
  bankId?: string;
  query: string;
  source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
  maxRecords?: number;
  maxChars?: number;
  includeTypes?: MemoryType[];
  now?: number;
}

export interface MemoryRecallResult {
  records: MemoryRecord[];
  promptBlock: string;
}

export interface RetainTurnInput {
  bankId?: string;
  userMessage: string;
  assistantMessage: string;
  source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
  contextPaths?: string[];
  toolResults?: Array<{ name: string; result: unknown }>;
  now?: number;
}

export const DEFAULT_MEMORY_BANK_ID = 'default';

export function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function tokenizeMemoryText(value: string): string[] {
  return normalizeMemoryText(value)
    .split(/[^a-z0-9\u4e00-\u9fff_.:/-]+/i)
    .filter((token) => token.length >= 2);
}

export function createMemoryId(input: {
  bankId: string;
  type: MemoryType;
  text: string;
  sourceKind: string;
}): string {
  const raw = `${input.bankId}|${input.type}|${input.sourceKind}|${normalizeMemoryText(input.text)}`;
  let hash = 5381;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(index);
    hash |= 0;
  }
  return `mem_${Math.abs(hash).toString(36)}`;
}

export function createDefaultMemoryBank(now: number = Date.now()): MemoryBank {
  return {
    id: DEFAULT_MEMORY_BANK_ID,
    name: 'Default Vault Memory',
    mission: 'Help Obsidian CLI personalize answers and remember durable user preferences, projects, decisions, and prior work.',
    directives: [
      'Prefer facts grounded in user messages or approved operations.',
      'Do not store secrets, API keys, tokens, passwords, or long private note excerpts.',
      'Prefer concise, reusable memories over raw transcript dumps.',
    ],
    createdAt: now,
    updatedAt: now,
  };
}
