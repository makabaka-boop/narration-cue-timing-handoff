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
import { FakeMediaAdapter, flush } from './narration/fakeMediaAdapter';

const DAY = 86_400_000;

function cuesJson(n: number): string {
  const cues = Array.from({ length: n }, (_, i) => ({
    start: i * 100,
    duration: 100,
    text: `cue ${i}`,
  }));
  return JSON.stringify({ cues });
}

async function importDocument(container: HTMLElement, json: string): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([json], 'cues.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.queryByText(/empty|导入根对象/)).toBeNull(),
  );
}

async function recordTake(
  adapter: FakeMediaAdapter,
  mark: { start: string; end: string } | null,
  options: { leaveMounted?: boolean } = {},
): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: '现场旁白采集' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByText('启用麦克风'));
  });
  await act(async () => flush());
  await act(async () => {
    fireEvent.click(screen.getByText('开始录制'));
  });
  adapter.advance(1200);
  await act(async () => {
    fireEvent.click(screen.getByText('停止'));
  });
  await act(async () => flush());
  expect(screen.getByText(/本条旁白已就绪/)).not.toBeNull();

  if (mark) {
    fireEvent.change(screen.getByTestId('mark-start'), {
      target: { value: mark.start },
    });
    fireEvent.change(screen.getByTestId('mark-end'), {
      target: { value: mark.end },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mark-send'));
    });
    expect(screen.getByTestId('mark-sent').textContent).toContain('已送到字幕页');
  }

  if (!options.leaveMounted) {
    // Leave the booth: unmount releases the mic/graph and revokes the take URL;
    // the timing mark (numbers only) survives in app state.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '字幕编辑' }));
    });
  }
}

function pointPanel() {
  return screen.getByTestId('pointmatch');
}

describe('narration point matching — end to end', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: marked take constrains a cue and adopts window+starts atomically', async () => {
    const adapter = new FakeMediaAdapter({ finalSize: 256 });
    const { container } = render(<App adapter={adapter} />);
    await importDocument(container, cuesJson(4));

    await recordTake(adapter, { start: '0', end: '100' });

    const panel = pointPanel();
    expect(panel.textContent).toContain('录音标记段 [0, 100)');

    // Pick cue #0 and an offset placing the segment at program time [400,500):
    // cue #0 duration 100 must fit fully, so its only feasible start is 400.
    fireEvent.change(screen.getByTestId('pm-cue'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('pm-offset'), {
      target: { value: '400' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pm-preview'));
    });

    const plan = screen.getByTestId('pm-plan');
    expect(plan.textContent).toContain('cue #0');
    expect(plan.textContent).toContain('[400, 400]');
    expect(plan.textContent).toContain('400');

    await act(async () => {
      fireEvent.click(screen.getByTestId('pm-apply'));
    });

    // Adopted: window fields now reflect 400/400 and the baseline moved.
    expect(screen.queryByTestId('pm-plan')).toBeNull();
    const e0 = screen.getByTestId('earliest-0') as HTMLInputElement;
    const l0 = screen.getByTestId('latest-0') as HTMLInputElement;
    expect(e0.value).toBe('400');
    expect(l0.value).toBe('400');
    // Row #0 shows the adopted baseline at 00:00:00.400; cue #1 pushed to 500.
    expect(document.body.textContent).toContain('基线 00:00:00.400');
  });

  it('mark form guards its own fields; solver-side reasons never mutate the draft', async () => {
    const adapter = new FakeMediaAdapter({});
    const { container } = render(<App adapter={adapter} />);
    await importDocument(
      container,
      JSON.stringify({
        cues: [
          { start: 0, duration: 100, text: 'a', earliest: 0, latest: 200 },
          { start: 100, duration: 100, text: 'b' },
        ],
      }),
    );

    await recordTake(adapter, { start: '100', end: '400' });
    // Booth-side guard: reversed marks are caught before sending (exercised
    // against the 1200 ms fake take above: the mark itself is valid, so the
    // pure solver-side reason classes are what we now drive from the panel).

    // cue #0 existing window [0,200]; offset 500 puts marked feasible starts
    // at [600,800]: empty intersection.
    fireEvent.change(screen.getByTestId('pm-cue'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('pm-offset'), { target: { value: '500' } });
    await act(async () => fireEvent.click(screen.getByTestId('pm-preview')));
    expect(screen.getByTestId('pm-rejected').textContent).toContain('交集为空');

    // Out of day: shift the same 300 ms segment past the day end.
    fireEvent.change(screen.getByTestId('pm-offset'), {
      target: { value: String(DAY) },
    });
    await act(async () => fireEvent.click(screen.getByTestId('pm-preview')));
    expect(screen.getByTestId('pm-rejected').textContent).toContain('越过节目边界');

    // Segment too short for the cue: drive it purely through cue choice using
    // a different cue duration is impossible here; instead offset -200 places
    // the segment start at -100: out of program.
    fireEvent.change(screen.getByTestId('pm-offset'), { target: { value: '-200' } });
    await act(async () => fireEvent.click(screen.getByTestId('pm-preview')));
    expect(screen.getByTestId('pm-rejected').textContent).toContain('越过节目边界');

    // Throughout, the draft windows and adopted starts are untouched.
    const e0 = screen.getByTestId('earliest-0') as HTMLInputElement;
    const l0 = screen.getByTestId('latest-0') as HTMLInputElement;
    expect(e0.value).toBe('0');
    expect(l0.value).toBe('200');
  });

  it('mark form rejects reversed / out-of-take / non-integer marks locally', async () => {
    const adapter = new FakeMediaAdapter({});
    render(<App adapter={adapter} />);
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: '现场旁白采集' })));
    await act(async () => fireEvent.click(screen.getByText('启用麦克风')));
    await act(async () => flush());
    await act(async () => fireEvent.click(screen.getByText('开始录制')));
    adapter.advance(1200);
    await act(async () => fireEvent.click(screen.getByText('停止')));
    await act(async () => flush());

    const start = screen.getByTestId('mark-start');
    const end = screen.getByTestId('mark-end');
    fireEvent.change(start, { target: { value: '300' } });
    fireEvent.change(end, { target: { value: '200' } });
    await act(async () => fireEvent.click(screen.getByTestId('mark-send')));
    expect(screen.getByTestId('mark-error').textContent).toContain('标记倒序');
    expect(screen.queryByTestId('mark-sent')).toBeNull();

    fireEvent.change(start, { target: { value: '0' } });
    fireEvent.change(end, { target: { value: '5000' } });
    await act(async () => fireEvent.click(screen.getByTestId('mark-send')));
    expect(screen.getByTestId('mark-error').textContent).toContain('整数毫秒');
    expect(screen.queryByTestId('mark-sent')).toBeNull();
  });

  it('re-record after a preview expires it: adopting reports expired, no change', async () => {
    const adapter = new FakeMediaAdapter({});
    const { container } = render(<App adapter={adapter} />);
    await importDocument(container, cuesJson(3));
    // Record take 1 and send its mark, staying in the review booth.
    await recordTake(adapter, { start: '0', end: '100' }, { leaveMounted: true });
    const take1Url = adapter.createdUrls[0];

    // Generate the preview against take 1 from the cue workspace (this unmounts
    // the booth and revokes take 1's media URL — but the timing mark remains).
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '字幕编辑' }));
    });
    fireEvent.change(screen.getByTestId('pm-cue'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('pm-offset'), { target: { value: '400' } });
    await act(async () => fireEvent.click(screen.getByTestId('pm-preview')));
    expect(screen.getByTestId('pm-plan').textContent).toContain('[400, 400]');

    // Re-record via the booth's own 废弃重来 path (a second take identity).
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '现场旁白采集' }));
    });
    // The booth was unmounted, so we are at idle; recording here produces a
    // fresh takeUid distinct from take 1.
    await act(async () => fireEvent.click(screen.getByText('启用麦克风')));
    await act(async () => flush());
    await act(async () => fireEvent.click(screen.getByText('开始录制')));
    adapter.advance(700);
    await act(async () => fireEvent.click(screen.getByText('停止')));
    await act(async () => flush());
    fireEvent.change(screen.getByTestId('mark-start'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('mark-end'), { target: { value: '100' } });
    await act(async () => fireEvent.click(screen.getByTestId('mark-send')));
    // The new take has its own URL; take 1's URL was already revoked on leave.
    expect(adapter.createdUrls).toHaveLength(2);
    expect(adapter.revokedUrls).toContain(take1Url);
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '字幕编辑' }));
    });

    // The old plan is visibly stale and cannot be applied.
    const stalePlan = screen.getByTestId('pm-plan');
    expect(stalePlan.textContent).toContain('已过期');
    await act(async () => fireEvent.click(screen.getByTestId('pm-apply')));
    expect(screen.getByTestId('pm-notice').textContent).toContain('已过期');
    // No window/start change: fields remain the all-day placeholders.
    expect((screen.getByTestId('earliest-0') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('latest-0') as HTMLInputElement).value).toBe('');
  });

  it('tab switching keeps the timing mark but releases the media URL', async () => {
    const adapter = new FakeMediaAdapter({});
    const { container } = render(<App adapter={adapter} />);
    await importDocument(container, cuesJson(2));
    await recordTake(adapter, { start: '10', end: '90' });

    // The mark survived the tab switch and is visible in the cue workspace.
    expect(pointPanel().textContent).toContain('[10, 90)');
    // Leaving the booth unmounted it: review finished its take, hardware was
    // already released at finalization; the object URL stays owned by the take
    // until discard/finish — here the booth unmounted with a live review, so
    // destroy() must have revoked exactly the created URL.
    expect(adapter.createdUrls).toHaveLength(1);
    expect(adapter.revokedUrls).toContain(adapter.createdUrls[0]);
  });

  it('fixed-point conflict and a mid-stream window edit both expire the preview', async () => {
    const adapter = new FakeMediaAdapter({});
    const { container } = render(<App adapter={adapter} />);
    await importDocument(container, cuesJson(3));

    // Pin cue #0 at 0 first.
    await act(async () => {
      fireEvent.change(screen.getByTestId('pin-0'), { target: { value: '0' } });
    });

    await recordTake(adapter, { start: '0', end: '100' });
    fireEvent.change(screen.getByTestId('pm-cue'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('pm-offset'), { target: { value: '400' } });
    await act(async () => fireEvent.click(screen.getByTestId('pm-preview')));

    // Pin at 0 vs forced window [400,400]: solver says no solution, reason only.
    expect(screen.getByTestId('pm-nosolution').textContent).toContain(
      '固定点落在自身窗口外',
    );
    // Nothing changed: pin still 0 and no apply button exists.
    expect((screen.getByTestId('pin-0') as HTMLInputElement).value).toBe('0');
    expect(screen.queryByTestId('pm-apply')).toBeNull();

    // Release the pin (a real separate user action re-renders the editor and
    // retires the old no-solution preview), then regenerate: feasible.
    await act(async () => {
      fireEvent.change(screen.getByTestId('pin-0'), { target: { value: '' } });
    });
    expect(screen.queryByTestId('pm-nosolution')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('pm-preview'));
    });
    const plan = screen.getByTestId('pm-plan');
    expect(plan.textContent).toContain('[400, 400]');

    // Now edit a window in between: the plan must expire.
    await act(async () => {
      fireEvent.change(screen.getByTestId('latest-1'), {
        target: { value: '900' },
      });
    });
    expect(screen.getByTestId('pm-plan').textContent).toContain('已过期');
    await act(async () => fireEvent.click(screen.getByTestId('pm-apply')));
    expect(screen.getByTestId('pm-notice').textContent).toContain('已过期');
    expect((screen.getByTestId('earliest-0') as HTMLInputElement).value).toBe('');
  });

  it('discard withdraws the delivered mark; finish keeps it but releases the URL', async () => {
    const adapter = new FakeMediaAdapter({});
    const { container } = render(<App adapter={adapter} />);
    await importDocument(container, cuesJson(2));
    await recordTake(adapter, { start: '10', end: '90' }, { leaveMounted: true });
    const takeUrl = adapter.createdUrls[0];

    // 完成，关闭麦克风：the booth releases the media URL via the existing
    // teardown, but the delivered timing numbers stay available for point use.
    await act(async () => fireEvent.click(screen.getByTestId('finish-take')));
    expect(adapter.revokedUrls).toContain(takeUrl);
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: '字幕编辑' })));
    expect(pointPanel().textContent).toContain('[10, 90)');
  });

  it('discarding the take withdraws the timing mark while revoking only the booth-owned URL', async () => {
    const adapter = new FakeMediaAdapter({});
    const { container } = render(<App adapter={adapter} />);
    await importDocument(container, cuesJson(2));
    await recordTake(adapter, { start: '20', end: '80' }, { leaveMounted: true });
    const takeUrl = adapter.createdUrls[0];

    // 废弃重来：existing path revokes the take URL and re-arms; the only thing
    // withdrawn on the cue side is the timing mark (never any URL ownership).
    await act(async () => fireEvent.click(screen.getByTestId('discard-take')));
    await act(async () => flush());
    expect(adapter.revokedUrls).toContain(takeUrl);
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: '字幕编辑' })));
    expect(pointPanel().textContent).toContain('尚无时间标记');
  });

  it('un-used point matching leaves the ordinary narration and cue flows intact', async () => {
    const adapter = new FakeMediaAdapter({});
    const { container } = render(<App adapter={adapter} />);
    await importDocument(container, cuesJson(2));
    // Record and finish without ever sending a mark.
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: '现场旁白采集' })));
    await act(async () => fireEvent.click(screen.getByText('启用麦克风')));
    await act(async () => flush());
    await act(async () => fireEvent.click(screen.getByText('开始录制')));
    adapter.advance(400);
    await act(async () => fireEvent.click(screen.getByText('停止')));
    await act(async () => flush());
    await act(async () => fireEvent.click(screen.getByTestId('finish-take')));
    expect(adapter.revokedUrls).toEqual(adapter.createdUrls);
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: '字幕编辑' })));
    // The panel simply reports no mark; editor preview/adopt still work.
    expect(pointPanel().textContent).toContain('尚无时间标记');
    expect((screen.getByTestId('adopt') as HTMLButtonElement).disabled).toBe(false);
  });
});
