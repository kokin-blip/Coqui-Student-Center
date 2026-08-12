import { recommendNext } from "../../../../../lib/planner";

export async function POST(request: Request) {
  try {
    const input = await request.json() as Parameters<typeof recommendNext>[0];
    return Response.json(recommendNext(input));
  } catch {
    return Response.json({ error:"Invalid recommendation request" }, { status:400 });
  }
}
