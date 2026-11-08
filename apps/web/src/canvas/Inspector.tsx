import { useState } from 'react';
import { AGENT_PROVIDERS } from '@syncode/protocol/events';
import type { AgentProvider } from '@syncode/protocol/events';
import type { ApiResult, SavedConfig } from './api.js';
import type { Node } from './graph.js';
import { PROVIDER_LABEL } from './fleetStatus.js';
import type { ConfigBody } from './presets.js';

export const KNOWN_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;

const FIELD =
  'w-full min-w-0 rounded-md border border-border-strong bg-bg px-2 py-1 text-xs text-fg placeholder:text-fg-muted ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const BTN =
  'inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50';

export interface NodeInspectorProps {
  node: Node;
  config: SavedConfig | undefined;
  /** How many nodes in this graph use the same config. */
  usedBy: number;
  others: readonly Node[];
  /** Ids of the nodes this one runs after. */
  upstream: readonly string[];
  onUpdateNode: (patch: Partial<Omit<Node, 'id'>>) => void;
  /** Returns the server/graph's refusal sentence, or null on success. */
  onToggleUpstream: (otherId: string, checked: boolean) => string | null;
  onDeleteNode: () => void;
  /** Save the config under its current name (shared by everything using it). */
  onApply: (body: ConfigBody) => Promise<ApiResult<SavedConfig>>;
  /** Save as a different name and rebind THIS node only. */
  onSaveAsNew: (body: ConfigBody) => Promise<ApiResult<SavedConfig>>;
}

/**
 * Edit one node. Display name, provider and model change the graph at once;
 * the role prompt, description and tools belong to the CONFIG, which other
 * nodes and workflows may share, so they only take effect on Apply.
 *
 * Tools are what the config REQUESTS - the room may narrow them, and a
 * hand-spawned agent does not enforce them today - so nothing here promises a
 * read-only guarantee.
 *
 * Remount per node (`key={node.id}`): the drafts below are initialised once.
 */
export function NodeInspector(props: NodeInspectorProps): JSX.Element {
  const { node, config, usedBy, others, upstream } = props;
  const [name, setName] = useState(node.displayName);
  const [model, setModel] = useState(node.model ?? '');
  const [description, setDescription] = useState(config?.description ?? '');
  const [prompt, setPrompt] = useState(config?.prompt ?? '');
  const [tools, setTools] = useState<string[]>(config?.tools ?? []);
  const [newName, setNewName] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toolChoices = [...KNOWN_TOOLS, ...tools.filter((t) => !(KNOWN_TOOLS as readonly string[]).includes(t))];

  function body(configName: string): ConfigBody {
    const out: ConfigBody = { name: configName, description, prompt, tools };
    if (node.model !== null) out.model = node.model;
    // Re-saving must not silently drop what this form never edits.
    if (config?.mcpServers !== undefined) out.mcpServers = config.mcpServers;
    if (config?.agents !== undefined) out.agents = config.agents;
    return out;
  }

  async function save(kind: 'apply' | 'new'): Promise<void> {
    setBusy(true);
    setProblems([]);
    setSaved(null);
    try {
      const target = kind === 'apply' ? node.configName : newName.trim();
      if (target === '') {
        setProblems(['Give the new config a name.']);
        return;
      }
      const result = await (kind === 'apply' ? props.onApply(body(target)) : props.onSaveAsNew(body(target)));
      if (result.ok) {
        setSaved(kind === 'apply' ? `Saved config "${target}".` : `Saved "${target}" and switched this agent to it.`);
        if (kind === 'new') setNewName('');
      } else {
        setProblems(result.problems.length > 0 ? result.problems : [result.message]);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-xs text-fg">
      <label className="flex flex-col gap-1">
        <span className="text-fg-muted">Display name</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            props.onUpdateNode({ displayName: name });
          }}
          onKeyDown={(e) => e.key === 'Enter' && props.onUpdateNode({ displayName: name })}
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-fg-muted">Provider</span>
        <select
          value={node.provider}
          onChange={(e) => props.onUpdateNode({ provider: e.target.value as AgentProvider })}
          className={FIELD}
        >
          {AGENT_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-fg-muted">Model</span>
        <input
          value={model}
          placeholder="Account default"
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => props.onUpdateNode({ model: model.trim() === '' ? null : model.trim() })}
          className={FIELD}
        />
      </label>

      <fieldset className="flex flex-col gap-1.5 rounded-md border border-border p-2">
        <legend className="px-1 text-fg-muted">Config: {node.configName}</legend>
        {config === undefined && (
          <p className="text-warn">This config is not saved, so a run would refuse it. Save it below.</p>
        )}
        {usedBy > 1 && (
          <p className="text-fg-muted">Used by {usedBy} nodes here: Apply changes all of them.</p>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Role / system prompt</span>
          <textarea value={prompt} rows={5} onChange={(e) => setPrompt(e.target.value)} className={FIELD} />
        </label>
        <div role="group" aria-label="Tools" className="flex flex-wrap gap-x-3 gap-y-1">
          {toolChoices.map((t) => (
            <label key={t} className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={tools.includes(t)}
                onChange={(e) => setTools((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))}
              />
              {t}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-fg-muted">Tools are requested; the room may narrow them.</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save('apply')}
            className={`${BTN} border-border-strong bg-surface-2 hover:bg-muted`}
          >
            Apply
          </button>
          <input
            aria-label="New config name"
            value={newName}
            placeholder="New config name"
            onChange={(e) => setNewName(e.target.value)}
            className={`${FIELD} w-32`}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void save('new')}
            className={`${BTN} border-border-strong hover:bg-surface-2`}
          >
            Save as new config
          </button>
        </div>
        {problems.length > 0 && (
          <ul role="alert" className="list-disc pl-4 text-danger">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {saved !== null && <p role="status" className="text-success">{saved}</p>}
      </fieldset>

      <fieldset className="flex flex-col gap-1 rounded-md border border-border p-2">
        <legend className="px-1 text-fg-muted">Runs after</legend>
        {others.length === 0 && <p className="text-fg-muted">No other agents on the canvas.</p>}
        {others.map((o) => (
          <label key={o.id} className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={upstream.includes(o.id)}
              onChange={(e) => setReason(props.onToggleUpstream(o.id, e.target.checked))}
            />
            {o.displayName}
          </label>
        ))}
        {reason !== null && (
          <p role="alert" className="text-danger">
            {reason}
          </p>
        )}
      </fieldset>

      <button type="button" onClick={props.onDeleteNode} className={`${BTN} self-start border-danger/45 text-danger hover:bg-danger/10`}>
        Delete agent
      </button>
    </div>
  );
}

export function EdgeInspector(props: { fromName: string; toName: string; onDelete: () => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-3 text-xs text-fg">
      <p>
        <strong>{props.fromName}</strong> runs before <strong>{props.toName}</strong>.
      </p>
      <button type="button" onClick={props.onDelete} className={`${BTN} self-start border-danger/45 text-danger hover:bg-danger/10`}>
        Delete connection
      </button>
    </div>
  );
}
