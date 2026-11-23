import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectGithubRepo,
  parseOriginUrl,
  readGitBranch,
} from '../../src/server/repoDetect.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'syncode-repodetect-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function repoWithConfig(config: string, head = 'ref: refs/heads/main\n'): string {
  const cwd = mkdtempSync(join(root, 'repo-'));
  mkdirSync(join(cwd, '.git'));
  writeFileSync(join(cwd, '.git', 'config'), config);
  writeFileSync(join(cwd, '.git', 'HEAD'), head);
  return cwd;
}

function originConfig(url: string): string {
  return `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
}

const CLEAN = (o: string, r: string) => ({ owner: o, repo: r, url: `https://github.com/${o}/${r}` });

describe('detectGithubRepo: accepted GitHub remotes', () => {
  const cases: [string, string][] = [
    ['https', 'https://github.com/octo/cat'],
    ['https .git', 'https://github.com/octo/cat.git'],
    ['https trailing slash', 'https://github.com/octo/cat/'],
    ['https .git trailing slash', 'https://github.com/octo/cat.git/'],
    ['scp style', 'git@github.com:octo/cat.git'],
    ['scp style without .git', 'git@github.com:octo/cat'],
    ['ssh://', 'ssh://git@github.com/octo/cat.git'],
    ['uppercase host', 'https://GitHub.com/octo/cat'],
  ];
  for (const [name, url] of cases) {
    it(`accepts ${name}`, () => {
      expect(detectGithubRepo(repoWithConfig(originConfig(url)))).toEqual(CLEAN('octo', 'cat'));
    });
  }

  it('keeps dots, dashes and underscores in the repo name', () => {
    expect(detectGithubRepo(repoWithConfig(originConfig('git@github.com:a-b/my_repo.js.git')))).toEqual(
      CLEAN('a-b', 'my_repo.js'),
    );
  });

  it('returns a rebuilt URL that contains no credential, whatever the raw URL carried', () => {
    for (const raw of [
      'https://ghp_SECRETTOKEN123@github.com/octo/cat.git',
      'https://x-access-token:ghs_SECRETTOKEN123@github.com/octo/cat',
      'https://user:p%40ss-SECRETTOKEN123@github.com/octo/cat.git',
    ]) {
      const found = detectGithubRepo(repoWithConfig(originConfig(raw)));
      expect(found, raw).toEqual(CLEAN('octo', 'cat'));
      expect(JSON.stringify(found)).not.toContain('SECRETTOKEN');
      expect(JSON.stringify(found)).not.toContain('@');
    }
  });

  it('handles a quoted value, an inline comment and mixed-case names', () => {
    const config = '[Remote "origin"]\n  URL = "https://github.com/octo/cat.git" ; mirror\n';
    expect(detectGithubRepo(repoWithConfig(config))).toEqual(CLEAN('octo', 'cat'));
  });

  it('handles the header and key on one line', () => {
    const config = '[remote "origin"] url = git@github.com:octo/cat.git\n';
    expect(detectGithubRepo(repoWithConfig(config))).toEqual(CLEAN('octo', 'cat'));
  });

  it('ignores commented-out lines and takes the first origin url', () => {
    const config =
      '[remote "origin"]\n# url = https://github.com/evil/one\n\turl = https://github.com/octo/cat\n\turl = https://github.com/other/two\n';
    expect(detectGithubRepo(repoWithConfig(config))).toEqual(CLEAN('octo', 'cat'));
  });
});

describe('detectGithubRepo: refused', () => {
  const refused: [string, string][] = [
    ['non-GitHub host', 'https://gitlab.com/octo/cat.git'],
    ['github.com as a prefix of another host', 'https://github.com.evil.com/octo/cat'],
    ['evilgithub.com', 'https://evilgithub.com/octo/cat'],
    ['evilgithub.com scp', 'git@evilgithub.com:octo/cat.git'],
    ['github.com only as userinfo', 'https://github.com@evil.com/octo/cat'],
    ['github.com in the path', 'https://evil.com/github.com/octo/cat'],
    ['plain http', 'http://github.com/octo/cat'],
    ['an explicit port', 'https://github.com:8443/octo/cat'],
    ['a different scp user', 'bob@github.com:octo/cat.git'],
    ['an owner starting with a dash', 'https://github.com/-octo/cat'],
    ['a dot-dot repo', 'https://github.com/octo/..'],
    ['too many path segments', 'https://github.com/octo/cat/extra'],
    ['a missing repo', 'https://github.com/octo'],
    ['a local path', '/srv/git/cat.git'],
    ['a file URL', 'file:///srv/git/cat.git'],
  ];
  for (const [name, url] of refused) {
    it(`returns null for ${name}`, () => {
      expect(detectGithubRepo(repoWithConfig(originConfig(url))), url).toBeNull();
    });
  }

  it('returns null when there is no origin remote', () => {
    expect(detectGithubRepo(repoWithConfig('[core]\n\tbare = false\n'))).toBeNull();
  });

  it('returns null when only an upstream remote exists', () => {
    const config = '[remote "upstream"]\n\turl = https://github.com/octo/cat.git\n';
    expect(detectGithubRepo(repoWithConfig(config))).toBeNull();
  });

  it('returns null for a folder that is not a git repository', () => {
    expect(detectGithubRepo(mkdtempSync(join(root, 'plain-')))).toBeNull();
  });

  it('returns null for a folder that does not exist', () => {
    expect(detectGithubRepo(join(root, 'nope'))).toBeNull();
  });

  it('returns null, without throwing, for an oversized config', () => {
    const big = `${originConfig('https://github.com/octo/cat')}${'# padding\n'.repeat(10_000)}`;
    expect(big.length).toBeGreaterThan(64 * 1024);
    expect(detectGithubRepo(repoWithConfig(big))).toBeNull();
  });

  it('returns null, without throwing, for garbage config bytes', () => {
    const garbage = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)).toString('latin1');
    expect(detectGithubRepo(repoWithConfig(garbage))).toBeNull();
    expect(detectGithubRepo(repoWithConfig('[remote "origin"\nurl = "unterminated\n'))).toBeNull();
    expect(detectGithubRepo(repoWithConfig('[remote "origin"]\nurl = https://github.com/a/b\\q\n'))).toBeNull();
  });

  it('returns null when .git/config is a directory', () => {
    const cwd = mkdtempSync(join(root, 'dirconfig-'));
    mkdirSync(join(cwd, '.git', 'config'), { recursive: true });
    expect(detectGithubRepo(cwd)).toBeNull();
  });
});

describe('git worktrees and submodules (.git is a file)', () => {
  it('follows gitdir: once, then commondir, reading config from the common dir', () => {
    const main = repoWithConfig(originConfig('https://github.com/octo/cat.git'));
    const wtGit = join(main, '.git', 'worktrees', 'feature');
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, 'commondir'), '../..\n');
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/feature/x\n');
    const wt = mkdtempSync(join(root, 'wt-'));
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(detectGithubRepo(wt)).toEqual(CLEAN('octo', 'cat'));
    // The branch is the worktree's own HEAD, not the main checkout's.
    expect(readGitBranch(wt)).toBe('feature/x');
    expect(readGitBranch(main)).toBe('main');
  });

  it('resolves a relative gitdir against the folder (submodule style)', () => {
    const outer = mkdtempSync(join(root, 'outer-'));
    const modules = join(outer, '.git', 'modules', 'sub');
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, 'config'), originConfig('git@github.com:octo/sub.git'));
    writeFileSync(join(modules, 'HEAD'), 'ref: refs/heads/dev\n');
    const sub = join(outer, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    expect(detectGithubRepo(sub)).toEqual(CLEAN('octo', 'sub'));
    expect(readGitBranch(sub)).toBe('dev');
  });

  it('returns null for a .git file that does not point at a directory', () => {
    const cwd = mkdtempSync(join(root, 'badptr-'));
    writeFileSync(join(cwd, '.git'), 'gitdir: /definitely/not/here\n');
    expect(detectGithubRepo(cwd)).toBeNull();
    writeFileSync(join(cwd, '.git'), 'nonsense');
    expect(detectGithubRepo(cwd)).toBeNull();
  });
});

describe('readGitBranch', () => {
  it('reads the branch name', () => {
    expect(readGitBranch(repoWithConfig('', 'ref: refs/heads/release/1.2\n'))).toBe('release/1.2');
  });

  it('is null for a detached HEAD', () => {
    expect(readGitBranch(repoWithConfig('', '0123456789abcdef0123456789abcdef01234567\n'))).toBeNull();
  });

  it('is null for a non-branch ref and for control characters', () => {
    expect(readGitBranch(repoWithConfig('', 'ref: refs/remotes/origin/main\n'))).toBeNull();
    expect(readGitBranch(repoWithConfig('', 'ref: refs/heads/a\u0007b\n'))).toBeNull();
  });

  it('is null for a non-repository', () => {
    expect(readGitBranch(mkdtempSync(join(root, 'plain-')))).toBeNull();
  });
});

describe('parseOriginUrl', () => {
  it('ignores include directives and other sections', () => {
    expect(parseOriginUrl('[include]\n\tpath = /etc/x\n[branch "main"]\n\turl = nope\n')).toBeNull();
  });
});
