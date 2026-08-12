interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; }
interface D1PreparedStatement { bind(...values: unknown[]): D1PreparedStatement; run(): Promise<unknown>; all(): Promise<unknown>; first(): Promise<unknown>; raw(): Promise<unknown>; }
interface D1Database { prepare(query:string): D1PreparedStatement; batch(statements:D1PreparedStatement[]): Promise<unknown[]>; exec(query:string): Promise<unknown>; }
