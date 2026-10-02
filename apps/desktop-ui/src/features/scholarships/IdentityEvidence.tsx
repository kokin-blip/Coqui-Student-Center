import type { ScholarshipOpportunity, ScholarshipProfile } from "../../native";
import { identityFit } from "./eligibility";
export function IdentityEvidence({opportunity,profile}:{opportunity:ScholarshipOpportunity;profile:ScholarshipProfile}){
 const fits=identityFit(opportunity,profile);
 return <div className="match-evidence"><h4>Identity-related criteria</h4>{fits.length?fits.map(({criterion,value,status},i)=><div key={i}><p>{status==="match"?`Your self-described ${value} matches this explicit criterion.`:"Needs your review; Coqui has not decided eligibility."}</p><blockquote>{criterion.sourceQuote}</blockquote><a href={criterion.sourceUrl} target="_blank" rel="noreferrer">Criterion source</a><small> · Captured {new Date(criterion.capturedAt).toLocaleDateString()}</small></div>):<p>No explicit identity-related criteria are recorded. Check the opportunity’s source; missing criteria do not establish eligibility.</p>}</div>;
}
