/**
 * `@nexus/server`'s package.json has no "main", "exports" or "types" field
 * (checked before writing this), and its build config
 * (apps/server/tsconfig.build.json) does not set `"declaration": true`, so
 * `npm run build -w @nexus/server` emits `dist/server/index.js` with no
 * accompanying `.d.ts`. Both files live in apps/server, which is out of
 * scope for this package — desktop owns only apps/desktop/** — so rather
 * than widen that package's build output, this declares just the shape
 * main.ts actually calls: the `server` half of what `createServer()` returns
 * (a plain node:http Server desktop can `.listen()` on an OS-assigned port
 * and read the real port back off). The `app: Hono` half of the real return
 * value is left out because nothing in this package touches it — main.ts
 * never adds routes or talks to Hono directly, it only owns the socket.
 *
 * Because there is no "exports" map on @nexus/server, Node's own module
 * resolution allows any subpath into the package at runtime (only an
 * "exports" field would restrict that) — so this exact specifier is also
 * what actually resolves once `@nexus/server` has been built.
 *
 * This file must have NO top-level import/export statement outside the
 * `declare module` block below. The moment it does, TypeScript treats the
 * whole file as itself being a module, and a `declare module "x" {}` inside
 * a module file is a *module augmentation* — it merges into an
 * already-resolved module and does nothing when there is nothing to merge
 * into. Only in a global (non-module) file does `declare module "x" {}` act
 * as a standalone ambient declaration, which is what actually suppresses
 * TS7016 for a real .js file that has no .d.ts. (Confirmed by hitting
 * exactly that TS7016 with the import hoisted to the top of this file
 * before moving it inside the block.) That's also why the `Server` type
 * below is imported from inside the block instead of at file scope.
 */
declare module '@nexus/server/dist/server/index.js' {
  import type { Server } from 'node:http';
  export function createServer(opts?: { agentDeps?: unknown }): { server: Server };
}
