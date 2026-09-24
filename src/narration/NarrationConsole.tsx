import { useMemo, useState } from 'react';
import { createBrowserAdapter } from './browserAdapter';
import { useNarrationRecorder } from './useNarrationRecorder';
import type { NarrationMediaAdapter } from './mediaAdapter';
import type { NarrationPhase, NarrationTake } from './NarrationRecorder';
import type { SpotMark } from '../solver/align';
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
   * Spotting sink: receives the take-relative sentence marks the operator
   * confirms on a reviewable take. Only time marks are handed over — the
   * take URL keeps its single owner (this console's recorder session).
   */
  onSpot?: (mark: SpotMark) => void;
}

interface SpotSectionProps {
  take: NarrationTake;
  onSpot: (mark: SpotMark) => void;
}

/**
 * Mark a sentence's take-relative start/end on the finished take and send the
 * time marker to the subtitle workspace. Inputs are keyed by take session (the
 * parent sets `key={take.sessionId}`), so a re-record starts with blank
 * fields. Validation here is only "integer milliseconds inside the take";
 * whether the marks can actually constrain a cue (reversed, too short, …) is
 * decided by the subtitle workspace when it generates the spotting preview.
 */
function SpotSection({ take, onSpot }: SpotSectionProps): JSX.Element {
  const [startRaw, setStartRaw] = useState('');
  const [endRaw, setEndRaw] = useState('');
  const [feedback, setFeedback] = useState<{
    kind: 'error' | 'sent';
    text: string;
  } | null>(null);

  const send = (): void => {
    const s = Number(startRaw);
    const e = Number(endRaw);
    if (
      startRaw.trim() === '' ||
      endRaw.trim() === '' ||
      !Number.isInteger(s) ||
      !Number.isInteger(e) ||
      s < 0 ||
      e < 0 ||
      s > take.durationMs ||
      e > take.durationMs
    ) {
      setFeedback({
        kind: 'error',
        text: `标记必须是 0–${take.durationMs} 内的整数毫秒（本条 take 时长 ${take.durationMs} ms）。`,
      });
      return;
    }
    onSpot({
      sessionId: take.sessionId,
      takeDurationMs: take.durationMs,
      markStartMs: s,
      markEndMs: e,
    });
    setFeedback({
      kind: 'sent',
      text: '已发送到字幕工作区（仅时间标记；音频仍由录音台管理，离开本页即释放）。',
    });
  };

  return (
    <div className="spot-section" data-testid="spot-section">
      <p className="spot-title">对点标记（本句在录音中的起止毫秒）</p>
      <div className="spot-fields">
        <label>
          起点 ms
          <input
            data-testid="spot-start"
            type="number"
            min={0}
            max={take.durationMs}
            step={1}
            value={startRaw}
            placeholder="0"
            onChange={(e) => {
              setStartRaw(e.target.value);
              setFeedback(null);
            }}
          />
        </label>
        <label>
          终点 ms
          <input
            data-testid="spot-end"
            type="number"
            min={0}
            max={take.durationMs}
            step={1}
            value={endRaw}
            placeholder={String(take.durationMs)}
            onChange={(e) => {
              setEndRaw(e.target.value);
              setFeedback(null);
            }}
          />
        </label>
        <button type="button" data-testid="spot-send" onClick={send}>
          发送到字幕对点
        </button>
      </div>
      {feedback && (
        <p
          className={feedback.kind === 'error' ? 'spot-error' : 'spot-sent'}
          data-testid="spot-feedback"
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
}

/**
 * Live narration booth. Fully independent of the subtitle editor: it neither
 * imports nor reads any cue data — its only input is the microphone, and its
 * only output (when `onSpot` is wired) is a spotting time marker.
 */
export function NarrationConsole({
  adapter,
  onSpot,
}: NarrationConsoleProps): JSX.Element {
  // The adapter is a stable module-level singleton in production; useMemo
  // guarantees the hook's effect does not recreate controllers on re-render.
  const media = useMemo(() => adapter ?? createBrowserAdapter(), [adapter]);
  const { state, enable, start, stop, discard, reset } =
    useNarrationRecorder(media);
  const { phase, errorCode, level, elapsedMs, take } = state;

  const activeStep = stepIndex(phase);
  const busy = phase === 'requesting' || phase === 'packaging';

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
            <div className="rec-actions">
              <button type="button" className="danger" onClick={discard}>
                废弃重来
              </button>
              <button type="button" onClick={reset}>
                完成，关闭麦克风
              </button>
            </div>
            {onSpot && <SpotSection key={take.sessionId} take={take} onSpot={onSpot} />}
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
