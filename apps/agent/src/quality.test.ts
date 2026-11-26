import {describe,expect,it} from 'vitest';
import {qualityPassed} from './quality.js';
import {parseResearchPlan,relevantResearchPage,relevantExcerpt,researchCoveragePassed,researchRequirements} from './research.js';
import {emptyCreativeProgress,runCreativeStage,creativeRevisionProgress,CREATIVE_STAGE_AUDIT,CREATIVE_STAGE_REAUDIT,CREATIVE_STAGE_CHECK} from './creative.js';
import {emptyReportProgress,revisionProgress,runReportStage,REPORT_STAGE_READ,REPORT_STAGE_REAUDIT_FINAL} from './report.js';
import type {OpenAIReply} from './openai.js';
const plan={subjects:['Paystack','Moniepoint'],questions:['fees','settlement time'],queries:['Paystack official fees settlement Nigeria','Moniepoint official fees settlement Nigeria']};
const pass=JSON.stringify({verdict:'PASS',issues:[]});
const fix=JSON.stringify({verdict:'FIX',issues:['Missing settlement time.']});
const reply=(text:string,costUsd=.001):OpenAIReply=>({model:'gpt-4o',text,usage:{promptTokens:100,completionTokens:100,totalTokens:200},costUsd});
const facts={businessName:'Ada',whatItDoes:'Food shop',services:['Rice'],prices:[{item:'Rice',price:'₦2500',listed:true}],contact:'08031234567',colours:'burgundy',notes:''};
const creative=()=>({...emptyCreativeProgress('Ada sells rice for ₦2500. Call 08031234567.','website'),generatorVersion:2 as const,facts,html:'<h1>Ada</h1><p>Rice ₦2500, call 08031234567.</p>',stage:CREATIVE_STAGE_REAUDIT,revisions:1,checkText:pass});
describe('Version 2 delivery gates',()=>{
 it('rejects prose, contradictory or malformed PASS verdicts',()=>{
  expect(qualityPassed('PASS')).toBe(false);
  expect(qualityPassed('{"verdict":"PASS","issues":["Wrong price"]}')).toBe(false);
  expect(qualityPassed(pass)).toBe(true);
 });
 it('never delivers after a second FIX and never emits a sealing receipt',async()=>{
  const result=await runCreativeStage(creative(),{chat:async()=>reply(fix)});
  expect(result.status).toBe('refused');expect(result.stage).toBe(0);expect(result.steps.some(s=>s.agent==='Messenger')).toBe(false);
 });
 it('does not let an auditor PASS override failed analyst checks',async()=>{
  const result=await runCreativeStage({...creative(),checkText:fix},{chat:async()=>reply(pass)});
  expect(result.status).toBe('refused');
 });
 it('delivers only after both checks pass',async()=>{
  const result=await runCreativeStage(creative(),{chat:async()=>reply(pass)});
  expect(result.status).toBe('delivered');expect(result.steps.at(-1)?.agent).toBe('Messenger');
 });
 it('reruns checks after a correction and re-extracts facts for customer revisions',()=>{
  const revised=creativeRevisionProgress(creative(),'The phone is now 08030000000.');
  expect(revised.generatorVersion).toBe(2);expect(revised.stage).toBe(1);expect(revised.facts).toBeNull();
 });
 it('accounts for an empty reply once instead of silently doubling the paid call',async()=>{
  let calls=0;const deps={chat:async()=>{calls++;return reply('');}};
  const first=await runCreativeStage({...creative(),stage:CREATIVE_STAGE_AUDIT,revisions:0},deps);
  expect(first.stage).toBe(7);expect(calls).toBe(1);
  const result=await runCreativeStage(first,deps);
  expect(result.status).toBe('refused');expect(calls).toBe(2);expect(result.totalCostUsd).toBe(.002);
 });
 it('uses the actual output allowance for the budget check before an audit',async()=>{
  let calls=0;const result=await runCreativeStage({...creative(),totalCostUsd:.49},{chat:async()=>{calls++;return reply(pass);}});
  expect(result.status).toBe('refused');expect(calls).toBe(0);
 });
 it('preserves the original pipeline for unversioned saved work',async()=>{
  const result=await runCreativeStage({...creative(),generatorVersion:undefined},{chat:async()=>reply('FIX\nStill needs a change.')});
  expect(result.status).toBe('delivered');
 });
});
describe('Research coverage and retrieval',()=>{
 it('requires a bounded usable research plan',()=>{
  expect(parseResearchPlan(JSON.stringify(plan))).toEqual(plan);
  expect(parseResearchPlan('{"subjects":[],"questions":[],"queries":[]}')).toBeNull();
 });
 it('rejects the historical unrelated football source',()=>{
  expect(relevantResearchPage({title:'Victor Osimhen',url:'https://example.com/football',text:'A footballer in Nigeria, known around the world.'},plan)).toBe(false);
  expect(relevantResearchPage({title:'Paystack pricing',url:'https://paystack.com/pricing',text:'Paystack local transaction fees.'},plan)).toBe(true);
 });
 it('extracts relevant evidence beyond a long navigation prefix',()=>{
  const page={title:'Fees',url:'https://example.com',text:('Browse our navigation and latest updates. ').repeat(100)+'Paystack settlement time is the next working day. Fees are 1.5%.'};
  expect(relevantExcerpt(page,plan,300)).toContain('settlement time');
 });
 it('requires every subject-by-question cell with valid source identifiers',()=>{
  const coverage=researchRequirements(plan).map(r=>({id:r.id,status:'met',sourceIds:[1]}));
  expect(researchCoveragePassed(JSON.stringify({verdict:'PASS',issues:[],coverage}),plan,1)).toBe(true);
  expect(researchCoveragePassed(JSON.stringify({verdict:'PASS',issues:[],coverage:coverage.slice(1)}),plan,1)).toBe(false);
  expect(researchCoveragePassed(JSON.stringify({verdict:'PASS',issues:[],coverage:coverage.map(c=>({...c,sourceIds:[99]}))}),plan,1)).toBe(false);
 });
 it('never accepts a final PASS over missing factual coverage',async()=>{
  const result=await runReportStage({...emptyReportProgress('Compare Paystack and Moniepoint fees and settlement'),generatorVersion:2,researchPlan:plan,stage:REPORT_STAGE_REAUDIT_FINAL,revisions:1,report:'Fees were unavailable.',auditFacts:fix},{chat:async()=>reply(pass)});
  expect(result.status).toBe('refused');expect(result.steps.some(s=>s.agent==='Messenger')).toBe(false);
 });
 it('persists research planning before making searches',async()=>{
  let searches=0;const result=await runReportStage({...emptyReportProgress('Compare providers'),generatorVersion:2,stage:10},{chat:async()=>reply(JSON.stringify(plan)),searchBing:async()=>{searches++;return [];}});
  expect(result.researchPlan).toEqual(plan);expect(result.stage).toBe(1);expect(searches).toBe(0);
 });
 it('reads only a bounded batch per stage and preserves its cursor',async()=>{
  const candidates=Array.from({length:5},(_,i)=>({title:'Paystack fees',url:'https://example.com/'+i}));let reads=0;
  const result=await runReportStage({...emptyReportProgress('Compare Paystack'),generatorVersion:2,researchPlan:plan,stage:REPORT_STAGE_READ,candidates},{fetchPage:async url=>{reads++;return {title:'Paystack',url,text:'Paystack transaction fees and settlement time.'};}});
  expect(reads).toBe(2);expect(result.readCursor).toBe(2);expect(result.stage).toBe(REPORT_STAGE_READ);expect(result.pages[0].retrievedAt).toBeTruthy();
 });
});

it('blocks an invented price even when both model verdicts are PASS',async()=>{
 const result=await runCreativeStage({...creative(),html:'<h1>Ada</h1><p>Rice ₦9999</p>'},{chat:async()=>reply(pass)});
 expect(result.status).toBe('refused');expect(result.reason).toContain('Unconfirmed price');
});

it('does not accept a naira amount silently changed into dollars',async()=>{
 const result=await runCreativeStage({...creative(),html:'<h1>Ada</h1><p>Rice $2500</p>'},{chat:async()=>reply(pass)});
 expect(result.status).toBe('refused');
});

it('finishes the complete upgraded research pipeline with a coverage-backed report',async()=>{
 let state={...emptyReportProgress('Compare Paystack and Moniepoint fees and settlement time in Nigeria'),generatorVersion:2 as const,stage:10};
 const report='| Provider | Fees | Settlement |\n|---|---|---|\n| Paystack | 1.5% [1] | Next working day [1] |\n| Moniepoint | 1% [2] | Next working day [2] |';
 const chat=async(input:{messages:{content:string}[]})=>{
  const prompt=input.messages.map(m=>m.content).join('\n');
  if(prompt.includes('Plan research'))return reply(JSON.stringify(plan));
  if(prompt.includes('checking the facts'))return reply(JSON.stringify({verdict:'PASS',issues:[],coverage:researchRequirements(plan).map((r,i)=>({id:r.id,status:'met',sourceIds:[i<2?1:2]}))}));
  if(prompt.includes('final read'))return reply(pass);
  if(prompt.includes('You are Writer'))return reply(report);
  return reply('Use official fees and settlement documentation. ALL NUMBERS CHECK OUT');
 };
 let stages=0;
 while(state.status==='in-progress' && stages++<35){
  state=await runReportStage(state,{chat,searchBing:async()=>[{title:'Paystack pricing',url:'https://paystack.com/pricing'},{title:'Moniepoint pricing',url:'https://moniepoint.com/pricing'}],fetchPage:async url=>({title:url,url,text:url.includes('paystack')?'Paystack fees are 1.5%. Settlement next working day.':'Moniepoint fees are 1%. Settlement next working day.'})}) as typeof state;
 }
 expect(state.status).toBe('delivered');expect(state.report).toContain('Moniepoint');expect(state.sources).toHaveLength(2);expect(state.steps.at(-1)?.agent).toBe('Messenger');expect(stages).toBeLessThan(35);
});

it('finds evidence after a navigation prefix without sentence punctuation',()=>{
 const page={title:'Official fees',url:'https://example.com',text:'Navigation menu services about help '.repeat(200)+'Paystack fees are 1.5% and settlement time is next working day'};
 expect(relevantExcerpt(page,plan,700)).toContain('Paystack fees');
});

it('replans changed research requirements and preserves previous spending on revision',()=>{
 const previous={...emptyReportProgress('Compare Paystack fees'),generatorVersion:2 as const,researchPlan:plan,totalCostUsd:.12,totalTokens:500,stage:0,status:'delivered' as const};
 const revised=revisionProgress(previous,'Also compare settlement and Flutterwave.');
 expect(revised.stage).toBe(10);expect(revised.researchPlan).toBeUndefined();expect(revised.pages).toEqual([]);expect(revised.totalCostUsd).toBe(.12);
});
it('preserves the total cost across a customer creative revision',()=>{
 expect(creativeRevisionProgress({...creative(),totalCostUsd:.1},'Correct the phone').totalCostUsd).toBe(.1);
});

it('builds and checks a new flyer through separate paid stages and exports the same artwork',async()=>{
 let state={...emptyCreativeProgress('Ada sells Rice for ₦2500. Call 08031234567.','flyers'),generatorVersion:2 as const};let callsThisStage=0;
 const chat=async(input:{responseSchema?:{name:string}})=>{callsThisStage++;if(input.responseSchema?.name==='creative_facts')return reply(JSON.stringify(facts));if(input.responseSchema?.name==='flyer_design')return reply(JSON.stringify({headline:'Rice for your day',subheading:'Food shop',details:'',accent:'#742F3E',background:'#FFF8EE'}));return reply(pass);};
 let stages=0;while(state.status==='in-progress'&&stages++<12){callsThisStage=0;state=await runCreativeStage(state,{chat}) as typeof state;expect(callsThisStage).toBeLessThanOrEqual(1);}
 expect(state.status).toBe('delivered');expect(state.designSvg).toContain('₦2500');expect(state.html).toContain(state.designSvg);expect(state.html).toContain(facts.contact);
});


it('runs the image stage between fact extraction and layout for a new version 2 job', async () => {
 const start = {...emptyCreativeProgress('Ada sells Rice for ₦2500. Call 08031234567.','flyers'),generatorVersion:2 as const};
 let chatCalls = 0, imageCalls = 0;
 const chat = async () => { chatCalls++; return reply(JSON.stringify(facts)); };
 const image = async () => { imageCalls++; return {dataUri:'data:image/jpeg;base64,/9j/2Q==',model:'fixture',costUsd:.019}; };
 const read = await runCreativeStage(start,{chat,image});
 expect(read.stage).toBe(6); expect(chatCalls).toBe(1); expect(imageCalls).toBe(0);
 const pictured = await runCreativeStage(read,{chat,image});
 expect(pictured.stage).toBe(2); expect(chatCalls).toBe(1); expect(imageCalls).toBe(1);
 expect(pictured.image).toContain('data:image/jpeg'); expect(pictured.totalCostUsd).toBeCloseTo(.020);
});
