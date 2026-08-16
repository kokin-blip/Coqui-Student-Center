import { buildApp } from "./app.js";
import { createSupabaseAccessTokenVerifier } from "./auth.js";
import { SupabaseRestSyncRepository } from "./sync-repository.js";

const supabaseUrl=process.env.SUPABASE_URL;
const publishableKey=process.env.SUPABASE_PUBLISHABLE_KEY;
if(!supabaseUrl||!publishableKey)throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required");
const port=Number(process.env.PORT??8788);
await buildApp({repository:new SupabaseRestSyncRepository(supabaseUrl,publishableKey),verifyAccessToken:createSupabaseAccessTokenVerifier(supabaseUrl)}).listen({port,host:"127.0.0.1"});
