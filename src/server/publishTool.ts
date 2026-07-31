/**
 * Exposes "publish this room's work as a pull request" to the agent as an MCP
 * tool (plan phase-6).
 *
 * Why a tool rather than a button: a tool call goes through `canUseTool`, which
 * is the room's existing four-eyes permission gate. Pushing code to someone's
 * repository is exactly the class of action that gate exists for, and routing it
 * this way means **no change to `permissions.ts` at all** — the request appears
 * in every participant's UI, any of them can approve or deny it, and a denial
 * comes back to the agent as guidance it can adapt to. It is deliberately in no
 * auto-approve list.
 *
 * This file is the thin SDK-facing wrapper. All of the actual publish logic is
 * in `publish.ts`, which imports nothing from the SDK and is unit-testable with
 * an injected `fetch` and an injected `git`.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { NexusEvent, UnsequencedEvent } from '../protocol/events.js';
import { publishToGithub } from './publish.js';
import type { Room } from './rooms.js';

export type EmitFn = (event: UnsequencedEvent) => void;

/**
 * The room's own last published commit, derived from the event log rather than
 * held in a variable (I3). That matters for more than tidiness: a room that
 * restarts must still know what it last pushed, or the next publish would take
 * a moving `main` as its parent and fail as a non-fast-forward.
 */
export function lastPublishedSha(events: NexusEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'github_published') return event.commitSha;
  }
  return null;
}

/**
 * Returns null when the room has no GitHub binding, so a plain room simply has
 * no publish tool rather than one that fails when called.
 */
export function createGithubMcpServer(
  room: Room,
  emit: EmitFn,
  readEvents: () => NexusEvent[],
): ReturnType<typeof createSdkMcpServer> | null {
  const binding = room.github;
  if (binding === null) return null;

  return createSdkMcpServer({
    name: 'nexus_github',
    version: '1.0.0',
    tools: [
      tool(
        'publish_pull_request',
        `Publish the current working tree to GitHub as a pull request on ${binding.owner}/${binding.repo}. ` +
          'Every participant in the room is asked to approve before this runs. ' +
          'Calling it again updates the same pull request rather than opening a second one.',
        {
          title: z.string().describe('Pull request title. One line, imperative mood.'),
          body: z
            .string()
            .describe('Pull request description: what changed and why, in a few sentences.'),
        },
        async (args) => {
          try {
            const result = await publishToGithub({
              binding,
              cwd: room.cwd,
              roomId: room.id,
              title: args.title,
              body: args.body,
              lastPublishedSha: lastPublishedSha(readEvents()),
            });

            // Logged, so "what did this room actually ship" is answerable from
            // the log alone. Carries no credential — everything here is public
            // the moment the PR exists.
            emit({
              type: 'github_published',
              prUrl: result.prUrl,
              prNumber: result.prNumber,
              branch: result.branch,
              commitSha: result.commitSha,
              filesChanged: result.filesChanged,
              created: result.created,
            });

            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `${result.created ? 'Opened' : 'Updated'} pull request #${result.prNumber} ` +
                    `(${result.filesChanged} file(s) changed) on branch ${result.branch}: ${result.prUrl}`,
                },
              ],
            };
          } catch (error) {
            // `publish.ts` is written never to put a token in its errors, but
            // this is the boundary where a message becomes a tool_result — which
            // is logged AND broadcast — so it does not rely on that alone (I4).
            const message = error instanceof Error ? error.message : 'Publishing failed.';
            return {
              content: [{ type: 'text' as const, text: `Could not publish: ${message}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
