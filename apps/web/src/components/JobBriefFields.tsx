"use client";
import type { JobType } from "@ikenga/shared";
import { briefFields } from "@/lib/jobBrief";
export default function JobBriefFields({jobType,values,onChange}:{jobType:JobType;values:Record<string,string>;onChange:(key:string,value:string)=>void}) {
 return <fieldset style={{border:0,padding:0,margin:0,display:"grid",gap:16}}><legend style={{fontWeight:600,marginBottom:12}}>Give the team a clear brief</legend><p style={{color:"var(--muted)",fontSize:14}}>Confirm the facts you want included. The team will use your brand colours and will not invent prices or contact details.</p>{briefFields(jobType).map(field=><div key={field.key}><label className="field" htmlFor={"brief-"+field.key}>{field.label}{!field.required&&<span className="hint">Optional</span>}</label><input id={"brief-"+field.key} name={field.key} value={values[field.key]??""} onChange={event=>onChange(field.key,event.target.value)} placeholder={field.placeholder} required={field.required} maxLength={500} style={{marginTop:8}} /></div>)}</fieldset>;
}
