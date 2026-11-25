import { requireJobAccess } from "@/lib/jobAccess";
import { GET as jobDetail } from "@/app/api/jobs/[id]/route";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { connectInjected } from "./lib/contracts";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("read-only UI review deployment", () => {
  it("leaves normal application requests untouched when the preview flag is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await proxy(new NextRequest("https://preview.example/api/vault"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refuses writes before they can reach production", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "1");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await proxy(new NextRequest("https://preview.example/api/jobs", { method: "POST" }));
    expect(response.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reads existing currency data without forwarding credentials", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "1");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ vaults: [{ currency: "USDT" }, { currency: "cNGN" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxy(new NextRequest("https://preview.example/api/vault", { headers: { cookie: "private=secret", authorization: "Bearer private" } }));
    expect(response.status).toBe(200);
    expect((await response.json()).vaults.map((v: { currency: string }) => v.currency)).toEqual(["USDT", "cNGN"]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://www.useikenga.xyz/api/vault");
    expect(options.headers).toEqual({ accept: "application/json" });
  });
  it("refuses unlisted endpoints instead of running local handlers", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "1");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await proxy(new NextRequest("https://preview.example/api/private-admin"))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("blocks wallet connection before a wallet provider is requested", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "1");
    const request = vi.fn(); vi.stubGlobal("window", { ethereum: { request } });
    await expect(connectInjected()).rejects.toThrow("preview is read-only");
    expect(request).not.toHaveBeenCalled();
  });
});


// Cross-wallet authorization tests exercise the same proxy boundary used by Next.
import { beforeEach } from "vitest";
import { MemoryLedger } from "@ikenga/ledger";
import { createHire, setLedgerForTests } from "@/lib/jobs";
import { signToken, SESSION_COOKIE } from "@/lib/walletSession";
import { GET as listJobs, POST as createJob } from "@/app/api/jobs/route";
const OWNER = "0x0000000000000000000000000000000000000002";
const OTHER = "0x0000000000000000000000000000000000000003";
const SITE = "https://ikenga.example";
function ownerRequest(path: string, address?: typeof OWNER | typeof OTHER, method="GET") {
  const value = address ? SESSION_COOKIE + "=" + signToken({kind:"session",address,origin:SITE,expires:Date.now()+60_000}) : "";
  return new NextRequest(SITE+path,{method,headers:{cookie:value,origin:SITE,"x-ikenga-verified-access":"worker"}});
}
describe("private job authorization boundary",()=>{
  let id: string;
  beforeEach(async()=>{
    vi.stubEnv("IKENGA_SESSION_SECRET","test-secret-with-at-least-32-characters");
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY","");
    setLedgerForTests(new MemoryLedger());
    id=(await createHire({jobType:"website",description:"A website for my bakery",customerWallet:OWNER,payCurrency:"USDT"})).id;
    await createHire({jobType:"flyers",description:"A flyer for my cafe",customerWallet:OTHER,payCurrency:"USDT"});
  });
  afterEach(()=>setLedgerForTests(new MemoryLedger()));
  it("blocks anonymous lists, details, and every mutation despite forged access headers",async()=>{
    expect((await listJobs(ownerRequest("/api/jobs"))).status).toBe(401);
    expect((await jobDetail(ownerRequest("/api/jobs/"+id),{params:Promise.resolve({id})})).status).toBe(401);
    for(const [path,method] of [["/api/jobs","GET"],["/api/jobs/"+id,"GET"],...["run","run/step","fund","escrow","decision","deliverable"].map(p=>["/api/jobs/"+id+"/"+p,"POST"])]) expect((await requireJobAccess(ownerRequest(path,undefined,method),id))?.status).toBe(401);
  });
  it("allows only owners and returns only their history",async()=>{
    const allowed=await jobDetail(ownerRequest("/api/jobs/"+id,OWNER),{params:Promise.resolve({id})});
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).job.id).toBe(id);
    expect(allowed.headers.get("cache-control")).toContain("no-store");
    expect((await jobDetail(ownerRequest("/api/jobs/"+id,OTHER),{params:Promise.resolve({id})})).status).toBe(404);
    const data=await (await listJobs(ownerRequest("/api/jobs",OWNER))).json();
    expect(data.jobs.map((job:{id:string})=>job.id)).toEqual([id]);
    const denied=await createJob(new Request(SITE+"/api/jobs",{method:"POST",headers:{"x-ikenga-verified-access":"worker",cookie:ownerRequest("/api/jobs",OWNER).headers.get("cookie")!,origin:SITE,"content-type":"application/json"},body:JSON.stringify({jobType:"website",description:"A website",customerWallet:OTHER})}));
    expect(denied.status).toBe(403);
  });
  it("filters legacy preview reads on the server without forwarding browser credentials",async()=>{
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY","1");
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({jobs:[{id:"mine",customerWallet:OWNER},{id:"other",customerWallet:OTHER}]})));
    vi.stubGlobal("fetch",fetchMock);
    expect((await (await proxy(ownerRequest("/api/jobs",OWNER))).json()).jobs.map((job:{id:string})=>job.id)).toEqual(["mine"]);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({accept:"application/json"});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({job:{customerWallet:OTHER,description:"private brief"},report:{html:"private work"}})));
    const denied=await proxy(ownerRequest("/api/jobs/any",OWNER));
    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toContain("private");
    expect((await proxy(ownerRequest("/api/auth/challenge",undefined,"POST"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(ownerRequest("/api/jobs/"+id+"/decision",OWNER,"POST"))).status).toBe(405);
  });
});
