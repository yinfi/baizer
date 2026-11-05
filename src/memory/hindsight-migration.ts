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

type LegacyProfile = typeof DEFAULT_USER_PROFILE;
/** 旧版 JSON 文件解析出的、尚未校验的对象。字段类型一律为 unknown。 */
type JsonObject = Record<string, unknown>;

export async function importPreviousMemoryFiles(
  app: App,
  store: HindsightStore,
  now: number = Date.now(),
): Promise<void> {
  await store.ready();
  const state = await store.getMigrationState();
  const stateUpdate: Partial<MigrationState> = {};

  if (!state.previousProfileFileImported) {
    const previousProfile = await readJsonObject(app, PREVIOUS_PROFILE_PATH);
    if (previousProfile) {
      const currentProfile = await readJsonObject(app, PROFILE_PATH);
      await writeJson(app, PROFILE_PATH, mergeProfiles(previousProfile, currentProfile, now));
    }
    stateUpdate.previousProfileFileImported = true;
  }

  if (!state.previousSummariesFileImported) {
    const previousSummaries = await readJsonArray(app, PREVIOUS_SUMMARIES_PATH);
    if (previousSummaries.length > 0) {
      const currentSummaries = await readJsonArray(app, SUMMARIES_PATH);
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
    const profile = await readJsonObject(app, PROFILE_PATH);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.legacyProfileMigrated = true;
  }

  if (!state.legacySummariesMigrated) {
    const summaries = await readJsonArray(app, SUMMARIES_PATH);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.legacySummariesMigrated = true;
  }

  if (!state.previousPluginProfileMigrated) {
    const profile = await readJsonObject(app, PREVIOUS_PROFILE_PATH);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.previousPluginProfileMigrated = true;
  }

  if (!state.previousPluginSummariesMigrated) {
    const summaries = await readJsonArray(app, PREVIOUS_SUMMARIES_PATH);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.previousPluginSummariesMigrated = true;
  }

  if (!state.previousPluginMemoriesMigrated) {
    const importedMemories = await readJsonArray(app, PREVIOUS_MEMORIES_PATH);
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

function mergeProfiles(previous: JsonObject, current: JsonObject | null, now: number): LegacyProfile {
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

function normalizeProfile(raw: unknown, now: number): LegacyProfile {
  const value = asObject(raw);
  const preferences = asObject(value.preferences);
  const context = asObject(value.context);
  const metadata = asObject(value.metadata);
  return {
    name: typeof value.name === 'string' ? value.name : DEFAULT_USER_PROFILE.name,
    profession: typeof value.profession === 'string' ? value.profession : DEFAULT_USER_PROFILE.profession,
    expertise: arrayOf(value.expertise),
    preferences: {
      language: typeof preferences.language === 'string'
        ? preferences.language
        : DEFAULT_USER_PROFILE.preferences.language,
      responseStyle: typeof preferences.responseStyle === 'string'
        ? preferences.responseStyle
        : DEFAULT_USER_PROFILE.preferences.responseStyle,
      topics: arrayOf(preferences.topics),
    },
    workflows: Array.isArray(value.workflows)
      ? (value.workflows as unknown[]).filter(isLegacyWorkflow)
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

function isLegacyWorkflow(item: unknown): item is LegacyProfile['workflows'][number] {
  const value = asObject(item);
  return typeof value.name === 'string' && typeof value.description === 'string';
}

function mergeSummaries(previous: unknown[], current: unknown[]): JsonObject[] {
  const merged: JsonObject[] = [];
  const seen = new Set<string>();
  for (const item of [...current, ...previous]) {
    const summary = asObject(item);
    if (typeof summary.summary !== 'string' || !summary.summary.trim()) continue;
    const key = `${typeof summary.timestamp === 'number' ? summary.timestamp : ''}:${summary.summary.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(summary);
  }
  return merged.sort((a, b) => numberOr(b.timestamp, 0) - numberOr(a.timestamp, 0));
}

function normalizeImportedMemories(values: unknown, now: number): MemoryRecord[] {
  if (!Array.isArray(values)) return [];
  return (values as unknown[])
    .map((value) => normalizeImportedMemory(value, now))
    .filter((memory): memory is MemoryRecord => memory !== null);
}

function normalizeImportedMemory(raw: unknown, now: number): MemoryRecord | null {
  const value = asObject(raw);
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

function profileToMemories(profile: JsonObject, now: number): MemoryRecord[] {
  const texts: string[] = [];
  const preferences = asObject(profile.preferences);
  const context = asObject(profile.context);
  if (profile.profession) texts.push(`User profession: ${String(profile.profession)}`);
  for (const expertise of arrayOf(profile.expertise)) texts.push(`User expertise: ${expertise}`);
  if (preferences.responseStyle) {
    texts.push(`User response style preference: ${String(preferences.responseStyle)}`);
  }
  for (const project of arrayOf(context.currentProjects)) texts.push(`Current project: ${project}`);
  for (const goal of arrayOf(context.goals)) texts.push(`User goal: ${goal}`);

  return texts.map((text) => makeMemory(text, 'world', 'profile-migration', now, 0.8));
}

function summariesToMemories(summaries: unknown[], now: number): MemoryRecord[] {
  const memories: MemoryRecord[] = [];
  for (const item of summaries) {
    const summary = asObject(item);
    if (typeof summary.summary !== 'string' || !summary.summary.trim()) continue;
    memories.push(makeMemory(
      `Previous session: ${summary.summary.trim()}`,
      'experience',
      'summary-migration',
      typeof summary.timestamp === 'number' ? summary.timestamp : now,
      0.65,
    ));
  }
  return memories;
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

function normalizeSource(raw: unknown): MemorySource {
  const value = asObject(raw);
  const kind = isSourceKind(value.kind) ? value.kind : 'manual';
  const source: MemorySource = { kind };
  if (typeof value.messageId === 'string') source.messageId = value.messageId;
  if (typeof value.action === 'string') source.action = value.action;
  if (typeof value.target === 'string') source.target = value.target;
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

/** 读取并解析 JSON;文件缺失或内容损坏时返回 undefined。解析结果未经校验,调用方必须窄化。 */
async function readJson(app: App, path: string): Promise<unknown> {
  try {
    const adapter = app.vault.adapter;
    if (!await adapter.exists(path)) return undefined;
    return JSON.parse(await adapter.read(path)) as unknown;
  } catch {
    return undefined;
  }
}

async function readJsonObject(app: App, path: string): Promise<JsonObject | null> {
  const value = await readJson(app, path);
  return isJsonObject(value) ? value : null;
}

async function readJsonArray(app: App, path: string): Promise<unknown[]> {
  const value = await readJson(app, path);
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把任意值视为对象读取;非对象一律当作空对象,各字段随后按类型逐个窄化。 */
function asObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

async function writeJson(app: App, path: string, value: unknown): Promise<void> {
  const adapter = app.vault.adapter;
  if (!await adapter.exists(MEMORY_DIR)) {
    await adapter.mkdir(MEMORY_DIR);
  }
  await adapter.write(path, JSON.stringify(value, null, 2));
}
