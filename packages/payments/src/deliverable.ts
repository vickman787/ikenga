/**
 * Deliverable hashes — the fingerprint of the finished work, sealed on the
 * job's JobEscrow by submitDeliverable() (via the vault) before the
 * customer can accept. The hash is keccak256 over the UTF-8 of a canonical
 * JSON of whichever content is present: the report text for a market
 * report, the page HTML for a website / flyer, the slides for a promo
 * slideshow. Same input always gives the same hash; different work gives
 * a different hash; real content never hashes to 0x0…0.
 */
import { keccak256, toHex } from "viem";

export interface DeliverableContent {
  /** The written market report. */
  report?: string;
  /** The built website / flyer page (sanitised HTML). */
  html?: string;
  /** The promo slideshow: one card per slide. */
  slides?: { title: string; text: string }[];
}

/** keccak256 of the canonical JSON of the delivered work. Deterministic. */
export function deliverableHashFor(content: DeliverableContent): `0x${string}` {
  const canonical: Record<string, unknown> = {};
  if (content.report) canonical.report = content.report;
  if (content.html) canonical.html = content.html;
  if (content.slides && content.slides.length > 0) {
    canonical.slides = content.slides.map((s) => ({ title: s.title, text: s.text }));
  }
  return keccak256(toHex(JSON.stringify(canonical)));
}
