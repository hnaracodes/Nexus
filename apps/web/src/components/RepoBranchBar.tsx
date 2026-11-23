import { GitBranch, GitPullRequest } from 'lucide-react';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { deriveGithubBinding } from '../githubBinding.js';

/**
 * Shows which repository and branch the room's agent would publish to.
 * Pure derivation off the log (I3): `deriveGithubBinding` reads the first
 * `room_created` event, and the branch name is computed the same way
 * `publish.ts:32,278` computes it server-side — `nexus/<roomId>` — so this
 * bar can never show a branch the publish tool would not actually write to.
 * No fetch, no local state.
 */
export function RepoBranchBar({
  events,
  roomId,
}: {
  events: SynCodeEvent[];
  roomId: string;
}): JSX.Element {
  const github = deriveGithubBinding(events);

  if (github === null) {
    return (
      <div
        className="flex h-6 min-w-0 shrink items-center gap-1 rounded px-1.5 text-xs text-fg-muted"
        title="This room was not connected to a GitHub repository"
      >
        <GitPullRequest size={12} aria-hidden="true" />
        <span className="truncate">No repository</span>
      </div>
    );
  }

  const branch = `nexus/${roomId}`;

  return (
    <div
      className="flex h-6 min-w-0 shrink items-center gap-1 rounded px-1.5 text-xs text-fg-muted"
      title={`Publishing opens a pull request on ${github.owner}/${github.repo} from ${branch}`}
    >
      <span className="flex min-w-0 items-center gap-1">
        <GitPullRequest size={12} aria-hidden="true" />
        <span className="truncate text-fg">{`${github.owner}/${github.repo}`}</span>
      </span>
      <span className="hidden min-w-0 items-center gap-1 font-mono sm:flex">
        <GitBranch size={12} aria-hidden="true" />
        <span className="truncate">{branch}</span>
      </span>
    </div>
  );
}
