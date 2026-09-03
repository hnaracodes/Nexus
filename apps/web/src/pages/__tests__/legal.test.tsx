import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Privacy } from '../Privacy.js';
import { Terms } from '../Terms.js';
import { Security } from '../Security.js';

const ANTHROPIC_POLICY =
  'Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users.';

const SECURITY_BOUNDARY = 'A shared room is a shared security boundary.';
const NO_ISOLATION = 'Nexus has no isolation between rooms.';

/** Heading levels must descend without skipping (h1 -> h2 -> h3, never h1 -> h3). */
function assertNoHeadingSkips(container: HTMLElement): void {
  const headings = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  let previousLevel = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName[1]);
    expect(level).toBeLessThanOrEqual(previousLevel + 1);
    previousLevel = level;
  }
}

describe.each([
  ['Privacy', Privacy],
  ['Terms', Terms],
  ['Security', Security],
])('%s page', (_name, Page) => {
  it('renders exactly one h1 and a Last updated date, with no heading skips', () => {
    const { container } = render(<Page />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText(/Last updated:/i)).toBeInTheDocument();
    assertNoHeadingSkips(container);
  });
});

describe('Privacy content', () => {
  it('discloses that there is no deletion mechanism', () => {
    render(<Privacy />);
    const text = document.body.textContent ?? '';
    expect(/no deletion mechanism|no mechanism to delete/i.test(text)).toBe(true);
  });

  it('mentions the sk-ant key format', () => {
    render(<Privacy />);
    expect(document.body.textContent).toContain('sk-ant');
  });

  it('discloses localStorage usage', () => {
    render(<Privacy />);
    expect(document.body.textContent).toContain('localStorage');
  });

  it('quotes the Anthropic Console-keys policy verbatim', () => {
    render(<Privacy />);
    expect(document.body.textContent).toContain(ANTHROPIC_POLICY);
  });

  it('discloses that redaction is narrow, not comprehensive', () => {
    render(<Privacy />);
    const text = document.body.textContent ?? '';
    expect(/written to the log verbatim/i.test(text)).toBe(true);
  });

  it('discloses the plaintext room token on disk', () => {
    render(<Privacy />);
    const text = document.body.textContent ?? '';
    expect(/plaintext/i.test(text)).toBe(true);
  });
});

describe('Security content', () => {
  it('states both verbatim BUILD_SPEC.md section 8 sentences', () => {
    render(<Security />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(SECURITY_BOUNDARY);
    expect(text).toContain(NO_ISOLATION);
  });

  it('states the 120-second timeout-denies rule and first-response-wins', () => {
    render(<Security />);
    const text = document.body.textContent ?? '';
    expect(/120 seconds/i.test(text)).toBe(true);
    expect(/first decision made wins/i.test(text)).toBe(true);
  });

  it('states the token is 256 bits and the room id is not the credential', () => {
    render(<Security />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('256-bit');
    expect(/room id.*is only 64 bits/i.test(text)).toBe(true);
  });
});

describe('Terms content', () => {
  it('states there is no warranty and usage costs land on the room creator', () => {
    render(<Terms />);
    const text = document.body.textContent ?? '';
    expect(/no warranty/i.test(text)).toBe(true);
    expect(/creator.*responsibility/i.test(text)).toBe(true);
  });
});
