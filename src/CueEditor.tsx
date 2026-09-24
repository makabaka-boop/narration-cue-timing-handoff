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
  applyPointMatch,
  buildPointMatchPlan,
  previewPointMatch,
  POINT_MATCH_REASON_TEXT,
  type PointMatchAnalysis,
  type PointMatchPlan,
  type TakeMark,
} from './solver/pointMatch';

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

interface PointMatchPanelProps {
  cueCount: number;
  mark: TakeMark | null;
  onPreview: (cueIndex: number, offset: number) => void;
  analysis: PointMatchAnalysis | null;
  plan: PointMatchPlan | null;
  stale: boolean;
  notice: string | null;
  onApply: () => void;
  onDismiss: () => void;
}

/**
 * Narration point-matching panel. The operator picks one cue and states the
 * integer offset of the recording timeline relative to the program timeline;
 * the preview intersects the marked feasible range with the cue's current
 * window and re-solves. Generation never edits the draft: adoption is the
 * only mutating action and is re-checked against the take session and every
 * subtitle revision before a single atomic commit.
 */
function PointMatchPanel({
  cueCount,
  mark,
  onPreview,
  analysis,
  plan,
  stale,
  notice,
  onApply,
  onDismiss,
}: PointMatchPanelProps): JSX.Element {
  const [cueRaw, setCueRaw] = useState('');
  const [offsetRaw, setOffsetRaw] = useState('0');
  const [inputError, setInputError] = useState<string | null>(null);

  const generate = (): void => {
    if (!mark) {
      setInputError('还没有收到录音时间标记：请先在复听的 take 上标记句子并送到字幕页。');
      return;
    }
    const cueIndex = Number(cueRaw);
    const offset = Number(offsetRaw);
    if (!Number.isInteger(cueIndex) || cueIndex < 0 || cueIndex >= cueCount) {
      setInputError(`cue 序号必须是 0–${cueCount - 1} 内的整数。`);
      return;
    }
    if (!Number.isInteger(offset)) {
      setInputError('录音相对节目时间轴的偏移必须是整数毫秒。');
      return;
    }
    setInputError(null);
    onPreview(cueIndex, offset);
  };

  return (
    <section className="pointmatch" data-testid="pointmatch">
      <h2>录音对点</h2>
      {!mark ? (
        <p className="pm-empty">
          尚无时间标记。切到「现场旁白采集」，在已封装、可复听的 take
          上标记一句话的起止毫秒后送到本页；跨工作区只传递时间标记，不转移音频地址。
        </p>
      ) : (
        <>
          <p className="pm-mark" data-testid="pm-mark">
            take #{mark.takeUid}（录音会话 {mark.sessionId}）· 录音标记段{' '}
            [{mark.markStartMs}, {mark.markEndMs}) ms · take 时长{' '}
            {mark.takeDurationMs} ms
          </p>
          <div className="pm-form">
            <label>
              cue 序号
              <input
                data-testid="pm-cue"
                type="number"
                min={0}
                max={cueCount - 1}
                step={1}
                value={cueRaw}
                placeholder={`0–${cueCount - 1}`}
                onChange={(e) => setCueRaw(e.target.value)}
              />
            </label>
            <label>
              录音→节目偏移 (ms)
              <input
                data-testid="pm-offset"
                type="number"
                step={1}
                value={offsetRaw}
                onChange={(e) => setOffsetRaw(e.target.value)}
              />
            </label>
            <button
              type="button"
              data-testid="pm-preview"
              className="primary"
              onClick={generate}
            >
              生成对点重排预览
            </button>
          </div>

          {inputError && (
            <div className="banner error" data-testid="pm-input-error">
              {inputError}
            </div>
          )}
          {notice && (
            <div className="banner warn" data-testid="pm-notice">
              <span>{notice}</span>
              <button type="button" className="repair-btn" onClick={onDismiss}>
                知道了
              </button>
            </div>
          )}

          {analysis?.kind === 'rejected' && (
            <div className="banner error" data-testid="pm-rejected">
              对点未执行 · {POINT_MATCH_REASON_TEXT[analysis.reason]}
              {analysis.detail ? ` ${analysis.detail}` : ''}
              字幕工作稿与已采纳起点均未改动。
            </div>
          )}
          {analysis?.kind === 'no-solution' && (
            <div className="banner error" data-testid="pm-nosolution">
              <span>{conflictText(analysis.result)}</span>
              <span> 整体无解：仅显示原因，未改动窗口、起点或固定点。</span>
            </div>
          )}

          {/*
            A ready plan stays on screen after a revision/take change and is
            marked 已过期 (like the repair plan): the matching analysis is
            cleared, but the plan itself remains inspectable and its adoption
            is refused atomically at click time.
          */}
          {plan && (
            <div
              className={'banner repair' + (stale ? ' stale' : '')}
              data-testid="pm-plan"
            >
              <div className="repair-head">
                <span>
                  对点预览 · cue #{plan.cueIndex} 窗口收窄为 [
                  {plan.window.earliest}, {plan.window.latest}] · 预览位移总和{' '}
                  {plan.cost.toLocaleString()} ms · 新起点{' '}
                  {fmtTime(plan.starts[plan.cueIndex])}
                </span>
                {stale && <em className="stale-tag">已过期</em>}
              </div>
              <div className="repair-actions">
                <button
                  type="button"
                  className="repair-apply"
                  data-testid="pm-apply"
                  onClick={onApply}
                >
                  {stale
                    ? '尝试采纳（已过期）'
                    : '采纳（窗口与起点一次性更新）'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
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

/**
 * Subtitle editing workspace. Kept as a standalone component so the narration
 * booth never imports or reads any cue data. The only inbound cross-workspace
 * datum is an optional timing-only `mark`.
 */
export function CueEditor({ mark }: { mark?: TakeMark | null }): JSX.Element {
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

  // Narration point-match preview state. Analysis is a pure snapshot; nothing
  // it describes is installed until an identity-checked, atomic adoption.
  const [pointAnalysis, setPointAnalysis] =
    useState<PointMatchAnalysis | null>(null);
  const [pointPlan, setPointPlan] = useState<PointMatchPlan | null>(null);
  const [pointNotice, setPointNotice] = useState<string | null>(null);

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

  // A point-match preview is valid only against the exact take session AND the
  // exact subtitle revisions it was generated with.
  const pointStale =
    pointPlan !== null &&
    (!sameRevision(pointPlan, rev) || mark?.takeUid !== pointPlan.takeUid);

  /**
   * Retire any point-match preview on EVERY draft/base/pin/window revision
   * bump. Retirement lives in a revKey-keyed effect (not in each handler) so
   * it cannot be reordered against other setStates queued in the same event:
   * an action that bumps a revision and regenerates a preview in one tick
   * observes the bump first, and the fresh preview is built for the new
   * revisions. Comparing against the previously committed key (rather than a
   * one-shot guard) is robust to StrictMode's setup→cleanup→setup effect
   * double-run, which sees an unchanged key and retires nothing.
   */
  const revKey = `${rev.draftRev}:${rev.baseRev}:${rev.pinsRev}:${rev.windowsRev}`;
  const prevRevKey = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRevKey.current;
    prevRevKey.current = revKey;
    if (prev === null || prev === revKey) return; // mount or unchanged re-run
    // A revision bump invalidates a preview: retire the *analysis* banner
    // (rejected/no-solution/ready reasons). A ready plan is deliberately kept
    // and marked 已过期, mirroring the repair plan: the operator can still see
    // what was proposed, and adoption is refused atomically at click time.
    setPointAnalysis(null);
    setPointNotice(null);
  }, [revKey]);

  const generatePoint = (cueIndex: number, offset: number): void => {
    if (!draft) return;
    const analysis = previewPointMatch({
      cues: draft.cues,
      base: draft.base,
      pins,
      mark: mark ?? null,
      cueIndex,
      offset,
    });
    setPointAnalysis(analysis);
    setPointNotice(null);
    // Only a feasible preview can be adopted; rejected/no-solution analyses
    // are reasons-only and never carry state changes.
    setPointPlan(
      analysis.kind === 'ready' ? buildPointMatchPlan(analysis, rev) : null,
    );
  };

  const applyPoint = (): void => {
    if (!draft || !pointPlan) return;
    const result = applyPointMatch(pointPlan, rev, mark?.takeUid ?? null);
    if (!result.ok) {
      // Stale take session or stale subtitle revisions: announce expiry and
      // perform no partial modification.
      setPointNotice(
        '对点预览已过期（take 会话或字幕修订版本已变更），窗口与起点均未改动。',
      );
      return;
    }
    // Re-derive the target window from the live cue right before committing:
    // the plan guarantees revisions are unchanged, this is a belt-and-braces
    // check that the cue still exists at the planned index.
    const target: Cue = {
      ...draft.cues[result.cueIndex],
      earliest: result.window.earliest,
      latest: result.window.latest,
    };
    const cues = draft.cues.slice();
    cues[result.cueIndex] = target;
    // One atomic update: window and starts are installed together. There is no
    // intermediate render where the window changed but the solve failed.
    setDraft({ cues, base: result.starts });
    setRev((r) => ({
      ...r,
      draftRev: r.draftRev + 1,
      baseRev: r.baseRev + 1,
      windowsRev: r.windowsRev + 1,
    }));
    setPlan(null);
    setPlanNotice(null);
    setPointAnalysis(null);
    setPointPlan(null);
    setPointNotice(null);
  };

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
    // A new document cannot carry a point-match preview built for the old one.
    setPointAnalysis(null);
    setPointPlan(null);
    setPointNotice(null);
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

      {!importError && draft && (
        <PointMatchPanel
          cueCount={draft.cues.length}
          mark={mark ?? null}
          onPreview={generatePoint}
          analysis={pointAnalysis}
          plan={pointPlan}
          stale={pointStale}
          notice={pointNotice}
          onApply={applyPoint}
          onDismiss={() => setPointNotice(null)}
        />
      )}

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
