# Phase 5b — Room UI Redesign

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the room from nine unstyled components into a dense collaborative console: a live agent-activity indicator, stable participant identity, visible driver arbitration, keyboard control of the driver token and the approval flow, a local room switcher, and an error system that offers recovery instead of a string.

**Why:** The room works and is live-verified, but nothing in it communicates state. There is no indication that the agent is thinking versus finished — `pendingDeltas` streams text and that is the only signal. The driver badge is a 🚗 emoji. `driver_requested` events are written to the log by the server and rendered **nowhere**, so asking a teammate for control is silent to everyone including them. There are no keyboard shortcuts at all — a grep for `keydown` across `client/src` returns zero matches. A room whose whole premise is shared situational awareness currently gives its participants almost none.

**Architecture:** Every new view derives from `view.events`, the way `approvals.ts#deriveApprovals` and `PendingPrompts.tsx#derivePending` already do (I3 — the log is authoritative and every view must be reconstructible from it). Each derivation is a **pure exported function** in its own module, unit-tested against fixture events without React. No new mutable client state except genuinely local UI state: palette open, rail collapsed, disclosure expanded.

**Mode:** PARALLEL — dispatch alongside `phase-5a-marketing-site.md`. The seam is `client/src/App.tsx` and `client/src/index.css`; see Global Constraints.

**Files owned:**
- `client/src/components/**`
- `client/src/hooks/**`
- `client/src/agentStatus.ts`
- `client/src/identity.ts`
- `client/src/rooms.ts`
- `client/src/store.ts`
- `client/src/App.tsx` — **only inside the `phase-5b layout` marker region** and the `// phase-5b import anchor` line
- `client/src/index.css` — **only inside the `phase-5b keyframes` marker region**
- `client/package.json` — to add `lucide-react` only
- `client/src/components/__tests__/**`
- `client/src/__fixtures__/**`

Anything outside these globs: stop and report `BLOCKED`. In particular `client/src/pages/**`, `client/src/router.tsx`, `client/tailwind.config.js` and `src/server/**` belong to `phase-5a` or are out of scope entirely.

---

## Global Constraints

- `npm test`, `npm run test:client`, `npm run typecheck` and `npm --prefix client run build` must **all** exit 0 before any commit. The client build is the only command that type-checks TSX; this repo has already shipped a `tsc -b` failure behind a green client suite.
- **Read `design-system/nexus/MASTER.md` first.** Colours, sizes, spacing, icons and motion durations all come from it. Room density is the dense scale (8–32px). Never write a raw hex value in a component — `phase-5a` Task 1 provides the Tailwind semantic utilities (`bg-surface`, `text-fg-muted`, `border-border`, `text-accent`, `text-warn`, `text-danger`). **If those utilities are not yet on your branch, that is expected under parallel dispatch** — write against the names anyway and note it; they resolve at merge.
- **Shared-file discipline.** `phase-5a` is running concurrently and owns `client/src/pages/**` plus the `phase-5a routing` region of `App.tsx`. Edit only inside `{/* --- BEGIN phase-5b layout --- */}` … `{/* --- END phase-5b layout --- */}`, and add imports only immediately below the line `// phase-5b import anchor`. Do not reformat, reorder or tidy anything else in `App.tsx`.
- **I3 — derive, never duplicate.** Any new information about room state must be computed from `view.events`. Adding a `useState` that mirrors something the log already knows will desynchronise on replay, reconnect and resume, and is the exact failure this invariant exists to prevent.
- **I2′ — the prompt input is never gated on the driver token.** `App.tsx:110-115` explains this at length: anyone may speak, the server orders and attributes, and the agent resolves genuine conflicts in the driver's favour. Do not add a driver check to `PromptInput`, do not disable it for non-drivers, do not visually imply non-drivers cannot type. Gating on `status !== 'open'` is the only permitted disable.
- **Preserve permission semantics exactly** (`src/server/permissions.ts`): **any** participant can decide, not just the driver; the first response wins; a request nobody answers within 120 seconds is denied. The existing expired-card placeholder in `ApprovalPrompt.tsx` must survive the redesign.
- **Colour never carries meaning alone,** and neither does motion. Every state has an icon or a text label that survives `prefers-reduced-motion: reduce`.
- **One new dependency: `lucide-react`.** No animation library, no component library, no `react-router`, no state library.

---

### Task 1: Agent activity indicator

**Files:**
- Modify: `client/package.json` — add `lucide-react`
- Create: `client/src/agentStatus.ts`
- Create: `client/src/components/AgentActivity.tsx`
- Create: `client/src/components/__tests__/agentStatus.test.ts`
- Modify: `client/src/index.css` — `phase-5b keyframes` region

**Interfaces:**
- Consumes: `NexusEvent[]` from `src/protocol/events.ts` (import type across the boundary; never copy the types), and `RoomView['pendingDeltas']`.
- Produces:
  ```ts
  export type AgentStatus =
    | { state: 'idle' }
    | { state: 'thinking' }
    | { state: 'streaming' }
    | { state: 'tool'; toolName: string; startedAt: number }
    | { state: 'awaiting'; requestCount: number };

  export function deriveAgentStatus(
    events: NexusEvent[],
    pendingDeltas: Record<string, string>,
  ): AgentStatus;
  ```

Precedence, highest first — `awaiting` outranks everything because a blocked room is the most urgent fact on the screen:

| State | Condition |
|---|---|
| `awaiting` | a `permission_requested` with no matching `permission_decided` and not past `expiresAt` |
| `tool` | a `tool_start` with no matching `tool_result` for its `toolUseId` |
| `streaming` | `pendingDeltas` is non-empty |
| `thinking` | a `user_prompt` or `prompt_batch_delivered` appears after the last `agent_idle` |
| `idle` | otherwise |

- [ ] **Step 1: Write the failing test**

  Create `client/src/components/__tests__/agentStatus.test.ts`. Build event arrays from the existing `client/src/__fixtures__/events.json` shape — read that file first and reuse its envelope fields (`seq`, `ts`, `roomId`) rather than inventing a shape.

  ```ts
  import { describe, expect, it } from 'vitest';
  import { deriveAgentStatus } from '../../agentStatus.js';

  describe('deriveAgentStatus', () => {
    it('is idle on an empty log', () => {
      expect(deriveAgentStatus([], {})).toEqual({ state: 'idle' });
    });

    it('is idle after agent_idle', () => {
      expect(deriveAgentStatus([prompt(1), idle(2)], {})).toEqual({ state: 'idle' });
    });

    it('is thinking once a prompt lands after the last idle', () => {
      expect(deriveAgentStatus([idle(1), prompt(2)], {})).toEqual({ state: 'thinking' });
    });

    it('is streaming while deltas are in flight', () => {
      expect(deriveAgentStatus([prompt(1)], { m1: 'partial' }).state).toBe('streaming');
    });

    it('reports the running tool and when it started', () => {
      const status = deriveAgentStatus([prompt(1), toolStart(2, 'Bash', 'tu_1')], {});
      expect(status).toMatchObject({ state: 'tool', toolName: 'Bash' });
    });

    it('leaves the tool state once its result arrives', () => {
      const events = [prompt(1), toolStart(2, 'Bash', 'tu_1'), toolResult(3, 'tu_1')];
      expect(deriveAgentStatus(events, {}).state).not.toBe('tool');
    });

    it('matches tool results by toolUseId, not by order', () => {
      // Two concurrent tools; only the second finishes. The first must still
      // be reported as running.
      const events = [
        prompt(1), toolStart(2, 'Read', 'tu_1'), toolStart(3, 'Bash', 'tu_2'),
        toolResult(4, 'tu_2'),
      ];
      expect(deriveAgentStatus(events, {})).toMatchObject({ state: 'tool', toolName: 'Read' });
    });

    it('awaiting outranks a running tool', () => {
      const events = [prompt(1), toolStart(2, 'Bash', 'tu_1'), permissionRequested(3, 'r1')];
      expect(deriveAgentStatus(events, {})).toMatchObject({ state: 'awaiting', requestCount: 1 });
    });

    it('stops awaiting once the request is decided', () => {
      const events = [permissionRequested(1, 'r1'), permissionDecided(2, 'r1', 'allow')];
      expect(deriveAgentStatus(events, {}).state).not.toBe('awaiting');
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- agentStatus`
  Expected: FAIL — `client/src/agentStatus.ts` does not exist.

- [ ] **Step 3: Write `client/src/agentStatus.ts`**

  A single reverse scan is enough; do not build intermediate arrays per call — this runs on every render with the full event log. Match tool results to starts by `toolUseId` and permission decisions to requests by `requestId`; never by position. Derive `startedAt` from the `tool_start` event's `ts` (parse the ISO string once).

- [ ] **Step 4: Write `client/src/components/AgentActivity.tsx`**

  Props: `{ status: AgentStatus; now: number }` — reuse the existing 1s tick in `App.tsx:46-49`; do not start a second timer.

  | State | Icon | Colour | Text |
  |---|---|---|---|
  | `idle` | `Circle` (outline) | `--fg-muted` | "Idle" |
  | `thinking` | `Circle` (filled, pulsing) | `--accent` | "Thinking…" |
  | `streaming` | `Circle` (filled, pulsing) | `--accent` | "Responding…" |
  | `tool` | `Terminal` / `FileText` by tool | `--accent` | "Running `{toolName}` · {n}s" |
  | `awaiting` | `ShieldAlert` (pulsing) | `--warn` | "Waiting for the room to approve" |

  Add the pulse keyframes inside the `phase-5b keyframes` region of `index.css`. **The text label always renders** — under `prefers-reduced-motion` the pulse stops and the label alone carries the state. Give the container `role="status"` and `aria-live="polite"`, except `awaiting`, which is `aria-live="assertive"` because it blocks the whole room.

- [ ] **Step 5: Run tests and commit**

  ```bash
  git add client/package.json client/package-lock.json client/src/agentStatus.ts client/src/components/AgentActivity.tsx client/src/components/__tests__/agentStatus.test.ts client/src/index.css
  git commit -m "feat(client): derive and display live agent activity from the event log"
  ```

---

### Task 2: Participant identity, roster and driver arbitration

**Files:**
- Create: `client/src/identity.ts`
- Create: `client/src/components/Avatar.tsx`
- Modify: `client/src/components/Roster.tsx`
- Create: `client/src/components/DriverRequestNotice.tsx`
- Create: `client/src/components/__tests__/{identity,roster,driverRequest}.test.tsx`

**Interfaces:**
- Produces: `export function avatarFor(participantId: string, displayName: string): { initials: string; hue: number };`
- Produces: `export function derivePendingDriverRequests(events: NexusEvent[]): { participantId: string; displayName: string; seq: number }[];`

**The gap this task closes:** the server logs `driver_requested` and `store.ts#applyEvent` drops it to `default`. Nobody ever sees that a teammate asked for control. Verify this is still true before you start; if `store.ts` has since handled it, adjust and say so.

A request is **pending** when a `driver_requested` for a participant has no later `driver_granted` (to anyone) and no later `driver_released`. A grant to a *different* participant also clears it — the question was answered, just not in their favour.

- [ ] **Step 1: Write the failing tests**

  For `identity`: `avatarFor` is deterministic for the same id across calls; the hue comes from `AVATAR_HUES`; different ids in a small room get different hues; initials are derived from the display name (first letters of the first two words, uppercased, single letter for a one-word name, and a sensible fallback for an empty or emoji-only name).

  For `derivePendingDriverRequests`: an unanswered request is pending; a request followed by a grant to that participant is not; a request followed by a grant to someone else is not; a request followed by a release is not; two requests from the same participant collapse to one; results are ordered by `seq`.

  For `Roster`: the driver renders a `Crown` icon and an accent ring; **no emoji appears anywhere in the rendered output** (regression guard on the 🚗); a disconnected participant is visually dimmed and carries a `title` explaining the grace period; "give control" appears only when self is driving and only on connected others.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npm --prefix client test -- identity roster driverRequest`
  Expected: FAIL — modules do not exist; `Roster` still renders 🚗.

- [ ] **Step 3: Write `client/src/identity.ts`**

  Hash the `participantId` (a small FNV-1a is plenty — it must be stable across reloads and identical for every participant in the room, which is the whole point: the same person is the same colour on everyone's screen) and index into `AVATAR_HUES` from `client/src/design/tokens.ts`. If that module is not yet on your branch under parallel dispatch, define the hue list locally with a `TODO` and note it in your report.

- [ ] **Step 4: Write `Avatar.tsx` and redesign `Roster.tsx`**

  `Avatar`: a circle at `hsl(hue 55% 45%)` with white initials, sizes `sm` (20px) and `md` (28px). Driver gets a 2px `--accent` ring plus a `Crown` badge. Disconnected drops to 40% opacity. Always `title={displayName}` and an `aria-label`.

  `Roster`: horizontal avatar row in the header, overflowing to "+3" past five, with the full list in the side rail. Keep every existing control — request, release, grant — and add a visible keyboard hint beside each (Task 3 wires the keys). Replace the 🚗 with `Crown`.

- [ ] **Step 5: Write `DriverRequestNotice.tsx`**

  Props: `{ events, selfId, driverId, onGrant, onDismiss }`.

  - If **self is the driver** and someone has a pending request: an actionable `--warn` card — avatar, "**Ben** wants to drive", **Grant control** and **Dismiss**. Dismiss is local-only UI state; it must not write anything to the log or the server, and it re-appears if they ask again.
  - If self is **not** the driver: a quiet `Hand` icon beside that participant's roster entry. Everyone can see who is waiting.
  - Self's own pending request shows as "Waiting for control…" on their own entry.

- [ ] **Step 6: Run tests and commit**

  ```bash
  git add client/src/identity.ts client/src/components/Avatar.tsx client/src/components/Roster.tsx client/src/components/DriverRequestNotice.tsx client/src/components/__tests__
  git commit -m "feat(client): stable participant avatars and visible driver-request arbitration"
  ```

---

### Task 3: Keyboard shortcuts and cheatsheet

**Files:**
- Create: `client/src/hooks/useHotkeys.ts`
- Create: `client/src/components/ShortcutHint.tsx`
- Create: `client/src/components/ShortcutCheatsheet.tsx`
- Create: `client/src/components/__tests__/useHotkeys.test.tsx`

**Interfaces:**
```ts
export interface Hotkey {
  combo: string;            // 'mod+k', 'mod+shift+d', 'escape', '?'
  handler: (event: KeyboardEvent) => void;
  allowInInput?: boolean;   // default false
  description: string;      // rendered in the cheatsheet
}
export function useHotkeys(hotkeys: Hotkey[]): void;
```

`mod` is `metaKey` on Mac and `ctrlKey` elsewhere; decide once from `navigator.platform`/`userAgentData` and render the hint glyph to match (`⌘` vs `Ctrl`).

| Combo | Action |
|---|---|
| `mod+k` | open the room switcher |
| `mod+shift+d` | toggle driver — request if not driving, release if driving |
| `mod+shift+g` | grant control — opens a participant picker |
| `mod+enter` | send the prompt (works from inside the input) |
| `escape` | interrupt the agent — **confirm step required**, see below |
| `?` | open the cheatsheet |
| `a` / `d` | approve / deny — **only when an approval card has focus** |

**Two safety rules that are requirements, not preferences:**

1. **`a`/`d` are never global.** They are handled on the focused `ApprovalPrompt` element, not on `document`. A global `d` would let someone deny — or worse, approve — a `Bash` call by typing a word while focus sat on the page body. This is a governance product; a mis-fired approval is the worst bug it can have.
2. **`escape` does not interrupt on the first press.** First press arms it and shows "Press Escape again to stop the agent" for 3 seconds; the second press interrupts. Escape is the most reflexively-pressed key on a keyboard and interrupting a shared agent affects everyone in the room.

Everything else: hotkeys do not fire while focus is in an `input`, `textarea` or `contenteditable` unless `allowInInput` is set. **Every shortcut is also a visible, clickable control** with its key hint rendered beside it via `ShortcutHint` — a shortcut that exists only in a hidden overlay does not exist.

- [ ] **Step 1: Write the failing test**

  Using `@testing-library/react` + `userEvent`: a registered `mod+k` fires on Ctrl+K; a bare-letter hotkey does **not** fire while a text input has focus; `allowInInput: true` does fire there; `mod+enter` fires from inside the input; handlers unregister on unmount; and an unrelated key fires nothing.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- useHotkeys`
  Expected: FAIL — the hook does not exist.

- [ ] **Step 3: Write `useHotkeys.ts`**

  One `keydown` listener on `document`, registered in an effect keyed on a stable serialisation of the combos. Call `preventDefault()` only when a combo actually matches — swallowing keys the app does not handle breaks browser shortcuts and is a common source of "the page ate my Ctrl+F".

- [ ] **Step 4: Write `ShortcutHint.tsx` and `ShortcutCheatsheet.tsx`**

  `ShortcutHint`: a small `--muted` `<kbd>` pill, mono, 12px, platform-correct glyphs.

  `ShortcutCheatsheet`: a modal (`z-40`) listing every shortcut and its description. Focus moves into it on open, is trapped while open, and returns to the trigger on close. `Escape` closes it — and while it is open, `Escape` must **not** reach the interrupt handler.

- [ ] **Step 5: Run tests and commit**

  ```bash
  git add client/src/hooks client/src/components/ShortcutHint.tsx client/src/components/ShortcutCheatsheet.tsx client/src/components/__tests__/useHotkeys.test.tsx
  git commit -m "feat(client): keyboard shortcuts with a discoverable cheatsheet"
  ```

---

### Task 4: Room switcher

**Files:**
- Create: `client/src/rooms.ts`
- Create: `client/src/components/RoomSwitcher.tsx`
- Create: `client/src/components/__tests__/{rooms,roomSwitcher}.test.tsx`

**Interfaces:**
```ts
export interface RecentRoom {
  roomId: string;
  token: string;
  displayName: string;
  label: string;       // repo name or short room id
  lastSeenAt: number;
}
export function readRecentRooms(): RecentRoom[];       // newest first
export function rememberRoom(room: RecentRoom): void;  // upsert by roomId, cap 10
export function forgetRoom(roomId: string): void;
export function forgetAllRooms(): void;
```

Storage key `nexus:rooms`, `localStorage`, every access wrapped in `try/catch` exactly as `ws.ts:57-79` does — private mode and disabled storage degrade to "no history", never to an error. `rememberRoom` is called on `replay_complete`, when the room is known to be real and the token known to be valid.

**State this tradeoff in your report and confirm `phase-5a` documented it on `/privacy`:** this persists room access tokens — full credentials — in `localStorage`. Mitigations are requirements, not extras: a per-entry **Forget** control, a **Forget all rooms** control, and a visible line in the palette footer reading *"Stored on this device only. Anyone using this browser can open these rooms."*

- [ ] **Step 1: Write the failing tests**

  For `rooms.ts`: round-trips a room; upserts by `roomId` rather than duplicating; orders newest-first by `lastSeenAt`; caps at 10 and evicts the oldest; `forgetRoom` removes one and leaves the rest; `forgetAllRooms` clears; corrupt JSON in storage yields `[]` and does not throw; a `localStorage` that throws on access yields `[]` and does not throw.

  For `RoomSwitcher`: filters as you type; `Enter` navigates to the highlighted room; arrow keys move the highlight and wrap; `Escape` closes and restores focus to the trigger; the current room is marked and not offered as a navigation target; the "New room" entry links to `/new`; the storage warning is present.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npm --prefix client test -- rooms roomSwitcher`
  Expected: FAIL — modules do not exist.

- [ ] **Step 3: Write `client/src/rooms.ts`**

- [ ] **Step 4: Write `RoomSwitcher.tsx`**

  A command palette (`z-50`): centred, `--surface` on a dimmed backdrop, a filter input focused on open, a list of recent rooms with relative times and their agent status if known, then **New room** with a `⌘⇧N` hint, then the storage-warning footer. Full keyboard navigation, `role="dialog"` + `aria-modal`, focus trapped while open, focus restored on close. Each row carries a Forget button (`Trash2`, `aria-label`) that does not trigger navigation — stop propagation.

- [ ] **Step 5: Wire `rememberRoom` into the connection**

  Call `rememberRoom` when a `replay_complete` frame arrives. `ws.ts` already handles that frame at lines 154-157 to persist identity — but **`ws.ts` is not in your owned globs.** Call it from `App.tsx` inside your marker region instead, reacting to `view.selfId` becoming non-null. If that proves impossible without editing `ws.ts`, report `BLOCKED` rather than editing it.

- [ ] **Step 6: Run tests and commit**

  ```bash
  git add client/src/rooms.ts client/src/components/RoomSwitcher.tsx client/src/components/__tests__/rooms.test.tsx client/src/components/__tests__/roomSwitcher.test.tsx
  git commit -m "feat(client): local room switcher with explicit forget controls"
  ```

---

### Task 5: Approval card redesign

**Files:**
- Modify: `client/src/components/ApprovalPrompt.tsx`
- Create: `client/src/components/{CountdownRing,ToolSummary}.tsx`
- Create: `client/src/components/__tests__/approvalPrompt.test.tsx`

This is the governance centrepiece — the feature `BUILD_SPEC.md` §9 names as the actual product. It deserves the most design attention in this plan.

**Interfaces:**
```ts
export type ToolRisk = 'destructive' | 'writing' | 'reading';
export function classifyTool(toolName: string): ToolRisk;
export function summarizeToolInput(toolName: string, input: unknown): string;
```

`classifyTool`: `Bash`, `KillShell` → `destructive`; `Write`, `Edit`, `NotebookEdit` → `writing`; everything else → `reading`. **Unknown tools classify as `destructive`** — failing safe is the only correct default when a new SDK tool appears that this table has never seen.

`summarizeToolInput`: plain language, one line. `Bash` → the command. `Write`/`Edit` → the file path. `Read` → the file path. Fall back to the tool name plus the first scalar field. Truncate at ~120 chars. The existing raw `<pre>` moves behind a **Show raw input** disclosure — a JSON blob is not a decision aid, but the person approving must still be able to see exactly what was asked.

- [ ] **Step 1: Write the failing test**

  Assert: `classifyTool('Bash') === 'destructive'`; **`classifyTool('SomeBrandNewTool') === 'destructive'`** (fail-safe); `summarizeToolInput('Bash', { command: 'rm -rf /' })` contains `rm -rf /`; a destructive card renders an `AlertTriangle` and danger styling; raw input is hidden until the disclosure is opened; the countdown renders remaining seconds and the expired card still renders the "nobody responded in time" placeholder; Approve and Deny call `onDecide` with the right decision; the card is reachable and operable by keyboard; and — a semantics regression guard — **the card renders its controls even when the viewer is not the driver.**

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- approvalPrompt`
  Expected: FAIL — the new modules do not exist.

- [ ] **Step 3: Write `ToolSummary.tsx` and `CountdownRing.tsx`**

  `CountdownRing`: an SVG circle with `stroke-dasharray` driven by remaining fraction; `--accent` above 50%, `--warn` above 20%, `--danger` below. The numeric seconds always render inside it — **the ring is decoration, the number is the information.** `aria-hidden` on the ring, the number in the accessible name.

- [ ] **Step 4: Rewrite `ApprovalPrompt.tsx`**

  Layout: risk icon + "**{Tool}** — {plain-language summary}" as the heading; the requester context; the countdown ring; **Approve** (accent) and **Deny** (danger outline) as equally-weighted, equally-easy targets — never make denial harder than approval; an optional reason field; and a **Show raw input** disclosure holding the existing `<pre>`. Border and icon by `ToolRisk`: `destructive` → `--danger`, `writing`/`reading` → `--warn`.

  A one-line note stays visible on the card: *"Anyone in the room can decide. The first response wins."* — that is the real behaviour and people should not have to learn it by surprise.

  Keep the expired placeholder exactly as it behaves today.

- [ ] **Step 5: Run tests and commit**

  ```bash
  git add client/src/components/ApprovalPrompt.tsx client/src/components/CountdownRing.tsx client/src/components/ToolSummary.tsx client/src/components/__tests__/approvalPrompt.test.tsx
  git commit -m "feat(client): risk-classified approval cards with plain-language tool summaries"
  ```

---

### Task 6: Notification system with recovery actions

**Files:**
- Create: `client/src/components/{Notice,NoticeStack}.tsx`
- Modify: `client/src/components/{ErrorBanner,ConnectionStatus,InterruptNotice}.tsx`
- Create: `client/src/components/__tests__/notice.test.tsx`

**Interfaces:**
```ts
export type Severity = 'info' | 'warn' | 'error' | 'fatal';
export interface NoticeAction { label: string; onAct: () => void; }
export interface NoticeProps {
  severity: Severity;
  message: string;
  action?: NoticeAction;
  onDismiss?: () => void;
}
```

Icons per `MASTER.md`: `Info`, `AlertTriangle`, `AlertOctagon`, `ShieldAlert`. **Keep the dismiss-by-count logic** in `App.tsx:33-37` — it exists because "You are not driving" repeats and dismissing by message text would swallow every repeat after the first. That reasoning still holds for other repeating errors.

The important change: an error that has a recovery path gets a button.

| Condition | Severity | Action |
|---|---|---|
| WS close `4409` (room recovered, no API key) | `fatal` | **Re-enter API key** → a dialog POSTing to `/api/rooms/:id/key` with the `X-Nexus-Token` header |
| WS close `4401` (unauthorized) | `fatal` | none — explain the link is invalid or revoked, link to `/new` |
| Reconnecting | `warn` | show the retry countdown |
| `agent_error` event | `error` | dismissible |
| Prompt batch discarded | `info` | **Resend** — the existing `PendingPrompts` affordance |

The re-key dialog must treat the key exactly as `CreateRoom` does: request body only, never a URL, never `localStorage`, cleared from state on success (I4).

`ConnectionStatus` becomes a token-coloured pill with a `Wifi`/`WifiOff` icon and, while reconnecting, the seconds until the next attempt (the backoff table is `[500, 1000, 2000, 4000, 8000]` at `ws.ts:31`).

- [ ] **Step 1: Write the failing test**

  Assert: each severity renders its icon and an accessible role (`status` for info/warn, `alert` for error/fatal); an action button renders and calls its handler; a `4409` notice offers re-entry; dismissing hides it; and the re-key dialog never renders the submitted key into the DOM.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- notice`
  Expected: FAIL — components do not exist.

- [ ] **Step 3: Write `Notice.tsx` and `NoticeStack.tsx`**

  Stack at `z-30`, top-right on desktop, full-width top on mobile. Transient notices auto-dismiss after 6s; `error` and `fatal` never auto-dismiss.

- [ ] **Step 4: Rewire `ErrorBanner` and `ConnectionStatus`**

  Keep `ErrorBanner`'s exported signature if anything else imports it; internally render a `Notice`.

- [ ] **Step 5: Run tests and commit**

  ```bash
  git add client/src/components/Notice.tsx client/src/components/NoticeStack.tsx client/src/components/ErrorBanner.tsx client/src/components/ConnectionStatus.tsx client/src/components/__tests__/notice.test.tsx
  git commit -m "feat(client): severity-typed notices with recovery actions"
  ```

---

### Task 7: Transcript redesign

**Files:**
- Modify: `client/src/components/MessageList.tsx`
- Create: `client/src/components/{ToolCallRow,ScrollAnchor}.tsx`
- Create: `client/src/components/__tests__/messageList.test.tsx`

- **Attribution.** Each user message carries its author's avatar and a left rule in that author's hue, so who-said-what is legible without reading names. `Message.wasDriver` already exists — driver prompts get a small `Crown`.
- **Tool calls** become `ToolCallRow`: collapsed by default showing icon + tool name + one-line summary (reuse `summarizeToolInput` from Task 5); expandable to full mono output. `isError` results get `--danger` and stay expanded. Long output scrolls inside its own `overflow-x:auto` container — the page must never scroll horizontally.
- **Scroll behaviour** is the highest-risk part of this task. Auto-scroll to the newest message **only when the user is already within ~80px of the bottom**. If they have scrolled up, do not move their viewport — show a "**Jump to latest**" pill with the count of new messages. An auto-scroll that fights the reader is the single most common failure of chat UIs, and in a room where someone is reading back through what the agent just did, it is worse than a cosmetic annoyance.
- **Streaming**: `pendingDeltas` renders with a blinking caret at the text end (static under reduced motion).
- Assistant text at `body-sm`, tool I/O in mono at 13px, generous vertical rhythm at the dense scale.
- The list is `aria-live="polite"` with `aria-relevant="additions"`.

- [ ] **Step 1: Write the failing test**

  Assert: messages render in `seq` order; a driver prompt shows the driver marker; a tool call is collapsed by default and expands on click; an errored tool result renders expanded with danger styling; streaming deltas append after settled messages; and — the important one — **when scrolled away from the bottom, a new message does not change `scrollTop`** and the jump-to-latest pill appears.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm --prefix client test -- messageList`
  Expected: FAIL — current list has no scroll management or tool rows.

- [ ] **Step 3: Write `ToolCallRow.tsx` and `ScrollAnchor.tsx`**

- [ ] **Step 4: Rewrite `MessageList.tsx`**

- [ ] **Step 5: Run tests and commit**

  ```bash
  git add client/src/components/MessageList.tsx client/src/components/ToolCallRow.tsx client/src/components/ScrollAnchor.tsx client/src/components/__tests__/messageList.test.tsx
  git commit -m "feat(client): attributed transcript with collapsible tool calls and sane auto-scroll"
  ```

---

### Task 8: Layout recomposition and accessibility pass

**Files:**
- Modify: `client/src/App.tsx` — `phase-5b layout` region only
- Create: `client/src/components/{RoomHeader,SideRail}.tsx`

Three regions:

```
┌─────────────────────────────────────────────────────────┐
│ ◆ Nexus  room-label   ●●●  [agent activity]   ⌘K   ?   │  header, z-10
├──────────────────────────────────────┬──────────────────┤
│  transcript (flex-1, scrolls)        │  side rail       │
│                                      │   Participants   │
│                                      │   Pending queue  │
│                                      │   Approvals      │
├──────────────────────────────────────┴──────────────────┤
│ [prompt ..........................] ⌘⏎ Send    ⎋ Stop   │
└─────────────────────────────────────────────────────────┘
```

Approval cards stay **above the transcript in the main column** as well as listed in the rail — a blocked room must be impossible to miss. Below `lg` the rail collapses to a bottom sheet with a badge count. The prompt row is sticky at the bottom, never scrolls away.

- [ ] **Step 1: Write `RoomHeader.tsx` and `SideRail.tsx`**

  Header: wordmark, room label (repo name from `room_created`, else short room id) with a copy-link button, the avatar row, `AgentActivity`, the `⌘K` switcher trigger and the `?` cheatsheet trigger.

  Rail: `Participants` (full roster with driver controls and their key hints), `Queued prompts` (existing `PendingPrompts`), `Approvals` (pending count and the settled history from `deriveApprovals(...).settled` — currently derived and never rendered; showing who approved what is the audit trail this product is for).

- [ ] **Step 2: Recompose `App.tsx` inside the marker region**

  Wire every component from Tasks 1–7 and register the hotkeys. **Preserve `phase-5a`'s routing region and every existing marker comment** — future dispatches depend on them. Keep the I2′ comment at `App.tsx:110-115` verbatim; it is the reason the input is not driver-gated and a future reader will otherwise "fix" it.

- [ ] **Step 3: Responsive pass at 375 / 768 / 1024 / 1440**

  No horizontal page scroll at any width. All touch targets ≥44×44px with ≥8px separation.

- [ ] **Step 4: Accessibility sweep**

  Complete a full turn keyboard-only: join, prompt, request control, approve a permission, interrupt. Focus visible throughout, no traps, focus returns correctly from every modal. Every icon-only control has an `aria-label`. Landmarks (`header`, `main`, `aside`, `form`) are present and labelled.

- [ ] **Step 5: Measured contrast audit**

  Every text/background pair ≥4.5:1 (3:1 large). Check `--danger` on `--surface-2` specifically — it is the known-tight pair.

- [ ] **Step 6: Run everything and commit**

  Run: `npm run test:all`, `npm run typecheck`, `npm --prefix client run build`

  ```bash
  git add client/src
  git commit -m "feat(client): recompose the room into a three-region console"
  ```

---

## Report notes

Confirm each with pasted evidence, not assertion:

- [ ] `npm test`, `npm run test:client`, `npm run typecheck`, `npm --prefix client run build` — all four exit 0. Paste the tail of each.
- [ ] **Real browser pass, two Chrome tabs, one room, `PORT=8099`** (8080 is occupied on the primary dev machine by an unrelated server). Confirm and describe: both tabs see the same stream; avatars are stable, identical across tabs, and distinct per person; the activity indicator tracks a real turn through thinking → tool → idle; a driver request raised in tab A appears as an actionable card in tab B; `⌘⇧D` transfers the token and both tabs update; `⌘K` lists and switches rooms; an approval card blocks the agent until decided **and can be decided by the non-driver tab**.
- [ ] **Keyboard-only pass.** A complete turn without touching the mouse. State explicitly whether focus was visible at every step.
- [ ] **Escape safety.** Confirm a single Escape does not interrupt, and that Escape while the cheatsheet or palette is open closes it without reaching the interrupt handler.
- [ ] **`a`/`d` are not global.** Confirm they do nothing when focus is on the page body and only act on a focused approval card.
- [ ] **I2′ preserved.** Confirm a non-driver can still type and send, and paste the resulting `user_prompt` event showing `wasDriver: false`.
- [ ] **Reduced motion.** With `prefers-reduced-motion: reduce`, every agent state is still identifiable. Say how you verified it.
- [ ] **Measured contrast table** with the tool named.
- [ ] **No emoji as icons.** Confirm the 🚗 is gone and no emoji remains in any component.
- [ ] **Room-switcher tradeoff.** Confirm room tokens in `localStorage` are disclosed on `/privacy` (owned by `phase-5a` — if that page does not say so, report it rather than editing it).
- [ ] **Screenshots** at 375px and 1440px: idle room, streaming room, room with a pending destructive approval, and the open `⌘K` palette.
- [ ] Note any `design-system/nexus/MASTER.md` token you needed that does not exist.
