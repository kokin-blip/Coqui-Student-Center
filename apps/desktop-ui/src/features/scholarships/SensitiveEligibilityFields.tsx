import { useState } from "react";
import type { ScholarshipProfile } from "../../native";
export const identityFields = [{key:"culturalBackground",label:"Ethnicity or cultural background"},{key:"religion",label:"Religion"},{key:"affiliations",label:"Community or organizational affiliations"}] as const;
export function SensitiveEligibilityFields({profile}:{profile?:ScholarshipProfile}){
 const [values,setValues]=useState<Record<string,string>>(()=>Object.fromEntries(identityFields.map(({key})=>[key,profile?.[key]?.join(", ")??""])));
 const [privateFields,setPrivateFields]=useState<string[]>(profile?.preferNotToSay??[]);
 return <details><summary>Optional identity-related eligibility</summary><p>Self-describe only what you want stored locally. Skip any answer. These details stay out of AI requests and catalog searches; Coqui never infers them.</p>
 {identityFields.map(({key,label})=><div key={key}><label className="field">{label} (optional, comma separated)<input name={key} maxLength={2000} value={values[key]} disabled={privateFields.includes(key)} onChange={e=>setValues({...values,[key]:e.target.value})}/></label>
 <label className="confirm-row"><input name="preferNotToSay" value={key} type="checkbox" checked={privateFields.includes(key)} onChange={e=>{setPrivateFields(current=>e.target.checked?[...current,key]:current.filter(k=>k!==key));if(e.target.checked)setValues({...values,[key]:""});}}/>Prefer not to say</label>
 <button className="text-button" type="button" onClick={()=>{setValues({...values,[key]:""});setPrivateFields(current=>current.filter(k=>k!==key));}}>Skip / clear {label.toLowerCase()}</button></div>)}<small>Changes take effect when you save your profile.</small></details>;
}
