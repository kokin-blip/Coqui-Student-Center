import { createRemoteJWKSet, jwtVerify } from "jose";

export type AuthIdentity = {
  accountId:string;
  accessToken:string;
};

export type AccessTokenVerifier = (accessToken:string)=>Promise<AuthIdentity>;

function requireSupabaseOrigin(value:string){
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/"){
    throw new Error("SUPABASE_URL must be an HTTPS origin");
  }
  return url.origin;
}

export function createSupabaseAccessTokenVerifier(supabaseUrl:string):AccessTokenVerifier{
  const origin=requireSupabaseOrigin(supabaseUrl);
  const issuer=`${origin}/auth/v1`;
  const jwks=createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async accessToken=>{
    const {payload}=await jwtVerify(accessToken,jwks,{issuer,audience:"authenticated"});
    if(typeof payload.sub!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sub)||payload.role!=="authenticated"){
      throw new Error("Access token does not identify an authenticated Supabase account");
    }
    return {accountId:payload.sub,accessToken};
  };
}

export function bearerToken(value:string|undefined){
  const match=/^Bearer ([A-Za-z0-9._~-]+)$/.exec(value??"");
  return match?.[1]??null;
}
