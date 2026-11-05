import { App } from 'obsidian';
import {
  createMemoryId,
  DEFAULT_MEMORY_BANK_ID,
  MemorySource,
  MemoryRecord,
  MemoryType,
  normalizeMemoryText,
  sanitizeMemoryText,
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

/** 旧 user-profile.json 的落盘形状：workflows 项可能带额外字段、也可能缺 frequency。 */
interface LegacyProfileWorkflow {
  name: string;
  description: string;
  frequency?: number;
  [key: string]: unknown;
}

interface LegacyProfile {
  name?: string;
  profession?: string;
  expertise: string[];
  preferences: {
    language: string;
    responseStyle: string;
    topics: string[];
  };
  workflows: LegacyProfileWorkflow[];
  context: {
    currentProjects: string[];
    goals: string[];
    challenges: string[];
  };
  metadata: {
    createdAt: number;
    updatedAt: number;
    totalInteractions: number;
    lastProfileUpdate: number;
  };
}

/** 旧 session-summaries.json 的单项形状。 */
interface LegacySummaryEntry {
  summary: string;
  timestamp?: number;
}

/** 外部输入（磁盘 JSON）的窄化入口：只接受非 null、非数组的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegacySummaryEntry(value: unknown): value is LegacySummaryEntry {
  return isRecord(value) && typeof value.summary === 'string' && value.summary.trim().length > 0;
}

export async function importPreviousMemoryFiles(
  app: App,
  store: HindsightStore,
  now: number = Date.now(),
): Promise<void> {
  await store.ready();
  const state = await store.getMigrationState();
  const stateUpdate: Partial<MigrationState> = {};

  if (!state.previousProfileFileImported) {
    const previousProfile = await readJson(app, PREVIOUS_PROFILE_PATH);
    if (previousProfile) {
      const currentProfile = await readJson(app, PROFILE_PATH);
      await writeJson(app, PROFILE_PATH, mergeProfiles(previousProfile, currentProfile, now));
    }
    stateUpdate.previousProfileFileImported = true;
  }

  if (!state.previousSummariesFileImported) {
    const previousSummaries = await readJson(app, PREVIOUS_SUMMARIES_PATH);
    if (Array.isArray(previousSummaries) && previousSummaries.length > 0) {
      const currentSummaries = await readJson(app, SUMMARIES_PATH);
      await writeJson(app, SUMMARIES_PATH, mergeSummaries(
        previousSummaries,
        Array.isArray(currentSummaries) ? currentSummaries : [],
      ));
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
    const profile = await readJson(app, PROFILE_PATH);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.legacyProfileMigrated = true;
  }

  if (!state.legacySummariesMigrated) {
    const summaries = await readJson(app, SUMMARIES_PATH);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.legacySummariesMigrated = true;
  }

  if (!state.previousPluginProfileMigrated) {
    const profile = await readJson(app, PREVIOUS_PROFILE_PATH);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.previousPluginProfileMigrated = true;
  }

  if (!state.previousPluginSummariesMigrated) {
    const summaries = await readJson(app, PREVIOUS_SUMMARIES_PATH);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.previousPluginSummariesMigrated = true;
  }

  if (!state.previousPluginMemoriesMigrated) {
    const importedMemories = await readJson(app, PREVIOUS_MEMORIES_PATH);
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

function mergeProfiles(previous: unknown, current: unknown, now: number): LegacyProfile {
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

function normalizeProfile(value: unknown, now: number): LegacyProfile {
  const profile = isRecord(value) ? value : {};
  const preferences = isRecord(profile.preferences) ? profile.preferences : {};
  const context = isRecord(profile.context) ? profile.context : {};
  const metadata = isRecord(profile.metadata) ? profile.metadata : {};

  return {
    name: typeof profile.name === 'string' ? profile.name : DEFAULT_USER_PROFILE.name,
    profession: typeof profile.profession === 'string' ? profile.profession : DEFAULT_USER_PROFILE.profession,
    expertise: arrayOf(profile.expertise),
    preferences: {
      language: typeof preferences.language === 'string'
        ? preferences.language
        : DEFAULT_USER_PROFILE.preferences.language,
      responseStyle: typeof preferences.responseStyle === 'string'
        ? preferences.responseStyle
        : DEFAULT_USER_PROFILE.preferences.responseStyle,
      topics: arrayOf(preferences.topics),
    },
    workflows: Array.isArray(profile.workflows)
      ? profile.workflows.filter((item): item is LegacyProfileWorkflow =>
        isRecord(item) && typeof item.name === 'string' && typeof item.description === 'string')
      : [],
    context: {
      currentProjects: arrayOf(context.currentProjects),
      goals: arrayOf(context.goals),
      challenges: arrayOf(context.challenges),
    },
    metadata: {
      createdAt: numberOr(metadata.createdAt, now),
      updatedAt: numberOr(metadata.updatedAt, now),
      totalInteractions: numberOr(metadata.totalInteractions, 0),
      lastProfileUpdate: numberOr(metadata.lastProfileUpdate, now),
    },
  };
}

function mergeSummaries(previous: unknown[], current: unknown[]): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const summary of [...current, ...previous]) {
    if (!isLegacySummaryEntry(summary)) continue;
    const key = `${typeof summary.timestamp === 'number' ? summary.timestamp : ''}:${summary.summary.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(summary);
  }
  return merged.sort((a, b) => summaryTimestamp(b) - summaryTimestamp(a));
}

function summaryTimestamp(value: unknown): number {
  return isRecord(value) ? numberOr(value.timestamp, 0) : 0;
}

function normalizeImportedMemories(values: unknown, now: number): MemoryRecord[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeImportedMemory(value, now))
    .filter((memory): memory is MemoryRecord => memory !== null);
}

function normalizeImportedMemory(value: unknown, now: number): MemoryRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.text !== 'string' || !value.text.trim()) return null;

  const type = isMemoryType(value.type) ? value.type : 'world';
  const bankId = typeof value.bankId === 'string' && value.bankId.trim()
    ? value.bankId
    : DEFAULT_MEMORY_BANK_ID;
  const source = normalizeSource(value.source);
  // 迁移导入同样必须脱敏:旧文件文本可能含密钥,且导入不经 retain 热路径。
  const text = sanitizeMemoryText(value.text.trim());
  // normalizedText 一律基于脱敏后文本重算,不信任旧文件里可能含密钥的缓存值。
  const normalizedText = normalizeMemoryText(text);

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

function profileToMemories(profile: unknown, now: number): MemoryRecord[] {
  const record = isRecord(profile) ? profile : {};
  const preferences = isRecord(record.preferences) ? record.preferences : {};
  const context = isRecord(record.context) ? record.context : {};
  const texts: string[] = [];
  if (record.profession) texts.push(`User profession: ${String(record.profession)}`);
  for (const expertise of arrayOf(record.expertise)) texts.push(`User expertise: ${expertise}`);
  if (preferences.responseStyle) texts.push(`User response style preference: ${String(preferences.responseStyle)}`);
  for (const project of arrayOf(context.currentProjects)) texts.push(`Current project: ${project}`);
  for (const goal of arrayOf(context.goals)) texts.push(`User goal: ${goal}`);

  return texts.map((text) => makeMemory(text, 'world', 'profile-migration', now, 0.8));
}

function summariesToMemories(summaries: unknown, now: number): MemoryRecord[] {
  if (!Array.isArray(summaries)) return [];
  return summaries
    .filter(isLegacySummaryEntry)
    .map((summary) => makeMemory(
      `Previous session: ${summary.summary.trim()}`,
      'experience',
      'summary-migration',
      typeof summary.timestamp === 'number' ? summary.timestamp : now,
      0.65,
    ));
}

function makeMemory(
  rawText: string,
  type: 'world' | 'experience',
  sourceKind: 'profile-migration' | 'summary-migration',
  timestamp: number,
  confidence: number,
): MemoryRecord {
  // profile / summary 迁移文本同样脱敏后再入库。
  const text = sanitizeMemoryText(rawText);
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

function normalizeSource(value: unknown): MemorySource {
  const raw = isRecord(value) ? value : {};
  const kind = isSourceKind(raw.kind) ? raw.kind : 'manual';
  const source: MemorySource = { kind };
  if (typeof raw.messageId === 'string') source.messageId = raw.messageId;
  if (typeof raw.action === 'string') source.action = raw.action;
  if (typeof raw.target === 'string') source.target = raw.target;
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

async function readJson(app: App, path: string): Promise<unknown> {
  try {
    const adapter = app.vault.adapter;
    if (!await adapter.exists(path)) return null;
    const parsed: unknown = JSON.parse(await adapter.read(path));
    return parsed;
  } catch {
    return null;
  }
}

async function writeJson(app: App, path: string, value: unknown): Promise<void> {
  const adapter = app.vault.adapter;
  if (!await adapter.exists(MEMORY_DIR)) {
    await adapter.mkdir(MEMORY_DIR);
  }
  await adapter.write(path, JSON.stringify(value, null, 2));
}
