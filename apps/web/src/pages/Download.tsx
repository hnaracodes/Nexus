import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, Loader2, ShieldAlert, Terminal } from 'lucide-react';
import { SiteHeader } from './components/SiteHeader.js';
import { SiteFooter } from './components/SiteFooter.js';

/**
 * The GitHub repository this page reads releases from and links to. There is
 * exactly one place this string lives — `USING.md` and `scripts/install.sh`
 * each hold their own copy because they cannot import TypeScript, but every
 * one of the three was written by this unit in the same pass and should be
 * kept in sync by hand if the repo ever moves.
 */
const REPO = 'hnaracodes/Nexus';
/**
 * OUR server, not GitHub's.
 *
 * This used to be `https://api.github.com/...` called straight from the page,
 * and it never once succeeded in production: `connect-src` is `'self'` plus the
 * room websocket, so the browser refused the request and every visitor saw the
 * "Couldn't reach GitHub" fallback. Widening the CSP would also have made
 * /privacy's "SynCode adds no other third-party processor" false, by handing
 * every visitor's IP to GitHub on page load. The server does the lookup now and
 * caches it; see `/api/releases/latest` in apps/server/src/server/index.ts.
 */
const RELEASES_API = '/api/releases/latest';

/**
 * Deliberately version-less. The whole point of fetching from the API at
 * runtime is that this page never hardcodes a version number — so the ONE
 * thing allowed to be hardcoded is a link that itself carries no version and
 * always resolves to whatever is newest. GitHub redirects `/releases/latest`
 * to the actual tag.
 */
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh`;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface LatestRelease {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

type FetchState =
  | { status: 'loading' }
  | { status: 'loaded'; release: LatestRelease }
  | { status: 'error' };

export type DetectedPlatform = 'mac' | 'windows' | 'linux' | 'unknown';

/**
 * Order matters: a Windows UA can contain neither "mac" nor "linux" tokens
 * that would misfire, but check Windows before Linux anyway since some
 * environments (WSL browsers) can carry both markers.
 */
export function detectPlatform(userAgent: string): DetectedPlatform {
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows') || ua.includes('win64') || ua.includes('win32')) return 'windows';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac';
  if (ua.includes('linux') || ua.includes('x11')) return 'linux';
  return 'unknown';
}

interface MatchedAssets {
  macArm64?: ReleaseAsset;
  macX64?: ReleaseAsset;
  windows?: ReleaseAsset;
  linux?: ReleaseAsset;
}

/**
 * Matches by filename SHAPE, not an exact hardcoded name — the version
 * segment changes on every release, and `electron-builder.yml` names
 * artifacts `${productName}-${version}-${os}-${arch}.${ext}`.
 */
function matchAssets(assets: ReleaseAsset[]): MatchedAssets {
  const find = (pred: (name: string) => boolean): ReleaseAsset | undefined =>
    assets.find((asset) => pred(asset.name.toLowerCase()));
  return {
    macArm64: find((name) => name.endsWith('.dmg') && name.includes('arm64')),
    macX64: find((name) => name.endsWith('.dmg') && !name.includes('arm64')),
    windows: find((name) => name.endsWith('.exe')),
    linux: find((name) => name.endsWith('.appimage')),
  };
}

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function DownloadRow({
  label,
  detail,
  asset,
}: {
  label: string;
  detail: string;
  asset: ReleaseAsset | undefined;
}): JSX.Element {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="text-xs text-fg-muted">{detail}</p>
      </div>
      <a
        href={asset?.browser_download_url ?? RELEASES_PAGE}
        target={asset === undefined ? '_blank' : undefined}
        rel={asset === undefined ? 'noreferrer noopener' : undefined}
        aria-label={`Download ${label}`}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border-strong px-4 py-2 text-sm font-medium text-fg transition-colors duration-150 hover:border-accent/50 hover:bg-surface-2"
      >
        {asset === undefined ? (
          <>
            <ExternalLink size={16} aria-hidden="true" />
            Releases page
          </>
        ) : (
          <>{formatSize(asset.size)}</>
        )}
      </a>
    </li>
  );
}

/**
 * `/download` (phase 17e). Detects the visitor's platform from
 * `navigator.userAgent` and offers the matching desktop build first, while
 * still listing all three so nobody is stuck if the guess is wrong. The
 * release itself is fetched from the GitHub API at mount time — never
 * hardcoded — with a version-less fallback link if that call fails.
 *
 * The honesty banner below is not decoration: CLAUDE.md §11 requires the real
 * state of the build (unsigned, un-notarized) to be surfaced in the UI a user
 * actually reads, not left to a README. A page that hid this would produce a
 * user who concludes their download is broken when Gatekeeper or SmartScreen
 * intervenes.
 */
export function Download(): JSX.Element {
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  const [platform] = useState<DetectedPlatform>(() =>
    detectPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  );

  useEffect(() => {
    let cancelled = false;
    fetch(RELEASES_API, { headers: { Accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
        return response.json() as Promise<LatestRelease>;
      })
      .then((release) => {
        if (!cancelled) setState({ status: 'loaded', release });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const assets = state.status === 'loaded' ? matchAssets(state.release.assets) : {};
  const releaseNotesUrl = state.status === 'loaded' ? state.release.html_url : RELEASES_PAGE;
  const versionLabel = state.status === 'loaded' ? state.release.tag_name : null;

  function primaryAsset(): { label: string; asset: ReleaseAsset | undefined } | null {
    if (platform === 'mac') return { label: 'Download for Mac', asset: assets.macArm64 ?? assets.macX64 };
    if (platform === 'windows') return { label: 'Download for Windows', asset: assets.windows };
    if (platform === 'linux') return { label: 'Download for Linux', asset: assets.linux };
    return null;
  }

  const primary = primaryAsset();

  return (
    <div className="min-h-screen bg-bg text-fg">
      <SiteHeader />
      <main id="main" className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-semibold text-fg sm:text-4xl">Download Nexus</h1>
        <p className="mt-3 max-w-prose text-base leading-relaxed text-fg-muted">
          The desktop app runs its own server on your machine — your rooms, your files, your
          Anthropic key. Built straight from source on every tagged release; nothing here is
          hosted or curated beyond GitHub itself.
        </p>

        {/* The honesty requirement. This is the first thing under the fold on
            purpose — not a footnote after the buttons. */}
        <section
          aria-labelledby="unsigned-h"
          className="mt-8 rounded-lg border border-warn/40 bg-surface p-4"
        >
          <h2 id="unsigned-h" className="flex items-center gap-2 text-lg font-semibold text-fg">
            <ShieldAlert size={20} aria-hidden="true" className="text-warn" />
            This build is unsigned
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-fg-muted">
            Nobody has bought an Apple Developer certificate or a Windows code-signing
            certificate for Nexus yet. That is a deferred decision, not an accident — see the
            project&rsquo;s own notes on it. It means your operating system will warn you before
            it lets the app run, and that warning is expected, not a sign the download failed.
          </p>
          <dl className="mt-4 flex flex-col gap-3 text-sm">
            <div>
              <dt className="font-medium text-fg">On macOS</dt>
              <dd className="mt-1 leading-relaxed text-fg-muted">
                You will see &ldquo;Apple could not verify that &lsquo;Nexus&rsquo; is free of
                malware.&rdquo; Do not click Trash. In Finder, <strong>right-click</strong> (or
                Control-click) <code>Nexus.app</code>, choose <strong>Open</strong>, then confirm
                in the dialog that appears. You only need to do this once.
              </dd>
            </div>
            <div>
              <dt className="font-medium text-fg">On Windows</dt>
              <dd className="mt-1 leading-relaxed text-fg-muted">
                SmartScreen will say &ldquo;Windows protected your PC.&rdquo; Click{' '}
                <strong>More info</strong>, then <strong>Run anyway</strong>.
              </dd>
            </div>
          </dl>
        </section>

        {/* Primary, platform-detected CTA. */}
        <section className="mt-8">
          {state.status === 'loading' && (
            <div
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-4 text-sm text-fg-muted"
              role="status"
            >
              <Loader2 size={16} aria-hidden="true" className="animate-spin" />
              Checking the latest release&hellip;
            </div>
          )}

          {state.status === 'error' && (
            <div className="rounded-lg border border-danger/45 bg-surface px-4 py-4 text-sm">
              <p className="flex items-center gap-2 font-medium text-fg">
                <AlertTriangle size={16} aria-hidden="true" className="text-danger" />
                Couldn&rsquo;t reach GitHub to check the latest release.
              </p>
              <p className="mt-2 text-fg-muted">
                Grab the build directly from the releases page instead:
              </p>
              <a
                href={RELEASES_PAGE}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:brightness-110"
              >
                <ExternalLink size={16} aria-hidden="true" />
                View releases on GitHub
              </a>
            </div>
          )}

          {state.status === 'loaded' && primary !== null && (
            <div className="rounded-lg border border-border bg-surface px-4 py-5">
              <a
                href={primary.asset?.browser_download_url ?? RELEASES_PAGE}
                target={primary.asset === undefined ? '_blank' : undefined}
                rel={primary.asset === undefined ? 'noreferrer noopener' : undefined}
                className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:brightness-110"
              >
                {primary.label}
                {platform === 'mac' && assets.macArm64 !== undefined && ' (Apple Silicon)'}
              </a>
              {primary.asset !== undefined && (
                <p className="mt-2 text-xs text-fg-muted">
                  {versionLabel} &middot; {formatSize(primary.asset.size)}
                </p>
              )}
              {primary.asset === undefined && (
                <p className="mt-2 text-xs text-fg-muted">
                  No matching build found in the latest release yet — this opens the releases
                  page instead.
                </p>
              )}
            </div>
          )}

          {state.status === 'loaded' && primary === null && (
            <p className="rounded-lg border border-border bg-surface px-4 py-4 text-sm text-fg-muted">
              Couldn&rsquo;t tell which platform you&rsquo;re on — pick one below.
            </p>
          )}
        </section>

        {/* Every build, always listed, regardless of the guess above. */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-fg">All downloads</h2>
          <ul className="mt-3 flex flex-col gap-2">
            <DownloadRow label="macOS — Apple Silicon" detail=".dmg, arm64" asset={assets.macArm64} />
            <DownloadRow label="macOS — Intel" detail=".dmg, x64" asset={assets.macX64} />
            <DownloadRow label="Windows" detail=".exe installer, x64" asset={assets.windows} />
            <DownloadRow label="Linux" detail=".AppImage, x64" asset={assets.linux} />
          </ul>
          <a
            href={releaseNotesUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-flex items-center gap-1 text-sm text-info underline underline-offset-2"
          >
            Release notes
          </a>
        </section>

        {/* Command-line install, for people who would rather not click through
            a browser download. */}
        <section className="mt-8 rounded-lg border border-border bg-surface p-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
            <Terminal size={18} aria-hidden="true" className="text-fg-muted" />
            From a terminal (macOS / Linux)
          </h2>
          <pre className="mt-3 overflow-x-auto rounded-md bg-bg px-3 py-2 text-xs text-fg">
            <code>{`curl -fsSL ${INSTALL_SCRIPT_URL} | sh`}</code>
          </pre>
          <p className="mt-2 text-xs leading-relaxed text-fg-muted">
            Downloads the right build for your OS and CPU, verifies its checksum against the one
            published in the release, and refuses to continue if it doesn&rsquo;t match. It does
            not silently work around the unsigned-build warning above.
          </p>
        </section>

        {/* Secondary, labelled last-resort workaround. Deliberately below
            everything else and never presented as the normal path. */}
        <section className="mt-8 rounded-lg border border-border bg-surface/60 p-4 text-sm">
          <p className="font-medium text-fg">Advanced / last resort</p>
          <p className="mt-2 leading-relaxed text-fg-muted">
            If right-click &rarr; Open still refuses, you can remove macOS&rsquo;s quarantine flag
            for this one app: <code>xattr -d com.apple.quarantine /Applications/Nexus.app</code>.
            This disables Gatekeeper&rsquo;s malware check for Nexus specifically — only do this if
            you trust where you got the file. It is not the recommended step; the right-click
            instruction above is.
          </p>
        </section>

        <p className="mt-8 flex items-center gap-2 text-xs text-fg-muted">
          <Check size={14} aria-hidden="true" />
          Built straight from this repository&rsquo;s source on every tagged release — nothing
          published here is hand-assembled.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
