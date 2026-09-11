import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Download } from '../Download.js';
import { resolveRoute } from '../../routing.js';

/**
 * The page fetches `GET /api/releases/latest` from OUR server (not GitHub — see
 * Download.tsx's comment on why the direct call could never work) from the
 * GitHub API on mount — never a hardcoded version — and picks a primary
 * download from the returned `assets` array by filename shape. This stub
 * mirrors that shape closely enough to exercise the matching logic without
 * depending on the real network.
 */
function releasePayload(assetNames: string[]): {
  tag_name: string;
  html_url: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
} {
  return {
    tag_name: 'v1.2.3',
    html_url: 'https://github.com/hnaracodes/Nexus/releases/tag/v1.2.3',
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: `https://github.com/hnaracodes/Nexus/releases/download/v1.2.3/${name}`,
      size: 123_456_789,
    })),
  };
}

const ALL_ASSETS = [
  'Nexus-1.2.3-mac-arm64.dmg',
  'Nexus-1.2.3-mac-x64.dmg',
  'Nexus-1.2.3-win-x64.exe',
  'Nexus-1.2.3-linux-x64.AppImage',
];

function setUserAgent(ua: string): void {
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value: ua,
    configurable: true,
  });
}

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

let originalFetch: typeof globalThis.fetch;
let originalUA: string;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalUA = globalThis.navigator.userAgent;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setUserAgent(originalUA);
  vi.restoreAllMocks();
});

describe('resolveRoute', () => {
  it('routes /download to the download page', () => {
    expect(resolveRoute('/download', '')).toBe('download');
  });
});

describe('Download page', () => {
  it('offers the macOS build first on a Mac user agent', async () => {
    setUserAgent(MAC_UA);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => releasePayload(ALL_ASSETS),
    })) as unknown as typeof fetch;

    render(<Download />);

    const primary = await screen.findByRole('link', { name: /download for mac/i });
    expect(primary.getAttribute('href')).toContain('mac-arm64.dmg');

    // The other two platforms are still listed, just not the headline choice.
    expect(screen.getByRole('link', { name: /windows/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /appimage|linux/i })).toBeInTheDocument();
  });

  it('offers the Windows build first on a Windows user agent', async () => {
    setUserAgent(WINDOWS_UA);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => releasePayload(ALL_ASSETS),
    })) as unknown as typeof fetch;

    render(<Download />);

    const primary = await screen.findByRole('link', { name: /download for windows/i });
    expect(primary.getAttribute('href')).toContain('win-x64.exe');
  });

  it('offers the Linux build first on a Linux user agent', async () => {
    setUserAgent(LINUX_UA);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => releasePayload(ALL_ASSETS),
    })) as unknown as typeof fetch;

    render(<Download />);

    const primary = await screen.findByRole('link', { name: /download for linux/i });
    expect(primary.getAttribute('href')).toContain('.AppImage');
  });

  it('says plainly, on every platform, that the build is unsigned', async () => {
    setUserAgent(MAC_UA);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => releasePayload(ALL_ASSETS),
    })) as unknown as typeof fetch;

    render(<Download />);
    await screen.findByRole('link', { name: /download for mac/i });

    expect(screen.getAllByText(/unsigned/i).length).toBeGreaterThan(0);
    // The exact macOS wording, so a user is not left thinking the download broke.
    expect(screen.getByText(/apple could not verify/i)).toBeInTheDocument();
    expect(screen.getByText(/smartscreen/i)).toBeInTheDocument();
    expect(screen.getAllByText(/right-click/i).length).toBeGreaterThan(0);
  });

  it('falls back to a hardcoded, version-less release link when the GitHub API call fails', async () => {
    setUserAgent(MAC_UA);
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    render(<Download />);

    const fallback = await screen.findByRole('link', { name: /view releases on github|all releases/i });
    const href = fallback.getAttribute('href') ?? '';
    expect(href).toContain('github.com/hnaracodes/Nexus/releases');
    // Never a specific tag — the whole point is it never hardcodes a version.
    expect(href).not.toMatch(/\/v?\d+\.\d+\.\d+/);

    // A visible, honest notice rather than a silently broken page.
    expect(screen.getByText(/couldn.t reach github/i)).toBeInTheDocument();
  });

  it('also falls back cleanly when the API responds with a non-OK status', async () => {
    setUserAgent(LINUX_UA);
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not Found' }),
    })) as unknown as typeof fetch;

    render(<Download />);

    const fallback = await screen.findByRole('link', { name: /view releases on github|all releases/i });
    expect(fallback.getAttribute('href')).toContain('github.com/hnaracodes/Nexus/releases');
  });

  it('mentions the quarantine workaround only as a secondary, labelled option', async () => {
    setUserAgent(MAC_UA);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => releasePayload(ALL_ASSETS),
    })) as unknown as typeof fetch;

    render(<Download />);
    await screen.findByRole('link', { name: /download for mac/i });

    const advanced = screen.getByText(/xattr -d com\.apple\.quarantine/);
    expect(advanced).toBeInTheDocument();
    // Labelled as a secondary/advanced/last-resort step, not the lead instruction.
    const container = advanced.closest('section, div, details') ?? advanced;
    expect(within(container as HTMLElement).getByText(/last resort|advanced|only if/i)).toBeInTheDocument();
  });

  it('waits for the release to load before rendering a download link', () => {
    setUserAgent(MAC_UA);
    let resolveFetch: (value: unknown) => void = () => {};
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;

    render(<Download />);
    expect(screen.queryByRole('link', { name: /download for mac/i })).not.toBeInTheDocument();
    // Keep the reference alive so nothing about the pending promise is flagged as unused.
    void resolveFetch;
  });

  it('waits until the release loads before rendering a download link', async () => {
    // Duplicate-guard for the assertion above: ensure a resolved-but-unmatched
    // response still lands on a sane state instead of throwing.
    setUserAgent('some-unknown-agent/1.0');
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => releasePayload(ALL_ASSETS),
    })) as unknown as typeof fetch;

    render(<Download />);
    await waitFor(() => {
      expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
    });
  });
});
