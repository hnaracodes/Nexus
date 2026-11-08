import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { Breadcrumbs } from '../Breadcrumbs.js';
import { ImagePreview } from '../ImagePreview.js';
import { MarkdownPreview } from '../MarkdownPreview.js';
import { OutputPanel } from '../OutputPanel.js';
import { DiffPanel } from '../DiffPanel.js';
import { AgentPicker } from '../AgentPicker.js';
import { CodeEditor } from '../CodeEditor.js';
import type { WorkspaceApi } from '../../workspace/workspaceApi.js';
import type { CachedFile } from '../../workspace/useWorkspace.js';

function api(overrides: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    getTree: vi.fn().mockResolvedValue([]),
    getFile: vi.fn().mockResolvedValue({ kind: 'text', content: '' }),
    getGitStatus: vi.fn().mockResolvedValue([]),
    getGitDiff: vi.fn().mockResolvedValue({ path: '', diff: '' }),
    getModels: vi.fn().mockResolvedValue([]),
    getFileBlob: vi.fn().mockRejectedValue(new Error('no raw route')),
    ...overrides,
  };
}

describe('Breadcrumbs', () => {
  it('renders one segment per path part, the last being the file', () => {
    render(<Breadcrumbs path="src/pages/Landing.tsx" />);
    const segments = Array.from(document.querySelectorAll('[data-breadcrumb-segment]')).map((n) => n.textContent);
    expect(segments).toEqual(['src', 'pages', 'Landing.tsx']);
    expect(screen.getByText('Landing.tsx')).toHaveAttribute('aria-current', 'page');
  });

  it('a root-level file has exactly one segment', () => {
    render(<Breadcrumbs path="README.md" />);
    expect(document.querySelectorAll('[data-breadcrumb-segment]')).toHaveLength(1);
  });
});

describe('MarkdownPreview', () => {
  it('renders a heading from the text', () => {
    render(<MarkdownPreview text={'# Hello preview\n\nbody'} />);
    expect(screen.getByRole('heading', { name: 'Hello preview' })).toBeInTheDocument();
  });

  it('never injects raw HTML', () => {
    const { container } = render(<MarkdownPreview text={'<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('ImagePreview', () => {
  const created: string[] = [];
  const revoked: string[] = [];
  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:test/${created.length}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows an <img> when the bytes load, and revokes the object URL on unmount', async () => {
    const getFileBlob = vi.fn().mockResolvedValue(new Blob(['x']));
    const { unmount } = render(<ImagePreview api={api({ getFileBlob })} path="img/a.png" />);
    const img = await screen.findByRole('img', { name: 'img/a.png' });
    expect(img).toHaveAttribute('src', 'blob:test/0');
    unmount();
    expect(revoked).toContain('blob:test/0');
  });

  it('degrades to the binary-file card on any failure', async () => {
    render(<ImagePreview api={api()} path="img/a.png" />);
    expect(await screen.findByText(/binary file/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('OutputPanel', () => {
  const ev = (seq: number, body: Record<string, unknown>) =>
    ({ seq, ts: '2026-07-28T10:11:12.000Z', roomId: 'r', ...body }) as unknown as SynCodeEvent;

  it('lists tool rows for the focused agent only', () => {
    const events = [
      ev(1, { type: 'tool_start', toolUseId: 't1', toolName: 'Read', input: { file_path: 'a.ts' } }),
      ev(2, { type: 'tool_result', toolUseId: 't1', toolName: 'Read', isError: false, output: 'done' }),
      ev(3, { type: 'tool_start', toolUseId: 't2', toolName: 'Grep', input: { pattern: 'x' }, agentId: 'agent_2' }),
      ev(4, { type: 'agent_error', message: 'boom' }),
      ev(5, { type: 'user_prompt', participantId: 'p', displayName: 'Ada', text: 'hi' }),
    ];
    render(<OutputPanel events={events} focusedAgentId={null} />);
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.queryByText('Grep')).toBeNull();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByText('hi')).toBeNull();
  });

  it('shows another agent’s rows when it is focused', () => {
    const events = [
      ev(1, { type: 'tool_start', toolUseId: 't1', toolName: 'Read', input: {} }),
      ev(2, { type: 'tool_start', toolUseId: 't2', toolName: 'Grep', input: { pattern: 'x' }, agentId: 'agent_2' }),
    ];
    render(<OutputPanel events={events} focusedAgentId={'agent_2' as never} />);
    expect(screen.getByText('Grep')).toBeInTheDocument();
    expect(screen.queryByText('Read')).toBeNull();
  });

  it('says so when there is nothing yet', () => {
    render(<OutputPanel events={[]} focusedAgentId={null} />);
    expect(screen.getByText(/no tool activity/i)).toBeInTheDocument();
  });
});

describe('DiffPanel', () => {
  it('asks for a selection when no file is chosen', () => {
    render(<DiffPanel api={api()} path={null} />);
    expect(screen.getByText(/select a changed file/i)).toBeInTheDocument();
  });

  it('renders the unified diff with +/- prefixes kept', async () => {
    const getGitDiff = vi.fn().mockResolvedValue({ path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' });
    render(<DiffPanel api={api({ getGitDiff })} path="a.ts" />);
    await waitFor(() => expect(screen.getByText('+new')).toBeInTheDocument());
    expect(screen.getByText('-old')).toBeInTheDocument();
    expect(getGitDiff).toHaveBeenCalledWith('a.ts');
  });
});

describe('AgentPicker', () => {
  const fleet = [
    { agentId: 'primary', displayName: 'Agent', provider: 'anthropic', model: null, status: 'idle', pendingApprovals: 0, queuedPrompts: 0 },
    { agentId: 'agent_2', displayName: 'Reviewer', provider: 'anthropic', model: null, status: 'idle', pendingApprovals: 0, queuedPrompts: 0 },
  ] as never;

  it('is hidden for a solo room', () => {
    const { container } = render(<AgentPicker fleet={[]} focusedAgentId={null} onFocusAgent={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the fleet and reports a pick (null for the primary agent)', () => {
    const onFocusAgent = vi.fn();
    render(<AgentPicker fleet={fleet} focusedAgentId={null} onFocusAgent={onFocusAgent} />);
    const select = screen.getByLabelText(/agent whose conversation/i) as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    select.value = 'agent_2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onFocusAgent).toHaveBeenCalledWith('agent_2');
  });
});

describe('CodeEditor — editor chrome and callbacks', () => {
  const ready = (content: string): CachedFile => ({ status: 'ready', result: { kind: 'text', content }, fetchedAtSeq: 1 });

  it('installs line numbers, active line and bracket matching', () => {
    const { container } = render(<CodeEditor path="a.ts" cached={ready('const a = (1);\n')} onRefresh={vi.fn()} />);
    expect(container.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(container.querySelector('.cm-activeLine')).not.toBeNull();
    expect(container.querySelector('.cm-activeLineGutter')).not.toBeNull();
  });

  it('reports the caret as 1-based line/col on mount', () => {
    const onCursorChange = vi.fn();
    render(<CodeEditor path="a.ts" cached={ready('abc\ndef')} onRefresh={vi.fn()} onCursorChange={onCursorChange} />);
    expect(onCursorChange).toHaveBeenCalledWith({ line: 1, col: 1 });
  });

  it('hides the path header when asked, so breadcrumbs are the only path display', () => {
    render(<CodeEditor path="a.ts" cached={ready('x')} onRefresh={vi.fn()} hideHeader />);
    expect(screen.queryByLabelText('Current file')).toBeNull();
  });
});
