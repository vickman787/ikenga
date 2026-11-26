"use client";
import { useEffect, useState } from 'react';
import { promoScene } from '@ikenga/shared';

/** The delivered slides and their video export use the same scene palette. */
export default function Slideshow({ slides }: { slides: { title: string; text: string; image?: string }[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = slides.length;
  const active = Math.min(index, Math.max(0, total - 1));
  const slide = slides[active];
  useEffect(() => {
    if (!playing || total <= 1) return;
    const timer = setInterval(() => setIndex(i => (i + 1) % total), 4000);
    return () => clearInterval(timer);
  }, [playing, total]);
  if (!slide) return null;
  const theme = promoScene(active);
  const image = slide.image || (active % 2 === 0 ? slides[0]?.image : undefined);
  const jump = (i: number) => { setPlaying(false); setIndex(i); };
  return <div>
    <style>{`@keyframes promo-enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}.promo-scene-copy{animation:promo-enter .5s ease}@media(prefers-reduced-motion:reduce){.promo-scene-copy{animation:none}}`}</style>
    <div aria-label={`Promo scene ${active + 1} of ${total}`} style={{ position: 'relative', overflow: 'hidden', aspectRatio: '9 / 16', minHeight: 480, borderRadius: 24, background: theme.background, color: theme.ink }}>
      {image && <img src={image} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '55%', objectFit: 'cover' }} />}
      {image && <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg,${theme.background}55 0%,transparent 25%,${theme.background} 58%)` }} />}
      <div style={{ position: 'absolute', top: '6%', left: '8%', zIndex: 1, fontSize: 12, fontWeight: 700, letterSpacing: 3, color: theme.accent }}><span style={{ display: 'block', width: 32, height: 3, background: theme.accent, marginBottom: 12 }} />{String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}</div>
      {!image && <span aria-hidden="true" style={{ position: 'absolute', top: '14%', right: '-2%', fontSize: 'clamp(100px,14vw,180px)', fontWeight: 800, letterSpacing: -12, opacity: .1, color: theme.accent }}>{String(active + 1).padStart(2, '0')}</span>}
      <div key={active} className="promo-scene-copy" style={{ position: 'absolute', inset: image ? '55% 8% auto' : '39% 8% auto', overflowWrap: 'anywhere' }}>
        <h3 style={{ fontSize: 'clamp(26px,3vw,42px)', lineHeight: 1.08, letterSpacing: '-.04em', color: 'inherit', margin: '0 0 20px', maxWidth: '15ch' }}>{slide.title}</h3>
        <p style={{ fontSize: 'clamp(15px,1.6vw,19px)', lineHeight: 1.55, margin: 0, color: 'inherit', opacity: .9 }}>{slide.text}</p>
      </div>
      <div aria-hidden="true" style={{ position: 'absolute', bottom: '7%', left: '8%', right: '8%', display: 'flex', gap: 5 }}>{slides.map((_, i) => <span key={i} style={{ height: 3, flex: 1, background: theme.accent, opacity: i <= active ? 1 : .22 }} />)}</div>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
      <button className="btn leaf" type="button" onClick={() => setPlaying(v => !v)} aria-label={playing ? 'Pause promo' : 'Play promo'}>{playing ? 'Pause' : 'Play promo'}</button>
      <button className="btn" type="button" onClick={() => jump((active - 1 + total) % total)} aria-label="Previous promo scene">←</button>
      <button className="btn" type="button" onClick={() => jump((active + 1) % total)} aria-label="Next promo scene">→</button>
      <span style={{ fontSize: 13, marginLeft: 'auto', opacity: .65 }}>{active + 1} of {total} scenes</span>
    </div>
  </div>;
}
