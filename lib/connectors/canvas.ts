export type CanvasAuth = { mode:"personal_token"; baseUrl:string; token:string } | { mode:"oauth"; baseUrl:string; accessToken:string; refreshToken:string };
export type NormalizedCanvasItem = { externalId:string; kind:"course"|"assignment"|"calendar_event"; observedAt:string; payload:Record<string,unknown> };

export interface Connector {
  validate(): Promise<void>;
  pull(cursor?:string): Promise<{ items:NormalizedCanvasItem[]; cursor?:string }>;
}

export async function validateCanvasBaseUrl(value:string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Canvas URL must use HTTPS");
  if (url.username || url.password || url.port) throw new Error("Canvas URL cannot contain credentials or a custom port");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error("Private network Canvas hosts are not allowed");
  return `${url.origin}`;
}

export class CanvasConnector implements Connector {
  constructor(private readonly auth:CanvasAuth) {}
  private get token() { return this.auth.mode === "personal_token" ? this.auth.token : this.auth.accessToken; }
  private async request(path:string) {
    const origin = await validateCanvasBaseUrl(this.auth.baseUrl);
    const response = await fetch(`${origin}/api/v1/${path}`, { headers:{ authorization:`Bearer ${this.token}` }, redirect:"error" });
    if (!response.ok) throw new Error(`Canvas request failed with status ${response.status}`);
    return response.json();
  }
  async validate() { await this.request("users/self/profile"); }
  async pull() {
    const observedAt = new Date().toISOString();
    const courses = await this.request("courses?enrollment_state=active&include[]=term") as Array<Record<string,unknown>>;
    const items = courses.map(course=>({ externalId:String(course.id), kind:"course" as const, observedAt, payload:course }));
    return { items, cursor:observedAt };
  }
}
