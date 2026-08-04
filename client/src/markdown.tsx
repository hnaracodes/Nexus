import type { ReactNode } from 'react';

/**
 * A small, deliberately incomplete Markdown renderer for agent output.
 *
 * Two decisions worth defending, because both look like under-engineering:
 *
 * 1. **It builds React nodes and never touches `dangerouslySetInnerHTML`.**
 *    Assistant text is model output rendered into a room that several people
 *    share, and one of them may have prompted the model adversarially. Any
 *    HTML-string path — including "sanitised" ones — puts a parser and an
 *    allow-list between us and an XSS in a governance tool. Constructing
 *    elements sidesteps the class entirely.
 *
 * 2. **It is hand-written rather than a dependency.** The client carries four
 *    runtime dependencies and each one was argued for. A full CommonMark stack
 *    is a large tree for a transcript that needs emphasis, code, lists and
 *    links. What it does not support (tables, footnotes, HTML passthrough,
 *    reference links) degrades to visible literal text, which is the honest
 *    failure mode: you see exactly what the model wrote.
 */

// Only these schemes may become an href. A model can emit `javascript:` — and
// in a shared room, so can a participant who talked it into doing so.
const SAFE_SCHEME = /^(https?:|mailto:)/i;

function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  return SAFE_SCHEME.test(trimmed) ? trimmed : null;
}

/**
 * Inline formatting. Ordered deliberately: code spans win over everything, so
 * `**not bold**` inside backticks stays literal, which is what anyone pasting
 * a code fragment expects.
 */
const INLINE = [
  { kind: 'code', re: /`([^`\n]+)`/ },
  { kind: 'link', re: /\[([^\]\n]*)\]\(([^)\s]+)\)/ },
  { kind: 'strong', re: /\*\*([^*]+)\*\*/ },
  { kind: 'strongAlt', re: /__([^_]+)__/ },
  { kind: 'strike', re: /~~([^~]+)~~/ },
  { kind: 'em', re: /\*([^*\n]+)\*/ },
  // Underscore emphasis only at a word boundary, so snake_case_names survive.
  { kind: 'emAlt', re: /(?:^|(?<=[\s(]))_([^_\n]+)_(?=$|[\s.,;:!?)])/ },
] as const;

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  let earliest: { kind: string; match: RegExpMatchArray; index: number } | null = null;
  for (const { kind, re } of INLINE) {
    const match = text.match(re);
    if (match?.index === undefined) continue;
    if (earliest === null || match.index < earliest.index) {
      earliest = { kind, match, index: match.index };
    }
  }

  if (earliest === null) return text === '' ? [] : [text];

  const { kind, match, index } = earliest;
  const before = text.slice(0, index);
  const after = text.slice(index + match[0].length);
  const inner = match[1] ?? '';
  const key = `${keyPrefix}-${index}`;

  let node: ReactNode;
  if (kind === 'code') {
    node = (
      <code key={key} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-accent">
        {inner}
      </code>
    );
  } else if (kind === 'link') {
    const href = safeHref(match[2] ?? '');
    node =
      href === null ? (
        // Refused scheme: show the literal source rather than a dead or, worse,
        // silently-stripped link. The reader should see what was actually written.
        <span key={key}>{match[0]}</span>
      ) : (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {renderInline(inner, `${key}l`)}
        </a>
      );
  } else if (kind === 'strong' || kind === 'strongAlt') {
    node = (
      <strong key={key} className="font-semibold text-fg">
        {renderInline(inner, `${key}s`)}
      </strong>
    );
  } else if (kind === 'strike') {
    node = (
      <span key={key} className="line-through opacity-70">
        {renderInline(inner, `${key}k`)}
      </span>
    );
  } else {
    node = (
      <em key={key} className="italic">
        {renderInline(inner, `${key}e`)}
      </em>
    );
  }

  return [...renderInline(before, `${keyPrefix}a`), node, ...renderInline(after, `${keyPrefix}b`)];
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'hr' };

const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const H = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```(\w*)\s*$/;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      // An unterminated fence still renders as code. The agent streams, so a
      // half-arrived block is the normal case, not a malformed one.
      i += 1;
      blocks.push({ kind: 'code', lang: fence[1] ?? '', lines: body });
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    const heading = line.match(H);
    if (heading) {
      blocks.push({ kind: 'h', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').match(QUOTE)?.[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }

    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').match(UL)?.[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    if (OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').match(OL)?.[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        current.trim() === '' ||
        HR.test(current) ||
        H.test(current) ||
        UL.test(current) ||
        OL.test(current) ||
        QUOTE.test(current) ||
        FENCE.test(current)
      ) {
        break;
      }
      para.push(current);
      i += 1;
    }
    blocks.push({ kind: 'p', lines: para });
  }

  return blocks;
}

const HEADING_SIZE = ['text-[17px]', 'text-[16px]', 'text-[15px]', 'text-sm', 'text-sm', 'text-sm'];

/**
 * Renders agent/user text as Markdown. `text-[14px]` and the room's colour
 * tokens throughout — this sits inside a dense transcript, not a document.
 */
export function Markdown({ text, className = '' }: { text: string; className?: string }): JSX.Element {
  const blocks = parseBlocks(text);

  return (
    <div className={`flex flex-col gap-2 text-[14px] leading-relaxed text-fg ${className}`}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.kind === 'hr') return <hr key={key} className="border-border" />;

        if (block.kind === 'h') {
          const Tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[block.level - 1] ?? 'h6';
          return (
            <Tag
              key={key}
              className={`${HEADING_SIZE[block.level - 1] ?? 'text-sm'} font-semibold text-fg`}
            >
              {renderInline(block.text, key)}
            </Tag>
          );
        }

        if (block.kind === 'code') {
          return (
            <pre
              key={key}
              className="overflow-x-auto rounded-lg border border-border bg-bg p-3 font-mono text-[13px] leading-normal text-fg"
            >
              <code>{block.lines.join('\n')}</code>
            </pre>
          );
        }

        if (block.kind === 'quote') {
          return (
            <blockquote key={key} className="border-l-2 border-border-strong pl-3 text-fg-muted">
              {renderInline(block.lines.join(' '), key)}
            </blockquote>
          );
        }

        if (block.kind === 'ul' || block.kind === 'ol') {
          const Tag = block.kind === 'ul' ? 'ul' : 'ol';
          return (
            <Tag
              key={key}
              className={`flex flex-col gap-1 pl-5 ${
                block.kind === 'ul' ? 'list-disc' : 'list-decimal'
              } marker:text-fg-muted`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
              ))}
            </Tag>
          );
        }

        // Soft line breaks inside a paragraph are preserved. The agent uses
        // them for structure far more often than prose does.
        return (
          <p key={key} className="whitespace-pre-wrap">
            {block.lines.map((line, lineIndex) => (
              <span key={`${key}-${lineIndex}`}>
                {lineIndex > 0 ? '\n' : ''}
                {renderInline(line, `${key}-${lineIndex}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
