import { z } from "zod";

const SEARCH_URL = "https://api.grants.gov/v1/api/search2";
const DETAIL_URL = "https://api.grants.gov/v1/api/fetchOpportunity";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEARCH_TERMS = ["student", "undergraduate", "graduate", "fellowship"] as const;
const MAX_HITS_PER_SEARCH = 4;

const searchResponse = z.object({
  errorcode: z.number(),
  data: z.object({
    oppHits: z.array(z.object({
      id: z.union([z.string(), z.number()]),
      title: z.string(),
      closeDate: z.string().optional().nullable(),
      oppStatus: z.string(),
    }).passthrough()),
  }).passthrough(),
}).passthrough();

const detailResponse = z.object({
  errorcode: z.number(),
  data: z.object({
    id: z.union([z.string(), z.number()]),
    opportunityTitle: z.string(),
    synopsis: z.object({
      agencyName: z.string(),
      synopsisDesc: z.string(),
      applicantTypes: z.array(z.object({ id: z.string() }).passthrough()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

async function postJson(url: string, body: object, request: typeof fetch): Promise<unknown> {
  const response = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok || !response.body) throw new Error("Grants.gov is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Grants.gov response is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function dateFromSearch(value: string | null | undefined, now: Date): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[3]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) return undefined;
  return date.toISOString().slice(0, 10);
}

function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|lt|gt|quot);/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
}

/** Only opportunities explicitly open to individuals and relevant to students. */
export async function fetchStudentGrants(request: typeof fetch = fetch, now = new Date()) {
  const searches = await Promise.all(SEARCH_TERMS.map(async keyword => {
    const search = searchResponse.parse(await postJson(SEARCH_URL, {
      rows: 40,
      keyword,
      eligibilities: "21",
      oppStatuses: "posted",
      startRecordNum: 0,
    }, request));
    if (search.errorcode !== 0) throw new Error("Grants.gov search failed");
    return search.data.oppHits.filter(hit => hit.oppStatus === "posted" && (!hit.closeDate || dateFromSearch(hit.closeDate, now))).slice(0, MAX_HITS_PER_SEARCH);
  }));
  const unique = new Map<number, (typeof searches)[number][number]>();
  for (const hit of searches.flat()) {
    const id = Number(hit.id);
    if (Number.isSafeInteger(id) && id > 0) unique.set(id, hit);
  }
  const results = await Promise.all([...unique].map(async ([id, hit]) => {
    const deadline = dateFromSearch(hit.closeDate, now);
    const detail = detailResponse.parse(await postJson(DETAIL_URL, { opportunityId: id }, request));
    if (detail.errorcode !== 0 || Number(detail.data.id) !== id) throw new Error("Grants.gov returned a mismatched opportunity");
    const synopsis = detail.data.synopsis;
    if (!synopsis.applicantTypes.some(type => type.id === "21")) return null;
    const summary = plainText(synopsis.synopsisDesc);
    if (!/\b(student|undergraduate|graduate|college|university)\b/i.test(`${detail.data.opportunityTitle} ${summary}`)) return null;
    const canonicalUrl = `https://www.grants.gov/search-results-detail/${id}`;
    return {
      canonicalUrl,
      sourceUrl: canonicalUrl,
      applicationUrl: canonicalUrl,
      provider: synopsis.agencyName.trim(),
      title: detail.data.opportunityTitle.trim(),
      opportunityType: "grant" as const,
      summary,
      updatedAt: now.toISOString(),
      parserVersion: "grants-gov-individual-1",
      ...(deadline ? { deadline } : {}),
    };
  }));
  return results.filter((result): result is NonNullable<typeof result> => result !== null);
}
