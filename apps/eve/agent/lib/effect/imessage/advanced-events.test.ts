import { describe, expect, it } from "vitest";

import { takeNextContiguousEvent } from "./advanced-events";

function shuffled(size: number, seed: number): number[] {
  const values = Array.from({ length: size }, (_, index) => index + 1);
  let state = seed;
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}

describe("Advanced iMessage contiguous event recovery", () => {
  it("advances through randomized out-of-order arrivals without skipping", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const pending = new Map<number, { sequence: number }>();
      const handled: number[] = [];
      let contiguous = 0;
      for (const sequence of shuffled(40, seed)) {
        pending.set(sequence, { sequence });
        while (true) {
          const next = takeNextContiguousEvent(pending, contiguous);
          if (next === undefined) break;
          handled.push(next.sequence);
          contiguous = next.sequence;
        }
      }
      expect(handled).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      expect(pending.size).toBe(0);
    }
  });

  it("stops at a gap and continues when the missing sequence arrives", () => {
    const pending = new Map([
      [12, { sequence: 12 }],
      [14, { sequence: 14 }],
    ]);
    expect(takeNextContiguousEvent(pending, 10)).toBeUndefined();
    pending.set(11, { sequence: 11 });
    expect(takeNextContiguousEvent(pending, 10)?.sequence).toBe(11);
    expect(takeNextContiguousEvent(pending, 11)?.sequence).toBe(12);
    expect(takeNextContiguousEvent(pending, 12)).toBeUndefined();
    pending.set(13, { sequence: 13 });
    expect(takeNextContiguousEvent(pending, 12)?.sequence).toBe(13);
    expect(takeNextContiguousEvent(pending, 13)?.sequence).toBe(14);
  });
});
