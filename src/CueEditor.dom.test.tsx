// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  within,
} from '@testing-library/react';
import { CueEditor } from './CueEditor';

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

async function importDocument(container: HTMLElement, json: string): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([json], 'cues.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
  // The importer awaits File.text(); settle that continuation explicitly.
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
      // jsdom never navigates; the anchor already carries the blob href.
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

describe('CueEditor — rejected inline window edits never take effect', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('out-of-range / non-integer / reversed edits keep the old value everywhere', async () => {
    const { container } = render(<CueEditor />);
    await importDocument(container, cuesJson(12));

    // Accept a legal window edit first: earliest = 50 on cue #0.
    const e0 = screen.getByTestId('earliest-0') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(e0, { target: { value: '50' } });
    });
    expect(e0.value).toBe('50');
    expect(screen.queryByTestId('window-rejected')).toBeNull();

    const dl = stubDownloads();

    // 1) Out of range.
    await act(async () => {
      fireEvent.change(e0, { target: { value: String(DAY + 1) } });
    });
    expect(e0.value).toBe('50'); // illegal content never stays in the field
    const rejectBanner = screen.getByTestId('window-rejected');
    expect(rejectBanner.textContent).toContain('cue #0');

    // Immediate preview/adopt/download remain usable and reference the
    // confirmed window [50, DAY], not the rejected 86,400,001.
    const adopt = screen.getByTestId('adopt') as HTMLButtonElement;
    expect(adopt.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId('download-base'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('download-preview'));
    });
    const exported = (await dl.blobs()).map((t) => JSON.parse(t));
    for (const doc of exported) {
      expect(doc.cues[0].earliest).toBe(50);
      expect(doc.cues[0].latest).toBeUndefined();
      expect(doc.cues[0]).not.toHaveProperty('latest');
    }
    dl.restore();

    // 2) Non-integer: same rule.
    await act(async () => {
      fireEvent.change(e0, { target: { value: '50.5' } });
    });
    expect(e0.value).toBe('50');
    expect(screen.getByTestId('window-rejected').textContent).toContain('cue #0');

    // 3) earliest > latest: a legal latest=600 on cue #1 first, then try
    //    earliest=601 (reversed). The rejected edit leaves [0,600] confirmed.
    const l1 = screen.getByTestId('latest-1') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(l1, { target: { value: '600' } });
    });
    expect(l1.value).toBe('600');
    const e1 = screen.getByTestId('earliest-1') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(e1, { target: { value: '601' } });
    });
    expect(e1.value).toBe(''); // reverted to the committed all-day default
    expect(l1.value).toBe('600');
    expect(screen.getByTestId('window-rejected').textContent).toContain('反序');

    // The rejected reversed edit cannot change exported boundaries either.
    const dl2 = stubDownloads();
    await act(async () => {
      fireEvent.click(screen.getByTestId('download-preview'));
    });
    const [doc2] = (await dl2.blobs()).map((t) => JSON.parse(t));
    expect(doc2.cues[1]).toEqual({
      start: 150,
      duration: 100,
      text: 'cue 1',
      latest: 600,
    });
    dl2.restore();
  });

  it('virtual scroll round-trip restores the confirmed value and drops the rejection', async () => {
    const { container } = render(<CueEditor />);
    await importDocument(container, cuesJson(30));

    const e0 = screen.getByTestId('earliest-0') as HTMLInputElement;
    // Reject an out-of-range edit on row #0.
    await act(async () => {
      fireEvent.change(e0, { target: { value: '-3' } });
    });
    expect(e0.value).toBe('');
    const banner = screen.getByTestId('window-rejected');
    expect(banner.textContent).toContain('cue #0');

    // Roll row #0 out of the virtual window...
    const list = screen.getByTestId('cue-list');
    await act(async () => {
      list.scrollTop = 2400;
      fireEvent.scroll(list);
    });
    expect(screen.queryByTestId('earliest-0')).toBeNull();
    // ...the stale rejection must not outlive the row it describes.
    expect(screen.queryByTestId('window-rejected')).toBeNull();

    // Roll back: the field shows the confirmed value, not -3.
    await act(async () => {
      list.scrollTop = 0;
      fireEvent.scroll(list);
    });
    const e0again = screen.getByTestId('earliest-0') as HTMLInputElement;
    expect(e0again.value).toBe('');
    expect(screen.queryByTestId('window-rejected')).toBeNull();

    // A legal edit still works after the round-trip and ends up in the export.
    await act(async () => {
      fireEvent.change(e0again, { target: { value: '0' } });
    });
    expect(screen.queryByTestId('window-rejected')).toBeNull();
    const dl = stubDownloads();
    await act(async () => {
      fireEvent.click(screen.getByTestId('download-preview'));
    });
    const [doc] = (await dl.blobs()).map((t) => JSON.parse(t));
    expect(doc.cues[0].earliest).toBe(0);
    dl.restore();
  });

  it('legal window edits, old three-field import and adoption stay compatible', async () => {
    const { container } = render(<CueEditor />);
    await importDocument(container, cuesJson(4));

    // Old three-field document exports three fields until a boundary is set.
    const dl = stubDownloads();
    await act(async () => {
      fireEvent.click(screen.getByTestId('download-base'));
    });
    const [before] = (await dl.blobs()).map((t) => JSON.parse(t));
    expect(before.cues[2]).toEqual({ start: 200, duration: 100, text: 'cue 2' });
    dl.restore();

    // Set earliest=90 on cue #2 (window then [90, DAY]); the preview moves
    // that cue to at least 90? No: start 200 already >= 90, stays put. Set
    // latest=150 instead: cue #2 moves to 150 and pushes cue #3 to 250.
    const l2 = screen.getByTestId('latest-2') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(l2, { target: { value: '250' } });
    });
    expect(l2.value).toBe('250');
    const e2 = screen.getByTestId('earliest-2') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(e2, { target: { value: '150' } });
    });
    expect(e2.value).toBe('150');
    // adopt then verify the re-solved vector.
    await act(async () => {
      fireEvent.click(screen.getByTestId('adopt'));
    });

    const dl2 = stubDownloads();
    await act(async () => {
      fireEvent.click(screen.getByTestId('download-base'));
    });
    const [after] = (await dl2.blobs()).map((t) => JSON.parse(t));
    expect(after.cues[2].start).toBe(200);
    expect(after.cues[3].start).toBe(300);
    expect(after.cues[2]).toMatchObject({ earliest: 150, latest: 250 });
    dl2.restore();
  });
});

describe('CueEditor — both conflict kinds on one cue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('diagnoses the self-window failure and offers no pin-release repair', async () => {
    // durations 100, full day: window-only chain is infeasible at cue #0
    // (earliest 100 but the future windows cap x[0] at 0), and pin 0 is
    // simultaneously outside cue #0's own window [100, DAY].
    const json = JSON.stringify({
      cues: [
        { start: 0, duration: 100, text: 'a', earliest: 100 },
        { start: 100, duration: 100, text: 'b', latest: 100 },
      ],
    });
    const { container } = render(<CueEditor />);
    await importDocument(container, json);

    // Add the self-violating pin.
    const pin0 = screen.getByTestId('pin-0') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(pin0, { target: { value: '0' } });
    });
    expect(pin0.value).toBe('0');

    // First diagnosis: the self-window kind takes precedence.
    const banner = await screen.findByText(/固定点落在自身窗口外/);
    expect(banner.textContent).toContain('cue #0');
    expect(banner.textContent).toContain('固定起点 0');
    expect(banner.textContent).toContain('[100, 86400000]');
    expect(document.body.textContent).not.toContain('窗口链冲突 · 最早 cue #0');

    // Analysis: releasing pins cannot repair infeasible windows — no plan.
    await act(async () => {
      fireEvent.click(screen.getByTestId('generate-repair'));
    });
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    const notice = document.body.textContent;
    expect(notice).toContain('解除固定点无法恢复');
    expect(notice).toContain('cue #0');
  });

  it('chain-only conflict (pin inside its own window) still repairs and fixes the set', async () => {
    // cue #0 window [0,200] pinned at 200; cue #1 window [200,250] pinned at
    // 200. Both pins lie inside their own windows, but pin #0 forces x[1] >=
    // 300 while cue #1's window tops out at 250: a pure WINDOW_CHAIN. The
    // windows alone are feasible, so the repair keeps pin #1 (keeping #0 is
    // impossible) and re-solving the applied set succeeds.
    const json = JSON.stringify({
      cues: [
        { start: 0, duration: 100, text: 'a', earliest: 0, latest: 200 },
        { start: 100, duration: 100, text: 'b', earliest: 200, latest: 250 },
      ],
    });
    const { container } = render(<CueEditor />);
    await importDocument(container, json);

    const pin0 = screen.getByTestId('pin-0') as HTMLInputElement;
    const pin1 = screen.getByTestId('pin-1') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(pin0, { target: { value: '200' } });
    });
    await act(async () => {
      fireEvent.change(pin1, { target: { value: '200' } });
    });

    const banner = await screen.findByText(/窗口链冲突/);
    expect(banner.textContent).toContain('cue #0');
    expect(banner.textContent).toContain('0');
    expect(banner.textContent).toContain('150');

    await act(async () => {
      fireEvent.click(screen.getByTestId('generate-repair'));
    });
    // Max retention: release cue #0 (its y is past the global suffix envelope),
    // retain cue #1.
    const repairBanner = screen
      .getByTestId('apply-repair')
      .closest('.banner') as HTMLElement;
    expect(repairBanner.textContent).toContain('保留 1/2');
    expect(within(repairBanner).getByText(/完整解除清单/).textContent).toContain(
      '0',
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('apply-repair'));
    });
    // Applied pin set re-solves to a ready preview; the released pin field is
    // empty and the retained pin survives.
    expect(screen.queryByTestId('apply-repair')).toBeNull();
    expect(screen.getByText(/预览就绪/)).not.toBeNull();
    expect((screen.getByTestId('pin-1') as HTMLInputElement).value).toBe('200');
    expect((screen.getByTestId('pin-0') as HTMLInputElement).value).toBe('');

    // The final fixed-point set in the export: cue #1 exactly 200; cue #0
    // returned to 0 by the optimum.
    const dl = stubDownloads();
    await act(async () => {
      fireEvent.click(screen.getByTestId('download-preview'));
    });
    const [doc] = (await dl.blobs()).map((t) => JSON.parse(t));
    expect(doc.cues[0].start).toBe(0);
    expect(doc.cues[1].start).toBe(200);
    expect(doc.cues[0]).toMatchObject({ earliest: 0, latest: 200 });
    expect(doc.cues[1]).toMatchObject({ earliest: 200, latest: 250 });
    dl.restore();
  });
});
