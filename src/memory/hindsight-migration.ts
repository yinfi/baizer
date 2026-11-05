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
import { asRecord, isRecord } from '../utils/narrow';

const PROFILE_PATH = `${MEMORY_DIR}/user-profile.json`;
const SUMMARIES_PATH = `${MEMORY_DIR}/session-summaries.json`;
const PREVIOUS_MEMORY_DIR = ['.obsidian', ['obsidian', 'cli'].join('-') + '-memory'].join('/');
const PREVIOUS_PROFILE_PATH = `${PREVIOUS_MEMORY_DIR}/user-profile.json`;
const PREVIOUS_SUMMARIES_PATH = `${PREVIOUS_MEMORY_DIR}/session-summaries.json`;
const PREVIOUS_MEMORIES_PATH = `${PREVIOUS_MEMORY_DIR}/memories.json`;

type LegacyProfile = typeof DEFAULT_USER_PROFILE;

/** 旧 session-summaries.json 中的一条记录(磁盘数据,字段均未经校验,保留未知字段原样回写)。 */
type LegacySummary = Record<string, unknown>;

function isLegacyWorkflow(item: unknown): item is LegacyProfile['workflows'][number] {
  const record = asRecord(item);
  return typeof record.name === 'string' && typeof record.description === 'string';
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
    const previousProfile = await readJson(app, PREVIOUS_PROFILE_PATH, null);
    if (previousProfile) {
      const currentProfile = await readJson(app, PROFILE_PATH, null);
      await writeJson(app, PROFILE_PATH, mergeProfiles(previousProfile, currentProfile, now));
    }
    stateUpdate.previousProfileFileImported = true;
  }

  if (!state.previousSummariesFileImported) {
    const previousSummaries = await readSummaries(app, PREVIOUS_SUMMARIES_PATH);
    if (previousSummaries.length > 0) {
      const currentSummaries = await readSummaries(app, SUMMARIES_PATH);
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
    const profile = await readJson(app, PROFILE_PATH, null);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.legacyProfileMigrated = true;
  }

  if (!state.legacySummariesMigrated) {
    const summaries = await readSummaries(app, SUMMARIES_PATH);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.legacySummariesMigrated = true;
  }

  if (!state.previousPluginProfileMigrated) {
    const profile = await readJson(app, PREVIOUS_PROFILE_PATH, null);
    if (profile) records.push(...profileToMemories(profile, now));
    stateUpdate.previousPluginProfileMigrated = true;
  }

  if (!state.previousPluginSummariesMigrated) {
    const summaries = await readSummaries(app, PREVIOUS_SUMMARIES_PATH);
    records.push(...summariesToMemories(summaries, now));
    stateUpdate.previousPluginSummariesMigrated = true;
  }

  if (!state.previousPluginMemoriesMigrated) {
    const importedMemories = await readJson(app, PREVIOUS_MEMORIES_PATH, []);
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
  const profile = asRecord(value);
  const preferences = asRecord(profile.preferences);
  const context = asRecord(profile.context);
  const metadata = asRecord(profile.metadata);
  const workflows = profile.workflows;
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
    workflows: Array.isArray(workflows)
      ? (workflows as unknown[]).filter(isLegacyWorkflow)
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

function mergeSummaries(previous: LegacySummary[], current: LegacySummary[]): LegacySummary[] {
  const merged: LegacySummary[] = [];
  const seen = new Set<string>();
  for (const summary of [...current, ...previous]) {
    const text = summary.summary;
    if (typeof text !== 'string' || !text.trim()) continue;
    const key = `${typeof summary.timestamp === 'number' ? summary.timestamp : ''}:${text.trim()}`;
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

function normalizeImportedMemory(value: unknown, now: number): MemoryRecord | null {
  const raw = asRecord(value);
  const rawText = raw.text;
  if (typeof rawText !== 'string' || !rawText.trim()) return null;

  const type: MemoryType = isMemoryType(raw.type) ? raw.type : 'world';
  const bankId = typeof raw.bankId === 'string' && raw.bankId.trim()
    ? raw.bankId
    : DEFAULT_MEMORY_BANK_ID;
  const source = normalizeSource(raw.source);
  // 迁移导入同样必须脱敏:旧文件文本可能含密钥,且导入不经 retain 热路径。
  const text = sanitizeMemoryText(rawText.trim());
  // normalizedText 一律基于脱敏后文本重算,不信任旧文件里可能含密钥的缓存值。
  const normalizedText = normalizeMemoryText(text);

  return {
    id: typeof raw.id === 'string' && raw.id.trim()
      ? raw.id
      : createMemoryId({ bankId, type, text, sourceKind: source.kind }),
    bankId,
    type,
    text,
    normalizedText,
    entities: arrayOf(raw.entities),
    tags: arrayOf(raw.tags),
    source,
    confidence: numberOr(raw.confidence, 0.7),
    createdAt: numberOr(raw.createdAt, now),
    updatedAt: numberOr(raw.updatedAt, now),
    mentionedAt: numberOr(raw.mentionedAt, now),
    lastAccessedAt: typeof raw.lastAccessedAt === 'number' ? raw.lastAccessedAt : undefined,
    accessCount: numberOr(raw.accessCount, 0),
    supersedes: arrayOf(raw.supersedes),
    evidenceIds: arrayOf(raw.evidenceIds),
  };
}

/** 模板字符串插值用:与原 `${any}` 行为一致(对象会变 "[object Object]")。 */
function interpolate(value: unknown): string {
  return String(value);
}

function profileToMemories(value: unknown, now: number): MemoryRecord[] {
  const profile = asRecord(value);
  const preferences = asRecord(profile.preferences);
  const context = asRecord(profile.context);
  const texts: string[] = [];
  if (profile.profession) texts.push(`User profession: ${interpolate(profile.profession)}`);
  for (const expertise of arrayOf(profile.expertise)) texts.push(`User expertise: ${expertise}`);
  if (preferences.responseStyle) texts.push(`User response style preference: ${interpolate(preferences.responseStyle)}`);
  for (const project of arrayOf(context.currentProjects)) texts.push(`Current project: ${project}`);
  for (const goal of arrayOf(context.goals)) texts.push(`User goal: ${goal}`);

  return texts.map((text) => makeMemory(text, 'world', 'profile-migration', now, 0.8));
}

function summariesToMemories(summaries: LegacySummary[], now: number): MemoryRecord[] {
  const result: MemoryRecord[] = [];
  for (const summary of summaries) {
    const text = asRecord(summary).summary;
    if (typeof text !== 'string' || !text.trim()) continue;
    const timestamp = asRecord(summary).timestamp;
    result.push(makeMemory(
      `Previous session: ${text.trim()}`,
      'experience',
      'summary-migration',
      typeof timestamp === 'number' ? timestamp : now,
      0.65,
    ));
  }
  return result;
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
  const raw = asRecord(value);
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

/** 读取磁盘 JSON。结果是未校验的外部输入(unknown),调用方必须自行窄化。 */
async function readJson(app: App, path: string, fallback: unknown): Promise<unknown> {
  try {
    const adapter = app.vault.adapter;
    if (!await adapter.exists(path)) return fallback;
    return JSON.parse(await adapter.read(path)) as unknown;
  } catch {
    return fallback;
  }
}

/** 读取 summaries 文件;内容不是数组或元素不是对象时丢弃该部分,不让脏数据流入合并逻辑。 */
async function readSummaries(app: App, path: string): Promise<LegacySummary[]> {
  const raw = await readJson(app, path, []);
  return Array.isArray(raw) ? (raw as unknown[]).filter(isRecord) : [];
}

async function writeJson(app: App, path: string, value: unknown): Promise<void> {
  const adapter = app.vault.adapter;
  if (!await adapter.exists(MEMORY_DIR)) {
    await adapter.mkdir(MEMORY_DIR);
  }
  await adapter.write(path, JSON.stringify(value, null, 2));
}
