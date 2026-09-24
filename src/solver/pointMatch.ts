// Narration point-matching: constrain one cue's cut-in window with the actual
// position of one sentence inside a recorded, sealed take.
//
// The operator marks the sentence with [markStartMs, markEndMs) in recording
// time and states an integer offset of the recording timeline relative to the
// program timeline (program = recording + offset). The chosen cue of duration d
// must fit *completely* inside the marked segment, so its feasible program
// starts are
//
//   markStartMs + offset <= x[i] <= markEndMs - d + offset.
//
// That interval is intersected with the cue's existing [earliest, latest]
// window; the resulting windows are then re-arranged by the existing solver
// (fixed points, day bounds, minimal absolute displacement, lexicographic tie
// break). Like the repair layer this module is a *pure analysis layer*:
// analysis never mutates the working draft, baseline, pins or windows, and a
// plan is applied atomically only after re-checking every identity.
//
// A point match carries timing numbers only — never a media URL. Ownership of
// the take object URL stays entirely with the narration booth, which revokes
// it on discard / booth leave / unmount.

import { solve, DAY_MS, cueWindow, type Cue, type InfeasibleResult, type Pins } from './solve';
import type { RevisionId } from './repair';

export const DAY_MS_POINT = DAY_MS;

/**
 * The only datum crossing from the narration booth to the subtitle workspace.
 * Contains timing numbers and take identities, never the take's object URL.
 */
export interface TakeMark {
  /** Session id of the recorder that produced the take (diagnostics only). */
  readonly sessionId: number;
  /** Globally unique take identity; a re-recorded take always gets a new one. */
  readonly takeUid: number;
  /** Marked sentence start in recording time, integer milliseconds. */
  readonly markStartMs: number;
  /** Marked sentence end (exclusive) in recording time, integer milliseconds. */
  readonly markEndMs: number;
  /** Total duration of the sealed take in milliseconds. */
  readonly takeDurationMs: number;
}

export type PointMatchReason =
  | 'MARK_REVERSED'
  | 'SEGMENT_TOO_SHORT'
  | 'OUT_OF_PROGRAM'
  | 'EMPTY_INTERSECTION'
  | 'INVALID_INPUT';

export type PointMatchAnalysis =
  | {
      kind: 'ready';
      starts: number[];
      cost: number;
      /** The cue window after intersection (identical for every other cue). */
      cueIndex: number;
      window: { earliest: number; latest: number };
      mark: TakeMark;
      offset: number;
    }
  | {
      kind: 'rejected';
      reason: PointMatchReason;
      cueIndex?: number;
      detail?: string;
    }
  | {
      kind: 'no-solution';
      result: InfeasibleResult;
    };

export interface PointMatchInput {
  cues: ReadonlyArray<Cue>;
  base: ReadonlyArray<number>;
  pins?: Pins;
  mark: TakeMark | null;
  cueIndex: number;
  /** Integer offset of recording time relative to program time. */
  offset: number;
  daySpan?: number;
}

export interface PointMatchPlan extends RevisionId {
  takeUid: number;
  cueIndex: number;
  window: { earliest: number; latest: number };
  starts: number[];
  cost: number;
}

export type ApplyPointMatchResult =
  | {
      ok: true;
      cueIndex: number;
      window: { earliest: number; latest: number };
      starts: number[];
    }
  | { ok: false; reason: 'EXPIRED' };

/**
 * Compute the feasible start range of a cue of duration `durationMs` within a
 * marked take segment placed on the program timeline by `offset`.
 * Null means the request is invalid for the given reason.
 */
export function markedStartRange(
  mark: TakeMark,
  durationMs: number,
  offset: number,
  daySpan: number,
):
  | { earliest: number; latest: number }
  | { invalid: PointMatchReason; detail?: string } {
  if (
    !Number.isFinite(mark.markStartMs) ||
    !Number.isFinite(mark.markEndMs) ||
    !Number.isFinite(offset)
  ) {
    return { invalid: 'INVALID_INPUT', detail: '标记或偏移不是有限数值。' };
  }
  if (
    !Number.isInteger(mark.markStartMs) ||
    !Number.isInteger(mark.markEndMs) ||
    !Number.isInteger(offset)
  ) {
    return { invalid: 'INVALID_INPUT', detail: '标记起止与偏移必须是整数毫秒。' };
  }
  if (mark.markStartMs < 0 || mark.markEndMs < 0) {
    return { invalid: 'INVALID_INPUT', detail: '标记不能位于录音开始之前。' };
  }
  if (mark.markStartMs >= mark.markEndMs) {
    return {
      invalid: 'MARK_REVERSED',
      detail: '标记倒序：起点必须早于终点。',
    };
  }
  // Keep the program-timeline arithmetic exact for every representable
  // integer day boundary (well inside the safe-integer range).
  if (
    offset < -DAY_MS_POINT ||
    offset > DAY_MS_POINT ||
    !Number.isSafeInteger(mark.markEndMs + offset) ||
    !Number.isSafeInteger(mark.markStartMs + offset)
  ) {
    return {
      invalid: 'INVALID_INPUT',
      detail: '偏移超出可表示的整数范围。',
    };
  }
  const segStart = mark.markStartMs + offset;
  const segEnd = mark.markEndMs + offset; // exclusive program time
  if (segStart < 0 || segEnd > daySpan) {
    return {
      invalid: 'OUT_OF_PROGRAM',
      detail: `标记段落在节目时间轴上为 [${segStart}, ${segEnd})，必须整体落在全天边界 [0, ${daySpan}] 内。`,
    };
  }
  // x + d <= segEnd, integer inclusive upper bound.
  if (mark.markEndMs - mark.markStartMs < durationMs) {
    return {
      invalid: 'SEGMENT_TOO_SHORT',
      detail: `标记段仅 ${mark.markEndMs - mark.markStartMs} ms，容不下该 cue 的 ${durationMs} ms 时长。`,
    };
  }
  return {
    earliest: segStart,
    latest: segEnd - durationMs,
  };
}

/**
 * Pure preview: intersect the marked feasible range with the cue's current
 * window and re-solve. Nothing in the input is mutated.
 */
export function previewPointMatch(input: PointMatchInput): PointMatchAnalysis {
  const { cues, base, mark, cueIndex, offset } = input;
  const daySpan = input.daySpan ?? DAY_MS_POINT;
  const n = cues.length;

  if (mark === null) {
    return { kind: 'rejected', reason: 'INVALID_INPUT', detail: '还没有录音时间标记。' };
  }
  if (
    !Number.isInteger(cueIndex) ||
    cueIndex < 0 ||
    cueIndex >= n ||
    base.length !== n
  ) {
    return { kind: 'rejected', reason: 'INVALID_INPUT', cueIndex, detail: 'cue 选择无效。' };
  }
  const cue = cues[cueIndex];
  const range = markedStartRange(mark, cue.duration, offset, daySpan);
  if ('invalid' in range) {
    return { kind: 'rejected', reason: range.invalid, cueIndex, detail: range.detail };
  }

  const win = cueWindow(cue, daySpan);
  const earliest = Math.max(win.earliest, range.earliest);
  const latest = Math.min(win.latest, range.latest);
  if (earliest > latest) {
    return {
      kind: 'rejected',
      reason: 'EMPTY_INTERSECTION',
      cueIndex,
      detail: `标记可落起点 [${range.earliest}, ${range.latest}] 与该 cue 现有窗口 [${win.earliest}, ${win.latest}] 交集为空。`,
    };
  }

  // Solve on a copy: only the chosen cue's window changes. Pins are read, not
  // edited; a pin incompatible with the intersected window is reported by the
  // solver's normal diagnostics.
  const nextCues = cues.slice();
  nextCues[cueIndex] = { ...cue, earliest, latest };
  const result = solve({ cues: nextCues, base, pins: input.pins });
  if (!result.ok) {
    return { kind: 'no-solution', result };
  }
  return {
    kind: 'ready',
    starts: result.starts,
    cost: result.cost,
    cueIndex,
    window: { earliest, latest },
    mark,
    offset,
  };
}

/**
 * Freeze a ready analysis into an identity-carrying plan. The take UID binds
 * the plan to the exact take marked; every subtitle revision is recorded.
 */
export function buildPointMatchPlan(
  analysis: PointMatchAnalysis,
  id: RevisionId,
): PointMatchPlan | null {
  if (analysis.kind !== 'ready') return null;
  return {
    draftRev: id.draftRev,
    baseRev: id.baseRev,
    pinsRev: id.pinsRev,
    windowsRev: id.windowsRev,
    takeUid: analysis.mark.takeUid,
    cueIndex: analysis.cueIndex,
    window: { ...analysis.window },
    starts: analysis.starts.slice(),
    cost: analysis.cost,
  };
}

/**
 * Apply only while BOTH the take session and every subtitle revision are still
 * exactly what the preview was generated against. Any mismatch is EXPIRED:
 * the caller reports it and performs no partial modification.
 */
export function applyPointMatch(
  plan: PointMatchPlan,
  current: RevisionId,
  currentTakeUid: number | null,
): ApplyPointMatchResult {
  const sameRev =
    plan.draftRev === current.draftRev &&
    plan.baseRev === current.baseRev &&
    plan.pinsRev === current.pinsRev &&
    plan.windowsRev === current.windowsRev;
  if (!sameRev || currentTakeUid !== plan.takeUid) {
    return { ok: false, reason: 'EXPIRED' };
  }
  return {
    ok: true,
    cueIndex: plan.cueIndex,
    window: { ...plan.window },
    starts: plan.starts.slice(),
  };
}

export const POINT_MATCH_REASON_TEXT: Record<PointMatchReason, string> = {
  MARK_REVERSED: '标记倒序：句子起点必须早于终点。',
  SEGMENT_TOO_SHORT: '标记时长不足：标记段落不下该 cue 的完整时长。',
  OUT_OF_PROGRAM: '标记越过节目边界：录音加偏移后必须整体落在 0–86,400,000 内。',
  EMPTY_INTERSECTION: '交集为空：标记可落起点范围与该 cue 现有窗口没有重叠。',
  INVALID_INPUT: '对点输入无效：请先在复听的 take 上标记句子并选择 cue。',
};
