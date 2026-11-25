import { expect, it } from "vitest";
import { publicActivity, publicTraction } from "./publicActivity";
it("returns totals without job IDs, wallet addresses, briefs, or decision text", () => {
  const data = publicActivity({mode:"live", backend:"postgres", verify:{ok:true,entries:122,ordersChecked:11}, summary:{jobs:4,done:4,settled:4,customers:4,excludedTestJobs:7,firstDoneJobId:"secret-job"}, decisions:[{orderId:"secret-job",reason:"private customer brief",txHash:"0x123"}], jobs:[{customerWallet:"secret-wallet"}]});
  expect(data.summary).toEqual({jobs:4,done:4,settled:4,customers:4});
  expect(data.verify).toEqual({ok:true});
  expect(data).not.toHaveProperty("backend");
  expect(data).not.toHaveProperty("mode");
  expect(data.onchainDecisions).toBe(1);
  expect(JSON.stringify(data)).not.toMatch(/secret-job|secret-wallet|private customer brief|firstDoneJobId/);
});

it("removes operational fields from legacy public traction responses", () => {
  expect(publicTraction({jobsStarted:4,customers:4,backend:"postgres",decisions:122,x402:{failed:5},fxSwaps:3})).toEqual({jobsStarted:4,customers:4});
});
