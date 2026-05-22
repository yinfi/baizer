import { App } from 'obsidian';
import {
  createMemoryId,
  DEFAULT_MEMORY_BANK_ID,
  MemoryRecord,
  normalizeMemoryText,
} from './hindsight-types';
import { HindsightStore } from './hindsight-store';

const MEMORY_DIR = '.obsidian/obsidian-cli-memory';
const PROFILE_PATH = `${MEMORY_DIR}/user-profile.json`;
const SUMMARIES_PATH = `${MEMORY_DIR}/session-summaries.json`;

export async function migrateLegacyMemory(
  app: App,
  store: HindsightStore,
  now: number = Date.now(),
): Promise<void> {
  await store.ready();
  const state = await store.getMigrationState();
  const records: MemoryRecord[] = [];
  const stateUpdate: { legacyProfileMigrated?: boolean; legacySummariesMigrated?: boolean } = {};

  if (!state.legacyProfileMigrated) {
    const profile = await readJson<any>(app, PROFILE_PATH, null);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.legacyProfileMigrated = true;
  }

  if (!state.legacySummariesMigrated) {
    const summaries = await readJson<any[]>(app, SUMMARIES_PATH, []);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.legacySummariesMigrated = true;
  }

  if (records.length > 0) {
    await store.upsertMemories(records);
  }
  if (Object.keys(stateUpdate).length > 0) {
    await store.updateMigrationState(stateUpdate);
  }
}

function profileToMemories(profile: any, now: number): MemoryRecord[] {
  const texts: string[] = [];
  if (profile.profession) texts.push(`User profession: ${profile.profession}`);
  for (const expertise of arrayOf(profile.expertise)) texts.push(`User expertise: ${expertise}`);
  if (profile.preferences?.responseStyle) texts.push(`User response style preference: ${profile.preferences.responseStyle}`);
  for (const project of arrayOf(profile.context?.currentProjects)) texts.push(`Current project: ${project}`);
  for (const goal of arrayOf(profile.context?.goals)) texts.push(`User goal: ${goal}`);

  return texts.map((text) => makeMemory(text, 'world', 'profile-migration', now, 0.8));
}

function summariesToMemories(summaries: any[], now: number): MemoryRecord[] {
  return summaries
    .filter((summary) => typeof summary?.summary === 'string' && summary.summary.trim())
    .map((summary) => makeMemory(
      `Previous session: ${summary.summary.trim()}`,
      'experience',
      'summary-migration',
      typeof summary.timestamp === 'number' ? summary.timestamp : now,
      0.65,
    ));
}

function makeMemory(
  text: string,
  type: 'world' | 'experience',
  sourceKind: 'profile-migration' | 'summary-migration',
  timestamp: number,
  confidence: number,
): MemoryRecord {
  return {
    id: createMemoryId({ bankId: DEFAULT_MEMORY_BANK_ID, type, text, sourceKind }),
    bankId: DEFAULT_MEMORY_BANK_ID,
    type,
    text,
    normalizedText: normalizeMemoryText(text),
    entities: extractSimpleEntities(text),
    tags: [sourceKind],
    source: { kind: sourceKind },
    confidence,
    createdAt: timestamp,
    updatedAt: timestamp,
    mentionedAt: timestamp,
    accessCount: 0,
  };
}

function arrayOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function extractSimpleEntities(text: string): string[] {
  return text
    .split(/[,;，；]/)
    .map((part) => part.replace(/^[^:]+:\s*/, '').trim())
    .filter((part) => part.length >= 2)
    .slice(0, 5);
}

async function readJson<T>(app: App, path: string, fallback: T): Promise<T> {
  try {
    const adapter = app.vault.adapter as any;
    if (!await adapter.exists(path)) return fallback;
    return JSON.parse(await adapter.read(path)) as T;
  } catch {
    return fallback;
  }
}
