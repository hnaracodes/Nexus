import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Usage } from '../Usage.js';

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

describe('Usage page', () => {
  it('renders exactly one h1 and a Last updated date, with no heading skips', () => {
    const { container } = render(<Usage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText(/Last updated:/i)).toBeInTheDocument();
    assertNoHeadingSkips(container);
  });

  it('states the Anthropic Console key requirement, including the sk-ant- prefix', () => {
    render(<Usage />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('sk-ant-');
    expect(/Pro or Max subscription will not work/i.test(text)).toBe(true);
  });

  it('links to /download rather than duplicating the download mechanics', () => {
    render(<Usage />);
    const link = screen.getByRole('link', { name: /get the desktop app/i });
    expect(link).toHaveAttribute('href', '/download');
  });

  it('discloses that every desktop build is unsigned', () => {
    render(<Usage />);
    const text = document.body.textContent ?? '';
    expect(/unsigned/i.test(text)).toBe(true);
  });

  it('lists the four-eyes approval step for a risky prompt', () => {
    render(<Usage />);
    const text = document.body.textContent ?? '';
    expect(/four-eyes gate/i.test(text)).toBe(true);
  });
});
