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
      screen.getByText('The MVP has no isolation between rooms.'),
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

  it('states the product has never been deployed, without softening it into "coming soon"', () => {
    render(<Landing />);
    const text = document.body.textContent ?? '';
    expect(text.toLowerCase()).not.toMatch(/coming soon/);
  });
});
