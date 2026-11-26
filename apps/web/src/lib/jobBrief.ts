import type { JobType } from "@ikenga/shared";
export interface BriefField { key: string; label: string; placeholder: string; required?: boolean; }
const creative: BriefField[] = [
 {key:"businessName",label:"Business name",placeholder:"e.g. Ada’s Kitchen",required:true},
 {key:"contact",label:"Contact to show",placeholder:"Phone, WhatsApp or email — specify which",required:true},
 {key:"audience",label:"Who is it for?",placeholder:"e.g. Office workers ordering lunch in Lekki"},
 {key:"goal",label:"What should people do?",placeholder:"e.g. Call to order, book a visit, request a quote"},
 {key:"brand",label:"Brand colours and style",placeholder:"e.g. Burgundy and cream, warm and modern"},
];
export function briefFields(jobType: JobType): BriefField[] {
 return jobType==="market-report" ? [
 {key:"subjects",label:"Businesses or market to research",placeholder:"e.g. Paystack, Flutterwave and Moniepoint",required:true},
 {key:"region",label:"Location and time period",placeholder:"e.g. Lagos, Nigeria; current information",required:true},
 {key:"goal",label:"Decision this research should help you make",placeholder:"e.g. Choose a payment provider for a retail shop"},
 ] : [...creative,{key:"context",label:jobType==="website"?"Website sections and references":jobType==="flyers"?"Where will you use the flyer?":"Promo audience and story",placeholder:jobType==="website"?"Sections you need and sites whose style you like":jobType==="flyers"?"e.g. A4 handout or a phone screen":"e.g. A simple mobile promo ending with a call to order"}];
}
/** Store the confirmed brief as text so escrow and legacy delivery formats stay compatible. */
export function composeJobBrief(jobType: JobType, description: string, details?: Record<string,string>): string {
 const text=description.trim();
 if(!text)throw new Error("Describe what you need, including exact services, prices or research questions.");
 if(!details)return text;
 const fields=briefFields(jobType);
 for(const field of fields)if(field.required && !details[field.key]?.trim())throw new Error("Please enter: "+field.label+".");
 const parts=["Customer brief",...fields.filter(f=>details[f.key]?.trim()).map(f=>f.label+": "+details[f.key].trim()),"Requested work and confirmed facts:\n"+text];
 const brief=parts.join("\n");
 if(brief.length>4000)throw new Error("Keep the complete brief within 4,000 characters.");
 return brief;
}
