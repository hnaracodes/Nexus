import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { PromptDock } from '../PromptDock.js';
import type { PromptDockProps } from '../PromptDock.js';

const ROOM_CREATED: SynCodeEvent = {
  type: 'room_created',
  seq: 1,
  ts: '2026-01-01T00:00:00.000Z',
  roomId: 'room_1',
  cwd: '/work',
  repoUrl: null,
  github: null,
};

function renderDock(overrides: Partial<PromptDockProps> = {}) {
  const props: PromptDockProps = {
    roomId: 'room_1',
    token: 'tok_secret',
    events: [ROOM_CREATED],
    driverId: null,
    selfId: 'p1',
    promptDisabled: false,
    promptValue: '',
    onPromptChange: vi.fn(),
    onSubmitPrompt: vi.fn(),
    onStop: vi.fn(),
    stopBusy: false,
    onSetModel: vi.fn(),
    ...overrides,
  };
  return { ...render(<PromptDock {...props} />), props };
}

describe('PromptDock', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [] }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('renders PromptInput, StopButton, and all four chrome components', () => {
    renderDock();

    // PromptInput
    expect(screen.getByPlaceholderText('Ask the agent…')).toBeInTheDocument();
    // StopButton
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    // RepoBranchBar (no binding on ROOM_CREATED)
    expect(screen.getByText('No repository')).toBeInTheDocument();
    // ContextWindowBar (no context_usage event yet)
    expect(screen.getByText('Usage unavailable')).toBeInTheDocument();
    // ModelSelector
    expect(screen.getByLabelText('Room model')).toBeInTheDocument();
    // VoiceInputButton (jsdom: unsupported)
    expect(screen.getByLabelText('Voice input is not supported in this browser')).toBeInTheDocument();
  });

  it("PromptInput's existing behaviour is unchanged: typing and submitting calls the right handlers", () => {
    const onPromptChange = vi.fn();
    const onSubmitPrompt = vi.fn();
    renderDock({ promptValue: 'hello', onPromptChange, onSubmitPrompt });

    const input = screen.getByPlaceholderText('Ask the agent…');
    expect(input).toHaveValue('hello');

    fireEvent.change(input, { target: { value: 'hello world' } });
    expect(onPromptChange).toHaveBeenCalledWith('hello world');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmitPrompt).toHaveBeenCalledWith('hello');
  });

  it('disables PromptInput only on connection state (promptDisabled), independent of driverId', () => {
    // Non-driver, floor held by someone else — I2' says this must NOT disable the input.
    renderDock({ promptDisabled: false, driverId: 'someone-else', selfId: 'p1' });
    expect(screen.getByPlaceholderText('Ask the agent…')).not.toBeDisabled();
  });

  it('wires the Stop button to onStop', () => {
    const onStop = vi.fn();
    renderDock({ onStop });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
  });
});
