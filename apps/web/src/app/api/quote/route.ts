/**
 * GET /api/quote?currency=cNGN
 *
 * The indicative price of a $1 job in another currency — what the hire
 * form shows before the customer picks. For cNGN this is a live Textile
 * FX preview (sell $1 of USDT, read back the cNGN), rounded up to whole
 * naira. Indicative only: the price a job is actually hired at is fixed
 * by the server at hire time (see createHire), so a rate move between
 * this quote and the hire never changes what the customer pays.
 * USDT needs no quote — a job is always $1.
 */
import { NextResponse } from "next/server";
import { cngnJobPrice } from "@ikenga/payments";
import { liveCngnUsdPreviewBuyAmount } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const currency = new URL(req.url).searchParams.get("currency");
  if (currency !== "cNGN") {
    return NextResponse.json({
      currency: "USDT",
      priceAtomic: "1000000",
      priceDisplay: "$1",
      rate: null,
      note: "A job is $1. Pay in USDT, or in cNGN at the live naira rate.",
    });
  }
  try {
    const buyAmount = await liveCngnUsdPreviewBuyAmount();
    const fixed = cngnJobPrice(buyAmount);
    return NextResponse.json({
      currency: "cNGN",
      priceAtomic: fixed.priceAtomic.toString(),
      priceDisplay: `${fixed.priceCngn} cNGN`,
      rate: fixed.rateCngnPerUsd,
      note: `About ${fixed.rateCngnPerUsd} cNGN per $1 right now. The price is fixed when the job is hired.`,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Could not read the live naira rate right now — pay in USDT, or try again in a moment.",
      },
      { status: 502 },
    );
  }
}
