/** Browser-only exports. Inputs remain on the customer's device. */
export function downloadBlob(blob: Blob, filename: string) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export async function loadImage(source: string): Promise<HTMLImageElement> {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(source))
        throw new Error('Only the delivered embedded picture can be exported.');
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('The delivered picture could not be decoded.')); img.src = source; });
}
export async function flyerCanvas(svg: string): Promise<HTMLCanvasElement> {
    // Only SVG from our trusted renderer reaches this function, never uploaded SVG.
    if (!svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') || /<script|<foreignObject|\son\w+=|(?:href|src)="https?:/i.test(svg))
        throw new Error('This artwork cannot be safely exported.');
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('This browser could not render the flyer export.')); image.src = url; });
        const canvas = document.createElement('canvas');
        canvas.width = 2000;
        canvas.height = 2828;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('Canvas export is not available in this browser.');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas;
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
export function canvasBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> { return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The export could not be encoded.')), type, quality)); }
const bytes = (s: string) => new TextEncoder().encode(s);
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const part of parts) {
    out.set(part, at);
    at += part.length;
} return out; }
/** One A4 page embedding the exact rendered artwork as a high-resolution JPEG. */
export function jpegPdf(jpeg: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
    const content = bytes('q 595.28 0 0 841.89 0 0 cm /Art Do Q');
    const objects = [bytes('<< /Type /Catalog /Pages 2 0 R >>'), bytes('<< /Type /Pages /Count 1 /Kids [3 0 R] >>'), bytes('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Art 4 0 R >> >> /Contents 5 0 R >>'), concat([bytes(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, bytes('\nendstream')]), concat([bytes(`<< /Length ${content.length} >>\nstream\n`), content, bytes('\nendstream')])];
    const parts = [bytes('%PDF-1.4\n')];
    const offsets = [0];
    let length = parts[0].length;
    objects.forEach((object, i) => { offsets.push(length); const part = concat([bytes(`${i + 1} 0 obj\n`), object, bytes('\nendobj\n')]); parts.push(part); length += part.length; });
    const xref = 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
    parts.push(bytes(xref + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
    return concat(parts);
}
export interface VideoSlide {
    title: string;
    text: string;
    image?: string;
}
export function videoFormat(supports: (mime: string) => boolean): {
    mime: string;
    extension: string;
} | null {
    for (const mime of ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'])
        if (supports(mime))
            return { mime, extension: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
    return null;
}
export function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
    const result: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
        if (ctx.measureText((line + ' ' + word).trim()).width <= width) {
            line = (line + ' ' + word).trim();
            continue;
        }
        if (line)
            result.push(line);
        line = '';
        for (const char of word) {
            if (ctx.measureText(line + char).width > width) {
                result.push(line);
                line = char;
            }
            else
                line += char;
        }
    }
    if (line)
        result.push(line);
    return result;
}
function drawText(ctx: CanvasRenderingContext2D, text: string, y: number, size: number, maxLines: number, colour: string) {
    let rows: string[] = [];
    for (; size >= 22; size -= 2) {
        ctx.font = `700 ${size}px Arial`;
        rows = wrapCanvasText(ctx, text, 610);
        if (rows.length <= maxLines)
            break;
    }
    if (rows.length > maxLines)
        throw new Error('This promo has more text than fits on a video frame.');
    ctx.fillStyle = colour;
    rows.forEach((row, i) => ctx.fillText(row, 55, y + i * size * 1.22));
    return rows.length * size * 1.22;
}
export async function exportPromoVideo(slides: VideoSlide[], format: {
    mime: string;
    extension: string;
}, signal: AbortSignal, progress: (p: number) => void): Promise<Blob> {
    if (!slides.length || slides.length > 20)
        throw new Error('Video export supports 1–20 slides.');
    if (typeof MediaRecorder === 'undefined')
        throw new Error('Video export is not available in this browser.');
    const pictures = await Promise.all(slides.map(s => s.image ? loadImage(s.image) : null));
    if (signal.aborted)
        throw new Error('Export cancelled.');
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new Error('Canvas export is not available.');
    if (typeof canvas.captureStream !== 'function')
        throw new Error('This browser cannot record a video export.');
    const duration = Math.min(slides.length * 4000, 60000);
    const sceneMs = duration / slides.length;
    let frame = 0;
    const draw = (elapsed: number) => {
        const index = Math.min(slides.length - 1, Math.floor(elapsed / sceneMs));
        const local = (elapsed - index * sceneMs) / sceneMs;
        const slide = slides[index];
        const image = pictures[index];
        ctx.fillStyle = '#13271C';
        ctx.fillRect(0, 0, 720, 1280);
        if (image) {
            const scale = Math.max(720 / image.width, 620 / image.height) * (1 + local * .06);
            const width = image.width * scale, height = image.height * scale;
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, 720, 620);
            ctx.clip();
            ctx.drawImage(image, (720 - width) / 2, (620 - height) / 2, width, height);
            ctx.restore();
            const gradient = ctx.createLinearGradient(0, 400, 0, 650);
            gradient.addColorStop(0, '#13271c00');
            gradient.addColorStop(1, '#13271c');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 400, 720, 250);
        }
        ctx.save();
        ctx.globalAlpha = Math.min(1, local * 8);
        ctx.translate(0, Math.max(0, 1 - local * 8) * 18);
        const y = image ? 690 : 420;
        const titleHeight = drawText(ctx, slide.title, y, 66, 3, '#FBF9F4');
        drawText(ctx, slide.text, y + titleHeight + 36, 36, 5, '#FBF9F4');
        ctx.restore();
        ctx.fillStyle = '#A3E36A';
        ctx.fillRect(55, 1190, 610 * Math.min(1, elapsed / duration), 5);
    };
    draw(0);
    const stream = canvas.captureStream(30);
    let recorder: MediaRecorder;
    try {
        recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 3000000 });
    }
    catch (error) {
        stream.getTracks().forEach(t => t.stop());
        throw error;
    }
    return new Promise((resolve, reject) => {
        const chunks: BlobPart[] = [];
        let failure: Error | null = null;
        let done = false;
        const cleanup = () => { cancelAnimationFrame(frame); stream.getTracks().forEach(t => t.stop()); signal.removeEventListener('abort', cancel); document.removeEventListener('visibilitychange', hidden); };
        const stop = (error?: Error) => { if (done)
            return; failure = error ?? null; done = true; cancelAnimationFrame(frame); if (recorder.state !== 'inactive')
            recorder.stop();
        else {
            cleanup();
            reject(failure ?? new Error('Recording could not start.'));
        } };
        const cancel = () => stop(new Error('Export cancelled.'));
        const hidden = () => { if (document.hidden)
            stop(new Error('Keep this tab visible while exporting. Please try again.')); };
        recorder.ondataavailable = e => { if (e.data.size)
            chunks.push(e.data); };
        recorder.onerror = () => stop(new Error('The browser could not encode this video.'));
        recorder.onstop = () => { cleanup(); if (failure)
            reject(failure);
        else if (!chunks.length)
            reject(new Error('The video export was empty.'));
        else
            resolve(new Blob(chunks, { type: recorder.mimeType || format.mime })); };
        signal.addEventListener('abort', cancel, { once: true });
        document.addEventListener('visibilitychange', hidden);
        if (signal.aborted) { cancel(); return; }
        if (document.hidden) { hidden(); return; }
        try { recorder.start(500); }
        catch (error) {
            done = true;
            cleanup();
            reject(error instanceof Error ? error : new Error('Recording could not start.'));
            return;
        }
        const started = performance.now();
        const tick = () => { if (done)
            return; try {
            const elapsed = performance.now() - started;
            draw(elapsed);
            progress(Math.min(1, elapsed / duration));
            if (elapsed >= duration) {
                stop();
                return;
            }
            frame = requestAnimationFrame(tick);
        }
        catch (error) {
            stop(error instanceof Error ? error : new Error('Could not render the video.'));
        } };
        frame = requestAnimationFrame(tick);
    });
}
