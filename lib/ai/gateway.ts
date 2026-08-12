export type AIRequest = {
  capability: "brain_dump" | "document_extract" | "task_breakdown" | "explanation";
  schemaName: string;
  schema: Record<string, unknown>;
  input: string;
};

export interface AIProvider {
  generateStructured<T>(request: AIRequest): Promise<{ value:T; model:string; latencyMs:number }>;
}

export class OpenAIProvider implements AIProvider {
  constructor(private readonly apiKey:string, private readonly model:string) {}

  async generateStructured<T>(request: AIRequest) {
    const started = Date.now();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method:"POST",
      headers:{ "content-type":"application/json", authorization:`Bearer ${this.apiKey}` },
      body:JSON.stringify({
        model:this.model,
        instructions:"Return only grounded student-planning facts. Never invent dates. Ambiguous facts must be warnings, not assumptions.",
        input:request.input.slice(0,50_000),
        text:{ format:{ type:"json_schema", name:request.schemaName, strict:true, schema:request.schema } },
      }),
    });
    if (!response.ok) throw new Error(`AI provider failed with status ${response.status}`);
    const payload = await response.json() as { output_text?:string };
    if (!payload.output_text) throw new Error("AI provider returned no structured output");
    return { value:JSON.parse(payload.output_text) as T, model:this.model, latencyMs:Date.now()-started };
  }
}

export function createAIGateway(env:{ OPENAI_API_KEY?:string; OPENAI_MODEL?:string }) {
  if (!env.OPENAI_API_KEY) return null;
  return new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL ?? "gpt-5.6-luna");
}
