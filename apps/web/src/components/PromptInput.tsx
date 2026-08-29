import { useState } from 'react';
import type { FormEvent } from 'react';

/**
 * `value`/`onChange` are optional and additive: existing callers that pass
 * neither keep the original uncontrolled behaviour (internal state only).
 * The room shell passes both so a document-level `mod+enter` hotkey can read
 * and submit the current text — the hotkey lives in App.tsx, outside this
 * component, so the text has to be visible to it.
 */
export function PromptInput({
  onSubmit,
  disabled,
  value: controlledValue,
  onChange,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
  value?: string;
  onChange?: (value: string) => void;
}): JSX.Element {
  const [internalValue, setInternalValue] = useState('');
  const value = controlledValue ?? internalValue;

  function setValue(next: string): void {
    if (onChange !== undefined) onChange(next);
    else setInternalValue(next);
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setValue('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Ask the agent…"
        className="min-h-11 flex-1 rounded border border-border bg-surface px-3 py-2 text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:bg-muted disabled:text-fg-muted"
      />
      <button
        type="submit"
        disabled={disabled}
        className="min-h-11 rounded bg-accent px-4 py-2 font-medium text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}
