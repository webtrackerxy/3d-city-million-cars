import { describe, expect, it } from "vitest";
import { AdaptiveLod } from "./AdaptiveLod.ts";

/** feed `seconds` of frames whose intervals alternate between the given values */
function run(a: AdaptiveLod, seconds: number, intervals: number[]): number | null {
  let decision: number | null = null;
  let t = 0;
  let i = 0;
  while (t < seconds) {
    const ms = intervals[i++ % intervals.length] as number;
    decision = a.update(ms, ms / 1000) ?? decision;
    t += ms / 1000;
  }
  return decision;
}

describe("AdaptiveLod", () => {
  it("shrinks when frames are long relative to the display period and recovers at vsync", () => {
    const a = new AdaptiveLod({ step: 0.5, interval: 1 });
    // a 60 Hz display with stalls: min 16.7 ms, mean ~30 ms -> shrink
    expect(run(a, 1.05, [16.7, 45, 16.7, 45])).toBe(0.5);
    expect(run(a, 1.05, [16.7, 45, 16.7, 45])).toBe(0.25);
    // steady 60 Hz: mean equals the period -> grow back to 1
    expect(run(a, 1.05, [16.7])).toBe(0.5);
    expect(run(a, 1.05, [16.7])).toBe(1);
    expect(run(a, 1.05, [16.7])).toBeNull();
    expect(a.scale).toBe(1);
  });

  it("treats a steady 120 Hz display the same way and respects the floor", () => {
    const a = new AdaptiveLod({ step: 0.5, interval: 1, minScale: 0.3 });
    expect(run(a, 1.05, [8.3])).toBeNull();
    for (let r = 0; r < 5; r++) run(a, 1.05, [8.3, 30]);
    expect(a.scale).toBe(0.3);
    run(a, 2.1, [8.3]);
    expect(a.scale).toBeGreaterThan(0.3);
  });

  it("keeps full detail at 120 Hz when a late frame and its catch-up frame arrive every 100 ms", () => {
    // what a 16 MB state-texture upload per 100 ms snapshot does at 1,000,000 vehicles:
    // ten on-time frames, one late frame, one early catch-up frame; the mean stays at 8.3 ms
    const a = new AdaptiveLod();
    for (let r = 0; r < 20; r++)
      run(a, 1.05, [8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 8.33, 12.5, 4.17]);
    expect(a.scale).toBe(1);
  });
});
