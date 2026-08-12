import { CanvasConnector, validateCanvasBaseUrl } from "../../../../../lib/connectors/canvas";

export async function POST(request:Request) {
  try {
    const payload = await request.json() as { baseUrl:string; token:string; validateOnly?:boolean };
    if (!payload.token || payload.token.length < 10) return Response.json({ error:"A valid Canvas token is required" }, { status:400 });
    const baseUrl = await validateCanvasBaseUrl(payload.baseUrl);
    if (payload.validateOnly) {
      const connector = new CanvasConnector({ mode:"personal_token", baseUrl, token:payload.token });
      await connector.validate();
    }
    return Response.json({ connection:{ provider:"canvas", baseUrl, status:payload.validateOnly?"connected":"pending_validation" }, credentialStored:false }, { status:201 });
  } catch (error) {
    return Response.json({ error:error instanceof Error?error.message:"Canvas connection failed" }, { status:400 });
  }
}
