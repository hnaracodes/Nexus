import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import { startWorkspaceWatcher } from '../../src/server/watcher.js';
import type { WatchFn } from '../../src/server/watcher.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

beforeEach(() => {
  __resetRooms();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeRoom() {
  return createRoom({ apiKey: KEY, cwd: '/fake/workspace', repoUrl: null });
}

/** A fake `fs.watch` that hands the test its listener to drive by hand. */
function fakeWatch(): { watch: WatchFn; emit: (filename: string | null) => void; closed: boolean } {
  const state = { closed: false };
  let listener: (eventType: string, filename: string | null) => void = () => undefined;
  const watch: WatchFn = (_path, _options, cb) => {
    listener = cb;
    return {
      close(): void {
        state.closed = true;
      },
    };
  };
  return {
    watch,
    emit: (filename: string | null) => listener('change', filename),
    get closed() {
      return state.closed;
    },
  };
}

describe('startWorkspaceWatcher', () => {
  it('coalesces multiple changes inside the debounce window into one call', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    startWorkspaceWatcher(makeRoom(), onChange, { watch: fake.watch });

    fake.emit('a.txt');
    fake.emit('a.txt');
    fake.emit('b.txt');
    expect(onChange).not.toHaveBeenCalled(); // still inside the debounce window

    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(1);
    const [paths, truncated] = onChange.mock.calls[0] as [string[], boolean];
    expect([...paths].sort()).toEqual(['a.txt', 'b.txt']);
    expect(truncated).toBe(false);
  });

  it('caps a frame at 200 paths and marks it truncated while still delivering what fits', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    startWorkspaceWatcher(makeRoom(), onChange, { watch: fake.watch });

    for (let i = 0; i < 250; i += 1) fake.emit(`file-${i}.txt`);
    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(1);
    const [paths, truncated] = onChange.mock.calls[0] as [string[], boolean];
    expect(paths).toHaveLength(200);
    expect(truncated).toBe(true);
  });

  it('filters .git and node_modules paths before they ever reach onChange', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    startWorkspaceWatcher(makeRoom(), onChange, { watch: fake.watch });

    fake.emit('.git/HEAD');
    fake.emit('node_modules/pkg/index.js');
    fake.emit('src/app.ts');
    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(1);
    const [paths] = onChange.mock.calls[0] as [string[], boolean];
    expect(paths).toEqual(['src/app.ts']);
  });

  it('never calls onChange when every change in the window was denied', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    startWorkspaceWatcher(makeRoom(), onChange, { watch: fake.watch });

    fake.emit('.git/HEAD');
    vi.advanceTimersByTime(300);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('degrades to a no-op watcher when fs.watch throws synchronously, rather than propagating', () => {
    const throwingWatch: WatchFn = () => {
      throw new Error('recursive watch unsupported here');
    };
    const onChange = vi.fn();
    expect(() =>
      startWorkspaceWatcher(makeRoom(), onChange, { watch: throwingWatch }),
    ).not.toThrow();

    const handle = startWorkspaceWatcher(makeRoom(), onChange, { watch: throwingWatch });
    expect(() => handle.close()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('close() stops the underlying watcher and clears a pending debounce timer', () => {
    const fake = fakeWatch();
    const onChange = vi.fn();
    const handle = startWorkspaceWatcher(makeRoom(), onChange, { watch: fake.watch });

    fake.emit('a.txt');
    handle.close();
    vi.advanceTimersByTime(300);

    expect(onChange).not.toHaveBeenCalled();
    expect(fake.closed).toBe(true);
  });

  it('requests recursive watching unconditionally, not behind a platform check', () => {
    let sawRecursive: boolean | undefined;
    const watch: WatchFn = (_path, options) => {
      sawRecursive = options.recursive;
      return { close(): void {} };
    };
    startWorkspaceWatcher(makeRoom(), vi.fn(), { watch });
    expect(sawRecursive).toBe(true);
  });
});
