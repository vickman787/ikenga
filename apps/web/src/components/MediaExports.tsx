"use client";
import { useEffect, useRef, useState } from 'react';
import { downloadBlob, flyerCanvas, canvasBlob, jpegPdf, videoFormat, exportPromoVideo, type VideoSlide } from '@/lib/mediaExport';
export default function MediaExports({ svg, slides }: {
    svg?: string;
    slides?: VideoSlide[];
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [percent, setPercent] = useState(0);
    const [format, setFormat] = useState<{
        mime: string;
        extension: string;
    } | null | undefined>(undefined);
    const controller = useRef<AbortController | null>(null);
    useEffect(() => { if (typeof MediaRecorder !== 'undefined')
        setFormat(videoFormat(type => MediaRecorder.isTypeSupported(type))); return () => controller.current?.abort(); }, []);
    async function flyer(kind: 'png' | 'pdf') { setBusy(true); setError(''); try {
        const canvas = await flyerCanvas(svg!);
        if (kind === 'png')
            downloadBlob(await canvasBlob(canvas), 'flyer.png');
        else {
            const jpeg = await canvasBlob(canvas, 'image/jpeg', .95);
            downloadBlob(new Blob([jpegPdf(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height)], { type: 'application/pdf' }), 'flyer.pdf');
        }
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Could not export the flyer.');
    }
    finally {
        setBusy(false);
    } }
    async function video() { if (!format)
        return; setBusy(true); setError(''); setPercent(0); controller.current = new AbortController(); try {
        const blob = await exportPromoVideo(slides!, format, controller.current.signal, p => setPercent(Math.round(p * 100)));
        downloadBlob(blob, 'promo.' + (blob.type.startsWith('video/mp4') ? 'mp4' : 'webm'));
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Could not export the video.');
    }
    finally {
        controller.current = null;
        setBusy(false);
    } }
    return <div style={{ marginTop: 16 }}>{svg && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button className="btn" type="button" onClick={() => flyer('png')} disabled={busy}>Download PNG</button><button className="btn" type="button" onClick={() => flyer('pdf')} disabled={busy}>Download PDF</button></div>}{slides?.length ? <><button className="btn leaf" type="button" onClick={video} disabled={busy || !format}>{busy ? `Exporting ${percent}%…` : format ? `Download ${format.extension.toUpperCase()}` : format === undefined ? 'Checking export support…' : 'Video unavailable'}</button>{busy && <button className="btn" type="button" style={{ marginLeft: 10 }} onClick={() => controller.current?.abort()}>Cancel export</button>}<p className="note" style={{ marginTop: 10 }}>A silent video made from your delivered slides. Keep this tab open and visible during export.{format?.extension === 'webm' ? ' This browser supports WebM; MP4 is unavailable here.' : ''}{format === null ? ' Video recording is unavailable in this browser.' : ''}</p></> : null}{svg && busy && <p role="status" style={{ marginTop: 10 }}>Preparing your file…</p>}{error && <p role="alert" className="error" style={{ marginTop: 10 }}>{error}</p>}</div>;
}
