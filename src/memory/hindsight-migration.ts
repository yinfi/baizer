import { App } from 'obsidian';
import {
  createMemoryId,
  DEFAULT_MEMORY_BANK_ID,
  MemorySource,
  MemoryRecord,
  MemoryType,
  normalizeMemoryText,
} from './hindsight-types';
import { DEFAULT_USER_PROFILE } from './types';
import { HindsightStore, MigrationState } from './hindsight-store';
import { MEMORY_DIR } from '../mcp/types';

const PROFILE_PATH = `${MEMORY_DIR}/user-profile.json`;
const SUMMARIES_PATH = `${MEMORY_DIR}/session-summaries.json`;
const PREVIOUS_MEMORY_DIR = ['.obsidian', ['obsidian', 'cli'].join('-') + '-memory'].join('/');
const PREVIOUS_PROFILE_PATH = `${PREVIOUS_MEMORY_DIR}/user-profile.json`;
const PREVIOUS_SUMMARIES_PATH = `${PREVIOUS_MEMORY_DIR}/session-summaries.json`;
const PREVIOUS_MEMORIES_PATH = `${PREVIOUS_MEMORY_DIR}/memories.json`;

type LegacyProfile = typeof DEFAULT_USER_PROFILE;

export async function importPreviousMemoryFiles(
  app: App,
  store: HindsightStore,
  now: number = Date.now(),
): Promise<void> {
  await store.ready();
  const state = await store.getMigrationState();
  const stateUpdate: Partial<MigrationState> = {};

  if (!state.previousProfileFileImported) {
    const previousProfile = await readJson<any | null>(app, PREVIOUS_PROFILE_PATH, null);
    if (previousProfile) {
      const currentProfile = await readJson<any | null>(app, PROFILE_PATH, null);
      await writeJson(app, PROFILE_PATH, mergeProfiles(previousProfile, currentProfile, now));
    }
    stateUpdate.previousProfileFileImported = true;
  }

  if (!state.previousSummariesFileImported) {
    const previousSummaries = await readJson<any[]>(app, PREVIOUS_SUMMARIES_PATH, []);
    if (previousSummaries.length > 0) {
      const currentSummaries = await readJson<any[]>(app, SUMMARIES_PATH, []);
      await writeJson(app, SUMMARIES_PATH, mergeSummaries(previousSummaries, currentSummaries));
    }
    stateUpdate.previousSummariesFileImported = true;
  }

  if (Object.keys(stateUpdate).length > 0) {
    await store.updateMigrationState(stateUpdate);
  }
}

export async function migrateLegacyMemory(
  app: App,
  store: HindsightStore,
  now: number = Date.now(),
): Promise<void> {
  await store.ready();
  const state = await store.getMigrationState();
  const records: MemoryRecord[] = [];
  const stateUpdate: Partial<MigrationState> = {};

  if (!state.legacyProfileMigrated) {
    const profile = await readJson<any | null>(app, PROFILE_PATH, null);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.legacyProfileMigrated = true;
  }

  if (!state.legacySummariesMigrated) {
    const summaries = await readJson<any[]>(app, SUMMARIES_PATH, []);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.legacySummariesMigrated = true;
  }

  if (!state.previousPluginProfileMigrated) {
    const profile = await readJson<any | null>(app, PREVIOUS_PROFILE_PATH, null);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.previousPluginProfileMigrated = true;
  }

  if (!state.previousPluginSummariesMigrated) {
    const summaries = await readJson<any[]>(app, PREVIOUS_SUMMARIES_PATH, []);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.previousPluginSummariesMigrated = true;
  }

  if (!state.previousPluginMemoriesMigrated) {
    const importedMemories = await readJson<any[]>(app, PREVIOUS_MEMORIES_PATH, []);
    records.push(...normalizeImportedMemories(importedMemories, now));
    stateUpdate.previousPluginMemoriesMigrated = true;
  }

  if (records.length > 0) {
    await store.upsertMemories(records);
  }
  if (Object.keys(stateUpdate).length > 0) {
    await store.updateMigrationState(stateUpdate);
  }
}

function mergeProfiles(previous: any, current: any | null, now: number): LegacyProfile {
  const previousProfile = normalizeProfile(previous, now);
  const currentProfile = current ? normalizeProfile(current, now) : null;
  if (!currentProfile) return previousProfile;

  return {
    name: preferText(currentProfile.name, previousProfile.name),
    profession: preferText(currentProfile.profession, previousProfile.profession),
    expertise: unionStrings(previousProfile.expertise, currentProfile.expertise),
    preferences: {
      language: preferText(currentProfile.preferences.language, previousProfile.preferences.language),
      responseStyle: preferText(currentProfile.preferences.responseStyle, previousProfile.preferences.responseStyle),
      topics: unionStrings(previousProfile.preferences.topics, currentProfile.preferences.topics),
    },
    workflows: unionObjects(previousProfile.workflows, currentProfile.workflows),
    context: {
      currentProjects: unionStrings(previousProfile.context.currentProjects, currentProfile.context.currentProjects),
      goals: unionStrings(previousProfile.context.goals, currentProfile.context.goals),
      challenges: unionStrings(previousProfile.context.challenges, currentProfile.context.challenges),
    },
    metadata: {
      createdAt: earliestPositive(previousProfile.metadata.createdAt, currentProfile.metadata.createdAt, now),
      updatedAt: Math.max(previousProfile.metadata.updatedAt, currentProfile.metadata.updatedAt, now),
      totalInteractions: Math.max(previousProfile.metadata.totalInteractions, currentProfile.metadata.totalInteractions),
      lastProfileUpdate: Math.max(previousProfile.metadata.lastProfileUpdate, currentProfile.metadata.lastProfileUpdate, now),
    },
  };
}

function normalizeProfile(value: any, now: number): LegacyProfile {
  return {
    name: typeof value?.name === 'string' ? value.name : DEFAULT_USER_PROFILE.name,
    profession: typeof value?.profession === 'string' ? value.profession : DEFAULT_USER_PROFILE.profession,
    expertise: arrayOf(value?.expertise),
    preferences: {
      language: typeof value?.preferences?.language === 'string'
        ? value.preferences.language
        : DEFAULT_USER_PROFILE.preferences.language,
      responseStyle: typeof value?.preferences?.responseStyle === 'string'
        ? value.preferences.responseStyle
        : DEFAULT_USER_PROFILE.preferences.responseStyle,
      topics: arrayOf(value?.preferences?.topics),
    },
    workflows: Array.isArray(value?.workflows)
      ? value.workflows.filter((item: any) => typeof item?.name === 'string' && typeof item?.description === 'string')
      : [],
    context: {
      currentProjects: arrayOf(value?.context?.currentProjects),
      goals: arrayOf(value?.context?.goals),
      challenges: arrayOf(value?.context?.challenges),
    },
    metadata: {
      createdAt: numberOr(value?.metadata?.createdAt, now),
      updatedAt: numberOr(value?.metadata?.updatedAt, now),
      totalInteractions: numberOr(value?.metadata?.totalInteractions, 0),
      lastProfileUpdate: numberOr(value?.metadata?.lastProfileUpdate, now),
    },
  };
}

function mergeSummaries(previous: any[], current: any[]): any[] {
  const merged: any[] = [];
  const seen = new Set<string>();
  for (const summary of [...current, ...previous]) {
    if (typeof summary?.summary !== 'string' || !summary.summary.trim()) continue;
    const key = `${typeof summary.timestamp === 'number' ? summary.timestamp : ''}:${summary.summary.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(summary);
  }
  return merged.sort((a, b) => numberOr(b?.timestamp, 0) - numberOr(a?.timestamp, 0));
}

function normalizeImportedMemories(values: any[], now: number): MemoryRecord[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeImportedMemory(value, now))
    .filter((memory): memory is MemoryRecord => memory !== null);
}

function normalizeImportedMemory(value: any, now: number): MemoryRecord | null {
  if (typeof value?.text !== 'string' || !value.text.trim()) return null;

  const type = isMemoryType(value.type) ? value.type : 'world';
  const bankId = typeof value.bankId === 'string' && value.bankId.trim()
    ? value.bankId
    : DEFAULT_MEMORY_BANK_ID;
  const source = normalizeSource(value.source);
  const text = value.text.trim();
  const normalizedText = typeof value.normalizedText === 'string' && value.normalizedText.trim()
    ? value.normalizedText
    : normalizeMemoryText(text);

  return {
    id: typeof value.id === 'string' && value.id.trim()
      ? value.id
      : createMemoryId({ bankId, type, text, sourceKind: source.kind }),
    bankId,
    type,
    text,
    normalizedText,
    entities: arrayOf(value.entities),
    tags: arrayOf(value.tags),
    source,
    confidence: numberOr(value.confidence, 0.7),
    createdAt: numberOr(value.createdAt, now),
    updatedAt: numberOr(value.updatedAt, now),
    mentionedAt: numberOr(value.mentionedAt, now),
    lastAccessedAt: typeof value.lastAccessedAt === 'number' ? value.lastAccessedAt : undefined,
    accessCount: numberOr(value.accessCount, 0),
    supersedes: arrayOf(value.supersedes),
    evidenceIds: arrayOf(value.evidenceIds),
  };
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

function unionStrings(first: string[], second: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [...first, ...second]) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

function unionObjects<T>(first: T[], second: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const value of [...first, ...second]) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

function preferText(preferred: string | undefined, fallback: string | undefined): string {
  return preferred?.trim() ? preferred : fallback || '';
}

function earliestPositive(first: number, second: number, fallback: number): number {
  const values = [first, second].filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? Math.min(...values) : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isMemoryType(value: unknown): value is MemoryType {
  return value === 'world' || value === 'experience' || value === 'observation';
}

function normalizeSource(value: any): MemorySource {
  const kind = isSourceKind(value?.kind) ? value.kind : 'manual';
  const source: MemorySource = { kind };
  if (typeof value?.messageId === 'string') source.messageId = value.messageId;
  if (typeof value?.action === 'string') source.action = value.action;
  if (typeof value?.target === 'string') source.target = value.target;
  return source;
}

function isSourceKind(value: unknown): value is MemorySource['kind'] {
  return value === 'chat'
    || value === 'tool'
    || value === 'profile-migration'
    || value === 'summary-migration'
    || value === 'manual';
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

async function writeJson(app: App, path: string, value: unknown): Promise<void> {
  const adapter = app.vault.adapter as any;
  if (!await adapter.exists(MEMORY_DIR)) {
    await adapter.mkdir(MEMORY_DIR);
  }
  await adapter.write(path, JSON.stringify(value, null, 2));
}
