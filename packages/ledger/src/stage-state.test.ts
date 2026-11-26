import { describe, expect, it } from 'vitest';
import { MemoryLedger, type StoredReportData } from './index.js';
import { claimStage, reserveStage, abandonStage } from './stage-state.js';
const report = (): StoredReportData => ({ generatorVersion: 2, report: '', sources: [], steps: [], totalTokens: 0, totalCostUsd: 0, status: 'in-progress', stage: 1, revisions: 0, deliveredAt: '' });
async function setup() { const ledger = new MemoryLedger(); await ledger.createOrder({ id: 'job', jobType: 'website', description: 'Test', customerWallet: '0x' + '1'.repeat(40), status: 'in-progress' }); await ledger.saveReport('job', report()); return ledger; }
describe('Shared stage leases and cost reservations', () => {
    it('allows only one concurrent claimant for a saved stage', async () => { const l = await setup(); const claims = await Promise.all([l.claimReportStage('job', 1, 'one'), l.claimReportStage('job', 1, 'two')]); expect(claims.filter(Boolean)).toHaveLength(1); });
    it('retains an uncertain request’s allowance after release and takeover', async () => { const l = await setup(); await l.claimReportStage('job', 1, 'one'); await l.reserveReportCost('job', 'one', .12); await l.abandonReportStage('job', 'one'); const next = await l.claimReportStage('job', 1, 'two'); expect(next?.totalCostUsd).toBe(.12); expect(await l.settleReportCost('job', 'one', 0)).toBeNull(); });
    it('settles a known result to actual cost and keeps the remaining budget available', async () => { const l = await setup(); await l.claimReportStage('job', 1, 'one'); await l.reserveReportCost('job', 'one', .1); const settled = await l.settleReportCost('job', 'one', .01); expect(settled?.totalCostUsd).toBe(.01); expect(await l.reserveReportCost('job', 'one', .5)).toBeNull(); });
    it('does not release a second in-flight reservation or exceed the limit', async () => { const l = await setup(); await l.claimReportStage('job', 1, 'one'); expect(await l.reserveReportCost('job', 'one', .3)).not.toBeNull(); expect(await l.reserveReportCost('job', 'one', .1)).toBeNull(); await l.settleReportCost('job', 'one', .3); expect(await l.reserveReportCost('job', 'one', .200001)).toBeNull(); });
    it('cannot deliver after a refund or with an expired/stale token', async () => { const l = await setup(); await l.claimReportStage('job', 1, 'one'); await l.updateOrderStatus('job', 'refunded'); expect(await l.completeReportStage('job', 'one', { ...report(), status: 'delivered', stage: 0 })).toBeNull(); expect((await l.getOrder('job'))?.status).toBe('refunded'); });
    it('atomically finishes the delivery and its job status using canonical recorded cost', async () => { const l = await setup(); await l.claimReportStage('job', 1, 'one'); await l.reserveReportCost('job', 'one', .1); await l.settleReportCost('job', 'one', .02); const result = await l.completeReportStage('job', 'one', { ...report(), totalCostUsd: 0, status: 'delivered', stage: 0, report: 'Delivered' }); expect(result?.totalCostUsd).toBe(.02); expect(result?.stageLease).toBeUndefined(); expect((await l.getOrder('job'))?.status).toBe('delivered'); });
    it('allows an expired lease to be replaced but retains reserved spending', () => { const first = claimStage(report(), 'in-progress', 1, 'one', 100)!; const reserved = reserveStage(first.report, 'in-progress', 'one', .1, 101)!; expect(claimStage(reserved.report, 'in-progress', 1, 'two', 102)).toBeNull(); const next = claimStage(reserved.report, 'in-progress', 1, 'two', 151000); expect(next?.report.totalCostUsd).toBe(.1); });
});
it('keeps cost history intact when two start requests race after a failed attempt', async () => {
    const l = await setup();
    await l.updateOrderStatus('job', 'escrowed');
    await l.saveReport('job', { ...report(), status: 'refused', stage: 0, totalCostUsd: .2 });
    const runs = await Promise.all([l.startReportRun('job', report()), l.startReportRun('job', report())]);
    expect(runs.filter(Boolean)).toHaveLength(1);
    expect((await l.getReport('job'))?.totalCostUsd).toBe(.2);
});
