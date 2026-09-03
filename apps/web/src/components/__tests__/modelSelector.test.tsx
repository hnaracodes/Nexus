import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NexusEvent } from '@nexus/protocol/events';
import { ModelSelector } from '../ModelSelector.js';

const MODELS_PAYLOAD = {
  models: [
    { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Balanced.' },
    { value: 'claude-opus-5', displayName: 'Opus 5', description: 'Most capable.' },
  ],
};

function modelChanged(model: string | null, seq = 1): NexusEvent {
  return {
    type: 'model_changed',
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    roomId: 'room_1',
    participantId: 'p1',
    displayName: 'Ben',
    model,
  };
}

describe('ModelSelector', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => MODELS_PAYLOAD,
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fetches the model list from GET /api/rooms/:id/models with the room token header', async () => {
    render(
      <ModelSelector
        roomId="room_1"
        token="tok_secret"
        events={[]}
        driverId={null}
        selfId="p1"
        onSetModel={vi.fn()}
      />,
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/rooms/room_1/models');
    expect((init.headers as Record<string, string>)['X-Nexus-Token']).toBe('tok_secret');

    await waitFor(() => expect(screen.getByRole('option', { name: 'Sonnet 5' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Opus 5' })).toBeInTheDocument();
  });

  it('selecting a model sends {kind: "set_model", model} with the chosen value', async () => {
    const onSetModel = vi.fn();
    render(
      <ModelSelector
        roomId="room_1"
        token="tok_secret"
        events={[]}
        driverId={null}
        selfId="p1"
        onSetModel={onSetModel}
      />,
    );
    await waitFor(() => expect(screen.getByRole('option', { name: 'Opus 5' })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Room model'), { target: { value: 'claude-opus-5' } });
    expect(onSetModel).toHaveBeenCalledWith('claude-opus-5');
  });

  it('selecting "Default" sends an explicit null, never undefined', async () => {
    const onSetModel = vi.fn();
    render(
      <ModelSelector
        roomId="room_1"
        token="tok_secret"
        events={[modelChanged('claude-opus-5')]}
        driverId={null}
        selfId="p1"
        onSetModel={onSetModel}
      />,
    );
    await waitFor(() => expect(screen.getByRole('option', { name: 'Opus 5' })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Room model'), { target: { value: '__default__' } });
    expect(onSetModel).toHaveBeenCalledWith(null);
    expect(onSetModel).not.toHaveBeenCalledWith(undefined);
  });

  it('derives the current model from the LAST model_changed event, not the first', () => {
    render(
      <ModelSelector
        roomId="room_1"
        token="tok_secret"
        events={[modelChanged('claude-opus-5', 1), modelChanged('claude-sonnet-5', 2)]}
        driverId={null}
        selfId="p1"
        onSetModel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Room model')).toHaveValue('claude-sonnet-5');
  });

  it('shows "Default" when no model_changed event has ever been logged', () => {
    render(
      <ModelSelector
        roomId="room_1"
        token="tok_secret"
        events={[]}
        driverId={null}
        selfId="p1"
        onSetModel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Room model')).toHaveValue('__default__');
  });

  it('is disabled with an explanatory tooltip for a non-driver while a driver exists', () => {
    render(
      <ModelSelector
        roomId="room_1"
        token="tok_secret"
        events={[]}
        driverId="p2"
        selfId="p1"
        onSetModel={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Room model');
    expect(select).toBeDisabled();
    expect(select.closest('[title]')).toHaveAttribute(
      'title',
      'Only the driver can switch the room model while someone is driving',
    );
  });

  it('is enabled for the driver themself', () => {
    render(
      <ModelSelector
        roomId="room_1"
        token="tok_secret"
        events={[]}
        driverId="p1"
        selfId="p1"
        onSetModel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Room model')).not.toBeDisabled();
  });

  it('is enabled for everyone when the floor is open (no driver)', () => {
    render(
      <ModelSelector
        roomId="room_1"
        token="tok_secret"
        events={[]}
        driverId={null}
        selfId="p1"
        onSetModel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Room model')).not.toBeDisabled();
  });
});
