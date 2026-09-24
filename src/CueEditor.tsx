import { useEffect, useMemo, useRef, useState } from 'react';
import {
  solve,
  DAY_MS,
  cueWindow,
  type Cue,
  type InfeasibleResult,
} from './solver/solve';
import { parseCues, toCuesJson } from './solver/cues';
import {
  analyzeMaxRetention,
  applyRepair,
  buildRepairPlan,
  sameRevision,
  type RepairPlan,
  type RevisionId,
} from './solver/repair';
import {
  alignmentWindow,
  type AlignmentWindowRejection,
  type SpotMarker,
} from './solver/align';

interface Draft {
  cues: Cue[];
  base: number[]; // adopted starts
}

type Preview =
  | { kind: 'ready'; starts: number[]; cost: number }
  | { kind: 'infeasible'; result: InfeasibleResult };

const ROW_H = 78;
const LIST_H = 560;

function fmtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1000;
  const pad = (v: number, w = 2): string => String(v).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(millis, 3)}`;
}

function conflictText(result: InfeasibleResult): string {
  if (result.reason === 'PIN_OUTSIDE_WINDOW') {
    return `固定点落在自身窗口外 · cue #${result.conflictIndex}：固定起点 ${result.requiredStart}，允许闭区间 [${result.allowedEarliest}, ${result.allowedLatest}]。`;
  }
  if (result.reason === 'WINDOW_CHAIN') {
    return `窗口链冲突 · 最早 cue #${result.conflictIndex}：前序时长要求起点至少 ${result.requiredStart}，允许上界 ${result.allowedLatest}。`;
  }
  if (result.reason === 'INVALID_WINDOW') {
    return `WINDOW_INVALID · cue #${result.conflictIndex ?? '?'} 的窗口缺失、越界或反序。`;
  }
  if (result.reason === 'INVALID_PIN') {
    return `PIN_INVALID · cue #${result.conflictIndex ?? '?'} 的固定点无效。`;
  }
  return 'INFEASIBLE — 固定点与窗口约束不可行。';
}

type WindowField = 'earliest' | 'latest';

/**
 * A generated spotting preview. Carries the identity of the marker and of
 * every subtitle revision it was generated against, so adoption can refuse a
 * stale plan instead of committing a window the solver never saw. The solved
 * starts are stored, not recomputed on adoption: window and baseline switch
 * in one state write, never "window first, solve later".
 */
interface AlignmentPreview {
  markerId: number;
  sessionId: number;
  cueIndex: number;
  offsetMs: number;
  earliest: number;
  latest: number;
  starts: number[];
  cost: number;
  rev: RevisionId;
}

type AlignmentResult =
  | { kind: 'ready'; preview: AlignmentPreview }
  | { kind: 'rejected'; message: string };

function alignmentRejectionText(r: AlignmentWindowRejection): string {
  if (r.reason === 'MARK_REVERSED') {
    return `标记倒序：标记起点 ${r.markStartMs} 晚于标记终点 ${r.markEndMs}。`;
  }
  if (r.reason === 'SEGMENT_TOO_SHORT') {
    return `时长不足：标记段 ${r.segmentMs} ms 装不下该 cue 的时长 ${r.durationMs} ms。`;
  }
  if (r.reason === 'OUT_OF_PROGRAM') {
    return `越过节目边界：按偏移平移后段落 [${r.segStart}, ${r.segEnd}] 超出节目范围 [0, ${DAY_MS}]。`;
  }
  return `交集为空：可完整落入标记段的起点范围 [${r.fitEarliest}, ${r.fitLatest}] 与该 cue 现有窗口 [${r.cueEarliest}, ${r.cueLatest}] 不相交。`;
}

interface CueRowProps {
  index: number;
  cue: Cue;
  base: number;
  pinned: boolean;
  pinValue: number | undefined;
  previewStart: number | null;
  overlapPrev: boolean;
  rejectedField: WindowField | null;
  onPinChange: (raw: string) => void;
  onWindowChange: (field: WindowField, raw: string) => boolean;
  onRemovePin: () => void;
  onRejectLeave: () => void;
}

/**
 * One virtualised cue row. The window inputs are *controlled by the last
 * confirmed window only*: a rejected edit commits nothing, the parent keeps
 * rendering the old boundary, and React restores the DOM value during the same
 * event tick, so the screen can never display a value older/newer than the
 * snapshot used by solve, adopt and export. When the row leaves the virtual
 * list it unmounts and withdraws its rejection banner, which therefore never
 * survives the content it refers to.
 */
function CueRow({
  index,
  cue,
  base,
  pinned,
  pinValue,
  previewStart,
  overlapPrev,
  rejectedField,
  onPinChange,
  onWindowChange,
  onRemovePin,
  onRejectLeave,
}: CueRowProps): JSX.Element {
  // Withdraw the rejection banner only when the row truly leaves the virtual
  // list, not on every parent re-render: keep the latest callback in a ref and
  // run the cleanup once on unmount.
  const leaveRef = useRef(onRejectLeave);
  leaveRef.current = onRejectLeave;
  useEffect(() => () => leaveRef.current(), []);

  const delta = previewStart === null ? null : previewStart - base;
  const win = cueWindow(cue, DAY_MS);
  const outOfWindow =
    previewStart !== null &&
    (previewStart < win.earliest || previewStart > win.latest);

  return (
    <div
      className={
        'row' +
        (pinned ? ' pinned' : '') +
        (delta !== 0 && previewStart !== null ? ' moved' : '')
      }
      style={{
        transform: `translateY(${index * ROW_H}px)`,
        height: ROW_H,
      }}
    >
      <div className="idx">#{index}</div>
      <div className="times">
        <div className="text" title={cue.text}>
          {cue.text}
        </div>
        <div className="starts">
          <span className={overlapPrev ? 'bad' : ''}>
            基线 {fmtTime(base)}
          </span>
          <span className="dur">时长 {cue.duration} ms</span>
          <span className={outOfWindow ? 'bad' : 'window'}>
            窗口 [{fmtTime(win.earliest)}, {fmtTime(win.latest)}]
          </span>
          {previewStart !== null && (
            <span className={delta === 0 ? 'same' : 'shift'}>
              预览 {fmtTime(previewStart)}
              {delta !== 0 && (
                <em>
                  {' '}
                  {delta! > 0 ? '+' : ''}
                  {delta}
                </em>
              )}
            </span>
          )}
        </div>
      </div>
      <div className="lock">
        <label>
          固定起点
          <input
            data-testid={`pin-${index}`}
            type="number"
            min={0}
            max={DAY_MS}
            step={1}
            value={pinned ? pinValue : ''}
            placeholder="—"
            onChange={(e) => onPinChange(e.target.value)}
          />
        </label>
        <label>
          earliest
          <input
            data-testid={`earliest-${index}`}
            className={rejectedField === 'earliest' ? 'invalid' : ''}
            type="number"
            min={0}
            max={DAY_MS}
            step={1}
            value={cue.earliest ?? ''}
            placeholder="0"
            onChange={(e) => onWindowChange('earliest', e.target.value)}
          />
        </label>
        <label>
          latest
          <input
            data-testid={`latest-${index}`}
            className={rejectedField === 'latest' ? 'invalid' : ''}
            type="number"
            min={0}
            max={DAY_MS}
            step={1}
            value={cue.latest ?? ''}
            placeholder={String(DAY_MS)}
            onChange={(e) => onWindowChange('latest', e.target.value)}
          />
        </label>
        <button type="button" disabled={!pinned} onClick={onRemovePin}>
          解除
        </button>
      </div>
    </div>
  );
}

interface CueEditorProps {
  /** Pending spotting marker sent from the narration booth (time data only). */
  spotMarker?: SpotMarker | null;
  /** Dismisses the pending marker (consumed or discarded by the operator). */
  onClearSpotMarker?: () => void;
}

/**
 * Subtitle editing workspace. Kept as a standalone component so the narration
 * booth never imports or reads any cue data; the only thing arriving from the
 * booth is a spotting time marker.
 */
export function CueEditor({
  spotMarker = null,
  onClearSpotMarker,
}: CueEditorProps): JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pins, setPins] = useState<Map<number, number>>(new Map());
  const [importError, setImportError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [windowError, setWindowError] = useState<{
    index: number;
    field: WindowField;
    message: string;
  } | null>(null);

  // Revision identities: every import, adoption, pin change or accepted window
  // edit bumps the relevant revision, immediately invalidating an older plan.
  const [rev, setRev] = useState<RevisionId>({
    draftRev: 0,
    baseRev: 0,
    pinsRev: 0,
    windowsRev: 0,
  });
  const [plan, setPlan] = useState<RepairPlan | null>(null);
  const [planNotice, setPlanNotice] = useState<string | null>(null);

  // Spotting ("对点"): the pending marker arrives from the narration booth;
  // the operator picks a cue and the recording's offset against the program
  // timeline, then generates a rearrangement preview. A generated preview is
  // kept (and flagged 已过期) when the marker or any revision moves on, so
  // adoption itself re-checks the take session and subtitle revisions.
  const [alignCue, setAlignCue] = useState('');
  const [alignOffset, setAlignOffset] = useState('');
  const [alignResult, setAlignResult] = useState<AlignmentResult | null>(null);
  const [alignNotice, setAlignNotice] = useState<string | null>(null);

  const preview: Preview | null = useMemo(() => {
    if (!draft || importError) return null;
    const r = solve({ cues: draft.cues, base: draft.base, pins });
    return r.ok
      ? { kind: 'ready', starts: r.starts, cost: r.cost }
      : { kind: 'infeasible', result: r };
  }, [draft, pins, importError]);

  // Pure analysis: the preview below never touches pins, base or the error.
  const planStale =
    plan !== null &&
    !sameRevision(plan, {
      draftRev: rev.draftRev,
      baseRev: rev.baseRev,
      pinsRev: rev.pinsRev,
      windowsRev: rev.windowsRev,
    });

  const importText = (text: string): void => {
    const parsed = parseCues(text);
    if (!parsed.ok) {
      // Illegal import: drop the current preview, keep the last legal draft,
      // pins, windows and repair state untouched.
      setImportError(true);
      return;
    }
    setRev((r) => ({
      draftRev: r.draftRev + 1,
      baseRev: 0,
      pinsRev: 0,
      windowsRev: r.windowsRev + 1,
    }));
    setPlan(null);
    setPlanNotice(null);
    setImportError(false);
    setPins(new Map());
    setWindowError(null);
    setScrollTop(0);
    setDraft({
      cues: parsed.cues,
      base: parsed.cues.map((c) => c.start),
    });
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    importText(await file.text());
    if (fileRef.current) fileRef.current.value = '';
  };

  const setPin = (index: number, raw: string): void => {
    if (raw.trim() === '') {
      // Clearing the field removes the lock; entering a value re-pins. A
      // no-op clear (field already empty) changes nothing and must not retire
      // a generated plan.
      if (!pins.has(index)) return;
      setPins((prev) => {
        const next = new Map(prev);
        next.delete(index);
        return next;
      });
      bumpPins();
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > DAY_MS) return;
    // Re-entering the same value is not an add/remove/edit: leave revisions.
    if (pins.get(index) === value) return;
    setPins((prev) => {
      const next = new Map(prev);
      // One pin per cue; re-editing overwrites the previous value.
      next.set(index, value);
      return next;
    });
    bumpPins();
  };

  const bumpPins = (): void => {
    setRev((r) => ({ ...r, pinsRev: r.pinsRev + 1 }));
    setPlan(null);
    setPlanNotice(null);
  };

  const removePin = (index: number): void => {
    setPins((prev) => {
      const next = new Map(prev);
      next.delete(index);
      return next;
    });
    bumpPins();
  };

  // Returns whether the edit was accepted. A rejection mutates no state apart
  // from the rejection notice: cues, base, pins, revisions and any generated
  // plan stay exactly as they were, and the controlled input immediately shows
  // the still-confirmed boundary again.
  const editWindow = (index: number, field: WindowField, raw: string): boolean => {
    if (!draft) return false;
    const cue = draft.cues[index];
    const current = cueWindow(cue, DAY_MS);
    if (raw.trim() === '') {
      if (cue[field] === undefined) {
        setWindowError(null);
        return true;
      }
      const target: Cue = {
        ...cue,
        earliest: field === 'earliest' ? undefined : cue.earliest,
        latest: field === 'latest' ? undefined : cue.latest,
      };
      commitWindow(index, target);
      return true;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > DAY_MS) {
      setWindowError({
        index,
        field,
        message: '窗口边界必须是 0–86,400,000 内的整数。',
      });
      return false;
    }
    if (cue[field] === value) {
      setWindowError(null);
      return true;
    }

    const earliest = field === 'earliest' ? value : current.earliest;
    const latest = field === 'latest' ? value : current.latest;
    if (earliest > latest) {
      setWindowError({
        index,
        field,
        message: '窗口反序：earliest 不能晚于 latest；本次修改已拒绝。',
      });
      return false;
    }

    const target: Cue = {
      ...draft.cues[index],
      earliest: field === 'earliest' ? value : draft.cues[index].earliest,
      latest: field === 'latest' ? value : draft.cues[index].latest,
    };
    commitWindow(index, target);
    return true;
  };

  const commitWindow = (index: number, cue: Cue): void => {
    if (!draft) return;
    const cues = draft.cues.slice();
    cues[index] = cue;
    setDraft({ cues, base: draft.base });
    setWindowError(null);
    setRev((r) => ({ ...r, draftRev: r.draftRev + 1, windowsRev: r.windowsRev + 1 }));
    setPlan(null);
    setPlanNotice(null);
  };

  // Pure maximum-retention analysis; pins/base/current error stay untouched.
  const generateRepair = (): void => {
    if (!draft || preview?.kind !== 'infeasible') return;
    const analysis = analyzeMaxRetention({ cues: draft.cues, pins });
    const built = buildRepairPlan(analysis, rev);
    setPlan(built);
    if (built !== null) {
      setPlanNotice(null);
    } else if (analysis.kind === 'unrecoverable' && analysis.reason === 'WINDOWS_INFEASIBLE') {
      const at = analysis.conflictIndex;
      setPlanNotice(
        at === undefined
          ? '当前窗口本身不可行：解除固定点无法恢复，未生成修复方案。'
          : `窗口链在 cue #${at} 冲突：所需起点 ${analysis.requiredStart}，允许上界 ${analysis.allowedLatest}；解除固定点无法恢复。`,
      );
    } else if (analysis.kind === 'unrecoverable' && analysis.reason === 'INVALID_WINDOW') {
      setPlanNotice(`cue #${analysis.conflictIndex ?? '?'} 的窗口无效，未生成修复方案。`);
    } else {
      setPlanNotice('P[n−1] 超过全天：无法靠解除固定点恢复，未生成修复方案。');
    }
  };

  const applyPlan = (): void => {
    if (!plan) return;
    const result = applyRepair(plan, rev);
    if (!result.ok) {
      // Stale action: announce expiry without any partial modification.
      setPlanNotice('修复方案已过期（工作稿、基线或固定点已变更），未做任何修改。');
      return;
    }
    // One-shot replacement; the next render re-solves against the retained set.
    setPins(result.pins);
    setRev((r) => ({ ...r, pinsRev: r.pinsRev + 1 }));
    setPlan(null);
    setPlanNotice(null);
  };

  const adopt = (): void => {
    if (!draft || preview?.kind !== 'ready') return;
    // The adopted result becomes the baseline for the next round; pins stay
    // bound to cue indices so the operator can iterate on the same locks.
    setDraft({ cues: draft.cues, base: preview.starts });
    setRev((r) => ({ ...r, baseRev: r.baseRev + 1 }));
    setPlan(null);
    setPlanNotice(null);
  };

  // A ready spotting preview is adoptable only while the pending marker is
  // still the exact one it was generated from and no subtitle revision moved.
  const alignStale =
    alignResult?.kind === 'ready' &&
    (!spotMarker ||
      spotMarker.id !== alignResult.preview.markerId ||
      spotMarker.sessionId !== alignResult.preview.sessionId ||
      !sameRevision(alignResult.preview.rev, rev));

  /**
   * Build the spotting preview. Every failure path is reason-only: the
   * working draft, adopted baseline, pins, windows and revisions stay exactly
   * as they were.
   */
  const generateAlignment = (): void => {
    setAlignNotice(null);
    if (!spotMarker) return;
    if (!draft) {
      setAlignResult({
        kind: 'rejected',
        message: '尚未导入字幕工作稿，无法选择 cue。',
      });
      return;
    }
    const idx = Number(alignCue);
    if (alignCue.trim() === '' || !Number.isInteger(idx) || idx < 0 || idx >= draft.cues.length) {
      setAlignResult({
        kind: 'rejected',
        message: `cue 序号无效：请输入 0–${draft.cues.length - 1} 的整数。`,
      });
      return;
    }
    const offset = Number(alignOffset);
    if (alignOffset.trim() === '' || !Number.isInteger(offset)) {
      setAlignResult({
        kind: 'rejected',
        message: '偏移必须是整数毫秒（节目时间 = 录音时刻 + 偏移）。',
      });
      return;
    }
    const w = alignmentWindow(draft.cues[idx], spotMarker, offset);
    if (!w.ok) {
      setAlignResult({ kind: 'rejected', message: alignmentRejectionText(w) });
      return;
    }
    // Tentative window, solved against the current pins/baseline in memory
    // only — nothing commits unless the preview is adopted later.
    const cues = draft.cues.slice();
    cues[idx] = { ...draft.cues[idx], earliest: w.earliest, latest: w.latest };
    const r = solve({ cues, base: draft.base, pins });
    if (!r.ok) {
      setAlignResult({
        kind: 'rejected',
        message: `整体无解：${conflictText(r)}`,
      });
      return;
    }
    setAlignResult({
      kind: 'ready',
      preview: {
        markerId: spotMarker.id,
        sessionId: spotMarker.sessionId,
        cueIndex: idx,
        offsetMs: offset,
        earliest: w.earliest,
        latest: w.latest,
        starts: r.starts,
        cost: r.cost,
        rev,
      },
    });
  };

  /**
   * Adopt a spotting preview: re-check the take session and every subtitle
   * revision against the preview, then install the intersected window and the
   * solved starts in a single draft write. A stale preview changes nothing.
   */
  const adoptAlignment = (): void => {
    if (!draft || alignResult?.kind !== 'ready') return;
    const p = alignResult.preview;
    const fresh =
      spotMarker !== null &&
      spotMarker.id === p.markerId &&
      spotMarker.sessionId === p.sessionId &&
      sameRevision(p.rev, rev);
    if (!fresh) {
      setAlignNotice(
        '对点预览已过期（时间标记、工作稿、基线、固定点或窗口已变更），未做任何修改。',
      );
      return;
    }
    const cues = draft.cues.slice();
    cues[p.cueIndex] = {
      ...draft.cues[p.cueIndex],
      earliest: p.earliest,
      latest: p.latest,
    };
    // One atomic commit: the intersected window and the solved baseline move
    // together, so the window can never go live without its solution.
    setDraft({ cues, base: p.starts });
    setRev((r) => ({
      draftRev: r.draftRev + 1,
      baseRev: r.baseRev + 1,
      pinsRev: r.pinsRev,
      windowsRev: r.windowsRev + 1,
    }));
    setPlan(null);
    setPlanNotice(null);
    setAlignResult(null);
    setAlignNotice(null);
  };

  const downloadStarts = (starts: number[]): void => {
    if (!draft) return;
    const blob = new Blob([toCuesJson(draft.cues, starts)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cues.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAdopted = (): void => {
    if (!draft) return;
    downloadStarts(draft.base);
  };

  const visibleRange = (() => {
    if (!draft) return { from: 0, to: 0 };
    const from = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
    const to = Math.min(
      draft.cues.length,
      Math.ceil((scrollTop + LIST_H) / ROW_H) + 4,
    );
    return { from, to };
  })();

  return (
    <>
      <section className="toolbar">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button
          type="button"
          data-testid="adopt"
          disabled={!draft || preview?.kind !== 'ready'}
          onClick={adopt}
        >
          采纳为新基线
        </button>
        <button type="button" data-testid="download-base" disabled={!draft} onClick={downloadAdopted}>
          下载同结构 JSON
        </button>
        {draft && preview?.kind === 'ready' && (
          <button
            type="button"
            data-testid="download-preview"
            onClick={() => downloadStarts(preview.starts)}
          >
            下载预览结果
          </button>
        )}
        {draft && (
          <span className="meta">
            {draft.cues.length.toLocaleString()} 条 · 固定点 {pins.size} 个
          </span>
        )}
      </section>

      {importError && (
        <div className="banner error">
          INVALID_CUES — 导入非法，已清空预览；下方保留最近一次合法工作稿。
        </div>
      )}
      {!importError && draft && windowError && (
        <div className="banner error" data-testid="window-rejected">
          <span>
            WINDOW_REJECTED · cue #{windowError.index} {windowError.message}
          </span>
        </div>
      )}
      {!importError && draft && preview?.kind === 'infeasible' && (
        <div className="banner error">
          <span>{conflictText(preview.result)}</span>
          <button
            type="button"
            className="repair-btn"
            data-testid="generate-repair"
            onClick={generateRepair}
          >
            生成最大保留修复
          </button>
        </div>
      )}

      {draft && planNotice && (
        <div className="banner warn">
          <span>{planNotice}</span>
          <button
            type="button"
            className="repair-btn"
            onClick={() => setPlanNotice(null)}
          >
            知道了
          </button>
        </div>
      )}

      {draft && plan && (
        <div className={'banner repair' + (planStale ? ' stale' : '')}>
          <div className="repair-head">
            <span>
              最大保留修复 · 保留 {plan.retainedCount}/{plan.totalCount} 个固定点
              （解除 {plan.released.length} 个
              {plan.mandatoryReleased.length > 0
                ? `，其中越界必然解除 ${plan.mandatoryReleased.length} 个`
                : ''}
              ）
            </span>
            {planStale && <em className="stale-tag">已过期</em>}
          </div>
          <div className="repair-list" title="完整解除清单（cueIndex 升序）">
            完整解除清单：[
            {plan.released.length === 0 ? '无' : plan.released.join(', ')}]
          </div>
          <div className="repair-actions">
            <button
              type="button"
              className="repair-apply"
              data-testid="apply-repair"
              onClick={applyPlan}
            >
              {planStale ? '尝试应用（已过期）' : '应用修复（一次性替换固定点）'}
            </button>
          </div>
        </div>
      )}

      {!draft && !importError && (
        <div className="empty">
          导入根对象仅含 cues 的 JSON（1–20000 项；start 严格递增，duration
          1–60000，text 1–200 字符；可选整数 earliest/latest 闭区间）。
        </div>
      )}

      {spotMarker && (
        <section className="spot-panel" data-testid="spot-panel">
          <div className="spot-head">
            <span>
              对点标记 · take 会话 #{spotMarker.sessionId} · 录音内段落 [
              {spotMarker.markStartMs}, {spotMarker.markEndMs}] ms（take 时长{' '}
              {spotMarker.takeDurationMs} ms）
            </span>
            <button
              type="button"
              className="spot-dismiss"
              data-testid="spot-clear"
              onClick={() => {
                setAlignResult(null);
                setAlignNotice(null);
                onClearSpotMarker?.();
              }}
            >
              清除标记
            </button>
          </div>
          <div className="spot-form">
            <label>
              cue 序号
              <input
                data-testid="align-cue"
                type="number"
                min={0}
                max={draft ? draft.cues.length - 1 : 0}
                step={1}
                value={alignCue}
                placeholder="—"
                onChange={(e) => setAlignCue(e.target.value)}
              />
            </label>
            <label>
              录音相对节目时间轴的偏移 ms
              <input
                data-testid="align-offset"
                type="number"
                step={1}
                value={alignOffset}
                placeholder="0"
                onChange={(e) => setAlignOffset(e.target.value)}
              />
            </label>
            <button
              type="button"
              data-testid="align-generate"
              onClick={generateAlignment}
            >
              生成对点预览
            </button>
          </div>
          <p className="spot-hint">
            节目时间 = 录音时刻 + 偏移；系统取该 cue 可完整落入标记段的起始范围，与其现有
            earliest/latest 求交集后按现有固定点、全天边界与最小位移规则重排。
          </p>

          {alignResult?.kind === 'rejected' && (
            <div className="banner error" data-testid="align-rejected">
              <span>ALIGN_REJECTED · {alignResult.message}</span>
            </div>
          )}

          {alignNotice && (
            <div className="banner warn" data-testid="align-notice">
              <span>{alignNotice}</span>
              <button
                type="button"
                className="repair-btn"
                onClick={() => setAlignNotice(null)}
              >
                知道了
              </button>
            </div>
          )}

          {alignResult?.kind === 'ready' && (
            <div
              className={'banner repair' + (alignStale ? ' stale' : '')}
              data-testid="align-preview"
            >
              <div className="repair-head">
                <span>
                  对点预览 · cue #{alignResult.preview.cueIndex} 新窗口 [
                  {alignResult.preview.earliest},{' '}
                  {alignResult.preview.latest}] · 起点{' '}
                  {alignResult.preview.starts[alignResult.preview.cueIndex]} ·
                  相对已采纳稿绝对位移总和{' '}
                  {alignResult.preview.cost.toLocaleString()} ms
                </span>
                {alignStale && <em className="stale-tag">已过期</em>}
              </div>
              <div className="repair-actions">
                <button
                  type="button"
                  className="repair-apply"
                  data-testid="align-adopt"
                  onClick={adoptAlignment}
                >
                  {alignStale
                    ? '尝试采纳（已过期）'
                    : '采纳对点（窗口与起点一次性更新）'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {draft && (
        <>
          {preview?.kind === 'ready' && (
            <div className="banner ok">
              预览就绪 · 相对已采纳稿绝对位移总和{' '}
              {preview.cost.toLocaleString()} ms
            </div>
          )}
          <div
            className="list"
            data-testid="cue-list"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div
              className="list-inner"
              style={{ height: draft.cues.length * ROW_H }}
            >
              {Array.from(
                { length: visibleRange.to - visibleRange.from },
                (_, k) => {
                  const i = visibleRange.from + k;
                  return (
                    <CueRow
                      key={i}
                      index={i}
                      cue={draft.cues[i]}
                      base={draft.base[i]}
                      pinned={pins.has(i)}
                      pinValue={pins.get(i)}
                      previewStart={
                        preview?.kind === 'ready' ? preview.starts[i] : null
                      }
                      overlapPrev={
                        i > 0 &&
                        draft.base[i] < draft.base[i - 1] + draft.cues[i - 1].duration
                      }
                      rejectedField={
                        windowError?.index === i ? windowError.field : null
                      }
                      onPinChange={(raw) => setPin(i, raw)}
                      onWindowChange={(field, raw) => editWindow(i, field, raw)}
                      onRemovePin={() => removePin(i)}
                      onRejectLeave={() =>
                        setWindowError((w) =>
                          w !== null && w.index === i ? null : w,
                        )
                      }
                    />
                  );
                },
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
