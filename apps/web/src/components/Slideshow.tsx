"use client";

import { useEffect, useState } from "react";

/**
 * The promo "video" — honestly a motion slideshow, not a video file.
 * The slides are the business's own words from its brief; this
 * component only moves between them. Play/pause, step forward and
 * back, and dots to jump to a slide. No video file is made here, and
 * the page says so in plain words next to the player.
 */
export default function Slideshow({ slides }: { slides: { title: string; text: string }[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const total = slides.length;
  const slide = slides[index] ?? { title: "", text: "" };

  useEffect(() => {
    if (!playing || total <= 1) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % total), 4000);
    return () => clearInterval(t);
  }, [playing, total]);

  if (total === 0) return null;

  return (
    <div>
      <style>{`@keyframes ikenga-slide-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div
        key={index}
        style={{
          animation: "ikenga-slide-in 0.5s ease",
          background: "var(--ink, #13271C)",
          color: "#FBF9F4",
          borderRadius: 16,
          padding: "56px 28px",
          minHeight: 280,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 14,
        }}
      >
        <p style={{ fontSize: 13, letterSpacing: 2, textTransform: "uppercase", color: "#A3E36A" }}>
          Slide {index + 1} of {total}
        </p>
        <h3 style={{ fontSize: 32, lineHeight: 1.15, margin: 0 }}>{slide.title}</h3>
        <p style={{ fontSize: 18, lineHeight: 1.6, color: "#FBF9F4", opacity: 0.92, margin: 0 }}>{slide.text}</p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button onClick={() => setPlaying((v) => !v)} className="btn leaf" type="button">
          {playing ? "Pause ❚❚" : "Play ▶"}
        </button>
        <button
          onClick={() => { setPlaying(false); setIndex((i) => (i - 1 + total) % total); }}
          className="btn"
          type="button"
        >
          ← Back
        </button>
        <button
          onClick={() => { setPlaying(false); setIndex((i) => (i + 1) % total); }}
          className="btn"
          type="button"
        >
          Next →
        </button>
        <span style={{ display: "flex", gap: 6, marginLeft: 4 }}>
          {slides.map((s, i) => (
            <button
              key={`${s.title}-${i}`}
              type="button"
              aria-label={`Go to slide ${i + 1}`}
              onClick={() => { setPlaying(false); setIndex(i); }}
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                border: "none",
                cursor: "pointer",
                background: i === index ? "#13271C" : "#c9c4b8",
                padding: 0,
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
