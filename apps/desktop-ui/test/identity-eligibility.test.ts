import { expect,test } from "vitest";
import { identityFit } from "../src/features/scholarships/eligibility";
import type { ScholarshipOpportunity,ScholarshipProfile,FundingCriterion } from "../src/native";
const criterion:FundingCriterion={attribute:"religion",values:["Quaker"],sourceQuote:"Applicants must be Quaker members.",sourceUrl:"https://example.edu/criteria",capturedAt:"2026-10-02T12:00:00Z",ambiguous:false};
const opportunity={eligibilityCriteria:[criterion]} as ScholarshipOpportunity;
const profile={religion:["Quaker"]} as ScholarshipProfile;
test("identity matches need literal criteria and self-described values",()=>{expect(identityFit(opportunity,profile)[0].status).toBe("match");expect(identityFit(opportunity,{...profile,religion:[],school:"Quaker school"})[0].status).toBe("review");expect(identityFit({...opportunity,eligibilityCriteria:[{...criterion,ambiguous:true}]},profile)[0].status).toBe("review");expect(identityFit({...opportunity,eligibilityCriteria:[{...criterion,sourceQuote:"All students may apply"}]},profile)[0].status).toBe("review");expect(identityFit(opportunity,{...profile,preferNotToSay:["religion"]})[0].status).toBe("review");});
