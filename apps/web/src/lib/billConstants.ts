/**
 * Naira-bill limits, shared by the form and the server validation.
 * No imports — a client component may import this (the server lib pulls
 * in pg and node:fs, which a browser bundle cannot take).
 */

/** Smallest bill that works: about $1, the corridor floor (~₦1,444 at the rate last checked). */
export const MIN_BILL_NGN = 1500;
/** Largest bill: about $34,000 at the rate last checked — inside the corridor's top end. */
export const MAX_BILL_NGN = 50_000_000;
/** A bill's deadline must be within 90 days — a live obligation, not a wish. */
export const MAX_DEADLINE_DAYS = 90;
