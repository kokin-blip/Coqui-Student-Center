import assert from "node:assert/strict";
import test from "node:test";
import { fetchStudentGrants } from "../src/funding-sources.js";

const now = new Date("2026-09-22T12:00:00Z");

test("Grants.gov ingestion requires a current, student-relevant opportunity open to individuals", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    if (url.endsWith("search2")) return Response.json({ errorcode: 0, data: { oppHits: [
      { id: "10", title: "Undergraduate Research Grant", closeDate: "10/15/2026", oppStatus: "posted" },
      { id: "11", title: "Student Innovation Grant", closeDate: "10/15/2026", oppStatus: "posted" },
      { id: "12", title: "Expired Student Grant", closeDate: "09/01/2026", oppStatus: "posted" },
      { id: "13", title: "Forecast Student Grant", closeDate: "10/15/2026", oppStatus: "forecasted" },
    ] } });
    return Response.json({ errorcode: 0, data: { id: body.opportunityId, opportunityTitle: body.opportunityId === 10 ? "Undergraduate Research Grant" : "Student Innovation Grant", synopsis: {
      agencyName: "Example Federal Agency", synopsisDesc: "<p>Support for undergraduate students.</p>", applicantTypes: [{ id: body.opportunityId === 10 ? "21" : "06" }],
    } } });
  };

  const opportunities = await fetchStudentGrants(request, now);

  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0]?.canonicalUrl, "https://www.grants.gov/search-results-detail/10");
  assert.equal(opportunities[0]?.deadline, "2026-10-15");
  assert.equal(opportunities[0]?.summary, "Support for undergraduate students.");
  assert.equal(requests.length, 6, "four searches and two deduplicated detail checks");
  assert.deepEqual(requests.filter(item => item.url.endsWith("search2")).map(item => item.body.keyword), ["student", "undergraduate", "graduate", "fellowship"]);
  assert.deepEqual(requests[0]?.body, { rows: 40, keyword: "student", eligibilities: "21", oppStatuses: "posted", startRecordNum: 0 });
  assert.ok(requests.every(item => !JSON.stringify(item.body).includes("profile")));
});

test("different search terms discover additional eligible grants without duplicate detail requests", async () => {
  const detailIds: number[] = [];
  const request: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith("search2")) {
      const id = body.keyword === "fellowship" ? "20" : "10";
      return Response.json({ errorcode: 0, data: { oppHits: [{ id, title: "Student Fellowship", closeDate: "10/15/2026", oppStatus: "posted" }] } });
    }
    detailIds.push(body.opportunityId);
    return Response.json({ errorcode: 0, data: { id: body.opportunityId, opportunityTitle: "Student Fellowship", synopsis: { agencyName: "Federal Agency", synopsisDesc: "Support for students", applicantTypes: [{ id: "21" }] } } });
  };
  const opportunities = await fetchStudentGrants(request, now);
  assert.deepEqual(detailIds, [10, 20]);
  assert.equal(opportunities.length, 2);
});

test("a mismatched detail response fails the whole refresh instead of publishing a partial catalog", async () => {
  const request: typeof fetch = async (input) => String(input).endsWith("search2")
    ? Response.json({ errorcode: 0, data: { oppHits: [{ id: "10", title: "Student Grant", closeDate: "10/15/2026", oppStatus: "posted" }] } })
    : Response.json({ errorcode: 0, data: { id: 11, opportunityTitle: "Student Grant", synopsis: { agencyName: "Agency", synopsisDesc: "Student funding", applicantTypes: [{ id: "21" }] } } });
  await assert.rejects(fetchStudentGrants(request, now), /mismatched opportunity/);
});
