import { describe, expect, it } from 'vitest';
import { jpegPdf, videoFormat, wrapCanvasText } from './mediaExport';
describe('Media file exports', () => {
    it('constructs a valid PDF object table with byte-accurate offsets', () => { const bytes = jpegPdf(new Uint8Array([255, 216, 1, 2, 255, 217]), 2000, 2828); const text = new TextDecoder('latin1').decode(bytes); expect(text).toContain('%PDF-1.4'); expect(text).toContain('/DCTDecode'); expect(text).toContain('/Width 2000'); const xref = Number(text.match(/startxref\n(\d+)/)?.[1]); expect(new TextDecoder().decode(bytes.slice(xref, xref + 4))).toBe('xref'); const lines = text.slice(text.indexOf('xref\n')).split('\n'); for (let i = 1; i <= 5; i++) {
        const offset = Number(lines[i + 2].slice(0, 10));
        expect(new TextDecoder().decode(bytes.slice(offset, offset + 7))).toBe(`${i} 0 obj`);
    } });
    it('never labels a WebM file as MP4', () => { expect(videoFormat(m => m === 'video/webm')).toEqual({ mime: 'video/webm', extension: 'webm' }); expect(videoFormat(m => m === 'video/mp4')?.extension).toBe('mp4'); expect(videoFormat(() => false)).toBeNull(); });
    it('wraps oversized words rather than clipping a contact string', () => { const ctx = { measureText: (s: string) => ({ width: s.length * 10 }) } as CanvasRenderingContext2D; const lines = wrapCanvasText(ctx, 'ABCDEFGHIJKLMNOPQRST', 50); expect(lines.join('')).toBe('ABCDEFGHIJKLMNOPQRST'); expect(lines.every(s => s.length <= 5)).toBe(true); });
});
