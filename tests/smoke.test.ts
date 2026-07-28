import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs ESM TypeScript under vitest', () => {
    expect(new URL('file:///x').protocol).toBe('file:');
  });
});
