import { requireJobsAccess } from "@/lib/jobAccess";
import { NextResponse } from "next/server";
import { createHire, ledgerBackend, listHires } from "@/lib/jobs";

export async function GET(request: Request) {
  const access = await requireJobsAccess(request);
  if (access instanceof Response) return access;
  return NextResponse.json({
    jobs: (await listHires()).filter(job => access.worker || job.customerWallet.toLowerCase() === access.address!.toLowerCase()),
    backend: ledgerBackend(),
    demo: ledgerBackend() === "memory",
    note: "Step 3: hires live in Postgres when DATABASE_URL is set, otherwise in memory. The $1 for a job goes into its own escrow contract first: the browser deploys the escrow, posts it here, then pays the $1 in — only then does the team start. Accepting the work releases the $1 to the team; turning it down sends it back.",
  }, { headers: { "cache-control": "private, no-store", "vary": "Cookie" } });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const access = await requireJobsAccess(req);
    if (access instanceof Response) return access;
    if (access.worker || typeof body.customerWallet !== "string" || body.customerWallet.toLowerCase() !== access.address!.toLowerCase()) return NextResponse.json({ error: "Create jobs with your verified wallet." }, { status: 403 });
    const hire = await createHire(body);
    return NextResponse.json({ job: hire, demo: true }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
