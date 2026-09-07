import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentProvider } from '@nexus/protocol/events';
import { isAgentProvider } from '@nexus/protocol/events';
import type { AgentConfig, AgentConfigResult } from './agentConfig.js';
import { parseAgentConfig } from './agentConfig.js';

/**
 * Persistence for saved agent configs and crew templates (phase 13, D3).
 *
 * These are USER ASSETS, not room history, and that is a deliberate split
 * from `recovery.ts`'s sidecars, not an oversight: a room's log records that a
 * crew *was launched* and which config produced an agent — enough to read a
 * shared transcript back into a crew — but the definitions themselves live
 * here, under their own directories, and never touch `openLog`/`JsonlEventLog`
 * (event-log.ts). Logging a config would make every edit to it permanent,
 * shareable room history, and slowly leak whatever a prompt happens to
 * contain. So: no import of the log module anywhere in this file, on purpose.
 *
 * Three rules carried over from `agentConfig.ts`'s header, restated here
 * because this is where they get enforced against the filesystem rather than
 * a request body:
 *
 * 1. Every write goes through `parseAgentConfig`. No exceptions, no "trusted"
 *    path — `saveConfig` is the only way this module puts a config on disk,
 *    and it validates before it writes.
 * 2. Re-validated on read, not just on write. A stored config is executable
 *    input on the way OUT as well as in: the file on disk is a file on disk,
 *    and anything that can write it — a hand-edited file, a downgraded
 *    server, a future migration bug — can hand back something `saveConfig`
 *    would have refused. `readConfig`/`readConfigs` run every result back
 *    through `parseAgentConfig` and silently drop what fails, exactly like a
 *    torn write.
 * 3. A config's `tools` list only ever narrows against what a room permits
 *    (`intersectTools`). Never a union — a config that could widen its own
 *    permissions is not a preference, it is a silent permanent hole in the
 *    room's four-eyes gate.
 */

const DEFAULT_DATA_DIR = process.env['NEXUS_DATA_DIR'] ?? './data';

function configsDir(dataDir: string): string {
  return join(resolve(dataDir), 'configs');
}

function crewsDir(dataDir: string): string {
  return join(resolve(dataDir), 'crews');
}

/**
 * Config and crew names are free text chosen by whoever saves them — unlike a
 * room id, which the server generates and can trust to already be a safe
 * path segment (`SAFE_ROOM_ID` in event-log.ts). `encodeURIComponent` turns
 * every `/` into `%2F`, which is what closes off a name like `../../etc/x` as
 * a way to write outside `configs/`/`crews/`.
 */
function safeFileName(name: string): string {
  return `${encodeURIComponent(name)}.json`;
}

/** Re-parses one already-on-disk JSON file. `null` covers a torn write, invalid
 * JSON, and a config/crew that no longer passes validation — all three are the
 * same "don't trust the file, don't take the process down" case. */
function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json'));
}

/* -------------------------------------------------------------------------
 * Agent configs
 * ---------------------------------------------------------------------- */

/**
 * Validates `input` through `parseAgentConfig` and, only on success, writes
 * it to disk. Rule 1: there is no other way into `configs/` from this module.
 */
export function saveConfig(input: unknown, dataDir: string = DEFAULT_DATA_DIR): AgentConfigResult {
  const result = parseAgentConfig(input);
  if (!result.ok) return result;

  mkdirSync(configsDir(dataDir), { recursive: true });
  writeFileSync(join(configsDir(dataDir), safeFileName(result.config.name)), JSON.stringify(result.config), 'utf8');
  return result;
}

/** One saved config by name, re-validated. `null` if it does not exist, is
 * corrupt, or no longer passes `parseAgentConfig` (rule 2). */
export function readConfig(name: string, dataDir: string = DEFAULT_DATA_DIR): AgentConfig | null {
  const raw = readJsonFile(join(configsDir(dataDir), safeFileName(name)));
  if (raw === undefined) return null;
  const result = parseAgentConfig(raw);
  return result.ok ? result.config : null;
}

/** Every saved config that still passes `parseAgentConfig` today. A config
 * that fails re-validation is skipped, exactly like a torn write — never
 * thrown, because one bad file must not take the rest of the library down. */
export function readConfigs(dataDir: string = DEFAULT_DATA_DIR): AgentConfig[] {
  const dir = configsDir(dataDir);
  const configs: AgentConfig[] = [];
  for (const fileName of listJsonFiles(dir)) {
    const raw = readJsonFile(join(dir, fileName));
    if (raw === undefined) continue;
    const result = parseAgentConfig(raw);
    if (result.ok) configs.push(result.config);
  }
  return configs;
}

/**
 * Narrows `config`'s tools to their intersection with `roomTools`. Never a
 * union: a room can only ever take tools away from a saved config, not have
 * one hand tools back to itself. Rebuilt field by field rather than spread,
 * matching `agentConfig.ts` and `recovery.ts`'s `writeRoomMeta` — so that
 * adding a field to `AgentConfig` later forces a conscious decision about
 * whether it needs narrowing too, instead of riding along for free.
 */
export function intersectTools(config: AgentConfig, roomTools: readonly string[]): AgentConfig {
  const permitted = new Set(roomTools);
  return {
    name: config.name,
    description: config.description,
    prompt: config.prompt,
    tools: config.tools.filter((tool) => permitted.has(tool)),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
    ...(config.agents !== undefined ? { agents: config.agents } : {}),
  };
}

/* -------------------------------------------------------------------------
 * Crews
 *
 * A crew is a name plus an ORDERED list of members — order matters (it is
 * launch order), so members is an array, never a map keyed by display name.
 * Each member names a saved config, a display name, a provider and a model.
 * Phase 14 adds a dependency graph between members; nothing here forecloses
 * that (a `dependsOn` field on a member is additive), but it is not built yet.
 * ---------------------------------------------------------------------- */

const ALLOWED_CREW_FIELDS = ['name', 'members'] as const;
const ALLOWED_MEMBER_FIELDS = ['configName', 'displayName', 'provider', 'model'] as const;

export interface CrewMember {
  /** Names a saved `AgentConfig` by its own `name` field. Resolved against
   * the config store at launch time (crews.ts), not validated for existence
   * here — a crew and the configs it names can be saved in either order. */
  configName: string;
  displayName: string;
  provider: AgentProvider;
  model?: string;
}

export interface Crew {
  name: string;
  members: CrewMember[];
}

export type CrewResult = { ok: true; crew: Crew } | { ok: false; problems: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownFields(input: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(input)
    .filter((key) => !allowed.includes(key))
    .map((key) => `\`${key}\` is not a field Nexus accepts on a crew.`);
}

function parseMember(index: number, value: unknown): { problems: string[]; member?: CrewMember } {
  if (!isPlainObject(value)) {
    return { problems: [`Member ${index} must be an object.`] };
  }
  const problems = unknownFields(value, ALLOWED_MEMBER_FIELDS).map((m) => `Member ${index}: ${m}`);

  if (typeof value['configName'] !== 'string' || value['configName'] === '') {
    problems.push(`Member ${index} needs a \`configName\`.`);
  }
  if (typeof value['displayName'] !== 'string' || value['displayName'] === '') {
    problems.push(`Member ${index} needs a \`displayName\`.`);
  }
  if (!isAgentProvider(value['provider'])) {
    problems.push(`Member ${index} needs a \`provider\` that is one of anthropic, openai, google.`);
  }
  if (value['model'] !== undefined && typeof value['model'] !== 'string') {
    problems.push(`Member ${index}: \`model\` must be a string.`);
  }
  if (problems.length > 0) return { problems };

  return {
    problems: [],
    // Rebuilt field by field, never spread — same discipline as
    // parseAgentConfig, for the same reason: a member is executable input
    // once crews.ts uses it to launch an agent.
    member: {
      configName: value['configName'] as string,
      displayName: value['displayName'] as string,
      provider: value['provider'] as AgentProvider,
      ...(typeof value['model'] === 'string' ? { model: value['model'] } : {}),
    },
  };
}

export function parseCrew(input: unknown): CrewResult {
  if (!isPlainObject(input)) {
    return { ok: false, problems: ['A crew must be a JSON object.'] };
  }

  const problems = unknownFields(input, ALLOWED_CREW_FIELDS);

  if (typeof input['name'] !== 'string' || input['name'] === '') problems.push('`name` is required.');

  const members: CrewMember[] = [];
  if (!Array.isArray(input['members'])) {
    problems.push('`members` must be an array.');
  } else if (input['members'].length === 0) {
    problems.push('`members` must name at least one agent.');
  } else {
    input['members'].forEach((raw, index) => {
      const parsed = parseMember(index, raw);
      problems.push(...parsed.problems);
      if (parsed.member !== undefined) members.push(parsed.member);
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  return { ok: true, crew: { name: input['name'] as string, members } };
}

/** Validates `input` through `parseCrew` and, only on success, writes it to
 * disk. Same rule as `saveConfig`: no other way into `crews/` from here. */
export function saveCrew(input: unknown, dataDir: string = DEFAULT_DATA_DIR): CrewResult {
  const result = parseCrew(input);
  if (!result.ok) return result;

  mkdirSync(crewsDir(dataDir), { recursive: true });
  writeFileSync(join(crewsDir(dataDir), safeFileName(result.crew.name)), JSON.stringify(result.crew), 'utf8');
  return result;
}

/** One saved crew by name, re-validated. `null` if it does not exist, is
 * corrupt, or no longer passes `parseCrew`. */
export function readCrew(name: string, dataDir: string = DEFAULT_DATA_DIR): Crew | null {
  const raw = readJsonFile(join(crewsDir(dataDir), safeFileName(name)));
  if (raw === undefined) return null;
  const result = parseCrew(raw);
  return result.ok ? result.crew : null;
}

/** Every saved crew that still passes `parseCrew` today. Same torn-write
 * tolerance as `readConfigs`: one bad file is skipped, not fatal. */
export function readCrews(dataDir: string = DEFAULT_DATA_DIR): Crew[] {
  const dir = crewsDir(dataDir);
  const crews: Crew[] = [];
  for (const fileName of listJsonFiles(dir)) {
    const raw = readJsonFile(join(dir, fileName));
    if (raw === undefined) continue;
    const result = parseCrew(raw);
    if (result.ok) crews.push(result.crew);
  }
  return crews;
}
