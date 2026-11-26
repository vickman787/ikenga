import { afterEach, expect, it, vi } from 'vitest';
import { exportPromoVideo } from './mediaExport';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('records and cleans up a supported video export without requesting camera access', async () => {
    const stopTrack = vi.fn();
    const ctx = { fillRect: vi.fn(), fillText: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), measureText: (text: string) => ({ width: text.length * 20 }) };
    const canvas = { getContext: () => ctx, captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }) };
    vi.stubGlobal('document', { createElement: () => canvas, addEventListener: vi.fn(), removeEventListener: vi.fn(), hidden: false });
    class Recorder {
        state = 'inactive';
        mimeType = 'video/mp4';
        ondataavailable: any;
        onstop: any;
        onerror: any;
        constructor(_stream: unknown, _options: unknown) { }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['fixture']) }); this.onstop?.(); }); }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { queueMicrotask(fn); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(5000);
    const result = await exportPromoVideo([{ title: 'Ada', text: 'Call to order' }], { mime: 'video/mp4', extension: 'mp4' }, new AbortController().signal, () => { });
    expect(result.type).toBe('video/mp4');
    expect(result.size).toBeGreaterThan(0);
    expect(stopTrack).toHaveBeenCalled();
});
it('does not start a recording after cancellation', async () => {
    vi.stubGlobal('MediaRecorder', class {
    });
    const controller = new AbortController();
    controller.abort();
    await expect(exportPromoVideo([{ title: 'Ada', text: 'Call' }], { mime: 'video/mp4', extension: 'mp4' }, controller.signal, () => { })).rejects.toThrow('cancelled');
});
