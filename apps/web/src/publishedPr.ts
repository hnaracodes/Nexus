import type { SynCodeEvent } from '@syncode/protocol/events';

export const PUBLISH_TOOL_SUFFIX = 'publish_pull_request';

export interface PublishedPr {
  prUrl: string;
  prNumber: number;
  branch: string;
  filesChanged: number;
  created: boolean;
  seq: number;
  approvedBy: string | null;
}

/**
 * The room's current pull request, derived from the log (I3). Null until the
 * agent has published once.
 *
 * Takes the LAST `github_published` rather than the first: branch
 * `nexus/<roomId>` is stable per room, so a second publish updates the same PR
 * and only the newest event describes its real state (`created: false`).
 *
 * `approvedBy` is the participant whose approval released this publish through
 * the four-eyes gate, used to decide whose browser may pop the PR open. It is
 * matched by tool name rather than by position — an approval for some other
 * tool between the publish approval and the publish itself is ordinary, and
 * this project has already shipped one bug from matching decisions positionally.
 * Null when the gate resolved without a human (auto-approve or timeout).
 */
export function deriveLatestPublishedPr(events: SynCodeEvent[]): PublishedPr | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'github_published') continue;

    let approvedBy: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const earlier = events[j];
      if (
        earlier?.type === 'permission_decided' &&
        earlier.decision === 'allow' &&
        earlier.toolName.endsWith(PUBLISH_TOOL_SUFFIX)
      ) {
        approvedBy = earlier.participantId;
        break;
      }
    }

    return {
      prUrl: event.prUrl,
      prNumber: event.prNumber,
      branch: event.branch,
      filesChanged: event.filesChanged,
      created: event.created,
      seq: event.seq,
      approvedBy,
    };
  }
  return null;
}
