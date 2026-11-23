/**
 * Messenger — the last step of every job: pack the finished work and
 * deliver it on the job page.
 *
 * Messenger runs after the Auditor passes. It takes the finished work
 * (the report, the website / flyer page, or the slideshow), works out
 * its fingerprint with the same hash the boss seals on the escrow
 * (deliverableHashFor), and writes a delivery receipt: what was
 * delivered, its fingerprint, and when. The receipt's fingerprint is
 * the same one the boss worker seals onchain before the customer can
 * accept — so the work on the page, the receipt and the chain all
 * agree.
 *
 * The delivery lives on the job page. Nothing is sent by email or
 * WhatsApp — Messenger does not have those, and the page says so.
 * Messenger never moves money and never calls a model: packing and
 * hashing cost nothing.
 */
import { deliverableHashFor, type DeliverableContent } from "@ikenga/payments";

export interface DeliveryReceipt {
  /** "report", "website", "flyer" or "slideshow". */
  noun: string;
  /** The fingerprint of the delivered work (keccak256, same as the onchain seal). */
  hash: `0x${string}`;
  deliveredAt: string;
  /** Where the work was delivered: always the job page. */
  where: "your job page";
}

export interface DeliveryStep {
  agent: "Messenger";
  what: string;
  detail: string;
}

/**
 * Pack finished work and deliver it. Pure — it sends nothing and
 * spends nothing. Returns the step the job page shows and the
 * receipt (kept in the step's detail and the money log).
 */
export function deliverWork(
  content: DeliverableContent,
  noun: "report" | "website" | "flyer" | "slideshow",
): { step: DeliveryStep; receipt: DeliveryReceipt } {
  const hash = deliverableHashFor(content);
  const receipt: DeliveryReceipt = { noun, hash, deliveredAt: new Date().toISOString(), where: "your job page" };
  return {
    step: {
      agent: "Messenger",
      what: `Packed the ${noun} and delivered it on your job page.`,
      detail: `Its fingerprint is ${hash} — the same fingerprint the boss seals on the escrow before you accept. You can read it right here on this page; it was not sent anywhere else.`,
    },
    receipt,
  };
}
