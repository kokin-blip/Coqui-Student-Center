import { replan } from "../../../../../lib/planner";

export async function POST(request: Request) {
  try {
    const input = await request.json() as Parameters<typeof replan>[0];
    return Response.json(replan(input), { status:201 });
  } catch {
    return Response.json({ error:"Invalid replan request" }, { status:400 });
  }
}
