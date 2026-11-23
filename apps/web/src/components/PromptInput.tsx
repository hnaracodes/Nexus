import { useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { SendHorizontal } from 'lucide-react';

/** ~8 lines of 13px/20px text; past this the textarea scrolls. */
const MAX_HEIGHT_PX = 160;

/**
 * `value`/`onChange` are optional and additive: existing callers that pass
 * neither keep the original uncontrolled behaviour (internal state only).
 * The room shell passes both so a document-level `mod+enter` hotkey can read
 * and submit the current text — the hotkey lives in App.tsx, outside this
 * component, so the text has to be visible to it. For that reason Ctrl/Cmd+Enter
 * is deliberately NOT handled here: it would double-send.
 *
 * One bordered box (VS Code chat style): an auto-growing textarea over a
 * compact toolbar row. `toolbar` (left, may truncate) and `actions` (right,
 * before Send) are slots so the dock can compose chips and buttons inside the
 * same box without this component knowing about them.
 *
 * I2' — `disabled` is connection state only, never the driver token.
 */
export function PromptInput({
  onSubmit,
  disabled,
  value: controlledValue,
  onChange,
  toolbar,
  actions,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
  value?: string;
  onChange?: (value: string) => void;
  toolbar?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  const [internalValue, setInternalValue] = useState('');
  const value = controlledValue ?? internalValue;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow: reset to auto so it can shrink, then fit the content up to the cap.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  function setValue(next: string): void {
    if (onChange !== undefined) onChange(next);
    else setInternalValue(next);
  }

  function submit(): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setValue('');
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey) return;
    // Enter that confirms an IME candidate must never send. Safari reports
    // that Enter AFTER compositionend, with isComposing=false but the legacy
    // keyCode 229 ("IME is processing"), so both are checked.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!disabled) submit();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex min-w-0 flex-col rounded border border-border bg-surface focus-within:border-accent"
    >
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask the agent…"
        className="max-h-40 min-h-[36px] w-full min-w-0 resize-none bg-transparent px-3 py-2 text-[13px] leading-5 text-fg placeholder:text-fg-muted focus-visible:outline-none disabled:text-fg-muted"
      />
      <div className="flex min-w-0 items-center gap-1 px-1.5 pb-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{toolbar}</div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <button
            type="submit"
            disabled={disabled}
            aria-label="Send"
            title="Send (Enter)"
            className="flex h-6 w-6 items-center justify-center rounded bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
          >
            <SendHorizontal size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>
  );
}
