// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react';
import { App } from './App';
import { CueEditor } from './CueEditor';
import { NarrationConsole } from './narration/NarrationConsole';
import { FakeMediaAdapter, flush } from './narration/fakeMediaAdapter';
import type { SpotMark, SpotMarker } from './solver/align';

const DAY = 86_400_000;

/** N legal strictly increasing cues (old three-field shape: no windows). */
function cuesJson(n: number): string {
  const cues = Array.from({ length: n }, (_, i) => ({
    start: i * 100,
    duration: 100,
    text: `cue ${i}`,
  }));
  return JSON.stringify({ cues });
}

async function importDocument(
  container: HTMLElement,
  json: string,
): Promise<void> {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File([json], 'cues.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.queryByText(/empty|导入根对象/)).toBeNull(),
  );
}

/** Capture the JSON of every triggered download while the stub is installed. */
function stubDownloads(): {
  blobs: () => Promise<string[]>;
  restore: () => void;
} {
  const created: Blob[] = [];
  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation((b: Blob | MediaSource) => {
      created.push(b as Blob);
      return 'blob:fake';
    });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function click(this: HTMLAnchorElement) {
      expect(this.href).toBeTruthy();
    });
  return {
    blobs: () => Promise.all(created.map((b) => b.text())),
    restore: () => {
      create.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
    },
  };
}

function marker(partial: Partial<SpotMarker> = {}): SpotMarker {
  return {
    id: 1,
    sessionId: 7,
    takeDurationMs: 10_000,
    markStartMs: 1_000,
    markEndMs: 3_000,
    ...partial,
  };
}

async function downloadBase(): Promise<{
  cues: Array<Record<string, unknown>>;
}> {
  const dl = stubDownloads();
  await act(async () => {
    fireEvent.click(screen.getByTestId('download-base'));
  });
  const [doc] = (await dl.blobs()).map((t) => JSON.parse(t));
  dl.restore();
  return doc;
}

async function setAlignmentInputs(cue: string, offset: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId('align-cue'), {
      target: { value: cue },
    });
    fireEvent.change(screen.getByTestId('align-offset'), {
      target: { value: offset },
    });
  });
}

async function generate(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('align-generate'));
  });
}

describe('CueEditor 对点面板 — 拒绝原因只显示、不改动工作稿与已采纳起点', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('标记倒序', async () => {
    const { container } = render(
      <CueEditor
        spotMarker={marker({ markStartMs: 3_000, markEndMs: 1_000 })}
      />,
    );
    await importDocument(container, cuesJson(4));
    await setAlignmentInputs('1', '5000');
    await generate();

    expect(screen.getByTestId('align-rejected').textContent).toContain(
      '标记倒序',
    );
    expect(screen.queryByTestId('align-preview')).toBeNull();
    const doc = await downloadBase();
    expect(doc.cues[1]).toEqual({ start: 100, duration: 100, text: 'cue 1' });
  });

  it('时长不足', async () => {
    const { container } = render(
      <CueEditor
        spotMarker={marker({ markStartMs: 1_000, markEndMs: 1_050 })}
      />,
    );
    await importDocument(container, cuesJson(4));
    await setAlignmentInputs('1', '5000');
    await generate();

    const banner = screen.getByTestId('align-rejected');
    expect(banner.textContent).toContain('时长不足');
    expect(banner.textContent).toContain('50 ms');
    const doc = await downloadBase();
    expect(doc.cues[1]).toEqual({ start: 100, duration: 100, text: 'cue 1' });
  });

  it('越过节目边界（负偏移与过大偏移两个方向）', async () => {
    const { container } = render(<CueEditor spotMarker={marker()} />);
    await importDocument(container, cuesJson(4));

    await setAlignmentInputs('1', '-5000');
    await generate();
    expect(screen.getByTestId('align-rejected').textContent).toContain(
      '越过节目边界',
    );

    await setAlignmentInputs('1', String(DAY));
    await generate();
    expect(screen.getByTestId('align-rejected').textContent).toContain(
      '越过节目边界',
    );

    const doc = await downloadBase();
    expect(doc.cues[1]).toEqual({ start: 100, duration: 100, text: 'cue 1' });
  });

  it('交集为空', async () => {
    const json = JSON.stringify({
      cues: [
        { start: 0, duration: 100, text: 'a' },
        { start: 100, duration: 100, text: 'b', latest: 1_000 },
        { start: 200, duration: 100, text: 'c' },
      ],
    });
    const { container } = render(<CueEditor spotMarker={marker()} />);
    await importDocument(container, json);
    // Fit range [6000, 7900] vs the cue's [0, 1000] window: no overlap.
    await setAlignmentInputs('1', '5000');
    await generate();

    const banner = screen.getByTestId('align-rejected');
    expect(banner.textContent).toContain('交集为空');
    expect(banner.textContent).toContain('[6000, 7900]');
    expect(banner.textContent).toContain('[0, 1000]');
    const doc = await downloadBase();
    expect(doc.cues[1]).toEqual({
      start: 100,
      duration: 100,
      text: 'b',
      latest: 1_000,
    });
  });

  it('非法 cue 序号与非法偏移', async () => {
    const { container } = render(<CueEditor spotMarker={marker()} />);
    await importDocument(container, cuesJson(4));

    await setAlignmentInputs('99', '5000');
    await generate();
    expect(screen.getByTestId('align-rejected').textContent).toContain(
      'cue 序号无效',
    );

    await setAlignmentInputs('1', '1.5');
    await generate();
    expect(screen.getByTestId('align-rejected').textContent).toContain(
      '偏移必须是整数',
    );

    const doc = await downloadBase();
    expect(doc.cues[1]).toEqual({ start: 100, duration: 100, text: 'cue 1' });
  });

  it('固定点冲突导致整体无解：只显示原因，窗口与固定点原样保留', async () => {
    const { container } = render(
      <CueEditor
        spotMarker={marker({ markStartMs: 50, markEndMs: 260 })}
      />,
    );
    await importDocument(container, cuesJson(3));

    // Pin cue #0 at 1200; the aligned window for cue #1 becomes [1050, 1160]
    // (offset 1000), which the pin's 1300 ms follow-on cannot meet.
    await act(async () => {
      fireEvent.change(screen.getByTestId('pin-0'), { target: { value: '1200' } });
    });
    await setAlignmentInputs('1', '1000');
    await generate();

    const banner = screen.getByTestId('align-rejected');
    expect(banner.textContent).toContain('整体无解');
    expect(banner.textContent).toContain('窗口链冲突');
    expect(screen.queryByTestId('align-preview')).toBeNull();

    // No partial mutation: the cue window fields and the pin are untouched.
    expect((screen.getByTestId('earliest-1') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('latest-1') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('pin-0') as HTMLInputElement).value).toBe('1200');
    const doc = await downloadBase();
    expect(doc.cues).toEqual([
      { start: 0, duration: 100, text: 'cue 0' },
      { start: 100, duration: 100, text: 'cue 1' },
      { start: 200, duration: 100, text: 'cue 2' },
    ]);
  });

  it('过期预览：修订变更后采纳被拒绝且无任何修改', async () => {
    const { container } = render(
      <CueEditor
        spotMarker={marker({ markStartMs: 200, markEndMs: 450 })}
      />,
    );
    await importDocument(container, cuesJson(4));
    await setAlignmentInputs('1', '5000');
    await generate();
    const preview = screen.getByTestId('align-preview');
    expect(preview.textContent).toContain('新窗口 [5200, 5350]');
    expect(preview.textContent).not.toContain('已过期');

    // Any revision bump (here a pin edit) retires the generated preview.
    await act(async () => {
      fireEvent.change(screen.getByTestId('pin-0'), { target: { value: '50' } });
    });
    expect(screen.getByTestId('align-preview').textContent).toContain('已过期');

    await act(async () => {
      fireEvent.click(screen.getByTestId('align-adopt'));
    });
    expect(screen.getByTestId('align-notice').textContent).toContain('已过期');

    // Nothing moved: no window installed, baseline unchanged, pin edit kept.
    const doc = await downloadBase();
    expect(doc.cues[1]).toEqual({ start: 100, duration: 100, text: 'cue 1' });
    expect(doc.cues[0]).toEqual({ start: 0, duration: 100, text: 'cue 0' });
    expect((screen.getByTestId('pin-0') as HTMLInputElement).value).toBe('50');
  });

  it('采纳对点：窗口与起点一次性更新，固定点保留', async () => {
    const { container } = render(
      <CueEditor spotMarker={marker({ markStartMs: 200, markEndMs: 450 })} />,
    );
    await importDocument(container, cuesJson(4));

    // A compatible pin participates in the spotting solve and survives.
    await act(async () => {
      fireEvent.change(screen.getByTestId('pin-0'), { target: { value: '0' } });
    });
    await setAlignmentInputs('1', '5000');
    await generate();

    const preview = screen.getByTestId('align-preview');
    expect(preview.textContent).toContain('cue #1');
    expect(preview.textContent).toContain('新窗口 [5200, 5350]');
    expect(preview.textContent).toContain('起点 5200');

    await act(async () => {
      fireEvent.click(screen.getByTestId('align-adopt'));
    });

    // One-shot commit: the intersected window and the solved baseline appear
    // together in the exported document.
    const doc = await downloadBase();
    expect(doc.cues).toEqual([
      { start: 0, duration: 100, text: 'cue 0' },
      { start: 5200, duration: 100, text: 'cue 1', earliest: 5200, latest: 5350 },
      { start: 5300, duration: 100, text: 'cue 2' },
      { start: 5400, duration: 100, text: 'cue 3' },
    ]);
    // Row inputs reflect the confirmed window; the pin survives adoption.
    expect((screen.getByTestId('earliest-1') as HTMLInputElement).value).toBe('5200');
    expect((screen.getByTestId('latest-1') as HTMLInputElement).value).toBe('5350');
    expect((screen.getByTestId('pin-0') as HTMLInputElement).value).toBe('0');
    // The preview is consumed; the marker stays for aligning further cues.
    expect(screen.queryByTestId('align-preview')).toBeNull();
    expect(screen.getByTestId('spot-panel')).toBeTruthy();
    // The main preview re-solves to a zero-cost ready state on the new base.
    expect(screen.getByText(/预览就绪/).textContent).toContain('0 ms');
  });

  it('清除标记后整个面板消失', async () => {
    const cleared: Array<null> = [];
    const { container, rerender } = render(
      <CueEditor
        spotMarker={marker()}
        onClearSpotMarker={() => cleared.push(null)}
      />,
    );
    await importDocument(container, cuesJson(2));
    expect(screen.getByTestId('spot-panel')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('spot-clear'));
    });
    expect(cleared).toHaveLength(1);
    rerender(<CueEditor spotMarker={null} />);
    expect(screen.queryByTestId('spot-panel')).toBeNull();
  });
});

describe('NarrationConsole 对点标记 — 只发送时间标记', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function driveToReview(adapter: FakeMediaAdapter): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByText('启用麦克风'));
      await flush();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('开始录制'));
    });
    await act(async () => {
      adapter.advance(1_500);
      fireEvent.click(screen.getByText('停止'));
      await flush();
    });
    expect(screen.getByText(/本条旁白已就绪/)).toBeTruthy();
  }

  it('发送的载荷只有时间字段，绝不包含媒体 URL', async () => {
    const adapter = new FakeMediaAdapter();
    const sent: SpotMark[] = [];
    render(
      <NarrationConsole adapter={adapter} onSpot={(m) => sent.push(m)} />,
    );
    await driveToReview(adapter);

    await act(async () => {
      fireEvent.change(screen.getByTestId('spot-start'), {
        target: { value: '200' },
      });
      fireEvent.change(screen.getByTestId('spot-end'), {
        target: { value: '450' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('spot-send'));
    });

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]).sort()).toEqual([
      'markEndMs',
      'markStartMs',
      'sessionId',
      'takeDurationMs',
    ]);
    expect(sent[0]).toEqual({
      sessionId: 1,
      takeDurationMs: 1_500,
      markStartMs: 200,
      markEndMs: 450,
    });
    expect(JSON.stringify(sent[0])).not.toContain('blob:');
    expect(screen.getByTestId('spot-feedback').textContent).toContain('已发送');
  });

  it('非整数或超出 take 时长的标记在本地被拒绝，不发送', async () => {
    const adapter = new FakeMediaAdapter();
    const sent: SpotMark[] = [];
    render(
      <NarrationConsole adapter={adapter} onSpot={(m) => sent.push(m)} />,
    );
    await driveToReview(adapter);

    await act(async () => {
      fireEvent.change(screen.getByTestId('spot-start'), {
        target: { value: '1.5' },
      });
      fireEvent.change(screen.getByTestId('spot-end'), {
        target: { value: '450' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('spot-send'));
    });
    expect(sent).toHaveLength(0);
    expect(screen.getByTestId('spot-feedback').textContent).toContain(
      '整数毫秒',
    );

    await act(async () => {
      fireEvent.change(screen.getByTestId('spot-start'), {
        target: { value: '200' },
      });
      fireEvent.change(screen.getByTestId('spot-end'), {
        target: { value: '1501' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('spot-send'));
    });
    expect(sent).toHaveLength(0);
  });

  it('未接入对点回调的录音台不渲染标记区，复听流程保持不变', async () => {
    const adapter = new FakeMediaAdapter();
    render(<NarrationConsole adapter={adapter} />);
    await driveToReview(adapter);
    expect(screen.queryByTestId('spot-section')).toBeNull();
    expect(screen.getByText('废弃重来')).toBeTruthy();
  });
});

describe('App 对点集成 — 跨工作区只传递时间标记', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function switchTab(name: string): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name }));
    });
  }

  async function recordTake(
    adapter: FakeMediaAdapter,
    ms: number,
  ): Promise<void> {
    await switchTab('现场旁白采集');
    await act(async () => {
      fireEvent.click(screen.getByText('启用麦克风'));
      await flush();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('开始录制'));
    });
    await act(async () => {
      adapter.advance(ms);
      fireEvent.click(screen.getByText('停止'));
      await flush();
    });
    expect(screen.getByText(/本条旁白已就绪/)).toBeTruthy();
  }

  async function sendMark(start: string, end: string): Promise<void> {
    await act(async () => {
      fireEvent.change(screen.getByTestId('spot-start'), {
        target: { value: start },
      });
      fireEvent.change(screen.getByTestId('spot-end'), {
        target: { value: end },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('spot-send'));
    });
  }

  it('切换页签：离开录音台按原机制释放资源，时间标记保留并完成采纳', async () => {
    const adapter = new FakeMediaAdapter();
    const { container } = render(<App narrationAdapter={adapter} />);
    await importDocument(container, cuesJson(4));

    await recordTake(adapter, 1_500);
    await sendMark('200', '450');
    expect(adapter.createdUrls).toHaveLength(1);
    expect(adapter.revokedUrls).toHaveLength(0);

    // Leaving the booth unmounts it: the take URL is revoked, tracks stopped
    // and the audio graph closed — exactly the pre-existing mechanism.
    await switchTab('字幕编辑');
    expect(adapter.revokedUrls).toEqual(adapter.createdUrls);
    expect(adapter.tracks[0].readyState).toBe('ended');
    expect(adapter.graphs[0].closed).toBe(true);

    // The pure time marker survived the teardown and drives the alignment.
    const panel = screen.getByTestId('spot-panel');
    expect(panel.textContent).toContain('take 会话 #1');
    expect(panel.textContent).toContain('[200, 450]');

    await setAlignmentInputs('1', '5000');
    await generate();
    expect(screen.getByTestId('align-preview').textContent).toContain(
      '新窗口 [5200, 5350]',
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-adopt'));
    });
    const doc = await downloadBase();
    expect(doc.cues[1]).toEqual({
      start: 5200,
      duration: 100,
      text: 'cue 1',
      earliest: 5200,
      latest: 5350,
    });
    expect(doc.cues[2]).toEqual({ start: 5300, duration: 100, text: 'cue 2' });
  });

  it('重录：新标记作废旧预览，采纳时核对 take 会话', async () => {
    const adapter = new FakeMediaAdapter();
    const { container } = render(<App narrationAdapter={adapter} />);
    await importDocument(container, cuesJson(4));

    // Take 1: mark and generate a spotting preview in the subtitle workspace.
    await recordTake(adapter, 1_500);
    await sendMark('200', '450');
    await switchTab('字幕编辑');
    await setAlignmentInputs('1', '5000');
    await generate();
    expect(
      screen.getByTestId('align-preview').textContent,
    ).not.toContain('已过期');

    // Re-record: the booth remounts fresh, take 2 gets marked and sent.
    await recordTake(adapter, 800);
    await sendMark('100', '400');
    await switchTab('字幕编辑');

    // The old preview is still displayed but flagged stale; adopting it is
    // refused without touching the draft, and the reason is shown.
    expect(screen.getByTestId('align-preview').textContent).toContain('已过期');
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-adopt'));
    });
    expect(screen.getByTestId('align-notice').textContent).toContain('已过期');
    let doc = await downloadBase();
    expect(doc.cues[1]).toEqual({ start: 100, duration: 100, text: 'cue 1' });

    // Regenerating against the new marker yields a fresh, adoptable preview.
    await generate();
    const preview = screen.getByTestId('align-preview');
    expect(preview.textContent).not.toContain('已过期');
    expect(preview.textContent).toContain('新窗口 [5100, 5300]');
    await act(async () => {
      fireEvent.click(screen.getByTestId('align-adopt'));
    });
    doc = await downloadBase();
    expect(doc.cues[1]).toEqual({
      start: 5100,
      duration: 100,
      text: 'cue 1',
      earliest: 5100,
      latest: 5300,
    });
    expect(doc.cues[3]).toEqual({ start: 5300, duration: 100, text: 'cue 3' });

    // Both takes' URLs stayed owned by the booth and were revoked on unmount.
    expect(adapter.revokedUrls.sort()).toEqual(adapter.createdUrls.sort());
  });

  it('未使用对点功能：不发送标记时字幕工作区无对点面板', async () => {
    const adapter = new FakeMediaAdapter();
    const { container } = render(<App narrationAdapter={adapter} />);
    await importDocument(container, cuesJson(2));
    await recordTake(adapter, 500);
    await switchTab('字幕编辑');
    expect(screen.queryByTestId('spot-panel')).toBeNull();
    // The ordinary subtitle flow is untouched.
    expect(screen.getByTestId('adopt')).toBeTruthy();
  });
});
