import type { ScholarshipOpportunity, ScholarshipWorkspace } from "../../native";

export type FundingSort = "match" | "deadline" | "award" | "effort" | "recency";
export type FundingFilters = {
  query: string;
  sort: FundingSort;
  type: string;
  major: string;
  provider: string;
  location: string;
  minimumAward: string;
  gpa: "all" | "within_profile" | "no_listed_minimum";
  noKnownConflicts: boolean;
  noListedEssay: boolean;
  noListedRecommendation: boolean;
  effort: "all" | "light" | "substantial" | "unknown";
};

export const defaultFundingFilters: FundingFilters = {
  query: "",
  sort: "match",
  type: "all",
  major: "",
  provider: "",
  location: "",
  minimumAward: "",
  gpa: "all",
  noKnownConflicts: false,
  noListedEssay: false,
  noListedRecommendation: false,
  effort: "all",
};

export function knownEffort(item: ScholarshipOpportunity): number | null {
  const documents = item.requiredDocuments?.length ?? 0;
  const essays = item.essayPrompts?.length ?? 0;
  const recommendations = item.recommendationsRequired;
  if (!documents && !essays && recommendations == null) return null;
  return documents + essays * 2 + (recommendations ?? 0);
}

const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const words = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function fundingPreferenceFit(item: ScholarshipOpportunity, profile: ScholarshipWorkspace["profile"], today = localToday()): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const type = item.opportunityType ?? "scholarship";
  if (profile.preferredOpportunityTypes?.includes(type)) {
    score += 2;
    reasons.push(`Preferred type: ${type.replaceAll("_", " ")}`);
  }
  const target = profile.awardMinimum;
  if (target != null && target > 0) {
    if (item.awardMinimum != null && item.awardMinimum >= target) {
      score += 1;
      reasons.push(`Published minimum meets your $${target.toLocaleString()} target`);
    } else if (item.awardMaximum != null && item.awardMaximum < target) {
      score -= 1;
      reasons.push(`Published maximum is below your $${target.toLocaleString()} target`);
    }
  }
  const description = ` ${words(`${item.title} ${item.summary ?? ""}`)} `;
  let interestMatches = 0;
  for (const interest of new Set((profile.interests ?? []).map(words).filter(Boolean))) {
    if (description.includes(` ${interest} `)) {
      score += 1;
      reasons.push(`Opportunity text mentions your interest: ${interest}`);
      if (++interestMatches === 2) break;
    }
  }
  const leadTime = profile.deadlineToleranceDays ?? 0;
  if (Number.isInteger(leadTime) && leadTime > 0 && item.deadline && /^\d{4}-\d{2}-\d{2}$/.test(item.deadline)) {
    const daysUntilDeadline = (Date.parse(`${item.deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    if (Number.isFinite(daysUntilDeadline)) {
      if (daysUntilDeadline < 0) {
        score -= 2;
        reasons.push("Published deadline has passed");
      } else if (daysUntilDeadline < leadTime) {
        score -= 1;
        reasons.push(`Less than your preferred ${leadTime}-day preparation time`);
      } else {
        score += 1;
        reasons.push(`At least your preferred ${leadTime}-day preparation time remains`);
      }
    }
  }
  return { score, reasons };
}

export function fundingResults(
  items: ScholarshipOpportunity[],
  matches: ScholarshipWorkspace["matches"],
  profile: ScholarshipWorkspace["profile"],
  filters: FundingFilters,
  today = localToday(),
): ScholarshipOpportunity[] {
  const matchById = new Map(matches.map((match) => [match.opportunityId, match]));
  const contains = (value: string, query: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const minimumAward = Number(filters.minimumAward);
  const filtered = items.filter((item) => {
    const match = matchById.get(item.id);
    const effort = knownEffort(item);
    if (filters.query && !contains(`${item.title} ${item.provider} ${item.summary ?? ""}`, filters.query)) return false;
    if (filters.type !== "all" && (item.opportunityType ?? "scholarship") !== filters.type) return false;
    if (filters.major && !item.fieldsOfStudy.some((value) => contains(value, filters.major))) return false;
    if (filters.provider && !contains(item.provider, filters.provider)) return false;
    if (filters.location && !item.locations.some((value) => contains(value, filters.location))) return false;
    if (filters.minimumAward && (!Number.isFinite(minimumAward) || (item.awardMinimum ?? -1) < minimumAward)) return false;
    if (filters.gpa === "within_profile" && (profile.gpa == null || (item.minimumGpa != null && item.minimumGpa > profile.gpa))) return false;
    if (filters.gpa === "no_listed_minimum" && item.minimumGpa != null) return false;
    if (filters.noKnownConflicts && (match?.ineligible.length ?? 0) > 0) return false;
    if (filters.noListedEssay && item.essayPrompts.length > 0) return false;
    if (filters.noListedRecommendation && (item.recommendationsRequired ?? 0) > 0) return false;
    if (filters.effort === "light" && (effort == null || effort > 2)) return false;
    if (filters.effort === "substantial" && (effort == null || effort <= 2)) return false;
    if (filters.effort === "unknown" && effort != null) return false;
    return true;
  });
  const deadline = (item: ScholarshipOpportunity) => item.deadline ?? "9999-12-31";
  const award = (item: ScholarshipOpportunity) => item.awardMaximum ?? item.awardMinimum ?? -1;
  return filtered.sort((left, right) => {
    if (filters.sort === "deadline") return deadline(left).localeCompare(deadline(right)) || left.title.localeCompare(right.title);
    if (filters.sort === "award") return award(right) - award(left) || left.title.localeCompare(right.title);
    if (filters.sort === "effort") return (knownEffort(left) ?? Infinity) - (knownEffort(right) ?? Infinity) || left.title.localeCompare(right.title);
    if (filters.sort === "recency") return right.fetchedAt.localeCompare(left.fetchedAt) || left.title.localeCompare(right.title);
    const leftMatch = matchById.get(left.id);
    const rightMatch = matchById.get(right.id);
    return Number((leftMatch?.ineligible.length ?? 0) > 0) - Number((rightMatch?.ineligible.length ?? 0) > 0)
      || (rightMatch?.score ?? 0) - (leftMatch?.score ?? 0)
      || fundingPreferenceFit(right, profile, today).score - fundingPreferenceFit(left, profile, today).score
      || deadline(left).localeCompare(deadline(right))
      || left.title.localeCompare(right.title);
  });
}
