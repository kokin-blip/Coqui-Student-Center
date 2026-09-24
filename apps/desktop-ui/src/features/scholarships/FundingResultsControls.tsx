import { Search } from "lucide-react";
import { defaultFundingFilters, type FundingFilters } from "./fundingResults";

const fundingTypes = [
  ["scholarship", "Scholarships"],
  ["grant", "Grants"],
  ["fellowship", "Fellowships"],
  ["stipend", "Stipends"],
  ["award", "Awards"],
  ["emergency_fund", "Emergency funds"],
  ["tuition_assistance", "Tuition assistance"],
  ["research_funding", "Research funding"],
  ["internship_stipend", "Internship stipends"],
  ["competition", "Competitions"],
] as const;

export function FundingResultsControls({ filters, onChange, count, total, gpa }: {
  filters: FundingFilters;
  onChange: (filters: FundingFilters) => void;
  count: number;
  total: number;
  gpa: number | null;
}) {
  const update = <K extends keyof FundingFilters>(key: K, value: FundingFilters[K]) => onChange({ ...filters, [key]: value });
  const advancedCount = [filters.major, filters.provider, filters.location, filters.minimumAward,
    filters.gpa !== "all", filters.noKnownConflicts, filters.noListedEssay,
    filters.noListedRecommendation, filters.effort !== "all"].filter(Boolean).length;
  return <div className="funding-results-controls">
    <div className="funding-results-primary">
      <label className="scholarship-search"><Search aria-hidden="true" /><input aria-label="Search funding opportunities" value={filters.query} onChange={(event) => update("query", event.target.value)} placeholder="Search opportunities" /></label>
      <label>Sort by<select value={filters.sort} onChange={(event) => update("sort", event.target.value as FundingFilters["sort"])}><option value="match">Best match</option><option value="deadline">Deadline</option><option value="award">Award amount</option><option value="effort">Known effort</option><option value="recency">Most recent</option></select></label>
      <label>Type<select value={filters.type} onChange={(event) => update("type", event.target.value)}><option value="all">All funding</option>{fundingTypes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    </div>
    <details className="funding-more-filters"><summary>More filters{advancedCount ? ` (${advancedCount})` : ""}</summary>
      <div className="funding-advanced-grid">
        <label>Published major criteria<input value={filters.major} onChange={(event) => update("major", event.target.value)} placeholder="e.g. Biology" /></label>
        <label>Provider or institution<input value={filters.provider} onChange={(event) => update("provider", event.target.value)} placeholder="e.g. ASU" /></label>
        <label>Published location criteria<input value={filters.location} onChange={(event) => update("location", event.target.value)} placeholder="e.g. Arizona" /></label>
        <label>Published minimum award ($)<input type="number" min="0" value={filters.minimumAward} onChange={(event) => update("minimumAward", event.target.value)} placeholder="Any amount" /></label>
        <label>GPA<select value={filters.gpa} onChange={(event) => update("gpa", event.target.value as FundingFilters["gpa"])}><option value="all">Any listed minimum</option><option value="within_profile" disabled={gpa == null}>Within my GPA{gpa != null ? ` (${gpa.toFixed(2)})` : " — add GPA first"}</option><option value="no_listed_minimum">No listed minimum</option></select></label>
        <label>Known effort<select value={filters.effort} onChange={(event) => update("effort", event.target.value as FundingFilters["effort"])}><option value="all">Any or unknown</option><option value="light">Light (up to 2 steps)</option><option value="substantial">Substantial (3+ steps)</option><option value="unknown">Not published</option></select></label>
      </div>
      <div className="funding-filter-flags">
        <label><input type="checkbox" checked={filters.noKnownConflicts} onChange={(event) => update("noKnownConflicts", event.target.checked)} /> No known eligibility conflicts</label>
        <label><input type="checkbox" checked={filters.noListedEssay} onChange={(event) => update("noListedEssay", event.target.checked)} /> No listed essay prompts</label>
        <label><input type="checkbox" checked={filters.noListedRecommendation} onChange={(event) => update("noListedRecommendation", event.target.checked)} /> No listed recommendations</label>
      </div>
      <p className="funding-filter-note">Best match uses known eligibility first, then your funding preferences. Unpublished criteria remain unknown.</p>
    </details>
    <div className="funding-results-footer"><span aria-live="polite">Showing {count} of {total} opportunit{total === 1 ? "y" : "ies"}</span><button className="text-button" type="button" onClick={() => onChange(defaultFundingFilters)} disabled={!filters.query && filters.sort === "match" && filters.type === "all" && advancedCount === 0}>Clear filters</button></div>
  </div>;
}
