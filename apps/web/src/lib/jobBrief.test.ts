import {describe,expect,it} from 'vitest';
import {composeJobBrief} from './jobBrief';
import {creativeToProgress,reportToProgress,progressToCreative,progressToReport,emptyStoredCreative,emptyStoredReport,HireInputSchema} from './jobs';
describe('New briefs and saved pipeline compatibility',()=>{
 it('requires business and contact before creating a guided creative brief',()=>{
  expect(()=>composeJobBrief('website','Rice ₦2500',{businessName:'Ada'})).toThrow('Contact');
  expect(composeJobBrief('website','Rice ₦2500',{businessName:'Ada',contact:'Call 08031234567',brand:'Burgundy and cream'})).toContain('Brand colours and style: Burgundy and cream');
 });
 it('requires research subjects and region and excludes unrelated creative fields',()=>{
  const brief=composeJobBrief('market-report','Compare fees and settlement time.',{subjects:'Paystack and Moniepoint',region:'Nigeria, current',businessName:'Do not include'});
  expect(brief).toContain('Paystack and Moniepoint');expect(brief).not.toContain('Do not include');
 });
 it('accepts legacy API briefs and rejects oversized input',()=>{
  expect(composeJobBrief('website',' An old simple brief ')).toBe('An old simple brief');
  expect(HireInputSchema.safeParse({jobType:'website',description:'a'.repeat(4001),customerWallet:'0x'+'1'.repeat(40)}).success).toBe(false);
 });
 it('starts new deliveries in version 2 without changing old saved progress',()=>{
  const modern=emptyStoredCreative('website');expect(modern.generatorVersion).toBe(2);
  const legacy={...modern,generatorVersion:undefined,html:'<h1>Original sealed work</h1>',status:'delivered' as const,stage:0};
  const progress=creativeToProgress(legacy,'Original brief','website');expect(progress.generatorVersion).toBe(1);
  expect(progressToCreative(progress).html).toBe(legacy.html);
 });
 it('round-trips research version, plan and cursors between stage requests',()=>{
  const stored={...emptyStoredReport(),researchPlan:{subjects:['Paystack'],questions:['fees'],queries:['Paystack fees']},searchCursor:1,readCursor:2};
  expect(stored.stage).toBe(10);const result=progressToReport(reportToProgress(stored,'Compare fees'));
  expect(result.researchPlan).toEqual(stored.researchPlan);expect(result.searchCursor).toBe(1);expect(result.readCursor).toBe(2);expect(result.generatorVersion).toBe(2);
 });
});
