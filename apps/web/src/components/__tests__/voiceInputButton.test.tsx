import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VoiceInputButton } from '../VoiceInputButton.js';

describe('VoiceInputButton', () => {
  // jsdom (the default environment for this suite, see client/vite.config.ts)
  // defines neither `window.SpeechRecognition` nor
  // `window.webkitSpeechRecognition`. That means every run of this test
  // exercises the real unsupported path — the one most likely to ship
  // broken, per the plan — with no stubbing required to get there.
  it('renders a graceful disabled state with an explanatory label when unsupported, rather than throwing', () => {
    expect('SpeechRecognition' in window).toBe(false);
    expect('webkitSpeechRecognition' in window).toBe(false);

    expect(() => render(<VoiceInputButton onTranscript={vi.fn()} />)).not.toThrow();

    const button = screen.getByRole('button', {
      name: 'Voice input is not supported in this browser',
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Voice input is not supported in this browser');
  });

  it('never calls onTranscript when unsupported, since clicking is impossible on a disabled control', () => {
    const onTranscript = vi.fn();
    render(<VoiceInputButton onTranscript={onTranscript} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  describe('when the browser supports speech recognition', () => {
    class FakeSpeechRecognition extends EventTarget {
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((event: { results: { 0: { transcript: string } }[] }) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      started = false;

      start(): void {
        this.started = true;
      }

      stop(): void {
        this.started = false;
        this.onend?.();
      }
    }

    it('toggles listening and forwards a recognized transcript to onTranscript', () => {
      const instances: FakeSpeechRecognition[] = [];
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = class extends FakeSpeechRecognition {
        constructor() {
          super();
          instances.push(this);
        }
      };

      const onTranscript = vi.fn();
      render(<VoiceInputButton onTranscript={onTranscript} />);

      const button = screen.getByRole('button', { name: 'Start voice input' });
      fireEvent.click(button);

      expect(screen.getByRole('button', { name: 'Stop voice input' })).toBeInTheDocument();
      const recognition = instances[0];
      expect(recognition).toBeDefined();
      expect(recognition?.started).toBe(true);

      recognition?.onresult?.({ results: [{ 0: { transcript: 'add a test' } }] });
      expect(onTranscript).toHaveBeenCalledWith('add a test');

      fireEvent.click(screen.getByRole('button', { name: 'Stop voice input' }));
      expect(recognition?.started).toBe(false);

      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    });
  });
});
