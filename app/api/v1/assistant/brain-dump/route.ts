import { createAIGateway } from "../../../../../lib/ai/gateway";

const schema = { type:"object", additionalProperties:false, required:["candidates","warnings"], properties:{ candidates:{ type:"array", items:{ type:"object", additionalProperties:false, required:["kind","title","durationMinutes"], properties:{ kind:{enum:["task","commitment"]}, title:{type:"string"}, durationMinutes:{type:"integer",minimum:5,maximum:720}, startsAt:{type:["string","null"]}, dueAt:{type:["string","null"]} } } }, warnings:{type:"array",items:{type:"string"}} } };

export async function POST(request:Request) {
  const payload = await request.json().catch(()=>null) as { text?:string } | null;
  if (!payload?.text?.trim()) return Response.json({ error:"text is required" }, { status:400 });
  const gateway = createAIGateway({ OPENAI_API_KEY:process.env.OPENAI_API_KEY, OPENAI_MODEL:process.env.OPENAI_MODEL });
  if (!gateway) return Response.json({ candidates:[], warnings:["AI is not configured in this environment"], reviewRequired:true });
  try {
    const result = await gateway.generateStructured<Record<string, unknown>>({ capability:"brain_dump", schemaName:"brain_dump_candidates", schema, input:payload.text });
    return Response.json({ ...result.value, reviewRequired:true, meta:{ model:result.model, latencyMs:result.latencyMs } });
  } catch {
    return Response.json({ error:"The assistant could not structure this brain dump" }, { status:502 });
  }
}
