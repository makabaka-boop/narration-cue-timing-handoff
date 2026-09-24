import { useRef, useState } from 'react';
import { CueEditor } from './CueEditor';
import { NarrationConsole } from './narration/NarrationConsole';
import type { NarrationMediaAdapter } from './narration/mediaAdapter';
import type { SpotMark, SpotMarker } from './solver/align';

type Tab = 'cues' | 'narration';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'cues', label: '字幕编辑' },
  { key: 'narration', label: '现场旁白采集' },
];

interface AppProps {
  /** Production leaves this unset; tests inject a fake media adapter. */
  narrationAdapter?: NarrationMediaAdapter;
}

export function App({ narrationAdapter }: AppProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('cues');
  // The pending spotting marker. Only time marks cross the workspace
  // boundary: the take URL stays owned by the recorder session and is revoked
  // by the booth's usual unmount/discard cleanup. Each send gets a fresh id,
  // so a re-recorded (or simply re-sent) marker retires earlier previews.
  const [spotMarker, setSpotMarker] = useState<SpotMarker | null>(null);
  const spotSeq = useRef(0);

  const sendSpot = (mark: SpotMark): void => {
    spotSeq.current += 1;
    setSpotMarker({ id: spotSeq.current, ...mark });
  };

  return (
    <div className="page">
      <header>
        <h1>字幕固定与去重叠</h1>
        <p className="sub">
          锁定少数字幕起点，求解器令固定项精确命中、全天内相邻不重叠，最小化相对已采纳稿的绝对位移总和；或切换到现场旁白采集，独立完成麦克风授权、录制、封装与复听，并把一句话在录音中的实际位置作为时间标记送回字幕对点。
        </p>
      </header>

      <nav className="tabs" role="tablist" aria-label="工作区切换">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={'tab' + (tab === t.key ? ' active' : '')}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/*
        The subtitle workspace stays mounted (hidden only) so an imported draft
        survives tab switches. The narration booth is mounted on demand:
        leaving it runs its unmount cleanup, which stops tracks, closes the
        audio graph and revokes the take URL — the sent marker is pure time
        data and survives on purpose.
      */}
      <div hidden={tab !== 'cues'}>
        <CueEditor
          spotMarker={spotMarker}
          onClearSpotMarker={() => setSpotMarker(null)}
        />
      </div>
      {tab === 'narration' && (
        <NarrationConsole adapter={narrationAdapter} onSpot={sendSpot} />
      )}
    </div>
  );
}
