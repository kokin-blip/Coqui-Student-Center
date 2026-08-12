const sampleCandidates = [
  { id:"candidate-paper", kind:"assignment", normalizedPayload:{ title:"Research paper: Social media and identity", course:"English 102", dueAt:"2026-08-14T23:59:00.000Z" }, evidence:[{ page:2, text:"Research paper due Aug 14 at 11:59 PM" }], confidence:0.98, warnings:[], status:"pending" },
  { id:"candidate-stats", kind:"assignment", normalizedPayload:{ title:"Statistics problem set 4", course:"Statistics 201", dueAt:"2026-08-17T09:00:00.000Z" }, evidence:[{ page:3, text:"Problem Set 4: Monday August 17, 9:00 AM" }], confidence:0.96, warnings:[], status:"pending" },
];

export async function GET() { return Response.json({ importRunId:"sample-syllabus", candidates:sampleCandidates }); }

export async function POST(request: Request) {
  const payload = await request.json().catch(()=>null) as { candidateIds?:string[] } | null;
  if (!payload?.candidateIds?.length) return Response.json({ error:"candidateIds are required" }, { status:400 });
  return Response.json({ approved:payload.candidateIds, event:"canonical.changed" }, { status:201 });
}
