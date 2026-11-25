import { expect, it } from "vitest";
import { publicActivity } from "./publicActivity";
it("returns totals without job IDs, wallet addresses, briefs, or decision text", () => {
  const data = publicActivity({mode:"live", verify:{ok:true,entries:1}, summary:{jobs:4,done:4,settled:4,customers:4,firstDoneJobId:"secret-job"}, decisions:[{orderId:"secret-job",reason:"private customer brief",txHash:"0x123"}], jobs:[{customerWallet:"secret-wallet"}]});
  expect(data.summary.jobs).toBe(4);
  expect(data.onchainDecisions).toBe(1);
  expect(JSON.stringify(data)).not.toMatch(/secret-job|secret-wallet|private customer brief|firstDoneJobId/);
});
