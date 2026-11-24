/**
 * The promo slideshow as a standalone file — what the "Download the
 * slideshow" button on the job page saves, and what the sample in
 * docs/samples is.
 *
 * One implementation, used by the page and by the testnet script, so
 * the file a customer downloads is exactly the file that was checked.
 * It is fully self-contained: inline CSS, no scripts, no external
 * links — the slides move on their own with a CSS animation (each
 * slide shows for about 4 seconds, then the next), and the picture,
 * when the job has one, is embedded as a data URI. It plays the same
 * slides the page shows.
 */
/** One slide of the promo slideshow. The picture, when the job has one, is a data URI on the first slide. */
export interface SlideshowSlide {
  title: string;
  text: string;
  image?: string;
}

/** The only image shapes the download ever embeds (our own generated pictures). */
const DATA_URI_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the standalone slideshow file from the job's slides. */
export function buildStandaloneSlideshowHtml(slides: SlideshowSlide[]): string {
  const total = Math.max(slides.length, 1);
  const cycleSeconds = total * 4;
  // Each slide is visible only in its own 4-second window of the
  // cycle: fade in over 0.6s, hold, fade out by the 4s mark. The
  // percentages are of the whole cycle. Each slide's delay is a
  // POSITIVE 4s per step — the delay shifts the slide's whole
  // timeline, not just its first loop, so slide 2 runs 4s behind
  // slide 1 forever, slide 3 runs 8s behind, and so on. (A negative
  // delay would do the opposite: it starts a slide part-way INTO the
  // cycle, so the slides would play in reverse order — caught by a
  // real-time screenshot, 2026-11-24.)
  const fadeInPct = ((0.6 / cycleSeconds) * 100).toFixed(1);
  const holdPct = ((3.4 / cycleSeconds) * 100).toFixed(1);
  const fadeOutPct = ((4 / cycleSeconds) * 100).toFixed(1);
  const cards = slides
    .map((slide, i) => {
      const image = slide.image && DATA_URI_PATTERN.test(slide.image) ? slide.image : "";
      const delay = `${i * 4}s`;
      return [
        `<section class="slide" style="opacity:${i === 0 ? 1 : 0};animation-delay:${delay}">`,
        image ? `<img src="${image}" alt="" />` : "",
        `<p class="kicker">Slide ${i + 1} of ${slides.length}</p>`,
        `<h1>${escapeHtml(slide.title)}</h1>`,
        `<p class="body">${escapeHtml(slide.text)}</p>`,
        `</section>`,
      ].join("\n");
    })
    .join("\n");
  const empty = slides.length === 0 ? `<section class="slide" style="opacity:1"><p class="body">No slides in this slideshow.</p></section>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Promo slideshow</title>
<style>
body { margin: 0; background: #FBF9F4; font-family: system-ui, -apple-system, sans-serif; }
.deck { position: relative; max-width: 860px; height: 720px; margin: 32px auto; padding: 0 16px; }
.slide { position: absolute; left: 16px; right: 16px; background: #13271C; color: #FBF9F4; border-radius: 16px; padding: 48px 28px; min-height: 280px; display: flex; flex-direction: column; justify-content: center; gap: 14px; overflow: hidden; animation: ikenga-show ${cycleSeconds}s linear infinite; }
.slide img { width: 100%; max-height: 320px; object-fit: cover; border-radius: 12px; display: block; }
.kicker { font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: #A3E36A; margin: 0; }
.slide h1 { font-size: 32px; line-height: 1.15; margin: 0; }
.slide .body { font-size: 18px; line-height: 1.6; opacity: 0.92; margin: 0; }
@keyframes ikenga-show { 0% { opacity: 0; } ${fadeInPct}% { opacity: 1; } ${holdPct}% { opacity: 1; } ${fadeOutPct}% { opacity: 0; } 100% { opacity: 0; } }
.note { margin: 24px auto 0; max-width: 860px; padding: 0 16px; color: #66726A; font-size: 13px; line-height: 1.6; }
</style>
</head>
<body>
<div class="deck">
${cards}${empty}
</div>
<p class="note">Made by Ikenga — a motion slideshow, not a video file.</p>
</body>
</html>`;
}
