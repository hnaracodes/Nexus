import { describe, expect, it } from 'vitest';
import { buildAgentEnv } from '../../src/server/subprocessEnv.js';

/**
 * The hole this closes (CLAUDE.md §11): `startAgent` spawns the SDK
 * subprocess with `env: { ...process.env, ANTHROPIC_API_KEY: ... }` — the
 * ENTIRE server environment, forwarded to a subprocess a room participant can
 * ask to run `printenv`. `findLeakedEnvSecrets()` in github.ts is a
 * deny-list WARNING against names matching a pattern somebody wrote down; the
 * whole point of `TOTALLY_NOVEL_CREDENTIAL` below is that it matches no such
 * pattern and a deny-list would let it through regardless.
 */
describe('buildAgentEnv', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'America/Los_Angeles',
    TMPDIR: '/tmp',
    TERM: 'xterm-256color',
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE',
    USERPROFILE: 'C:\\Users\\someone',
    APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
    GITHUB_APP_PRIVATE_KEY_B64: 'super-secret-pem',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    STRIPE_KEY: 'sk_live_whatever',
    DATABASE_URL: 'postgres://user:pass@host/db',
    // Matches no deny-list pattern anyone would think to write — that's the
    // point: an allow-list drops it anyway, a deny-list would not.
    TOTALLY_NOVEL_CREDENTIAL: 'shh',
    OTHER_PROVIDER_KEY: 'should-not-leak-either',
  };

  it('lets the platform basics through', () => {
    const env = buildAgentEnv(source, 'sk-ant-test');
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/Users/someone');
    expect(env['SHELL']).toBe('/bin/zsh');
    expect(env['LANG']).toBe('en_US.UTF-8');
    expect(env['LC_ALL']).toBe('en_US.UTF-8');
    expect(env['TZ']).toBe('America/Los_Angeles');
    expect(env['TMPDIR']).toBe('/tmp');
    expect(env['TERM']).toBe('xterm-256color');
  });

  it('lets the Windows platform equivalents through', () => {
    const env = buildAgentEnv(source, 'sk-ant-test');
    expect(env['SYSTEMROOT']).toBe('C:\\Windows');
    expect(env['COMSPEC']).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(env['PATHEXT']).toBe('.COM;.EXE');
    expect(env['USERPROFILE']).toBe('C:\\Users\\someone');
    expect(env['APPDATA']).toBe('C:\\Users\\someone\\AppData\\Roaming');
    expect(env['LOCALAPPDATA']).toBe('C:\\Users\\someone\\AppData\\Local');
  });

  it('drops every known-secret name, including one matching no written-down pattern', () => {
    const env = buildAgentEnv(source, 'sk-ant-test');
    expect(env['GITHUB_APP_PRIVATE_KEY_B64']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['STRIPE_KEY']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    // The whole point: this name matches no SECRET|PRIVATE_KEY|_TOKEN$
    // pattern, so only an allow-list — not a smarter deny-list — catches it.
    expect(env['TOTALLY_NOVEL_CREDENTIAL']).toBeUndefined();
  });

  it('includes the provider key passed explicitly, under ANTHROPIC_API_KEY', () => {
    const env = buildAgentEnv(source, 'sk-ant-test');
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-test');
  });

  it('drops a key present in source but not passed as the argument', () => {
    // OTHER_PROVIDER_KEY sits right there in source, unrelated to the
    // ANTHROPIC_API_KEY this caller explicitly asked for. The caller must
    // name the key this agent gets — nothing is inherited by proximity.
    const env = buildAgentEnv(source, 'sk-ant-test');
    expect(env['OTHER_PROVIDER_KEY']).toBeUndefined();
  });

  it('returns a fresh object and does not mutate source', () => {
    const before = { ...source };
    const env = buildAgentEnv(source, 'sk-ant-test');
    expect(env).not.toBe(source);
    expect(source).toEqual(before);
  });
});
