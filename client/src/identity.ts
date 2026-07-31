import { AVATAR_HUES } from './design/tokens.js';

/**
 * Small FNV-1a hash. It only needs to be stable across reloads and identical
 * for every participant in the room — the same person is the same colour on
 * everyone's screen — not cryptographically strong.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function avatarFor(
  participantId: string,
  displayName: string,
): { initials: string; hue: number } {
  const hue = AVATAR_HUES[fnv1a(participantId) % AVATAR_HUES.length]!;
  return { initials: initialsFor(displayName), hue };
}

function initialsFor(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .map((word) => firstLetter(word))
    .filter((letter): letter is string => letter !== null);

  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!;
  return `${words[0]}${words[1]}`;
}

/**
 * The first "letter" of a word, uppercased. Returns null for a word with no
 * letter-like character at all (an emoji-only or symbol-only token), so a
 * display name that is entirely emoji falls back to "?" rather than an emoji
 * initial — this project never renders emoji as an icon substitute.
 */
function firstLetter(word: string): string | null {
  const match = word.match(/\p{L}|\p{N}/u);
  return match ? match[0].toUpperCase() : null;
}
