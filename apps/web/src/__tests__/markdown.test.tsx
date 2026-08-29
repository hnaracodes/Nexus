import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks } from '../markdown.js';

describe('markdown — blocks', () => {
  it('separates paragraphs on a blank line', () => {
    expect(parseBlocks('one\n\ntwo').map((b) => b.kind)).toEqual(['p', 'p']);
  });

  it('reads headings by level', () => {
    const [block] = parseBlocks('### Deep');
    expect(block).toEqual({ kind: 'h', level: 3, text: 'Deep' });
  });

  it('keeps a fenced block whole and records its language', () => {
    const [block] = parseBlocks('```ts\nconst a = 1;\n\nconst b = 2;\n```');
    expect(block).toEqual({ kind: 'code', lang: 'ts', lines: ['const a = 1;', '', 'const b = 2;'] });
  });

  it('treats an UNTERMINATED fence as code', () => {
    // The agent streams, so a half-arrived block is the normal case. Falling
    // back to paragraph here would make the text reflow the moment the closing
    // fence lands, which reads as a glitch.
    const [block] = parseBlocks('```\nhalf a function(');
    expect(block).toEqual({ kind: 'code', lang: '', lines: ['half a function('] });
  });

  it('does not treat a fenced ``` marker as a heading or list', () => {
    expect(parseBlocks('```\n# not a heading\n- not a list\n```')[0]?.kind).toBe('code');
  });

  it('groups consecutive list items into one list', () => {
    const blocks = parseBlocks('- a\n- b\n- c');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'ul', items: ['a', 'b', 'c'] });
  });

  it('tells an ordered list from an unordered one', () => {
    expect(parseBlocks('1. first\n2. second')[0]?.kind).toBe('ol');
  });

  it('reads a blockquote without its marker', () => {
    expect(parseBlocks('> quoted')[0]).toEqual({ kind: 'quote', lines: ['quoted'] });
  });

  it('normalises CRLF so Windows agent output is not one long line', () => {
    expect(parseBlocks('a\r\n\r\nb').map((b) => b.kind)).toEqual(['p', 'p']);
  });
});

describe('markdown — inline', () => {
  it('renders bold and italic as real elements', () => {
    const { container } = render(<Markdown text="**bold** and *italic*" />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
  });

  it('renders __bold__ and _italic_ too', () => {
    const { container } = render(<Markdown text="__b__ and _i_" />);
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('em')?.textContent).toBe('i');
  });

  it('leaves snake_case identifiers alone', () => {
    // The underscore-emphasis rule is word-boundary anchored precisely so that
    // agent output full of variable names does not turn into italics soup.
    const { container } = render(<Markdown text="call some_long_name(x)" />);
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toContain('some_long_name');
  });

  it('lets a code span suppress formatting inside it', () => {
    const { container } = render(<Markdown text="`**not bold**`" />);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('**not bold**');
  });

  it('nests emphasis inside a link', () => {
    render(<Markdown text="[a **b**](https://example.com)" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link.querySelector('strong')?.textContent).toBe('b');
  });

  it('opens links in a new tab without leaking the referrer', () => {
    render(<Markdown text="[x](https://example.com)" />);
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noreferrer noopener');
  });
});

describe('markdown — untrusted input', () => {
  /**
   * Assistant text is model output rendered into a room several people share,
   * and one of them may have prompted the model adversarially. These are the
   * cases that make the no-innerHTML decision worth its cost.
   */
  it('refuses a javascript: URL and shows the literal source instead', () => {
    const { container } = render(<Markdown text="[click](javascript:alert(1))" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[click](javascript:alert(1))');
  });

  it('refuses a data: URL', () => {
    const { container } = render(<Markdown text="[x](data:text/html,<script>alert(1)</script>)" />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('never interprets raw HTML — it renders as text', () => {
    const { container } = render(<Markdown text="<img src=x onerror=alert(1)>" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('allows ordinary relative and mailto links', () => {
    render(<Markdown text="[a](/security) [b](mailto:x@y.z)" />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});
