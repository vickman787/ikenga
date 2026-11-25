import { NextResponse } from "next/server";
import { getHire } from "@/lib/jobs";
import { privateJson, sameOrigin, walletSession } from "@/lib/walletSession";
import { workerAccess } from "@/lib/workerAccess";
/** Every job handler calls this itself; proxy headers never establish identity. */
export async function requireJobsAccess(request: Request): Promise<{address: string | null; worker: boolean} | NextResponse> {
  const session = walletSession(request);
  if (session) {
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) return privateJson({error:"Use the Ikenga site to manage your jobs."},403);
    return {address:session.address,worker:false};
  }
  if (await workerAccess(request)) return {address:null,worker:true};
  return privateJson({error:"Sign in with the wallet that owns this job.",code:"SIGN_IN_REQUIRED"},401);
}
export async function requireJobAccess(request: Request, id: string): Promise<NextResponse | null> {
  const access = await requireJobsAccess(request);
  if (access instanceof Response) return access;
  if (access.worker) return null;
  const job = await getHire(id);
  if (!job || job.customerWallet.toLowerCase() !== access.address!.toLowerCase()) return privateJson({error:"This job is not available to this wallet."},404);
  return null;
}
