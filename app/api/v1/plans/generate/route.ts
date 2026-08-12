import { generatePlan } from "../../../../../lib/planner";

export async function POST(request: Request) {
  try {
    const input = await request.json() as Parameters<typeof generatePlan>[0];
    return Response.json(generatePlan(input), { status: 201 });
  } catch {
    return Response.json({ error:"Invalid plan request" }, { status:400 });
  }
}
