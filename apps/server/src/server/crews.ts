/**
 * Launching a saved crew (phase 13, G3).
 *
 * Owns POLICY only, same split as `fleet.ts`: how a crew's members become
 * live agents, not the mechanism of spawning one. Every agent this module
 * produces goes through `spawnAgent` (`fleet.ts`) — never a second, parallel
 * implementation of id minting, the resource cap, or the `attachAgent` call,
 * because a second implementation is a second place for I1/I3 to quietly stop
 * holding.
 *
 * `CrewRuntime` below is `FleetRuntime` (fleet.ts) plus the one extra member
 * this file needs of its own: `commit`, for `crew_launched` itself, which is
 * NOT agent-scoped (`CrewLaunched` in events.ts carries no `agentId`) and so
 * is sealed through `commit`, not `commitAs` — see `ws.ts`'s `commit`, which
 * routes to `commitAs(PRIMARY_AGENT_ID, …)` and, on that branch, stamps no
 * `agentId` key onto the event at all.
 */
import { randomUUID } from 'node:crypto';
import type { AgentId, CrewLaunched, NexusEvent, UnsequencedEvent } from '@syncode/protocol/events';
import type { AgentDeps, Interrupter } from './agent.js';
import { readConfig, readCrew } from './configStore.js';
import type { FleetRuntime } from './fleet.js';
import { spawnAgent, stopAgent } from './fleet.js';

export interface CrewRuntime extends FleetRuntime {
  commit(event: UnsequencedEvent): NexusEvent;
}

export interface LaunchCrewArgs {
  runtime: CrewRuntime;
  /** Names a saved `Crew` by its own `name` field (configStore.ts). */
  crewName: string;
  /** Who asked for this launch. Always a person — `launch_crew` (wire.ts) has
   *  no unattended path. */
  by: Interrupter;
  /** Where `configStore.ts` looks for the crew and its members' configs.
   *  Defaults to `NEXUS_DATA_DIR` exactly like every `configStore.ts` export. */
  dataDir?: string;
  /** Test seam threaded straight through to every member's `spawnAgent` call —
   *  see fleet.ts's own `CanSpawnOptions`. The cap must never depend on the
   *  memory of whatever machine happens to run the suite. */
  totalMemBytes?: number;
  /** Test seam threaded through to every member's `spawnAgent` call. Defaults
   *  to a fresh random id per member. */
  nextAgentId?: () => AgentId;
  /** Test seam for this crew's own id. Defaults to a fresh random id. */
  nextCrewId?: () => string;
  /** Test seam threaded through to every member's `spawnAgent` call — a
   *  stub `runQuery` (or the OpenAI/Gemini equivalent), never anything
   *  provider-specific decided in this file. */
  deps?: AgentDeps;
}

export type LaunchCrewResult =
  | { ok: true; crewId: string; agentIds: AgentId[] }
  | { ok: false; reason: string };

function defaultNextCrewId(): string {
  return `crew_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * Launch every member of a saved crew and log ONE `crew_launched` naming the
 * crew and the real ids it produced.
 *
 * All-or-nothing, deliberately: a crew that gets three of five members up and
 * then silently stops is worse than a crew that never started, because a
 * human looking at the fleet has no way to tell "this is the whole crew" from
 * "this is what fit before something broke". So two checks run BEFORE any
 * agent is touched — the crew exists, and every member's named config still
 * resolves — and if a member fails to spawn anyway (in practice this can only
 * be the phase-12 resource cap; a config that doesn't resolve is already
 * caught above), every member this call already spawned is stopped again
 * before returning. A crew of six on a machine that holds four is not a
 * special case that gets to bypass that cap — it is exactly how a user
 * discovers it, and three agents left running with no way to know they're
 * half a crew is a worse discovery than a clean refusal.
 */
export function launchCrew(args: LaunchCrewArgs): LaunchCrewResult {
  const crew = readCrew(args.crewName, args.dataDir);
  if (crew === null) {
    return { ok: false, reason: `No saved crew named "${args.crewName}".` };
  }

  // Resolved BEFORE any agent is touched. A crew whose config was deleted (or
  // never existed) after the crew was saved must fail cleanly, not discover
  // the dangling reference on member three after members one and two are
  // already live.
  const missingConfigs = [...new Set(crew.members.map((member) => member.configName))].filter(
    (name) => readConfig(name, args.dataDir) === null,
  );
  if (missingConfigs.length > 0) {
    return {
      ok: false,
      reason:
        `Crew "${crew.name}" names a saved configuration Nexus can't find: ${missingConfigs.join(', ')}. ` +
        'Save it again, or remove that member from the crew.',
    };
  }

  const spawnedIds: AgentId[] = [];
  for (const member of crew.members) {
    const result = spawnAgent({
      runtime: args.runtime,
      displayName: member.displayName,
      provider: member.provider,
      model: member.model ?? null,
      by: args.by,
      configName: member.configName,
      ...(args.deps === undefined ? {} : { deps: args.deps }),
      ...(args.totalMemBytes === undefined ? {} : { totalMemBytes: args.totalMemBytes }),
      ...(args.nextAgentId === undefined ? {} : { nextId: args.nextAgentId }),
    });

    if (!result.ok) {
      // Roll back rather than leave a half-launched crew running silently.
      for (const agentId of spawnedIds) {
        stopAgent({ runtime: args.runtime, agentId, by: args.by });
      }
      return {
        ok: false,
        reason:
          `Launching "${crew.name}" stopped after ${spawnedIds.length} of ${crew.members.length} ` +
          `member${crew.members.length === 1 ? '' : 's'}: ${result.reason} ` +
          'Every agent this launch started has been stopped — nothing was left half-running.',
      };
    }
    spawnedIds.push(result.agentId);
  }

  const crewId = (args.nextCrewId ?? defaultNextCrewId)();

  // Committed AFTER every member exists, naming their real ids — a
  // `crew_launched` naming an agent that was never spawned is unreconstructible
  // state (I3), the same discipline `spawnAgent` (fleet.ts) uses for
  // `agent_spawned` itself.
  args.runtime.commit({
    type: 'crew_launched',
    crewId,
    crewName: crew.name,
    agentIds: spawnedIds,
    participantId: args.by.participantId,
    displayName: args.by.displayName,
  } satisfies Omit<CrewLaunched, 'seq' | 'ts' | 'roomId'>);

  return { ok: true, crewId, agentIds: spawnedIds };
}

export interface CrewProjection {
  crewId: string;
  crewName: string;
  agentIds: AgentId[];
}

/**
 * Reconstructs every crew this room has ever launched, from the log alone
 * (I3). `configStore.ts`'s `Crew`/`CrewMember` are what PRODUCED a launch —
 * user assets, not room history (phase-13-crews-and-accounts.md D3) — so they
 * are deliberately not read here; only `crew_launched` itself, which is the
 * one durable record that a launch happened and what it produced.
 */
export function projectCrews(events: NexusEvent[]): CrewProjection[] {
  const crews: CrewProjection[] = [];
  for (const event of events) {
    if (event.type === 'crew_launched') {
      crews.push({ crewId: event.crewId, crewName: event.crewName, agentIds: [...event.agentIds] });
    }
  }
  return crews;
}
