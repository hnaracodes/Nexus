/**
 * The barrel. Subpath imports (`@nexus/protocol/events`) are the convention in
 * this repo — they map one-to-one onto the relative imports they replaced, so
 * the extraction stayed a mechanical rewrite. This entry exists for consumers
 * that want the whole surface in one import.
 */
export * from './events.js';
export * from './wire.js';
export * from './docsync.js';
