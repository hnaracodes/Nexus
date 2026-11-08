import { afterEach, describe, expect, it, vi } from 'vitest';
import { NETWORK_ERROR, createRoomApi, describeFailure } from '../api.js';

function stub(status: number, body: unknown) {
  const f = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  vi.stubGlobal('fetch', f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe('createRoomApi', () => {
  it('sends the token as a header and never in the URL', async () => {
    const f = stub(200, { configs: [], crews: [] });
    await createRoomApi('room 1', 'sekret').library();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/rooms/room%201/configs');
    expect(url).not.toContain('sekret');
    expect((init.headers as Record<string, string>)['X-SynCode-Token']).toBe('sekret');
  });

  it('encodes crew names with slashes, queries and spaces', async () => {
    const f = stub(200, { nodes: [] });
    await createRoomApi('r', 't').run('a/b?c d', 'go');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/rooms/r/crews/a%2Fb%3Fc%20d/run');
    await createRoomApi('r', 't').deleteCrew('x/y');
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe('/api/rooms/r/crews/x%2Fy');
  });

  it('posts JSON bodies and unwraps config', async () => {
    const f = stub(200, { config: { name: 'A', description: '', prompt: '', tools: [] } });
    const r = await createRoomApi('r', 't').saveConfig({ name: 'A', description: '', prompt: '', tools: [] });
    expect(r.ok && r.data.name).toBe('A');
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).name).toBe('A');
  });

  it('maps {problems} to a list, verbatim', async () => {
    stub(400, { problems: ['`tools` must be an explicit list.', 'second'] });
    const r = await createRoomApi('r', 't').saveConfig({ name: 'A', description: '', prompt: '', tools: [] });
    expect(r).toMatchObject({ ok: false, status: 400, problems: ['`tools` must be an explicit list.', 'second'] });
  });

  it('maps {error} to text', async () => {
    stub(409, { error: 'That room is not attached.' });
    const r = await createRoomApi('r', 't').run('c', 'p');
    expect(r).toMatchObject({ ok: false, message: 'That room is not attached.' });
  });

  it('maps a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    const r = await createRoomApi('r', 't').library();
    expect(r).toMatchObject({ ok: false, message: NETWORK_ERROR });
  });

  it('saveCrew posts the crew body shape', async () => {
    const f = stub(200, { crew: { name: 'W', members: [] } });
    await createRoomApi('r', 't').saveCrew('W', { nodes: [], edges: [] });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(['graph', 'members', 'name']);
  });
});

describe('describeFailure', () => {
  it('401/404/other wording', () => {
    expect(describeFailure(401, {}).message).toMatch(/token/);
    expect(describeFailure(404, {}).message).toMatch(/not found/);
    expect(describeFailure(500, null).message).toMatch(/500/);
  });
});
