import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../../src/server/queue.js';

async function drain<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) out.push(item);
  return out;
}

describe('AsyncQueue', () => {
  it('yields items pushed before iteration starts', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    expect(await drain(q)).toEqual([1, 2]);
  });

  it('yields items pushed after the consumer is already waiting', async () => {
    const q = new AsyncQueue<string>();
    const collected = drain(q);
    await Promise.resolve();
    q.push('a');
    q.push('b');
    q.close();
    expect(await collected).toEqual(['a', 'b']);
  });

  it('terminates a waiting consumer on close', async () => {
    const q = new AsyncQueue<number>();
    const collected = drain(q);
    await Promise.resolve();
    q.close();
    expect(await collected).toEqual([]);
  });

  it('preserves FIFO order across many interleaved pushes', async () => {
    const q = new AsyncQueue<number>();
    const collected = drain(q);
    for (let i = 0; i < 100; i++) q.push(i);
    q.close();
    expect(await collected).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('rejects a push after close', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).toThrow(/closed/);
  });
});
