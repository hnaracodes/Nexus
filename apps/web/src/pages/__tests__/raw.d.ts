// Ambient types for the two things tokens.test.ts needs to read source files
// as text. The web tsconfig deliberately carries no Node or vite/client types,
// and vitest stubs `.css?raw` to an empty string, so the test reads the files
// with node:fs and declares only the sliver of it that it uses.
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}

interface ImportMeta {
  url: string;
  glob(pattern: string, options?: { query?: string; import?: string; eager?: boolean }): Record<string, unknown>;
}
