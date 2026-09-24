// Spotting ("对点"): constrain a cue's edit window with the actual position of
// a sentence inside a finished narration take.
//
// The narration booth marks the sentence's take-relative start/end on a
// packaged, reviewable take and sends a *time marker only* across the
// workspace boundary — the take's object URL keeps its single owner (the
// recorder session) and is never transferred. In the subtitle workspace the
// operator picks a cue and enters the integer offset of the recording
// relative to the program timeline (program time = take time + offset). The
// cue may start anywhere it fully fits inside the shifted marked segment:
//
//   start ∈ [markStart + offset, markEnd + offset − duration]
//
// That fit range is intersected with the cue's existing [earliest, latest]
// window; the intersection is what a spotting preview proposes to install.
// Every failure is classified and reported without touching the working
// draft or the adopted starts.

import { cueWindow, DAY_MS, type Cue } from './solve';

/**
 * Time-marker payload sent from the narration booth. Numbers only: no media
 * URL, no blob, no recorder handle crosses the workspace boundary.
 */
export interface SpotMark {
  /** Session of the take the marks were taken from. */
  readonly sessionId: number;
  /** Duration of that take in milliseconds (mark range upper bound). */
  readonly takeDurationMs: number;
  /** Sentence start within the take, milliseconds. */
  readonly markStartMs: number;
  /** Sentence end within the take, milliseconds. */
  readonly markEndMs: number;
}

/**
 * A pending marker held by the app shell. `id` is assigned per send, so
 * re-sending — even identical values, and in particular after a re-record —
 * retires every preview generated from an earlier marker.
 */
export interface SpotMarker extends SpotMark {
  readonly id: number;
}

export type AlignmentWindowRejection =
  | {
      ok: false;
      reason: 'MARK_REVERSED';
      markStartMs: number;
      markEndMs: number;
    }
  | {
      ok: false;
      reason: 'SEGMENT_TOO_SHORT';
      segmentMs: number;
      durationMs: number;
    }
  | {
      ok: false;
      reason: 'OUT_OF_PROGRAM';
      segStart: number;
      segEnd: number;
    }
  | {
      ok: false;
      reason: 'EMPTY_INTERSECTION';
      fitEarliest: number;
      fitLatest: number;
      cueEarliest: number;
      cueLatest: number;
    };

export type AlignmentWindowResult =
  | { ok: true; earliest: number; latest: number }
  | AlignmentWindowRejection;

/**
 * Intersect the cue's fit-inside-segment start range with its existing edit
 * window. Pure: validates the mark, shifts it by the recording offset into
 * program time, and never mutates the cue.
 */
export function alignmentWindow(
  cue: Cue,
  mark: SpotMark,
  offsetMs: number,
  daySpan: number = DAY_MS,
): AlignmentWindowResult {
  const { markStartMs, markEndMs } = mark;
  if (markStartMs > markEndMs) {
    return { ok: false, reason: 'MARK_REVERSED', markStartMs, markEndMs };
  }
  const segmentMs = markEndMs - markStartMs;
  if (segmentMs < cue.duration) {
    return {
      ok: false,
      reason: 'SEGMENT_TOO_SHORT',
      segmentMs,
      durationMs: cue.duration,
    };
  }
  const segStart = markStartMs + offsetMs;
  const segEnd = markEndMs + offsetMs;
  if (segStart < 0 || segEnd > daySpan) {
    return { ok: false, reason: 'OUT_OF_PROGRAM', segStart, segEnd };
  }
  // Starts for which [start, start + duration] lies fully inside the segment.
  const fitEarliest = segStart;
  const fitLatest = segEnd - cue.duration;
  const win = cueWindow(cue, daySpan);
  const earliest = Math.max(fitEarliest, win.earliest);
  const latest = Math.min(fitLatest, win.latest);
  if (earliest > latest) {
    return {
      ok: false,
      reason: 'EMPTY_INTERSECTION',
      fitEarliest,
      fitLatest,
      cueEarliest: win.earliest,
      cueLatest: win.latest,
    };
  }
  return { ok: true, earliest, latest };
}
