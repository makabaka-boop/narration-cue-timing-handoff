import { useMemo, useState } from 'react';
import { createBrowserAdapter } from './browserAdapter';
import { useNarrationRecorder } from './useNarrationRecorder';
import type { NarrationMediaAdapter } from './mediaAdapter';
import type { NarrationPhase, NarrationTake } from './NarrationRecorder';
import type { TakeMark } from '../solver/pointMatch';
import { ERROR_TEXT, formatDuration } from './labels';

const STEPS: Array<{ key: NarrationPhase; label: string }> = [
  { key: 'requesting', label: '请求授权' },
  { key: 'armed', label: '待录' },
  { key: 'recording', label: '录制' },
  { key: 'packaging', label: '封装' },
  { key: 'review', label: '复听' },
];

function stepIndex(phase: NarrationPhase): number {
  const i = STEPS.findIndex((s) => s.key === phase);
  return i;
}

interface NarrationConsoleProps {
  /** Production injects the real browser adapter; tests a fake one. */
  adapter?: NarrationMediaAdapter;
  /**
   * Called with timing-only marks the operator hands to the subtitle
   * workspace, or with null when the current take is discarded/completed.
   * The take object URL is never included: its ownership stays with this
   * booth and is revoked through the existing teardown paths.
   */
  onTakeMark?: (mark: TakeMark | null) => void;
}

interface MarkFormProps {
  take: NarrationTake;
  onSend: (mark: TakeMark) => void;
}

/**
 * Sentence marker shown while a sealed take can be re-listened. Only integer
 * millisecond marks inside the take with start strictly before end are
 * accepted; the marker hands timing numbers across to the subtitle workspace
 * but keeps the media URL here.
 */
function MarkForm({ take, onSend }: MarkFormProps): JSX.Element {
  const [rawStart, setRawStart] = useState('');
  const [rawEnd, setRawEnd] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const submit = (): void => {
    const a = Number(rawStart);
    const b = Number(rawEnd);
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      a < 0 ||
      b < 0 ||
      a > take.durationMs ||
      b > take.durationMs
    ) {
      setNotice(
        `起止必须是 0–${take.durationMs} 内的整数毫秒（take 时长）。`,
      );
      return;
    }
    if (a >= b) {
      setNotice('标记倒序：句子起点必须早于终点。');
      return;
    }
    setNotice(null);
    onSend({
      sessionId: take.sessionId,
      takeUid: take.takeUid,
      markStartMs: a,
      markEndMs: b,
      takeDurationMs: take.durationMs,
    });
  };

  return (
    <div className="mark-form">
      <p className="mark-title">对点：标记这句话在录音中的起止毫秒（可复听后填写）</p>
      <label>
        起
        <input
          data-testid="mark-start"
          type="number"
          min={0}
          max={take.durationMs}
          step={1}
          value={rawStart}
          placeholder="0"
          onChange={(e) => setRawStart(e.target.value)}
        />
      </label>
      <label>
        止
        <input
          data-testid="mark-end"
          type="number"
          min={0}
          max={take.durationMs}
          step={1}
          value={rawEnd}
          placeholder={String(take.durationMs)}
          onChange={(e) => setRawEnd(e.target.value)}
        />
      </label>
      <button type="button" data-testid="mark-send" onClick={submit}>
        把时间标记送到字幕页
      </button>
      {notice && (
        <div className="mark-notice" data-testid="mark-error">
          {notice}
        </div>
      )}
    </div>
  );
}

/**
 * Live narration booth. Fully independent of the subtitle editor: it neither
 * imports nor reads any cue data — its only input is the microphone. The sole
 * outbound datum is a timing-only TakeMark (never the take URL).
 */
export function NarrationConsole({
  adapter,
  onTakeMark,
}: NarrationConsoleProps): JSX.Element {
  // The adapter is a stable module-level singleton in production; useMemo
  // guarantees the hook's effect does not recreate controllers on re-render.
  const media = useMemo(() => adapter ?? createBrowserAdapter(), [adapter]);
  const { state, enable, start, stop, discard, reset } =
    useNarrationRecorder(media);
  const { phase, errorCode, level, elapsedMs, take } = state;
  const [sentUid, setSentUid] = useState<number | null>(null);

  const activeStep = stepIndex(phase);
  const busy = phase === 'requesting' || phase === 'packaging';

  const sendMark = (mark: TakeMark): void => {
    // Hand across timing numbers only; the booth keeps the object URL.
    onTakeMark?.(mark);
    setSentUid(mark.takeUid);
  };

  const finishTake = (): void => {
    // 完成：现有机制关闭会话并释放 take URL。已经送到字幕页的只是毫秒数字，
    // 交付后不随 booth 关闭而撤回；未使用对点时本来就没有标记。
    setSentUid(null);
    reset();
  };

  const redoTake = (): void => {
    // 废弃重来：take URL 由录音台撤销，跨工作区只撤回时间标记本身。
    onTakeMark?.(null);
    setSentUid(null);
    discard();
  };

  return (
    <div className="booth">
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className={
              i === activeStep
                ? 'current'
                : activeStep >= 0 && i < activeStep
                  ? 'done'
                  : ''
            }
          >
            <span className="dot" />
            {s.label}
          </li>
        ))}
      </ol>

      <div className="booth-panel">
        {phase === 'idle' && (
          <div className="booth-idle">
            <p>
              现场旁白采集使用独立的麦克风会话，不读取任何字幕数据。点击下方
              按钮由你主动授权麦克风后开始。
            </p>
            <button type="button" className="primary" onClick={enable}>
              启用麦克风
            </button>
          </div>
        )}

        {phase === 'requesting' && (
          <div className="booth-status">
            <span className="spinner" aria-hidden="true" />
            正在请求麦克风授权…
          </div>
        )}

        {(phase === 'armed' ||
          phase === 'recording' ||
          phase === 'packaging') && (
          <div className="booth-rec">
            <div className="rec-readout">
              <span
                className={
                  'rec-dot' + (phase === 'recording' ? ' live' : '')
                }
                aria-hidden="true"
              />
              <span className="rec-time">{formatDuration(elapsedMs)}</span>
              {phase === 'armed' && <span className="rec-hint">待录</span>}
              {phase === 'recording' && (
                <span className="rec-hint">正在录制</span>
              )}
              {phase === 'packaging' && (
                <span className="rec-hint">封装中…</span>
              )}
            </div>
            <div
              className="meter"
              aria-label="输入电平"
              aria-valuenow={Math.round(level * 100)}
              role="progressbar"
            >
              <div
                className="meter-fill"
                style={{
                  width: `${Math.round(level * 100)}%`,
                }}
              />
            </div>
            <div className="rec-actions">
              {phase === 'armed' && (
                <button type="button" className="primary" onClick={start}>
                  开始录制
                </button>
              )}
              {phase === 'recording' && (
                <button type="button" className="danger" onClick={stop}>
                  停止
                </button>
              )}
              {phase === 'packaging' && (
                <button type="button" disabled>
                  封装中…
                </button>
              )}
              {!busy && (
                <button type="button" onClick={reset}>
                  取消
                </button>
              )}
            </div>
          </div>
        )}

        {phase === 'review' && take && (
          <div className="booth-review">
            <p className="review-title">本条旁白已就绪，请复听确认：</p>
            <audio className="review-player" controls src={take.url} />
            <dl className="review-meta">
              <dt>时长</dt>
              <dd>{formatDuration(take.durationMs)}</dd>
              <dt>大小</dt>
              <dd>{take.size.toLocaleString()} B</dd>
              <dt>格式</dt>
              <dd>{take.mimeType || '平台默认'}</dd>
            </dl>
            <MarkForm take={take} onSend={sendMark} />
            {sentUid === take.takeUid && (
              <div className="mark-sent" data-testid="mark-sent">
                时间标记已送到字幕页（仅毫秒位置，不携带音频地址）。
              </div>
            )}
            <div className="rec-actions">
              <button
                type="button"
                className="danger"
                data-testid="discard-take"
                onClick={redoTake}
              >
                废弃重来
              </button>
              <button type="button" data-testid="finish-take" onClick={finishTake}>
                完成，关闭麦克风
              </button>
            </div>
          </div>
        )}

        {phase === 'error' && errorCode && (
          <div className="booth-error">
            <p className="error-code">{errorCode}</p>
            <p className="error-msg">{ERROR_TEXT[errorCode]}</p>
            <div className="rec-actions">
              <button type="button" className="primary" onClick={enable}>
                重试
              </button>
              <button type="button" onClick={reset}>
                返回
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
