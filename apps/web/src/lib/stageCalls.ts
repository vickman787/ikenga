import type { Ledger } from '@ikenga/ledger';
import { chatOpenAI, generateImageOpenAI, promptTokenUpperBound, worstCaseCostUsd } from '@ikenga/agent';
export class StageBudgetError extends Error {
}
/** Reserve in the shared ledger before each paid call; uncertain calls retain their allowance. */
export function reservedStageCalls(ledger: Ledger, id: string, token: string) {
    async function reserve(amount: number) { if (!await ledger.reserveReportCost(id, token, amount))
        throw new StageBudgetError('This step cannot start within the job’s remaining AI budget.'); }
    async function settle(amount: number) { if (!await ledger.settleReportCost(id, token, amount))
        throw new Error('This processing lease has expired.'); }
    return {
        chat: async (input: Parameters<typeof chatOpenAI>[0]) => {
            const allowance = worstCaseCostUsd(input.model, promptTokenUpperBound(JSON.stringify(input)), input.maxTokens ?? 1024);
            await reserve(allowance);
            let reply;
            try {
                reply = await chatOpenAI(input);
            }
            catch (error) {
                await settle(allowance);
                throw error;
            }
            const cost = reply.usageEstimated ? allowance : reply.costUsd;
            await settle(cost);
            return { ...reply, costUsd: cost };
        },
        image: async (input: {
            prompt: string;
        }) => {
            const allowance = .1;
            await reserve(allowance);
            let result;
            try {
                result = await generateImageOpenAI(input);
            }
            catch (error) {
                await settle(allowance);
                throw error;
            }
            const cost = result.usageEstimated ? allowance : result.costUsd;
            await settle(cost);
            return { ...result, costUsd: cost };
        },
    };
}
