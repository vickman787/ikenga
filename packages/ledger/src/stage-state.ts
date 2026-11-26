import type { StoredReportData } from './index.js';
export interface StageLease {
    token: string;
    expiresAt: number;
    pendingUsd: number;
}
export interface StageChange {
    report: StoredReportData;
    orderStatus?: string;
}
const money = (n: number) => Math.round(n * 1e6) / 1e6;
const active = (r: StoredReportData, token: string, now: number) => r.stageLease?.token === token && r.stageLease.expiresAt > now;
export function claimStage(r: StoredReportData, status: string, stage: number, token: string, now: number): StageChange | null {
    if (status !== 'in-progress' || r.status !== 'in-progress' || r.stage !== stage || r.stageLease && r.stageLease.expiresAt > now)
        return null;
    return { report: { ...r, stageLease: { token, expiresAt: now + 150000, pendingUsd: 0 } } };
}
export function reserveStage(r: StoredReportData, status: string, token: string, amount: number, now: number): StageChange | null {
    if (status !== 'in-progress' || !active(r, token, now) || r.stageLease!.pendingUsd !== 0 || !Number.isFinite(amount) || amount <= 0)
        return null;
    const reserved = Math.ceil(amount * 1e6) / 1e6;
    if (money(r.totalCostUsd + reserved) > .5)
        return null;
    return { report: { ...r, totalCostUsd: money(r.totalCostUsd + reserved), stageLease: { ...r.stageLease!, pendingUsd: reserved } } };
}
export function settleStage(r: StoredReportData, token: string, actual: number, now: number): StageChange | null {
    if (!active(r, token, now) || !Number.isFinite(actual) || actual < 0)
        return null;
    const total = money(r.totalCostUsd - r.stageLease!.pendingUsd + actual);
    return { report: { ...r, totalCostUsd: total, stageLease: { ...r.stageLease!, pendingUsd: 0 } } };
}
export function completeStage(r: StoredReportData, status: string, token: string, result: StoredReportData, now: number): StageChange | null {
    if (status !== 'in-progress' || !active(r, token, now) || r.stageLease!.pendingUsd !== 0)
        return null;
    const { stageLease: _, ...content } = result;
    const report = { ...content, totalCostUsd: r.totalCostUsd };
    if (report.totalCostUsd > .5) {
        report.status = 'refused';
        report.stage = 0;
        report.reason = 'The job reached its AI spending limit.';
        report.report = '';
        report.html = '';
        report.slides = [];
    }
    return { report, orderStatus: report.status === 'delivered' ? 'delivered' : report.status === 'refused' ? 'escrowed' : 'in-progress' };
}
export function abandonStage(r: StoredReportData, token: string): StageChange | null {
    if (r.stageLease?.token !== token)
        return null;
    // An uncertain call keeps its reservation. Only the lease is released.
    const { stageLease: _, ...report } = r;
    return { report };
}
export function startStage(previous: StoredReportData, status: string, initial: StoredReportData): StageChange | null {
    if (status !== 'escrowed' && status !== 'delivered')
        return null;
    if (previous.stageLease && previous.stageLease.expiresAt > Date.now())
        return null;
    const report = { ...initial };
    if (previous.generatorVersion === 2) {
        report.totalCostUsd = previous.totalCostUsd;
        report.totalTokens = previous.totalTokens;
        report.steps = [...previous.steps];
    }
    if (report.totalCostUsd >= .5)
        return null;
    return { report, orderStatus: 'in-progress' };
}
