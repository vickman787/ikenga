import type { SourcePage } from "./search.js";
import { QUALITY_SCHEMA, qualityPassed } from "./quality.js";
export interface ResearchPlan { subjects: string[]; questions: string[]; queries: string[]; }
const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(x => typeof x === "string" && x.trim().length > 0 && x.length <= 300);
export const RESEARCH_PLAN_SCHEMA = { type: "object", additionalProperties: false, properties: {
 subjects: { type: "array", items: { type: "string" } }, questions: { type: "array", items: { type: "string" } }, queries: { type: "array", items: { type: "string" } },
}, required: ["subjects", "questions", "queries"] };
export function parseResearchPlan(text: string): ResearchPlan | null {
 try { const v=JSON.parse(text); if(!v || !strings(v.subjects,4) || !strings(v.questions,6) || !strings(v.queries,6) || !v.questions.length || !v.queries.length) return null;
 return { subjects: [...new Set<string>(v.subjects.map((x:string)=>x.trim()))], questions:[...new Set<string>(v.questions.map((x:string)=>x.trim()))], queries:[...new Set<string>(v.queries.map((x:string)=>x.trim()))] };
 } catch { return null; }
}
export function researchRequirements(plan: ResearchPlan): { id: string; question: string }[] {
 const questions=plan.subjects.length ? plan.subjects.flatMap(subject=>plan.questions.map(q=>subject + ": " + q)) : plan.questions;
 return questions.map((question,i)=>({id:"R"+(i+1),question}));
}
export function relevantResearchPage(page: SourcePage, plan: ResearchPlan): boolean {
 const text=(page.title+" "+page.text).toLowerCase();
 // Named entities are mandatory when the brief names them. Generic words such as Nigeria never admit an unrelated biography.
 const terms=plan.subjects.length ? plan.subjects : plan.queries.flatMap(q=>q.split(/\s+/)).filter(w=>w.length>5 && !/^(official|pricing|research|market|compare|nigeria)$/i.test(w));
 return terms.some(t=>text.includes(t.toLowerCase()));
}
export function relevantExcerpt(page: SourcePage, plan: ResearchPlan, maxChars=2200): string {
 const sentences=page.text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean).flatMap(text=>{
   if(text.length<=700)return [text];
   const chunks:string[]=[];for(let at=0;at<text.length;at+=500)chunks.push(text.slice(at,at+700));return chunks;
 });
 const terms=[...plan.subjects,...plan.questions.flatMap(q=>q.split(/\W+/).filter(w=>w.length>3))].map(w=>w.toLowerCase());
 const ranked=sentences.map((text,i)=>({text,i,score:terms.filter(w=>text.toLowerCase().includes(w)).length})).sort((a,b)=>b.score-a.score||a.i-b.i);
 let length=0; const selected: typeof ranked=[];
 for(const sentence of ranked) { if(length>=maxChars)break; const text=sentence.text.slice(0,maxChars-length); selected.push({...sentence,text}); length+=text.length+1; }
 return selected.sort((a,b)=>a.i-b.i).map(s=>s.text).join(" ");
}
export function researchSources(pages: SourcePage[], plan: ResearchPlan): string {
 return pages.map((p,i)=>"["+(i+1)+"] "+p.title+" — "+p.url+" (retrieved "+(p.retrievedAt??"unknown")+")\n"+relevantExcerpt(p,plan)).join("\n\n");
}
export const RESEARCH_QUALITY_SCHEMA = { ...QUALITY_SCHEMA, properties: { ...QUALITY_SCHEMA.properties, coverage: { type:"array", items:{ type:"object", additionalProperties:false, properties: {
 id:{type:"string"}, status:{type:"string",enum:["met","missing"]}, sourceIds:{type:"array",items:{type:"integer"}},
 },required:["id","status","sourceIds"]} } },required:["verdict","issues","coverage"] };
export function researchCoveragePassed(text: string, plan: ResearchPlan, sourceCount: number): boolean {
 if(!qualityPassed(text))return false;
 try { const coverage=JSON.parse(text).coverage;
 if(!Array.isArray(coverage) || coverage.length!==researchRequirements(plan).length)return false;
 return researchRequirements(plan).every(r=>{ const matches=coverage.filter(c=>c.id===r.id); if(matches.length!==1)return false; const c=matches[0];
 return c.status==="met" && Array.isArray(c.sourceIds) && c.sourceIds.length>0 && c.sourceIds.every((id:unknown)=>Number.isInteger(id) && Number(id)>=1 && Number(id)<=sourceCount); });
 } catch{return false;}
}
