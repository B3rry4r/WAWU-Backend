import { randomBytes } from 'node:crypto';

/** The source of the random bytes a reference is made of. */
export type RandomBytes = (size: number) => Buffer;

/**
 * Injection token for that source (JOIN-01). The default is the operating
 * system's `crypto.randomBytes`; a spec replaces it to force two
 * registrations to draw the same access code.
 */
export const WAITLIST_RANDOM = Symbol('WAITLIST_RANDOM');

export const systemRandom: RandomBytes = (size) => randomBytes(size);
