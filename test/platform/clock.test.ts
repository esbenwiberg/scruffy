import { describe, expect, it } from "vitest";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";

describe("FixedClock", () => {
  it("is not corrupted by mutating the Date returned from now()", () => {
    const clock = new FixedClock(new Date(0));
    const a = clock.now();
    a.setFullYear(2000);
    expect(clock.now().getTime()).toBe(0);
  });

  it("is not corrupted by mutating the start Date after construction", () => {
    const start = new Date(0);
    const clock = new FixedClock(start);
    start.setFullYear(2000);
    expect(clock.now().getTime()).toBe(0);
  });

  it("is not corrupted by mutating the Date passed to set()", () => {
    const clock = new FixedClock(new Date(0));
    const at = new Date(1_000);
    clock.set(at);
    at.setFullYear(2000);
    expect(clock.now().getTime()).toBe(1_000);
  });

  it("advance is additive", () => {
    const clock = new FixedClock(new Date(0));
    clock.advance(1_000);
    clock.advance(500);
    expect(clock.now().getTime()).toBe(1_500);
  });

  it("set replaces the current time", () => {
    const clock = new FixedClock(new Date(0));
    clock.set(new Date(42));
    expect(clock.now().getTime()).toBe(42);
  });
});

describe("SeededIdGenerator", () => {
  it("produces identical ids for the same seed and call sequence", () => {
    const a = new SeededIdGenerator("s");
    const b = new SeededIdGenerator("s");
    expect(a.next("x")).toBe(b.next("x"));
    expect(a.next("y")).toBe(b.next("y"));
  });

  it("increments the numeric suffix monotonically across next() calls", () => {
    const gen = new SeededIdGenerator("s");
    const first = gen.next("x");
    const second = gen.next("x");
    const suffix = (id: string) => Number(id.slice(id.lastIndexOf("_") + 1));
    expect(suffix(second)).toBe(suffix(first) + 1);
    expect(suffix(second)).toBeGreaterThan(suffix(first));
  });

  it("advances the counter regardless of prefix", () => {
    const gen = new SeededIdGenerator("s");
    expect(gen.next("x")).toBe("x_s_000001");
    expect(gen.next("y")).toBe("y_s_000002");
  });
});
