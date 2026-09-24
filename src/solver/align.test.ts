import { describe, it, expect } from 'vitest';
import { alignmentWindow, type SpotMark } from './align';
import { solveWithSpan, type Cue } from './solve';

const U = 100_000;

function mark(partial: Partial<SpotMark> = {}): SpotMark {
  return {
    sessionId: 1,
    takeDurationMs: 10_000,
    markStartMs: 1_000,
    markEndMs: 3_000,
    ...partial,
  };
}

function cue(partial: Partial<Cue> = {}): Cue {
  return { start: 0, duration: 500, text: 'c', ...partial };
}

describe('alignmentWindow — fit range intersected with the existing window', () => {
  it('shifts the marked segment by the offset and clamps the fit range by duration', () => {
    // Segment [1000, 3000] + offset 60000 -> program [61000, 63000]; a
    // 500 ms cue may start in [61000, 62500].
    const r = alignmentWindow(cue({ duration: 500 }), mark(), 60_000, U);
    expect(r).toEqual({ ok: true, earliest: 61_000, latest: 62_500 });
  });

  it('intersects with both existing window boundaries', () => {
    const r = alignmentWindow(
      cue({ duration: 500, earliest: 61_500, latest: 62_000 }),
      mark(),
      60_000,
      U,
    );
    expect(r).toEqual({ ok: true, earliest: 61_500, latest: 62_000 });
  });

  it('clamps only the side the existing window actually tightens', () => {
    const lo = alignmentWindow(cue({ earliest: 61_500 }), mark(), 60_000, U);
    expect(lo).toEqual({ ok: true, earliest: 61_500, latest: 62_500 });
    const hi = alignmentWindow(cue({ latest: 62_000 }), mark(), 60_000, U);
    expect(hi).toEqual({ ok: true, earliest: 61_000, latest: 62_000 });
  });

  it('treats absent boundaries as the whole-day window', () => {
    const r = alignmentWindow(cue(), mark(), 0, U);
    expect(r).toEqual({ ok: true, earliest: 1_000, latest: 2_500 });
  });

  it('a zero offset keeps the segment where it was recorded', () => {
    const r = alignmentWindow(cue({ duration: 2_000 }), mark(), 0, U);
    expect(r).toEqual({ ok: true, earliest: 1_000, latest: 1_000 });
  });
});

describe('alignmentWindow — classified rejections', () => {
  it('MARK_REVERSED when the mark start is past the mark end', () => {
    const r = alignmentWindow(
      cue(),
      mark({ markStartMs: 3_000, markEndMs: 1_000 }),
      0,
      U,
    );
    expect(r).toEqual({
      ok: false,
      reason: 'MARK_REVERSED',
      markStartMs: 3_000,
      markEndMs: 1_000,
    });
  });

  it('SEGMENT_TOO_SHORT only when the segment is strictly shorter than the cue', () => {
    const exact = alignmentWindow(
      cue({ duration: 2_000 }),
      mark(),
      0,
      U,
    );
    expect(exact.ok).toBe(true);
    const short = alignmentWindow(cue({ duration: 2_001 }), mark(), 0, U);
    expect(short).toEqual({
      ok: false,
      reason: 'SEGMENT_TOO_SHORT',
      segmentMs: 2_000,
      durationMs: 2_001,
    });
    // A zero-length mark can never hold a cue (duration >= 1).
    const empty = alignmentWindow(
      cue({ duration: 1 }),
      mark({ markStartMs: 500, markEndMs: 500 }),
      0,
      U,
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('SEGMENT_TOO_SHORT');
  });

  it('OUT_OF_PROGRAM when the shifted segment leaves the program day', () => {
    const before = alignmentWindow(cue(), mark(), -1_500, U);
    expect(before).toEqual({
      ok: false,
      reason: 'OUT_OF_PROGRAM',
      segStart: -500,
      segEnd: 1_500,
    });
    const after = alignmentWindow(cue(), mark(), U, U);
    expect(after).toEqual({
      ok: false,
      reason: 'OUT_OF_PROGRAM',
      segStart: 101_000,
      segEnd: 103_000,
    });
    // Exactly touching both day edges is still inside.
    const edge = alignmentWindow(
      cue({ duration: 500 }),
      mark({ markStartMs: 0, markEndMs: 2_000 }),
      0,
      2_000,
    );
    expect(edge).toEqual({ ok: true, earliest: 0, latest: 1_500 });
  });

  it('EMPTY_INTERSECTION when the fit range misses the existing window', () => {
    // Fit range [61000, 62500] vs window [0, 1000].
    const before = alignmentWindow(cue({ latest: 1_000 }), mark(), 60_000, U);
    expect(before).toEqual({
      ok: false,
      reason: 'EMPTY_INTERSECTION',
      fitEarliest: 61_000,
      fitLatest: 62_500,
      cueEarliest: 0,
      cueLatest: 1_000,
    });
    // Fit range [61000, 62500] vs window [70000, U].
    const after = alignmentWindow(cue({ earliest: 70_000 }), mark(), 60_000, U);
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.reason).toBe('EMPTY_INTERSECTION');
      if (after.reason === 'EMPTY_INTERSECTION') {
        expect(after.cueEarliest).toBe(70_000);
        expect(after.cueLatest).toBe(U);
      }
    }
  });
});

describe('alignmentWindow — tentative window through the solver', () => {
  const durations = [100, 100, 100];
  const cues: Cue[] = durations.map((d, i) => ({
    start: i * 100,
    duration: d,
    text: `c${i}`,
  }));
  const base = cues.map((c) => c.start);

  it('the intersected window re-solves to a feasible, pin-exact arrangement', () => {
    // Sentence for cue #1 heard at take [50, 260] with offset 1000: program
    // segment [1050, 1260], fit range for a 100 ms cue [1050, 1160].
    const w = alignmentWindow(cues[1], mark({ markStartMs: 50, markEndMs: 260 }), 1_000, U);
    expect(w).toEqual({ ok: true, earliest: 1_050, latest: 1_160 });
    if (!w.ok) return;
    const tentative = cues.slice();
    tentative[1] = { ...cues[1], earliest: w.earliest, latest: w.latest };
    const pins = new Map<number, number>([[0, 900]]);
    const r = solveWithSpan(tentative, base, pins, U);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.starts[0]).toBe(900); // pin hit exactly
      expect(r.starts[1]).toBeGreaterThanOrEqual(1_050);
      expect(r.starts[1]).toBeLessThanOrEqual(1_160);
      expect(r.starts[2]).toBeGreaterThanOrEqual(r.starts[1] + 100);
    }
  });

  it('a pin colliding with the aligned window makes the whole instance infeasible', () => {
    // Same segment as above, but cue #0 is pinned at 1200: cue #1 would have
    // to start at >= 1300 while its aligned window caps it at 1160.
    const w = alignmentWindow(cues[1], mark({ markStartMs: 50, markEndMs: 260 }), 1_000, U);
    if (!w.ok) throw new Error('expected a window');
    const tentative = cues.slice();
    tentative[1] = { ...cues[1], earliest: w.earliest, latest: w.latest };
    const r = solveWithSpan(tentative, base, new Map([[0, 1_200]]), U);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('WINDOW_CHAIN');
  });
});
