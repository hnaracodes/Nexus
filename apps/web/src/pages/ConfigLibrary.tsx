import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, Loader2, Pencil, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import type { AgentProvider } from '@nexus/protocol/events';
import { AGENT_PROVIDERS } from '@nexus/protocol/events';
import { Button } from '../components/Button.js';

/**
 * The config library (phase 13, G5) — list, create, edit and delete the
 * agent configs and crews a participant has saved.
 *
 * `AgentConfig`/`SubagentConfig`/`AgentConfigResult` mirror
 * `apps/server/src/server/agentConfig.ts`, and `Crew`/`CrewMember`/`CrewResult`
 * mirror `configStore.ts` — both server-internal modules `apps/web` has no
 * business importing across the app boundary, so this page keeps its own copy
 * of their WIRE shape, exactly like `CreateRoom.tsx`'s `PickerRepo`. `AgentProvider`
 * itself DOES come from `@nexus/protocol/events` — it is a real protocol type,
 * not a server-internal one, and `FleetPane.tsx` already imports it the same way.
 *
 * D3 is why this page talks to `/api/configs` and `/api/crews` rather than a
 * room-scoped `/api/rooms/:id/...` route the way `workspaceApi.ts` does:
 * configs and crews are USER ASSETS, not room history, so there is no room id
 * or `X-Nexus-Token` in play here at all — nothing on this page is scoped to a
 * room. When accounts land (D1/D3: "keyed by account once accounts exist")
 * these calls gain whatever session credential identifies the signed-in user,
 * carried in a header the same way `workspaceApi.ts` carries the room token —
 * never a query parameter — but today the store is process-wide, matching
 * `configStore.ts`'s current (account-less) signature.
 *
 * D2 is why the banner below exists and is not optional decoration: a saved
 * config is executable input, and CLAUDE.md §11 requires the real security
 * boundary to be surfaced in the UI, not left to a README. This page is where
 * a person actually reads it.
 */

interface SubagentConfig {
  description: string;
  prompt: string;
  model?: string;
  tools: string[];
}

interface AgentConfig {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools: string[];
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, SubagentConfig>;
}

/** Mirrors `AgentConfigResult` (agentConfig.ts) — what `POST /api/configs` is
 *  expected to answer with, on both the happy and the rejected path. */
type AgentConfigResult = { ok: true; config: AgentConfig } | { ok: false; problems: string[] };

interface CrewMember {
  configName: string;
  displayName: string;
  provider: AgentProvider;
  model?: string;
}

interface Crew {
  name: string;
  members: CrewMember[];
}

/** Mirrors `CrewResult` (configStore.ts). */
type CrewResult = { ok: true; crew: Crew } | { ok: false; problems: string[] };

const PROVIDER_LABEL: Record<AgentProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

const FIELD_CLASS = `min-h-11 rounded-[10px] border border-border-strong bg-bg px-3 py-2 text-sm text-fg ${FOCUS_RING}`;

/* -------------------------------------------------------------------------
 * Small, local wire helpers. Deliberately not `workspaceApi.ts`'s `request`:
 * that helper always throws on a non-2xx, which is right for a room's
 * workspace routes (a thrown, typed `WorkspaceError` the caller catches once).
 * Here a non-2xx and a 2xx can BOTH carry a meaningful `{ ok, problems }` body
 * — `parseAgentConfig`'s rejection IS the normal, expected response to a bad
 * config, not an exceptional one — so the shape is read from the body first,
 * and only a body that fails to parse as that shape falls back to a generic,
 * status-coded message. Never a raw caught error's `.message`: that can be
 * "Failed to fetch" or a stack-shaped string, neither of which is a message a
 * human reading this page can act on.
 * ---------------------------------------------------------------------- */

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentConfigResult(value: unknown): value is AgentConfigResult {
  if (!isPlainRecord(value) || typeof value['ok'] !== 'boolean') return false;
  return value['ok'] ? isPlainRecord(value['config']) : Array.isArray(value['problems']);
}

function isCrewResult(value: unknown): value is CrewResult {
  if (!isPlainRecord(value) || typeof value['ok'] !== 'boolean') return false;
  return value['ok'] ? isPlainRecord(value['crew']) : Array.isArray(value['problems']);
}

/* -------------------------------------------------------------------------
 * Config form state and (de)serialisation
 * ---------------------------------------------------------------------- */

interface ConfigFormValues {
  name: string;
  description: string;
  prompt: string;
  model: string;
  /** Comma-separated in the form, split into `AgentConfig.tools` on submit —
   *  matches how a person actually types a short tool list, while the server
   *  still gets the explicit array `parseAgentConfig` requires. */
  tools: string;
  /** Optional raw JSON for `mcpServers` and `agents` (subagents). Both are
   *  nested, open-ended shapes that do not earn a dedicated set of form
   *  fields yet; merged into the submitted object verbatim, so an unknown key
   *  typed here surfaces as a normal `parseAgentConfig` rejection rather than
   *  being silently dropped or specially handled. */
  advancedJson: string;
}

const EMPTY_CONFIG_FORM: ConfigFormValues = {
  name: '',
  description: '',
  prompt: '',
  model: '',
  tools: '',
  advancedJson: '',
};

function configToFormValues(config: AgentConfig): ConfigFormValues {
  const advanced: Record<string, unknown> = {};
  if (config.mcpServers !== undefined) advanced['mcpServers'] = config.mcpServers;
  if (config.agents !== undefined) advanced['agents'] = config.agents;
  return {
    name: config.name,
    description: config.description,
    prompt: config.prompt,
    model: config.model ?? '',
    tools: config.tools.join(', '),
    advancedJson: Object.keys(advanced).length > 0 ? JSON.stringify(advanced, null, 2) : '',
  };
}

function parseToolsField(value: string): string[] {
  return value
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool !== '');
}

/** Builds the object POSTed to `/api/configs`, or `null` with a form-level
 *  error already set when the advanced JSON itself doesn't parse — a JSON
 *  syntax error is caught here, client-side, rather than sent to the server
 *  only to come back as an opaque "must be a JSON object" from a field the
 *  person can't see the contents of anymore. */
function buildConfigPayload(
  form: ConfigFormValues,
  onAdvancedJsonError: (message: string) => void,
): Record<string, unknown> | null {
  let advanced: Record<string, unknown> = {};
  if (form.advancedJson.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(form.advancedJson);
    } catch {
      onAdvancedJsonError('The advanced JSON is not valid — check for a missing comma or bracket.');
      return null;
    }
    if (!isPlainRecord(parsed)) {
      onAdvancedJsonError('The advanced JSON must be an object, for example {"mcpServers": {}}.');
      return null;
    }
    advanced = parsed;
  }

  return {
    name: form.name.trim(),
    description: form.description.trim(),
    prompt: form.prompt,
    tools: parseToolsField(form.tools),
    ...(form.model.trim() !== '' ? { model: form.model.trim() } : {}),
    ...advanced,
  };
}

/* -------------------------------------------------------------------------
 * Crew form state
 * ---------------------------------------------------------------------- */

interface CrewMemberFormValues {
  configName: string;
  displayName: string;
  provider: AgentProvider;
  model: string;
}

interface CrewFormValues {
  name: string;
  members: CrewMemberFormValues[];
}

function emptyCrewMember(): CrewMemberFormValues {
  return { configName: '', displayName: '', provider: 'anthropic', model: '' };
}

function crewToFormValues(crew: Crew): CrewFormValues {
  return {
    name: crew.name,
    members: crew.members.map((member) => ({
      configName: member.configName,
      displayName: member.displayName,
      provider: member.provider,
      model: member.model ?? '',
    })),
  };
}

function buildCrewPayload(form: CrewFormValues): Record<string, unknown> {
  return {
    name: form.name.trim(),
    members: form.members.map((member) => ({
      configName: member.configName.trim(),
      displayName: member.displayName.trim(),
      provider: member.provider,
      ...(member.model.trim() !== '' ? { model: member.model.trim() } : {}),
    })),
  };
}

/* -------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------- */

type PendingDelete = { kind: 'config' | 'crew'; name: string };

export function ConfigLibrary(): JSX.Element {
  const [configs, setConfigs] = useState<AgentConfig[]>([]);
  const [crews, setCrews] = useState<Crew[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [configForm, setConfigForm] = useState<ConfigFormValues | null>(null);
  const [editingConfigName, setEditingConfigName] = useState<string | null>(null);
  const [configProblems, setConfigProblems] = useState<string[]>([]);
  const [configFormError, setConfigFormError] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  const [crewForm, setCrewForm] = useState<CrewFormValues | null>(null);
  const [editingCrewName, setEditingCrewName] = useState<string | null>(null);
  const [crewProblems, setCrewProblems] = useState<string[]>([]);
  const [crewFormError, setCrewFormError] = useState<string | null>(null);
  const [savingCrew, setSavingCrew] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      const [configsResponse, crewsResponse] = await Promise.all([fetch('/api/configs'), fetch('/api/crews')]);
      if (!configsResponse.ok || !crewsResponse.ok) {
        throw new Error('load-failed');
      }
      const configsBody = (await configsResponse.json()) as { configs?: AgentConfig[] };
      const crewsBody = (await crewsResponse.json()) as { crews?: Crew[] };
      setConfigs(configsBody.configs ?? []);
      setCrews(crewsBody.crews ?? []);
    } catch {
      // Covers a network failure and a non-2xx alike — neither carries a
      // message worth repeating verbatim (see the wire-helpers comment above).
      setLoadError('Could not load the config library. Reload the page to try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // Runs once, on mount. `reload` closes over no props — there is nothing
    // for a dependency array to name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Config form -------------------------------------------------------

  function openCreateConfig(): void {
    setConfigForm({ ...EMPTY_CONFIG_FORM });
    setEditingConfigName(null);
    setConfigProblems([]);
    setConfigFormError(null);
  }

  function openEditConfig(config: AgentConfig): void {
    setConfigForm(configToFormValues(config));
    setEditingConfigName(config.name);
    setConfigProblems([]);
    setConfigFormError(null);
  }

  function closeConfigForm(): void {
    setConfigForm(null);
    setEditingConfigName(null);
    setConfigProblems([]);
    setConfigFormError(null);
  }

  async function submitConfigForm(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (configForm === null) return;

    setConfigProblems([]);
    setConfigFormError(null);

    let advancedError: string | null = null;
    const payload = buildConfigPayload(configForm, (message) => {
      advancedError = message;
    });
    if (payload === null) {
      setConfigFormError(advancedError);
      return;
    }

    setSavingConfig(true);
    try {
      const response = await fetch('/api/configs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await safeJson(response);
      if (!isAgentConfigResult(body)) {
        setConfigFormError(`Could not save this configuration (status ${response.status}). Try again.`);
        return;
      }
      if (!body.ok) {
        setConfigProblems(body.problems);
        return;
      }
      closeConfigForm();
      await reload();
    } catch {
      setConfigFormError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSavingConfig(false);
    }
  }

  // --- Crew form -----------------------------------------------------------

  function openCreateCrew(): void {
    setCrewForm({ name: '', members: [emptyCrewMember()] });
    setEditingCrewName(null);
    setCrewProblems([]);
    setCrewFormError(null);
  }

  function openEditCrew(crew: Crew): void {
    setCrewForm(crewToFormValues(crew));
    setEditingCrewName(crew.name);
    setCrewProblems([]);
    setCrewFormError(null);
  }

  function closeCrewForm(): void {
    setCrewForm(null);
    setEditingCrewName(null);
    setCrewProblems([]);
    setCrewFormError(null);
  }

  function updateCrewMember(index: number, patch: Partial<CrewMemberFormValues>): void {
    setCrewForm((current) => {
      if (current === null) return current;
      const members = current.members.map((member, i) => (i === index ? { ...member, ...patch } : member));
      return { ...current, members };
    });
  }

  function addCrewMember(): void {
    setCrewForm((current) => (current === null ? current : { ...current, members: [...current.members, emptyCrewMember()] }));
  }

  function removeCrewMember(index: number): void {
    setCrewForm((current) =>
      current === null ? current : { ...current, members: current.members.filter((_, i) => i !== index) },
    );
  }

  async function submitCrewForm(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (crewForm === null) return;

    setCrewProblems([]);
    setCrewFormError(null);
    setSavingCrew(true);
    try {
      const response = await fetch('/api/crews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildCrewPayload(crewForm)),
      });
      const body = await safeJson(response);
      if (!isCrewResult(body)) {
        setCrewFormError(`Could not save this crew (status ${response.status}). Try again.`);
        return;
      }
      if (!body.ok) {
        setCrewProblems(body.problems);
        return;
      }
      closeCrewForm();
      await reload();
    } catch {
      setCrewFormError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSavingCrew(false);
    }
  }

  // --- Delete, with confirmation always in between ------------------------

  function requestDelete(kind: PendingDelete['kind'], name: string): void {
    setDeleteError(null);
    setPendingDelete({ kind, name });
  }

  function cancelDelete(): void {
    setPendingDelete(null);
  }

  async function confirmDelete(): Promise<void> {
    if (pendingDelete === null) return;
    const { kind, name } = pendingDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(
        `${kind === 'config' ? '/api/configs' : '/api/crews'}/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        setDeleteError(`Could not delete "${name}". Try again.`);
        return;
      }
      setPendingDelete(null);
      await reload();
    } catch {
      setDeleteError('Could not reach the server. Check your connection and try again.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6 sm:p-8">
      <div>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-fg">Config library</h1>
        <p className="text-fg-muted">
          Saved agent configurations and crews you can launch into any room. These are your
          assets, not room history — saving or editing one here never touches an event log.
        </p>
      </div>

      <section
        aria-labelledby="governance-h"
        className="flex items-start gap-3 rounded-xl border border-border border-l-[3px] border-l-warn bg-surface p-4 text-sm"
      >
        <ShieldAlert size={20} strokeWidth={2} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
        <div className="text-fg">
          <h2 id="governance-h" className="mb-2 font-semibold">
            What a saved config can and cannot do
          </h2>
          <p className="mb-2">
            A config can only ever <strong className="font-semibold">narrow</strong> what a room
            already permits. Its tools list is intersected with the room&rsquo;s, never unioned —
            a config cannot hand itself a tool, an MCP server, or a permission the room does not
            already allow.
          </p>
          <p>
            It can <strong className="font-semibold">never weaken</strong> approval. Every risky
            action still needs a human&rsquo;s explicit yes, enforced by the room itself,
            regardless of what a config or its subagents ask for.
          </p>
        </div>
      </section>

      {loadError !== null && (
        <p role="alert" className="rounded-md border border-danger bg-muted px-3 py-2 text-sm text-fg">
          {loadError}
        </p>
      )}

      {deleteError !== null && (
        <p role="alert" className="rounded-md border border-danger bg-muted px-3 py-2 text-sm text-fg">
          {deleteError}
        </p>
      )}

      {/* --- Agent configs ------------------------------------------------ */}
      <section aria-labelledby="configs-h" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 id="configs-h" className="text-lg font-semibold text-fg">
            Agent configs
          </h2>
          {configForm === null && (
            <Button variant="secondary" size="sm" onClick={openCreateConfig}>
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              New config
            </Button>
          )}
        </div>

        {configForm !== null && (
          <form
            onSubmit={(event) => void submitConfigForm(event)}
            aria-label={editingConfigName !== null ? `Edit ${editingConfigName}` : 'New agent config'}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
            // The server (`parseAgentConfig`) is the authority on what's valid,
            // not the browser — this page's whole job is to surface ITS
            // `problems`, field by field. Native constraint validation would
            // silently swallow the submit for e.g. an empty `required` Name
            // before the request ever left the browser, hiding the server's
            // own "`name` is required." behind a native tooltip instead.
            noValidate
          >
            {/* The "name can't change" hint is a SIBLING of the label, not a
                child of it — a child text node becomes part of the label's
                accessible name (it's everything inside the <label>), which
                would make `getByLabelText(/^name$/i)` stop matching the
                moment a person opens Edit. */}
            <div className="flex flex-col gap-1 text-sm">
              <label className="flex flex-col gap-1">
                <span className="text-fg">Name</span>
                <input
                  value={configForm.name}
                  onChange={(event) => setConfigForm({ ...configForm, name: event.target.value })}
                  required
                  disabled={editingConfigName !== null}
                  className={`${FIELD_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
                />
              </label>
              {editingConfigName !== null && (
                <span className="text-xs text-fg-muted">
                  A config&rsquo;s name can&rsquo;t be changed after saving — delete this one and
                  create a new config instead.
                </span>
              )}
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg">Description</span>
              <input
                value={configForm.description}
                onChange={(event) => setConfigForm({ ...configForm, description: event.target.value })}
                required
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg">Prompt</span>
              <textarea
                value={configForm.prompt}
                onChange={(event) => setConfigForm({ ...configForm, prompt: event.target.value })}
                required
                rows={3}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg">Model (optional)</span>
              <input
                value={configForm.model}
                onChange={(event) => setConfigForm({ ...configForm, model: event.target.value })}
                placeholder="Room default"
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg">Tools (comma-separated)</span>
              <input
                value={configForm.tools}
                onChange={(event) => setConfigForm({ ...configForm, tools: event.target.value })}
                placeholder="Read, Grep, Edit"
                className={FIELD_CLASS}
              />
              <span className="text-xs text-fg-muted">
                Whatever this names, the room the config is launched into may still cut it down
                further — never the other way around.
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg">Advanced: subagents &amp; MCP servers (JSON, optional)</span>
              <textarea
                value={configForm.advancedJson}
                onChange={(event) => setConfigForm({ ...configForm, advancedJson: event.target.value })}
                placeholder={'{\n  "mcpServers": {}\n}'}
                rows={3}
                spellCheck={false}
                className={`${FIELD_CLASS} font-mono text-xs`}
              />
            </label>

            {configProblems.length > 0 && (
              <div role="alert" className="rounded-md border border-danger bg-muted px-3 py-2 text-sm text-fg">
                <p className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertTriangle size={14} strokeWidth={2} className="text-danger" aria-hidden="true" />
                  Nexus rejected this configuration:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  {configProblems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}
            {configFormError !== null && (
              <p role="alert" className="rounded-md border border-danger bg-muted px-3 py-2 text-sm text-fg">
                {configFormError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={closeConfigForm}>
                <X size={14} strokeWidth={2} aria-hidden="true" />
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={savingConfig}>
                {savingConfig && <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden="true" />}
                {savingConfig ? 'Saving…' : 'Save config'}
              </Button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden="true" />
            Loading your saved configs&hellip;
          </p>
        ) : configs.length === 0 ? (
          <p className="text-sm text-fg-muted">No saved configs yet.</p>
        ) : (
          <ul aria-label="Saved agent configs" className="flex flex-col gap-2">
            {configs.map((config) => (
              <li
                key={config.name}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-fg">{config.name}</p>
                  <p className="text-sm text-fg-muted">{config.description}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    Tools: {config.tools.length > 0 ? config.tools.join(', ') : 'none'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {pendingDelete !== null && pendingDelete.kind === 'config' && pendingDelete.name === config.name ? (
                    <DeleteConfirmRow
                      name={config.name}
                      busy={deleting}
                      onCancel={cancelDelete}
                      onConfirm={() => void confirmDelete()}
                    />
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Edit ${config.name}`}
                        onClick={() => openEditConfig(config)}
                      >
                        <Pencil size={14} strokeWidth={2} aria-hidden="true" />
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        aria-label={`Delete ${config.name}`}
                        onClick={() => requestDelete('config', config.name)}
                      >
                        <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- Crews ---------------------------------------------------------- */}
      <section aria-labelledby="crews-h" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 id="crews-h" className="text-lg font-semibold text-fg">
            Crews
          </h2>
          {crewForm === null && (
            <Button variant="secondary" size="sm" onClick={openCreateCrew}>
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              New crew
            </Button>
          )}
        </div>

        {crewForm !== null && (
          <form
            onSubmit={(event) => void submitCrewForm(event)}
            aria-label={editingCrewName !== null ? `Edit ${editingCrewName}` : 'New crew'}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
            noValidate
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg">Crew name</span>
              <input
                value={crewForm.name}
                onChange={(event) => setCrewForm({ ...crewForm, name: event.target.value })}
                required
                disabled={editingCrewName !== null}
                className={`${FIELD_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
              />
            </label>

            <div className="flex flex-col gap-3">
              {crewForm.members.map((member, index) => (
                <fieldset
                  key={index}
                  className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
                >
                  <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    Member {index + 1}
                  </legend>
                  <label className="flex flex-col gap-1">
                    <span className="text-fg">Saved config name</span>
                    <input
                      value={member.configName}
                      onChange={(event) => updateCrewMember(index, { configName: event.target.value })}
                      list="known-config-names"
                      required
                      className={FIELD_CLASS}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-fg">Display name</span>
                    <input
                      value={member.displayName}
                      onChange={(event) => updateCrewMember(index, { displayName: event.target.value })}
                      required
                      className={FIELD_CLASS}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-fg">Provider</span>
                    <select
                      value={member.provider}
                      onChange={(event) => updateCrewMember(index, { provider: event.target.value as AgentProvider })}
                      className={FIELD_CLASS}
                    >
                      {AGENT_PROVIDERS.map((provider) => (
                        <option key={provider} value={provider}>
                          {PROVIDER_LABEL[provider]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-fg">Model (optional)</span>
                    <input
                      value={member.model}
                      onChange={(event) => updateCrewMember(index, { model: event.target.value })}
                      placeholder="Account default"
                      className={FIELD_CLASS}
                    />
                  </label>
                  {crewForm.members.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      onClick={() => removeCrewMember(index)}
                    >
                      Remove member
                    </Button>
                  )}
                </fieldset>
              ))}
            </div>
            <datalist id="known-config-names">
              {configs.map((config) => (
                <option key={config.name} value={config.name} />
              ))}
            </datalist>

            <Button type="button" variant="secondary" size="sm" className="self-start" onClick={addCrewMember}>
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              Add member
            </Button>

            {crewProblems.length > 0 && (
              <div role="alert" className="rounded-md border border-danger bg-muted px-3 py-2 text-sm text-fg">
                <p className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertTriangle size={14} strokeWidth={2} className="text-danger" aria-hidden="true" />
                  Nexus rejected this crew:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  {crewProblems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}
            {crewFormError !== null && (
              <p role="alert" className="rounded-md border border-danger bg-muted px-3 py-2 text-sm text-fg">
                {crewFormError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={closeCrewForm}>
                <X size={14} strokeWidth={2} aria-hidden="true" />
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={savingCrew}>
                {savingCrew && <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden="true" />}
                {savingCrew ? 'Saving…' : 'Save crew'}
              </Button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden="true" />
            Loading your saved crews&hellip;
          </p>
        ) : crews.length === 0 ? (
          <p className="text-sm text-fg-muted">No saved crews yet.</p>
        ) : (
          <ul aria-label="Saved crews" className="flex flex-col gap-2">
            {crews.map((crew) => (
              <li
                key={crew.name}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-fg">{crew.name}</p>
                  <p className="text-sm text-fg-muted">
                    {crew.members
                      .map((member) => `${member.displayName} (${PROVIDER_LABEL[member.provider]})`)
                      .join(', ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {pendingDelete !== null && pendingDelete.kind === 'crew' && pendingDelete.name === crew.name ? (
                    <DeleteConfirmRow
                      name={crew.name}
                      busy={deleting}
                      onCancel={cancelDelete}
                      onConfirm={() => void confirmDelete()}
                    />
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Edit ${crew.name}`}
                        onClick={() => openEditCrew(crew)}
                      >
                        <Pencil size={14} strokeWidth={2} aria-hidden="true" />
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        aria-label={`Delete ${crew.name}`}
                        onClick={() => requestDelete('crew', crew.name)}
                      >
                        <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * The confirmation step every delete passes through, config or crew alike.
 * Its own component only so the two lists above don't each carry a separate
 * copy of the same three buttons and the same "are you sure" copy.
 */
function DeleteConfirmRow({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={`Confirm deleting ${name}`}
      className="flex items-center gap-2 rounded-md border border-danger/45 bg-danger/10 px-2 py-1"
    >
      <span className="text-xs text-fg">Delete permanently?</span>
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy}>
        {busy && <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden="true" />}
        {busy ? 'Deleting…' : 'Confirm delete'}
      </Button>
    </div>
  );
}
