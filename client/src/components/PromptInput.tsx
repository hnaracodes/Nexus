import { useState } from 'react';
import type { FormEvent } from 'react';

export function PromptInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
}): JSX.Element {
  const [value, setValue] = useState('');

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
        className="flex-1 rounded border border-slate-300 px-3 py-2 disabled:bg-slate-100"
      />
      <button
        type="submit"
        disabled={disabled}
        className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}
