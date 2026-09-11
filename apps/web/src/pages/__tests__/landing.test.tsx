import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Landing } from '../Landing.js';

describe('Landing', () => {
  it('renders the verbatim security-boundary sentence', () => {
    render(<Landing />);
    expect(
      screen.getByText('A shared room is a shared security boundary.'),
    ).toBeInTheDocument();
  });

  it('renders the verbatim no-isolation sentence', () => {
    render(<Landing />);
    expect(
      screen.getByText('SynCode has no isolation between rooms.'),
    ).toBeInTheDocument();
  });

  it('has exactly one h1', () => {
    render(<Landing />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('never skips a heading level', () => {
    render(<Landing />);
    const headings = screen.getAllByRole('heading');
    const levels = headings.map((h) => Number(h.tagName.slice(1)));
    let max = 0;
    for (const level of levels) {
      expect(level).toBeLessThanOrEqual(max + 1);
      max = Math.max(max, level);
    }
  });

  it('links the primary CTA to /new', () => {
    render(<Landing />);
    const ctas = screen.getAllByRole('link', { name: /open a room/i });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta).toHaveAttribute('href', '/new');
    }
  });

  it('footer links to /privacy, /terms and /security', () => {
    render(<Landing />);
    const privacyLinks = screen.getAllByRole('link', { name: /^privacy$/i });
    expect(privacyLinks.some((a) => a.getAttribute('href') === '/privacy')).toBe(true);
    const termsLinks = screen.getAllByRole('link', { name: /^terms$/i });
    expect(termsLinks.some((a) => a.getAttribute('href') === '/terms')).toBe(true);
    const securityLinks = screen.getAllByRole('link', { name: /security/i });
    expect(securityLinks.some((a) => a.getAttribute('href') === '/security')).toBe(true);
  });

  it('never fabricates social proof', () => {
    render(<Landing />);
    const text = document.body.textContent ?? '';
    expect(text.toLowerCase()).not.toMatch(/trusted by/);
    expect(text.toLowerCase()).not.toMatch(/testimonial/);
    // A digit-percent pattern would imply a fabricated metric (e.g. "99.9%").
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
  });

  it('marks the room mockup as static, non-interactive and captioned', () => {
    const { container } = render(<Landing />);
    const mock = container.querySelector('[aria-hidden="true"]');
    expect(mock).not.toBeNull();
    expect(screen.getByText(/mockup/i)).toBeInTheDocument();
  });

  it('presents as a shipped product, not a preview', () => {
    render(<Landing />);
    const text = document.body.textContent ?? '';
    for (const hedge of [/coming soon/, /work in progress/, /not yet (built|available)/, /\bmvp\b/, /\bbeta\b/, /never been deployed/]) {
      expect(text.toLowerCase()).not.toMatch(hedge);
    }
  });

  it('still states the security boundary — that is product copy, not a disclaimer', () => {
    // The trust model is presented confidently rather than apologetically, but
    // the two load-bearing facts stay: what a participant can reach, and that
    // rooms are not isolated from each other. Both are safety-relevant.
    render(<Landing />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/shared security boundary/);
    expect(text).toMatch(/no isolation between rooms/);
  });

  /**
   * The download link the user could not find. It existed only in the header
   * nav and the footer, which is the same as not existing for anyone who
   * arrives, reads the hero, and leaves.
   */
  it('offers the desktop app from the hero itself, not just the nav', () => {
    render(<Landing />);

    const hero = screen.getByRole('heading', { level: 1 }).closest('section');
    expect(hero, 'the h1 should live inside a section').not.toBeNull();

    const downloadLinks = [...(hero as HTMLElement).querySelectorAll('a[href="/download"]')];
    expect(downloadLinks.length, '/download must be reachable from the hero').toBeGreaterThan(0);
    expect(downloadLinks.some((a) => /download the app/i.test(a.textContent ?? ''))).toBe(true);
  });

  /**
   * Unsigned is the first thing a downloader experiences, so it is said before
   * the download, not after. A page that omits it produces people who conclude
   * the file is broken.
   */
  it('says the build is unsigned where the download is offered', () => {
    render(<Landing />);

    expect(screen.getByText(/unsigned build, so your OS will warn on first launch/i)).toBeTruthy();
  });

  /**
   * "Open a room" must stay the loudest action: it needs nothing installed and
   * is the fastest path to understanding the product. A second primary button
   * beside it would make the page ask twice.
   */
  it('keeps Open a room as the single primary call to action', () => {
    render(<Landing />);

    // Scoped to the hero: "Open a room" also appears in the footer, and the
    // claim under test is about the hero's visual hierarchy, not the page's
    // total link count.
    const hero = screen.getByRole('heading', { level: 1 }).closest('section') as HTMLElement;
    const primary = within(hero).getByRole('link', { name: /open a room/i });
    const download = within(hero).getByRole('link', { name: /download the app/i });
    expect(primary.className).toContain('bg-accent');
    expect(download.className).not.toContain('bg-accent');
  });
});
