import { expect, test } from "vitest";
import type { ScholarshipOpportunity, ScholarshipWorkspace } from "../src/native";
import { defaultFundingFilters, fundingPreferenceFit, fundingResults, knownEffort } from "../src/features/scholarships/fundingResults";

const profile: ScholarshipWorkspace["profile"] = { studyLevel: "undergraduate", fieldsOfStudy: ["Biology"], locations: ["Arizona"], citizenship: [], residency: [], gpa: 3.4 };
const item = (id: string, changes: Partial<ScholarshipOpportunity> = {}): ScholarshipOpportunity => ({
  id, sourceId: "catalog", canonicalUrl: `https://example.org/${id}`, provider: "Example University",
  title: id, applicationUrl: `https://example.org/${id}`, studyLevels: [], fieldsOfStudy: [],
  locations: [], citizenship: [], residency: [], essayPrompts: [], requiredDocuments: [],
  fetchedAt: "2026-09-22T12:00:00Z", freshness: "fresh", verificationStatus: "unverified",
  aiPolicy: "unknown", notes: "", priority: "medium", state: "discovered", taskIds: [], ...changes,
});

test("best match places known eligibility conflicts last, and effort puts unknown requirements last", () => {
  const items = [item("conflict", { requiredDocuments: ["transcript"] }), item("unknown"), item("fit", { essayPrompts: [{ id: "essay", prompt: "Why?" }] })];
  const matches: ScholarshipWorkspace["matches"] = [
    { opportunityId: "conflict", matched: [], unknown: [], ineligible: ["GPA too low"], score: 0.9 },
    { opportunityId: "fit", matched: [], unknown: [], ineligible: [], score: 0.6 },
  ];
  expect(fundingResults(items, matches, profile, defaultFundingFilters).map((value) => value.id)).toEqual(["fit", "unknown", "conflict"]);
  expect(fundingResults(items, matches, profile, { ...defaultFundingFilters, sort: "effort" }).map((value) => value.id)).toEqual(["conflict", "fit", "unknown"]);
  expect(knownEffort(items[1])).toBeNull();
});

test("published criteria filters do not treat an unknown award floor as a guaranteed minimum", () => {
  const items = [
    item("explicit", { opportunityType: "grant", provider: "Arizona State University", fieldsOfStudy: ["Biology"], locations: ["Arizona"], awardMinimum: 1500, awardMaximum: 4000, minimumGpa: 3.2, requiredDocuments: ["transcript"], recommendationsRequired: 0 }),
    item("unknown-floor", { opportunityType: "grant", provider: "Arizona State University", fieldsOfStudy: ["Biology"], locations: ["Arizona"], awardMaximum: 5000 }),
    item("too-high-gpa", { opportunityType: "grant", provider: "Arizona State University", fieldsOfStudy: ["Biology"], locations: ["Arizona"], awardMinimum: 1500, minimumGpa: 3.8 }),
  ];
  const filters = { ...defaultFundingFilters, type: "grant", major: "biology", provider: "asu", location: "arizona", minimumAward: "1000", gpa: "within_profile" as const, noListedEssay: true, noListedRecommendation: true, effort: "light" as const };
  expect(fundingResults(items, [], profile, filters).map((value) => value.id)).toEqual([]);
  expect(fundingResults(items, [], profile, { ...filters, provider: "Arizona State" }).map((value) => value.id)).toEqual(["explicit"]);
});

test("best match uses volunteered funding preferences only after eligibility evidence", () => {
  const preferences = { ...profile, preferredOpportunityTypes: ["grant"], awardMinimum: 1000 };
  const items = [
    item("scholarship", { opportunityType: "scholarship", awardMinimum: 3000, deadline: "2026-09-23" }),
    item("preferred", { opportunityType: "grant", awardMinimum: 1500, deadline: "2026-12-01" }),
    item("unknown-floor", { opportunityType: "grant", awardMaximum: 5000, deadline: "2026-09-24" }),
    item("conflict", { opportunityType: "grant", awardMinimum: 3000, deadline: "2026-09-22" }),
  ];
  const matches: ScholarshipWorkspace["matches"] = items.map((value) => ({ opportunityId: value.id, matched: [], unknown: [], ineligible: value.id === "conflict" ? ["Study level differs"] : [], score: 0.5 }));
  expect(fundingResults(items, matches, preferences, defaultFundingFilters).map((value) => value.id)).toEqual(["preferred", "unknown-floor", "scholarship", "conflict"]);
  expect(fundingPreferenceFit(items[1], preferences).reasons).toEqual(["Preferred type: grant", "Published minimum meets your $1,000 target"]);
  expect(fundingPreferenceFit(items[2], preferences).reasons).toEqual(["Preferred type: grant"]);
});

test("best match uses explicit interest phrases without substring guesses", () => {
  const preferences = { ...profile, interests: ["art", "climate change", "public service"] };
  const climate = item("climate", { title: "Climate change research grant", summary: "For public-service projects" });
  const unrelated = item("unrelated", { title: "Scholarship for startups" });
  expect(fundingPreferenceFit(climate, preferences).reasons).toEqual([
    "Opportunity text mentions your interest: climate change",
    "Opportunity text mentions your interest: public service",
  ]);
  expect(fundingPreferenceFit(unrelated, preferences).reasons).toEqual([]);
  expect(fundingResults([unrelated, climate], [], preferences, defaultFundingFilters).map((value) => value.id)).toEqual(["climate", "unrelated"]);
});

test("minimum preparation time changes ranking without hiding near or unknown deadlines", () => {
  const preferences = { ...profile, deadlineToleranceDays: 30 };
  const items = [
    item("near", { deadline:"2026-10-01" }),
    item("far", { deadline:"2026-11-01" }),
    item("unknown"),
    item("past", { deadline:"2026-09-01" }),
    item("conflict", { deadline:"2026-11-01" }),
  ];
  const matches: ScholarshipWorkspace["matches"] = items.map((value) => ({ opportunityId:value.id, matched:[], unknown:[], ineligible:value.id === "conflict" ? ["Published requirement differs"] : [], score:.5 }));
  expect(fundingResults(items, matches, preferences, defaultFundingFilters, "2026-09-23").map((value) => value.id)).toEqual(["far", "unknown", "near", "past", "conflict"]);
  expect(fundingPreferenceFit(items[0], preferences, "2026-09-23").reasons).toEqual(["Less than your preferred 30-day preparation time"]);
  expect(fundingPreferenceFit(items[1], preferences, "2026-09-23").reasons).toEqual(["At least your preferred 30-day preparation time remains"]);
});
