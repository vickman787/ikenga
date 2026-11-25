import { keccak256, toHex, type Address, type Hex } from "viem";
interface WorkerSigner { address: Address; signMessage(args: {message: string}): Promise<Hex> }
/** A request signature proves worker identity; it never authorizes an onchain transaction. */
export async function signedWorkerRequest(url: string, init: RequestInit | undefined, account: WorkerSigner): Promise<RequestInit> {
  const target = new URL(url);
  const timestamp = Date.now().toString();
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const message = ["Ikenga worker request v1", target.origin, method, target.pathname + target.search, timestamp, keccak256(toHex(body))].join("\n");
  const signature = await account.signMessage({message});
  const headers = new Headers(init?.headers);
  headers.set("x-ikenga-worker-address", account.address);
  headers.set("x-ikenga-worker-time", timestamp);
  headers.set("x-ikenga-worker-signature", signature);
  return {...init, headers};
}
