import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';

/**
 * The tiny slice of the Web Speech API this component needs. Not exported by
 * `lib.dom.d.ts` in this TS/lib combination (it is still a draft spec and
 * support is Chromium/WebKit-prefixed only), so the shape is hand-declared
 * here rather than widened globally.
 */
interface SpeechRecognitionResultLike {
  0: { transcript: string };
}

interface SpeechRecognitionEventLike extends Event {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * Feature-detects both the standard and the WebKit-prefixed constructor.
 * jsdom (the default test environment, see vite.config.ts) defines neither,
 * so the unsupported branch below is the branch every test run actually
 * exercises — not a hypothetical edge case.
 */
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * A microphone toggle that feeds recognized speech to `onTranscript`, which
 * the caller (`PromptDock`) wires into `PromptInput`'s controlled `onChange`.
 * No protocol change, no server involvement — this is purely a browser-side
 * dictation affordance. `PromptInput` itself is untouched.
 */
export function VoiceInputButton({
  onTranscript,
}: {
  onTranscript: (text: string) => void;
}): JSX.Element {
  const Ctor = useMemo(getSpeechRecognitionCtor, []);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Stop any in-flight recognition on unmount rather than leaving it running
  // against a component that no longer has anywhere to deliver a transcript.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  if (Ctor === null) {
    return (
      <button
        type="button"
        disabled
        aria-label="Voice input is not supported in this browser"
        title="Voice input is not supported in this browser"
        className="flex min-h-11 min-w-11 items-center justify-center rounded border border-border text-fg-muted opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <MicOff size={16} aria-hidden="true" />
      </button>
    );
  }

  function toggle(): void {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    // Ctor is narrowed non-null in this closure by the `Ctor === null` return
    // above, but TypeScript cannot see across the render — reassert here.
    const recognition = new (Ctor as SpeechRecognitionCtor)();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (typeof transcript === 'string' && transcript.trim().length > 0) {
        onTranscript(transcript.trim());
      }
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={listening}
      aria-label={listening ? 'Stop voice input' : 'Start voice input'}
      title={listening ? 'Stop voice input' : 'Start voice input'}
      className={`flex min-h-11 min-w-11 items-center justify-center rounded border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
        listening ? 'border-accent text-accent' : 'border-border text-fg-muted hover:text-fg'
      }`}
    >
      <Mic size={16} aria-hidden="true" />
    </button>
  );
}
