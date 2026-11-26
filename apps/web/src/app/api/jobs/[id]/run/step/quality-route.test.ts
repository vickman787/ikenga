import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MemoryLedger} from '@ikenga/ledger';
import {getHire,getReport,setLedgerForTests,setReport,emptyStoredCreative} from '@/lib/jobs';
import {signToken,SESSION_COOKIE} from '@/lib/walletSession';
import {POST} from './route';
const {stage}=vi.hoisted(()=>({stage:vi.fn()}));
vi.mock('@ikenga/agent',async original=>({...await original<typeof import('@ikenga/agent')>(),runCreativeStage:stage}));
const customer='0x'+'2'.repeat(40);
let ledger:MemoryLedger;
beforeEach(async()=>{
 vi.stubEnv('OPENAI_API_KEY','test-only');vi.stubEnv('IKENGA_SESSION_SECRET','test-only-32-character-session-secret');
 ledger=new MemoryLedger();setLedgerForTests(ledger);stage.mockReset();
 await ledger.createOrder({id:'quality-job',jobType:'website',description:'Ada sells rice.',customerWallet:customer,status:'in-progress',escrowAddress:'0x'+'a'.repeat(40),fundTxHash:'0x'+'b'.repeat(64)});
 await setReport('quality-job',emptyStoredCreative('website'));
});
afterEach(()=>{vi.unstubAllEnvs();setLedgerForTests(new MemoryLedger());});
const request=()=>new Request('http://localhost/api/jobs/quality-job/run/step',{method:'POST',headers:{origin:'http://localhost',cookie:SESSION_COOKIE+'='+signToken({kind:'session',address:customer,origin:'http://localhost',expires:Date.now()+60000})}});
const ctx={params:Promise.resolve({id:'quality-job'})};
describe('Quality failure and escrow state',()=>{
 it('keeps a funded failed job in escrow with no delivered receipt',async()=>{
  stage.mockImplementation(async p=>({...p,status:'refused',stage:0,reason:'Missing price evidence.',totalCostUsd:.02}));
  const response=await POST(request(),ctx);expect(response.status).toBe(200);
  expect((await getHire('quality-job'))?.status).toBe('escrowed');expect((await getReport('quality-job'))?.status).toBe('refused');
 });
 it('does not advance a job that was already refunded',async()=>{
  await ledger.updateOrderStatus('quality-job','refunded');
  const response=await POST(request(),ctx);expect(response.status).toBe(409);expect(stage).not.toHaveBeenCalled();
 });
 it('does not overwrite a refund made while the AI stage was running',async()=>{
  stage.mockImplementation(async p=>{await ledger.updateOrderStatus('quality-job','refunded');return {...p,status:'delivered',stage:0};});
  const response=await POST(request(),ctx);expect(response.status).toBe(409);expect((await getHire('quality-job'))?.status).toBe('refunded');expect((await getReport('quality-job'))?.status).toBe('in-progress');
 });
});
