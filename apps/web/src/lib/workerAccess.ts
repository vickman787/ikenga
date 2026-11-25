import { requestOrigin } from "@/lib/walletSession";
import { createPublicClient, http, keccak256, parseAbi, toHex, verifyMessage, type Address, type Hex } from "viem";
import deployment from "../../../../contracts/deployments/celo.json";
export function workerMessage(request: Request, timestamp: string, body: string) {
  const url = new URL(request.url);
  return ["Ikenga worker request v1", requestOrigin(request), request.method.toUpperCase(), url.pathname + url.search, timestamp, keccak256(toHex(body))].join("\n");
}
export function workerScope(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (request.method === "GET" && /^\/api\/jobs(?:\/[^/]+)?$/.test(path)) ||
    (request.method === "POST" && /^\/api\/jobs\/[^/]+\/(?:deliverable|run\/step)$/.test(path));
}
export async function workerAccess(request: Request): Promise<boolean> {
  const signature = request.headers.get("x-ikenga-worker-signature");
  const timestamp = request.headers.get("x-ikenga-worker-time");
  const address = request.headers.get("x-ikenga-worker-address");
  if (!workerScope(request) || !signature || !/^0x[0-9a-fA-F]{130}$/.test(signature) || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000 || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  try {
    const message = workerMessage(request, timestamp, await request.clone().text());
    if (!await verifyMessage({ address: address as Address, message, signature: signature as Hex })) return false;
    // Authority comes from the deployed vault, never from an incoming address header.
    const sepolia = process.env.IKENGA_CHAIN === "sepolia";
    const vault = (process.env.IKENGA_VAULT_ADDRESS ?? (sepolia ? "" : deployment.IkengaVault)) as Address;
    if (!vault) return false;
    const rpc = sepolia ? process.env.CELO_SEPOLIA_RPC_URL : process.env.CELO_RPC_URL;
    const client = createPublicClient({ transport: http(rpc ?? (sepolia ? "https://rpc.ankr.com/celo_sepolia" : "https://rpc.ankr.com/celo"), { timeout: 10_000, retryCount: 0 }) });
    const boss = await client.readContract({ address: vault, abi: parseAbi(["function boss() view returns (address)"]), functionName: "boss" });
    return boss.toLowerCase() === address.toLowerCase();
  } catch { return false; }
}
