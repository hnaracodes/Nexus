import { describe, expect, it } from 'vitest';
import { AVATAR_HUES } from '../../design/tokens.js';
import { avatarFor } from '../../identity.js';

describe('avatarFor', () => {
  it('is deterministic for the same id across calls', () => {
    const a = avatarFor('p_ada', 'Ada');
    const b = avatarFor('p_ada', 'Ada');
    expect(a).toEqual(b);
  });

  it('picks a hue from AVATAR_HUES', () => {
    const { hue } = avatarFor('p_ada', 'Ada');
    expect(AVATAR_HUES as readonly number[]).toContain(hue);
  });

  it('gives different ids in a small room different hues', () => {
    const ids = ['p_ada', 'p_grace', 'p_ben', 'p_zooey'];
    const hues = new Set(ids.map((id) => avatarFor(id, id).hue));
    expect(hues.size).toBeGreaterThan(1);
  });

  it('derives initials from the first letters of the first two words', () => {
    expect(avatarFor('p_1', 'Ada Lovelace').initials).toBe('AL');
  });

  it('uses a single letter for a one-word name', () => {
    expect(avatarFor('p_1', 'Ada').initials).toBe('A');
  });

  it('falls back sensibly for an empty name', () => {
    expect(avatarFor('p_1', '').initials).toBe('?');
  });

  it('falls back sensibly for an emoji-only name', () => {
    expect(avatarFor('p_1', '🚗🚀').initials).toBe('?');
  });
});
