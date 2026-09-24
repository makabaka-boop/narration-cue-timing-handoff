import { describe, it, expect } from 'vitest';
import { solveWithSpan, type Cue } from './solve';
import {
  previewPointMatch,
  buildPointMatchPlan,
  applyPointMatch,
  markedStartRange,
  type TakeMark,
} from './pointMatch';
import type { RevisionId } from './repair';

const U = 1000;

function makeCues(
  durations: number[],
  windows: Array<{ earliest?: number; latest?: number }> = [],
): Cue[] {
  return durations.map((d, i) => ({
    start: durations.slice(0, i).reduce((a, b) => a + b, 0),
    text: `c${i}`,
    duration: d,
    ...(windows[i] ?? {}),
  }));
}

function mark(
  partial: Partial<TakeMark> = {},
): TakeMark {
  return {
    sessionId: 1,
    takeUid: 101,
    markStartMs: 100,
    markEndMs: 300,
    takeDurationMs: 1000,
    ...partial,
  };
}

describe('markedStartRange', () => {
  it('places the segment on the program timeline and leaves room for duration', () => {
    const r = markedStartRange(mark({ markStartMs: 100, markEndMs: 300 }), 50, 200, U);
    expect(r).toEqual({ earliest: 300, latest: 450 });
  });

  it('rejects reversed marks', () => {
    const r = markedStartRange(mark({ markStartMs: 300, markEndMs: 300 }), 10, 0, U);
    expect(r).toMatchObject({ invalid: 'MARK_REVERSED' });
    const r2 = markedStartRange(mark({ markStartMs: 301, markEndMs: 300 }), 10, 0, U);
    expect(r2).toMatchObject({ invalid: 'MARK_REVERSED' });
  });

  it('rejects segments too short for the cue duration', () => {
    const r = markedStartRange(mark({ markStartMs: 0, markEndMs: 40 }), 100, 0, U);
    expect(r).toMatchObject({ invalid: 'SEGMENT_TOO_SHORT' });
    // Exact fit is allowed: a single feasible start.
    const ok = markedStartRange(mark({ markStartMs: 0, markEndMs: 100 }), 100, 0, U);
    expect(ok).toEqual({ earliest: 0, latest: 0 });
  });

  it('rejects marks that cross the program day boundary', () => {
    const before = markedStartRange(mark({ markStartMs: 0, markEndMs: 100 }), 50, -50, U);
    expect(before).toMatchObject({ invalid: 'OUT_OF_PROGRAM' });
    const after = markedStartRange(mark({ markStartMs: 950, markEndMs: 1000 }), 10, 100, U);
    expect(after).toMatchObject({ invalid: 'OUT_OF_PROGRAM' });
    // Segment fully inside [0, U] even if the offset is negative.
    const ok = markedStartRange(mark({ markStartMs: 100, markEndMs: 200 }), 50, -100, U);
    expect(ok).toEqual({ earliest: 0, latest: 50 });
  });

  it('rejects non-integer marks or offsets', () => {
    expect(
      markedStartRange(mark({ markStartMs: 1.5 }), 10, 0, U),
    ).toMatchObject({ invalid: 'INVALID_INPUT' });
    expect(
      markedStartRange(mark(), 10, 2.5, U),
    ).toMatchObject({ invalid: 'INVALID_INPUT' });
  });
});

describe('previewPointMatch — pure intersection + re-solve', () => {
  it('intersects the marked range with the existing window and re-solves', () => {
    // Two cues, duration 100 each, base starts [0, 100]. Mark the range so the
    // cue #0 must start in [400, 450] (offset 400, segment [0, 100]).
    const cues = makeCues([100, 100]);
    const base = [0, 100];
    const a = previewPointMatch({
      cues,
      base,
      mark: mark({ markStartMs: 0, markEndMs: 100 }),
      cueIndex: 0,
      offset: 400,
      daySpan: U,
    });
    expect(a.kind).toBe('ready');
    if (a.kind !== 'ready') return;
    expect(a.window).toEqual({ earliest: 400, latest: 400 });
    expect(a.starts).toEqual([400, 500]);
    // The input draft is untouched.
    expect(cues[0].earliest).toBeUndefined();
  });

  it('keeps the tightest of the two windows (intersection)', () => {
    const cues = makeCues([100], [{ earliest: 50, latest: 900 }]);
    const a = previewPointMatch({
      cues,
      base: [0],
      mark: mark({ markStartMs: 100, markEndMs: 300 }),
      cueIndex: 0,
      offset: 400, // marked feasible starts [500, 600]
      daySpan: U,
    });
    expect(a.kind).toBe('ready');
    if (a.kind !== 'ready') return;
    expect(a.window).toEqual({ earliest: 500, latest: 600 });
  });

  it('reports an empty intersection without touching anything', () => {
    const cues = makeCues([100], [{ earliest: 0, latest: 200 }]);
    const a = previewPointMatch({
      cues,
      base: [0],
      mark: mark({ markStartMs: 100, markEndMs: 300 }),
      cueIndex: 0,
      offset: 400, // marked feasible starts [500, 600] vs window [0, 200]
      daySpan: U,
    });
    expect(a).toMatchObject({ kind: 'rejected', reason: 'EMPTY_INTERSECTION' });
    expect(cues[0]).toEqual({ start: 0, duration: 100, text: 'c0', earliest: 0, latest: 200 });
  });

  it.each([
    ['MARK_REVERSED', { markStartMs: 300, markEndMs: 100 }],
    ['SEGMENT_TOO_SHORT', { markStartMs: 0, markEndMs: 50 }],
    ['OUT_OF_PROGRAM', { markStartMs: 950, markEndMs: 1000 }],
  ] as const)('surfaces %s as a reason-only rejection', (expected, patch) => {
    const cues = makeCues([100]);
    const a = previewPointMatch({
      cues,
      base: [0],
      mark: mark(patch),
      cueIndex: 0,
      offset: expected === 'OUT_OF_PROGRAM' ? 100 : 0,
      daySpan: U,
    });
    expect(a.kind).toBe('rejected');
    if (a.kind === 'rejected') expect(a.reason).toBe(expected);
  });

  it('needs a mark and a valid cue index', () => {
    const cues = makeCues([100]);
    expect(
      previewPointMatch({ cues, base: [0], mark: null, cueIndex: 0, offset: 0, daySpan: U }),
    ).toMatchObject({ kind: 'rejected', reason: 'INVALID_INPUT' });
    expect(
      previewPointMatch({
        cues,
        base: [0],
        mark: mark(),
        cueIndex: 5,
        offset: 0,
        daySpan: U,
      }),
    ).toMatchObject({ kind: 'rejected', reason: 'INVALID_INPUT' });
  });

  it('reports no-solution when a fixed point conflicts with the narrowed window', () => {
    // cue #0 pinned at 0, but the marked+intersected window starts at 500.
    const cues = makeCues([100]);
    const pins = new Map([[0, 0]]);
    const a = previewPointMatch({
      cues,
      base: [0],
      pins,
      mark: mark({ markStartMs: 100, markEndMs: 300 }),
      cueIndex: 0,
      offset: 400,
      daySpan: U,
    });
    expect(a.kind).toBe('no-solution');
    if (a.kind !== 'no-solution') return;
    expect(a.result.ok).toBe(false);
    // The pin and draft were not modified.
    expect(pins.get(0)).toBe(0);
    expect(cues[0].earliest).toBeUndefined();
  });

  it('reports no-solution when the narrowed window breaks a later pin chain', () => {
    // Day U = 1000; two cues of 600 fit only back-to-back. cue #1 is pinned
    // at 600 (inside its own all-day window). Forcing cue #0 into [300, 400]
    // makes the chain require cue #1 >= 900, clashing with the pin: a
    // propagated WINDOW_CHAIN, while the mark and intersection are both valid.
    const cues = makeCues([600, 600]);
    const pins = new Map([[1, 600]]);
    const a = previewPointMatch({
      cues,
      base: [0, 600],
      pins,
      mark: mark({ markStartMs: 100, markEndMs: 800 }), // 700 ms long: fits 600
      cueIndex: 0,
      offset: 200, // marked feasible starts for cue #0: [300, 400]
      daySpan: U,
    });
    expect(a.kind).toBe('no-solution');
    if (a.kind !== 'no-solution') return;
    expect(a.result).toMatchObject({ ok: false, reason: 'WINDOW_CHAIN' });
    // Nothing mutated: the pin survives and no window was installed.
    expect(pins.get(1)).toBe(600);
    expect(cues[0].earliest).toBeUndefined();
  });

  it('produces the same vector as solving with the intersected window directly', () => {
    const cues = makeCues([100, 100, 100], [{}, { earliest: 0, latest: 800 }, {}]);
    const base = [0, 100, 200];
    const a = previewPointMatch({
      cues,
      base,
      mark: mark({ markStartMs: 0, markEndMs: 100 }),
      cueIndex: 0,
      offset: 300, // forces cue #0 to exactly 300
      daySpan: U,
    });
    if (a.kind !== 'ready') throw new Error('expected ready');
    const forced = cues.slice();
    forced[0] = { ...cues[0], earliest: 300, latest: 300 };
    const ref = solveWithSpan(forced, base, new Map(), U);
    expect(ref.ok).toBe(true);
    if (ref.ok) expect(a.starts).toEqual(ref.starts);
  });
});

describe('point-match plans — atomic, identity-checked adoption', () => {
  const id: RevisionId = { draftRev: 1, baseRev: 0, pinsRev: 0, windowsRev: 1 };

  function readyPlan(takeUid = 101) {
    const cues = makeCues([100]);
    const a = previewPointMatch({
      cues,
      base: [0],
      mark: mark({ takeUid, markStartMs: 0, markEndMs: 100 }),
      cueIndex: 0,
      offset: 400,
      daySpan: U,
    });
    expect(a.kind).toBe('ready');
    return buildPointMatchPlan(a, id)!;
  }

  it('applies when take session and all revisions still match', () => {
    const p = readyPlan();
    const r = applyPointMatch(p, id, 101);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cueIndex).toBe(0);
      expect(r.window).toEqual({ earliest: 400, latest: 400 });
      expect(r.starts).toEqual([400]);
    }
  });

  it('expires when the take session changed (re-recorded take)', () => {
    const p = readyPlan(101);
    expect(applyPointMatch(p, id, 102).ok).toBe(false);
    // A booth re-mount with a fresh recorder also presents session-less null.
    expect(applyPointMatch(p, id, null).ok).toBe(false);
  });

  it('expires on any subtitle revision drift', () => {
    const p = readyPlan();
    for (const drifted of [
      { ...id, draftRev: 2 },
      { ...id, baseRev: 1 },
      { ...id, pinsRev: 3 },
      { ...id, windowsRev: 2 },
    ]) {
      expect(applyPointMatch(p, drifted, 101)).toEqual({ ok: false, reason: 'EXPIRED' });
    }
  });

  it('does not build a plan from rejected or no-solution analyses', () => {
    const rejected = previewPointMatch({
      cues: makeCues([100]),
      base: [0],
      mark: mark({ markStartMs: 500, markEndMs: 500 }),
      cueIndex: 0,
      offset: 0,
      daySpan: U,
    });
    expect(buildPointMatchPlan(rejected, id)).toBeNull();
  });
});
