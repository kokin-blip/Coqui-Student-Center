import type { ScholarshipOpportunity, ScholarshipProfile, FundingCriterion } from "../../native";
export type IdentityFit = {criterion:FundingCriterion;value:string|null;status:"match"|"review"};
const normalize=(text:string)=>text.trim().toLocaleLowerCase();
export function identityFit(opportunity:ScholarshipOpportunity,profile:ScholarshipProfile):IdentityFit[]{
 return (opportunity.eligibilityCriteria??[]).map(criterion=>{
   const supplied=profile.preferNotToSay?.includes(criterion.attribute)?[]:profile[criterion.attribute]??[];
   const supported=!!criterion.sourceQuote.trim()&&/^https:\/\//.test(criterion.sourceUrl)&&criterion.values.length>0&&criterion.values.every(v=>normalize(criterion.sourceQuote).includes(normalize(v)));
   const value=supplied.find(v=>criterion.values.some(required=>normalize(required)===normalize(v)))??null;
   return {criterion,value,status:supported&&!criterion.ambiguous&&value!==null?"match":"review"};
 });
}
