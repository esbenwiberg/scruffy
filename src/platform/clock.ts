/**
 * Time and identity are injected, never read ambient. Reconciliation replays
 * and end-to-end harness runs must be reproducible, so nothing in the domain
 * calls `Date.now()` or generates random ids directly. See ADR 0003 validation
 * #4 (reconciliation-after-kill must replay deterministically).
 */

import { randomUUID } from "node:crypto";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Monotonic within a generator instance; deterministic given a seed. */
  next(prefix: string): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Advances only when explicitly told to; the default for tests and harness. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date) {
    // Defensive copy: Date is mutable, so store our own instance to prevent the
    // caller mutating the one they passed in and silently moving the clock.
    this.#current = new Date(start.getTime());
  }

  now(): Date {
    // Return a fresh instance (matching SystemClock) so callers cannot mutate
    // our internal state via the returned reference.
    return new Date(this.#current.getTime());
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }

  set(at: Date): void {
    this.#current = new Date(at.getTime());
  }
}

/**
 * Deterministic id generator. Given the same seed and the same sequence of
 * `next()` calls, produces identical ids — so a replayed run yields the same
 * identities it did the first time.
 */
export class SeededIdGenerator implements IdGenerator {
  #counter = 0;
  readonly #seed: string;

  constructor(seed: string) {
    this.#seed = seed;
  }

  next(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_${this.#seed}_${this.#counter.toString().padStart(6, "0")}`;
  }
}

/**
 * Production id generator: a random UUID per id. Non-deterministic by design —
 * only for real entry points (the manual trigger, an eventual server), never the
 * harness or reconciliation replay, which use SeededIdGenerator for reproducibility.
 */
export class UuidIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}
