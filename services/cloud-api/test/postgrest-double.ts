/**
 * A small in-memory stand-in for the PostgREST surface that SupabaseRestSyncRepository talks to.
 *
 * WHAT THIS PROVES: that the Supabase adapter shapes its HTTP requests correctly and participates
 * in the same invariants as the in-memory adapter. It is the mechanism that stops the two from
 * silently diverging, which is how unauthorized push reached production.
 *
 * WHAT THIS CANNOT PROVE: row-level security policies, database constraints, and triggers all live
 * in supabase/migrations and are enforced by Postgres, not by this double. The two behaviours below
 * that mirror the database (account scoping, and the mutation-substitution trigger) are emulated so
 * the adapter can be exercised end to end -- they are NOT evidence that the real policies are right.
 * Those stay asserted as migration text in security.test.ts, and ultimately need a live project.
 */
import { createHash } from "node:crypto";

type Row=Record<string,unknown>;
type Filter={column:string;operator:string;value:string};

const MUTATION_IDENTITY=["account_id","device_id","logical_timestamp","entity_id","entity_type","nonce","ciphertext","schema_version","tombstone","signature"] as const;

function parseFilters(params:URLSearchParams){
  const filters:Filter[]=[];
  for(const [column,raw] of params){
    if(["select","order","limit","offset","on_conflict"].includes(column))continue;
    const separator=raw.indexOf(".");
    filters.push({column,operator:raw.slice(0,separator),value:raw.slice(separator+1)});
  }
  return filters;
}

function matches(row:Row,filter:Filter){
  const value=row[filter.column];
  switch(filter.operator){
    case "eq":return String(value)===filter.value;
    case "gt":return filter.value==="null"?value!==null:String(value)>filter.value&&value!==null;
    case "is":return filter.value==="null"?value===null||value===undefined:String(value)===filter.value;
    default:throw new Error(`postgrest double does not implement operator ${filter.operator}`);
  }
}

function compare(a:Row,b:Row,column:string,descending:boolean){
  const left=a[column],right=b[column];
  const order=left===right?0:(left as never)<(right as never)?-1:1;
  return descending?-order:order;
}

export class PostgrestDouble{
  readonly tables=new Map<string,Row[]>();
  readonly storage=new Map<string,Buffer>();
  #identity=new Map<string,number>();

  #rows(table:string){
    if(!this.tables.has(table))this.tables.set(table,[]);
    return this.tables.get(table)!;
  }

  // Stands in for RLS: every request is scoped to the account named by its bearer token.
  #account(init?:RequestInit){
    const headers=(init?.headers??{}) as Record<string,string>;
    const token=String(headers.Authorization??"").replace("Bearer ","");
    const accountId=this.tokens.get(token);
    if(!accountId)throw new Error("postgrest double received an unknown access token");
    return accountId;
  }

  constructor(readonly tokens:Map<string,string>){}

  readonly fetch=async(input:string,init?:RequestInit):Promise<Response>=>{
    const url=new URL(input);
    if(url.pathname.startsWith("/storage/v1/"))return this.#storage(url,init);
    const table=url.pathname.replace("/rest/v1/","");
    const accountId=this.#account(init);
    const method=(init?.method??"GET").toUpperCase();
    const filters=parseFilters(url.searchParams);
    // Account scoping is applied unconditionally, exactly as the RLS policies do.
    const visible=this.#rows(table).filter(row=>row.account_id===accountId);

    if(method==="GET"){
      let rows=visible.filter(row=>filters.every(filter=>matches(row,filter)));
      const order=url.searchParams.get("order");
      if(order){
        const [column,direction]=order.split(".");
        rows=[...rows].sort((a,b)=>compare(a,b,column!,direction==="desc"));
      }
      const limit=url.searchParams.get("limit");
      if(limit)rows=rows.slice(0,Number(limit));
      const select=url.searchParams.get("select")?.split(",");
      const projected=select?rows.map(row=>Object.fromEntries(select.map(column=>[column,row[column]??null]))):rows;
      return this.#json(projected,200);
    }

    if(method==="POST"){
      const body=JSON.parse(String(init?.body??"[]"));
      const incoming:Row[]=Array.isArray(body)?body:[body];
      const accepted:Row[]=[];
      for(const row of incoming){
        if(row.account_id!==accountId)return this.#json({message:"row violates row-level security policy"},403);
        if(table==="student_center_encrypted_mutations"){
          const existing=visible.find(current=>current.mutation_id===row.mutation_id);
          if(existing){
            // Emulates student_center_reject_mutation_substitution.
            if(MUTATION_IDENTITY.some(column=>existing[column]!==row[column]))return this.#json({message:"mutation ID cannot be reused with different ciphertext"},409);
            continue;
          }
          const sequence=(this.#identity.get(table)??0)+1;
          this.#identity.set(table,sequence);
          const stored={...row,sequence,received_at:new Date().toISOString()};
          this.#rows(table).push(stored);
          accepted.push(stored);
          continue;
        }
        if(table==="student_center_devices"&&visible.some(current=>current.id===row.id))return this.#json({message:"duplicate key value violates unique constraint"},409);
        if(table==="student_center_device_envelopes"&&visible.some(current=>current.envelope_id===row.envelope_id))return this.#json({message:"duplicate key value violates unique constraint"},409);
        const stored={created_at:new Date().toISOString(),consumed_at:null,revoked_at:null,approved_at:null,...row};
        this.#rows(table).push(stored);
        accepted.push(stored);
      }
      return this.#json(accepted,201);
    }

    if(method==="PATCH"){
      const patch=JSON.parse(String(init?.body??"{}")) as Row;
      for(const row of visible)if(filters.every(filter=>matches(row,filter)))Object.assign(row,patch);
      return this.#json([],200);
    }

    throw new Error(`postgrest double does not implement ${method}`);
  };

  async #storage(url:URL,init?:RequestInit){
    const key=url.pathname.replace("/storage/v1/object/","");
    const method=(init?.method??"GET").toUpperCase();
    if(method==="POST"){this.storage.set(key,Buffer.from(init?.body as ArrayBuffer));return this.#json({Key:key},200);}
    if(method==="HEAD")return new Response(null,{status:this.storage.has(key)?200:404});
    const bytes=this.storage.get(key);
    if(!bytes)return new Response(null,{status:404});
    return new Response(new Uint8Array(bytes),{status:200});
  }

  #json(body:unknown,status:number){
    return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
  }

  sha256(bytes:Buffer){return createHash("sha256").update(bytes).digest("hex");}
}
