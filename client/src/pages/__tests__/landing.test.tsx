import { render, screen } from '@testing-library/react';
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
      screen.getByText('Nexus has no isolation between rooms.'),
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
});
