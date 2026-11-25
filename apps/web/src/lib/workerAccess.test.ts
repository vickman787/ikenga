import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
const {readContract} = vi.hoisted(() => ({readContract: vi.fn()}));
vi.mock("viem", async original => ({...await original<typeof import("viem")>(), createPublicClient: () => ({readContract})}));
import { workerAccess, workerMessage } from "./workerAccess";
const boss = privateKeyToAccount(("0x" + "3".repeat(64)) as Hex);
const attacker = privateKeyToAccount(("0x" + "4".repeat(64)) as Hex);
beforeEach(() => {readContract.mockReset(); readContract.mockResolvedValue(boss.address);});
afterEach(() => vi.unstubAllEnvs());
async function signed(path="/api/jobs/id/run/step", method="POST", body="", account=boss, timestamp=Date.now().toString()) {
  const request = new Request("https://ikenga.example" + path, {method, ...(body ? {body} : {})});
  const signature = await account.signMessage({message:workerMessage(request,timestamp,body)});
  const headers = {"x-ikenga-worker-address":account.address,"x-ikenga-worker-time":timestamp,"x-ikenga-worker-signature":signature};
  return new Request(request, {headers});
}
describe("worker authorization", () => {
  it("accepts the deployed vault boss for worker reads and stages", async () => {
    expect(await workerAccess(await signed())).toBe(true);
    expect(await workerAccess(await signed("/api/jobs", "GET"))).toBe(true);
    expect(readContract).toHaveBeenCalled();
  });
  it("rejects forged authority, stale signatures, changed bodies, paths, and unscoped actions", async () => {
    expect(await workerAccess(await signed(undefined,undefined,undefined,attacker))).toBe(false);
    expect(await workerAccess(await signed(undefined,undefined,undefined,boss,(Date.now()-61_000).toString()))).toBe(false);
    const request = await signed("/api/jobs/id/deliverable", "POST", '{"txHash":"original"}');
    expect(await workerAccess(new Request(request.url,{method:"POST",headers:request.headers,body:'{"txHash":"different"}'}))).toBe(false);
    expect(await workerAccess(new Request("https://ikenga.example/api/jobs/another/run/step",{method:"POST",headers:(await signed()).headers}))).toBe(false);
    expect(await workerAccess(await signed("/api/jobs/id/decision"))).toBe(false);
    expect(await workerAccess(await signed("/api/jobs", "POST"))).toBe(false);
  });
  it("denies unsigned visitors without making a chain request", async () => {
    expect(await workerAccess(new Request("https://ikenga.example/api/jobs"))).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });
});

import { signedWorkerRequest } from "../../../../apps/agent/src/worker-auth";
it("accepts the actual worker client's signed request without changing its payload", async () => {
  readContract.mockResolvedValue(boss.address);
  const url = "https://ikenga.example/api/jobs/id/deliverable";
  const init = {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({txHash:"0x123"})};
  const signed = await signedWorkerRequest(url,init,boss);
  expect(signed.body).toBe(init.body);
  expect(new Headers(signed.headers).get("content-type")).toBe("application/json");
  expect(await workerAccess(new Request(url,signed))).toBe(true);
});

it("verifies a real client signature when Next canonicalizes its internal hostname", async () => {
  readContract.mockResolvedValue(boss.address);
  const url = "http://127.0.0.1:3002/api/jobs";
  const signed = await signedWorkerRequest(url, {method:"GET"},boss);
  const headers = new Headers(signed.headers);headers.set("host","127.0.0.1:3002");
  expect(await workerAccess(new Request("http://localhost:3002/api/jobs",{method:"GET",headers}))).toBe(true);
});
