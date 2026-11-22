/** Ikenga agent runner CLI — Step 2: runs one job through the real loop. No money moves unless live deps are injected (see e2e-sepolia.ts). */
import { AgentRunner } from "./agent.js";

const runner = new AgentRunner();
const result = await runner.runJob({
  jobType: "website",
  toolCostUsdc: 0.6,
  accepted: 0,
  quoted: 0,
  agentId: process.env.SELF_AGENT_ID ?? "0",
  agentAddress: process.env.SELF_AGENT_ADDRESS ?? "0x0000000000000000000000000000000000000000",
  orderId: "ord_demo_1",
});
console.log(JSON.stringify(result, null, 2));
console.log("\nNote: with no registered Self agent this run refuses at the Self gate (fail-closed).");
console.log("Register an agent (Self app QR scan) and set SELF_AGENT_ID / SELF_AGENT_ADDRESS to proceed.");
