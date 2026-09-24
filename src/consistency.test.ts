import { describe, it, expect } from 'vitest';
import { solveWithSpan, type Cue } from './solver/solve';
import {
  analyzeMaxRetentionWithSpan,
  buildRepairPlan,
  applyRepair,
  type RevisionId,
} from './solver/repair';

function makeCues(
  durations: number[],
  windows: Array<{ earliest?: number; latest?: number }> = [],
): Cue[] {
  return durations.map((d, i) => ({
    start: durations.slice(0, i).reduce((a, b) => a + b, 0),
    duration: d,
    text: `c${i}`,
    ...(windows[i] ?? {}),
  }));
}

describe('three-way consistency across millions of random instances', () => {
  it('diagnosis/analysis/applied-set never contradict each other', () => {
    const rng = (seed: number) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const rand = rng(20260923);
    let infeasible = 0;
    const id: RevisionId = { draftRev: 1, baseRev: 0, pinsRev: 0, windowsRev: 0 };
    for (let trial = 0; trial < 1_000_000; trial++) {
      const n = 1 + Math.floor(rand() * 5);
      const durations = Array.from({ length: n }, () => 1 + Math.floor(rand() * 6));
      const P: number[] = [0];
      for (let i = 1; i < n; i++) P.push(P[i - 1] + durations[i - 1]);
      const U = P[n - 1] + Math.floor(rand() * 9);
      const windows = Array.from({ length: n }, () => {
        const w: { earliest?: number; latest?: number } = {};
        if (rand() < 0.6) w.earliest = Math.floor(rand() * (U + 1));
        if (rand() < 0.6) w.latest = Math.floor(rand() * (U + 1));
        if (w.earliest !== undefined && w.latest !== undefined && w.earliest > w.latest) {
          return { earliest: w.latest, latest: w.earliest };
        }
        return w;
      });
      const pins = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        if (rand() < 0.55) pins.set(i, Math.floor(rand() * (U + 3)) - 1);
      }
      if (pins.size === 0) continue;

      const cues = makeCues(durations, windows);
      const base = cues.map((c) => c.start);
      const r = solveWithSpan(cues, base, pins, U);
      if (r.ok) continue;
      infeasible++;
      const a = analyzeMaxRetentionWithSpan(cues, pins, U);

      if (r.reason === 'PIN_OUTSIDE_WINDOW') {
        // The reported pin must genuinely be outside its own window.
        const ci = r.conflictIndex;
        const pin = pins.get(ci)!;
        expect(pin < (windows[ci]?.earliest ?? 0) || pin > (windows[ci]?.latest ?? U)).toBe(true);
      }
      if (r.reason === 'WINDOW_CHAIN') {
        const ci = r.conflictIndex;
        const pin = pins.get(ci);
        if (pin !== undefined) {
          // At the reported cue a WINDOW_CHAIN may not coexist with a
          // self-window violation of the same cue.
          expect(
            pin >= (windows[ci]?.earliest ?? 0) && pin <= (windows[ci]?.latest ?? U),
            `trial ${trial}: ${JSON.stringify({ durations, U, windows, pins: [...pins], ci })}`,
          ).toBe(true);
        }
      }

      if (a.kind === 'repair') {
        const applied = applyRepair(buildRepairPlan(a, id)!, id);
        expect(applied.ok).toBe(true);
        if (!applied.ok) continue;
        const r2 = solveWithSpan(cues, base, applied.pins, U);
        // The applied pin set must always re-solve to a feasible result.
        expect(r2.ok, `trial ${trial}: retained set infeasible ${JSON.stringify({ durations, U, windows, pins: [...pins], kept: [...applied.pins] })}`).toBe(true);
      } else {
        // Unrecoverable: windows alone must really be infeasible (or too long).
        const winOnly = solveWithSpan(cues, base, new Map(), U);
        expect(winOnly.ok, `trial ${trial}: claimed unrecoverable but windows feasible`).toBe(false);
      }
    }
    expect(infeasible).toBeGreaterThan(10_000);
  }, 600_000);
});
