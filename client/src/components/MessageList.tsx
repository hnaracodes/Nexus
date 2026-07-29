import type { Message } from '../store.js';

const TONE: Record<Message['kind'], string> = {
  user: 'bg-sky-50 border-sky-200',
  assistant: 'bg-white border-slate-200',
  tool: 'bg-slate-50 border-slate-200 font-mono text-xs',
  system: 'bg-transparent border-transparent text-slate-500 text-xs',
};

export function MessageList({
  messages,
  pendingDeltas,
}: {
  messages: Message[];
  pendingDeltas: Record<string, string>;
}): JSX.Element {
  return (
    <ol className="flex flex-col gap-2">
      {messages.map((message) => (
        <li key={message.id} className={`rounded border p-3 ${TONE[message.kind]}`}>
          {message.author !== null && (
            <div className="mb-1 text-xs font-semibold text-slate-600">{message.author}</div>
          )}
          <div className="whitespace-pre-wrap">{message.text}</div>
        </li>
      ))}
      {Object.entries(pendingDeltas).map(([id, text]) => (
        <li key={id} className="rounded border border-slate-200 bg-white p-3 opacity-70">
          <div className="whitespace-pre-wrap">{text}</div>
        </li>
      ))}
    </ol>
  );
}
