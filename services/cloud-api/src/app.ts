import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import {
  AiStructureRequest,
  AiStructureResult,
  DeviceEnvelope,
  EncryptedObjectChunk,
  EncryptedObjectManifest,
  DeviceRegistration,
  SyncCursor,
  SyncPush,
  encryptedMutationSigningMessage
} from "@student-center/contracts";
import { verifyEd25519 } from "./signature.js";
import { bearerToken, type AccessTokenVerifier, type AuthIdentity } from "./auth.js";
import {
  MemorySyncRepository,
  RepositoryConflict,
  RepositoryForbidden,
  type SyncRepository
} from "./sync-repository.js";
import { AuthorizingSyncRepository } from "./authorizing-repository.js";

type AppOptions={
  repository?:SyncRepository;
  verifyAccessToken?:AccessTokenVerifier;
  aiProvider?:AiProvider;
};

export type AiProviderResult={
  outputText:string;
  model:string;
  inputTokens?:number;
  outputTokens?:number;
};
export type AiProvider=(input:{capability:AiStructureRequest["capability"];excerpt:string;locale:string})=>Promise<AiProviderResult>;

const academicCandidateSchema={
  type:"object",additionalProperties:false,
  properties:{
    candidates:{type:"array",maxItems:100,items:{
      type:"object",additionalProperties:false,
      properties:{
        kind:{type:"string",enum:["task","commitment","assignment","exam"]},
        title:{type:"string",minLength:1,maxLength:240},
        course:{type:["string","null"],maxLength:200},
        durationMinutes:{type:["integer","null"],minimum:5,maximum:480},
        dueAt:{type:["string","null"]},
        startsAt:{type:["string","null"]},
        endsAt:{type:["string","null"]},
        evidence:{type:"string",minLength:1,maxLength:2000},
        confidence:{type:"number",minimum:0,maximum:1},
        warnings:{type:"array",maxItems:20,items:{type:"string",minLength:1,maxLength:300}}
      },
      required:["kind","title","course","durationMinutes","dueAt","startsAt","endsAt","evidence","confidence","warnings"]
    }},
    explanation:{type:["string","null"],maxLength:4000}
  },
  required:["candidates","explanation"]
} as const;

function capabilityInstruction(capability:AiStructureRequest["capability"]){
  const common="Use only facts explicitly supported by the supplied excerpt. Evidence must be a short verbatim span from that excerpt. Never invent or silently disambiguate dates. Return null for unknown fields and add a warning for ambiguity.";
  switch(capability){
    case "brain_dump":return `${common} Convert the student's brain dump into proposed tasks or commitments.`;
    case "document_extraction":return `${common} Extract only academic planning facts: assignments, exams, tasks, and commitments.`;
    case "task_decomposition":return `${common} Propose concrete, bounded subtasks and realistic duration estimates.`;
    case "explanation":return `${common} Return no candidates and explain the supplied deterministic planner facts in concise student-friendly language.`;
  }
}

function configuredAiProvider():AiProvider|undefined{
  if(!process.env.OPENAI_API_KEY)return undefined;
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:20_000,maxRetries:1});
  return async input=>{
    const response=await client.responses.create({
      model:process.env.OPENAI_MODEL??"gpt-5.6-terra",
      store:false,
      input:[
        {role:"system",content:capabilityInstruction(input.capability)},
        {role:"user",content:input.excerpt}
      ],
      text:{format:{type:"json_schema",name:"student_center_review",strict:true,schema:academicCandidateSchema}}
    });
    return {outputText:response.output_text,model:response.model,inputTokens:response.usage?.input_tokens,outputTokens:response.usage?.output_tokens};
  };
}

function errorStatus(error:unknown){
  if(error instanceof RepositoryConflict)return 409;
  if(error instanceof RepositoryForbidden)return 403;
  return 500;
}

function sendRepositoryError(req:FastifyRequest,reply:FastifyReply,error:unknown,fallback:string){
  const status=errorStatus(error);
  if(status===500)req.log.error({err:error},fallback);
  const message=error instanceof RepositoryConflict||error instanceof RepositoryForbidden?error.message:fallback;
  return reply.code(status).send({error:message});
}

export function buildApp(options:AppOptions={}){
  // Every repository is wrapped, so device authorization cannot depend on which adapter is injected.
  const repository=new AuthorizingSyncRepository(options.repository??new MemorySyncRepository());
  const verifyAccessToken=options.verifyAccessToken;
  const aiProvider=options.aiProvider??configuredAiProvider();
  const app=Fastify({bodyLimit:8*1024*1024,logger:{redact:["req.headers.authorization","req.body.excerpt","req.body.ciphertext","req.body.mutations[*].ciphertext","req.body.encryptedAccountKey","req.body.signature"],serializers:{req(req){return {method:req.method,url:req.url};}}}});

  async function requireAuth(req:FastifyRequest,reply:FastifyReply):Promise<AuthIdentity|null>{
    if(!verifyAccessToken){reply.code(503).send({error:"account services are not configured"});return null;}
    const token=bearerToken(req.headers.authorization);
    if(!token){reply.code(401).send({error:"a bearer access token is required"});return null;}
    try{return await verifyAccessToken(token);}catch{reply.code(401).send({error:"the access token is invalid or expired"});return null;}
  }
  async function requireAuthorizedDevice(req:FastifyRequest,reply:FastifyReply,auth:AuthIdentity){
    const header=Array.isArray(req.headers["x-student-center-device-id"])?undefined:req.headers["x-student-center-device-id"];
    if(typeof header!=="string"){reply.code(401).send({error:"an authorized device header is required"});return null;}
    const device=await repository.getDevice(auth,header);
    if(!device||!device.authorized||device.revoked){reply.code(403).send({error:"the device is not authorized"});return null;}
    return device;
  }

  app.get("/health",async()=>({ok:true,service:"student-center-cloud-api",accountsConfigured:Boolean(verifyAccessToken)}));

  app.post("/v1/devices/register",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    const input=DeviceRegistration.safeParse(req.body);if(!input.success)return reply.code(400).send({error:"invalid device registration"});
    try{const result=await repository.registerDevice(auth,input.data);return reply.code(result.created?201:200).send({registered:true,created:result.created,authorized:result.authorized,accountId:auth.accountId});}
    catch(error){return sendRepositoryError(req,reply,error,"device registration failed");}
  });

  app.post("/v1/devices/:id/approve",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    const parsed=DeviceEnvelope.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:"invalid encrypted device envelope"});
    const targetId=(req.params as {id:string}).id;
    if(targetId!==parsed.data.targetDeviceId)return reply.code(400).send({error:"target device does not match the route"});
    if(Date.parse(parsed.data.expiresAt)<=Date.now())return reply.code(400).send({error:"device envelope is expired"});
    try{
      const [sender,target]=await Promise.all([repository.getDevice(auth,parsed.data.senderDeviceId),repository.getDevice(auth,parsed.data.targetDeviceId)]);
      if(!sender||sender.revoked||!sender.authorized||!target||target.revoked||target.authorized)return reply.code(403).send({error:"the sender must be authorized and the target must be pending"});
      const message=JSON.stringify({envelopeId:parsed.data.envelopeId,targetDeviceId:parsed.data.targetDeviceId,senderDeviceId:parsed.data.senderDeviceId,encryptedAccountKey:parsed.data.encryptedAccountKey,createdAt:parsed.data.createdAt,expiresAt:parsed.data.expiresAt});
      if(!verifyEd25519(sender.signingPublicKey,Buffer.from(message),parsed.data.signature))return reply.code(403).send({error:"the device approval signature is invalid"});
      await repository.saveDeviceEnvelope(auth,parsed.data);
      await repository.authorizeDevice(auth,targetId);
      return {accepted:true,expiresAt:parsed.data.expiresAt};
    }catch(error){return sendRepositoryError(req,reply,error,"device approval failed");}
  });

  app.get("/v1/devices",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    if(!await requireAuthorizedDevice(req,reply,auth))return;
    try{return {devices:(await repository.listDevices(auth)).filter(device=>device.authorized&&!device.revoked)};}
    catch(error){return sendRepositoryError(req,reply,error,"authorized device lookup failed");}
  });

  app.get("/v1/devices/pending",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    if(!await requireAuthorizedDevice(req,reply,auth))return;
    try{return {devices:(await repository.listDevices(auth)).filter(device=>!device.authorized&&!device.revoked)};}
    catch(error){return sendRepositoryError(req,reply,error,"pending device lookup failed");}
  });

  app.get("/v1/devices/envelopes",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    const header=Array.isArray(req.headers["x-student-center-device-id"])?undefined:req.headers["x-student-center-device-id"];
    if(typeof header!=="string")return reply.code(401).send({error:"a device header is required"});
    try{
      const target=await repository.getDevice(auth,header);
      if(!target||target.revoked)return reply.code(403).send({error:"the target device is unavailable"});
      const envelopes=await repository.listDeviceEnvelopes(auth,header);
      const results=[];
      for(const envelope of envelopes){const sender=await repository.getDevice(auth,envelope.senderDeviceId);if(sender&&sender.authorized&&!sender.revoked)results.push({...envelope,senderPublicKey:sender.publicKey,senderSigningPublicKey:sender.signingPublicKey});}
      return {envelopes:results};
    }catch(error){return sendRepositoryError(req,reply,error,"device envelope lookup failed");}
  });

  app.delete("/v1/devices/:id",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    if(!await requireAuthorizedDevice(req,reply,auth))return;
    const deviceId=(req.params as {id:string}).id;
    try{await repository.revokeDevice(auth,deviceId);return {revoked:true,deviceId};}
    catch(error){return sendRepositoryError(req,reply,error,"device revocation failed");}
  });

  // Consumption must accept a still-pending target: the device adopting an approval envelope is
  // by definition not authorized yet, so this uses the same relaxed check as GET /v1/devices/envelopes.
  app.post("/v1/devices/envelopes/:envelopeId/consume",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    const header=Array.isArray(req.headers["x-student-center-device-id"])?undefined:req.headers["x-student-center-device-id"];
    if(typeof header!=="string")return reply.code(401).send({error:"a device header is required"});
    const envelopeId=(req.params as {envelopeId:string}).envelopeId;
    try{
      const target=await repository.getDevice(auth,header);
      if(!target||target.revoked)return reply.code(403).send({error:"the target device is unavailable"});
      await repository.markDeviceEnvelopeConsumed(auth,header,envelopeId);
      return {consumed:true,envelopeId};
    }catch(error){return sendRepositoryError(req,reply,error,"device envelope consumption failed");}
  });

  app.post("/v1/sync/push",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    const device=await requireAuthorizedDevice(req,reply,auth);if(!device)return;
    const parsed=SyncPush.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:"invalid encrypted mutation batch"});
    if(parsed.data.mutations.some(item=>item.accountId!==auth.accountId))return reply.code(403).send({error:"mutation account does not match the authenticated account"});
    // The client binds every mutation's HLC suffix to its own device ID, so a batch may only ever
    // carry mutations authored by the pushing device. Anything else is an attempt to spoof authorship.
    if(parsed.data.mutations.some(item=>item.deviceId!==device.deviceId))return reply.code(403).send({error:"mutation device does not match the pushing device"});
    // Authorship is cryptographic, not merely asserted: the account key is shared across a student's
    // devices, so only the per-device signing key distinguishes who actually wrote a mutation.
    if(parsed.data.mutations.some(item=>!verifyEd25519(device.signingPublicKey,Buffer.from(encryptedMutationSigningMessage(item)),item.signature)))return reply.code(403).send({error:"the mutation signature is invalid"});
    try{return await repository.pushMutations(auth,parsed.data.mutations);}
    catch(error){return sendRepositoryError(req,reply,error,"sync push failed");}
  });

  app.get("/v1/sync/pull",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    if(!await requireAuthorizedDevice(req,reply,auth))return;
    const query=req.query as {cursor?:string;limit?:string};
    const parsedCursor=SyncCursor.safeParse(query.cursor??"0");
    const limit=Number(query.limit??500);
    if(!parsedCursor.success||!Number.isInteger(limit)||limit<1||limit>1000)return reply.code(400).send({error:"invalid sync cursor or limit"});
    try{return await repository.pullMutations(auth,Number(parsedCursor.data),limit);}
    catch(error){return sendRepositoryError(req,reply,error,"sync pull failed");}
  });

  app.post("/v1/objects/initiate",async(req,reply)=>{const auth=await requireAuth(req,reply);if(!auth||!await requireAuthorizedDevice(req,reply,auth))return;const parsed=EncryptedObjectManifest.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:"invalid encrypted object manifest"});try{const missingChunks=await repository.initiateObject(auth,parsed.data);return {initiated:true,documentId:parsed.data.documentId,chunkCount:parsed.data.chunkHashes.length,missingChunks};}catch(error){return sendRepositoryError(req,reply,error,"object initiation failed");}});
  app.put("/v1/objects/:id/chunks/:index",async(req,reply)=>{const auth=await requireAuth(req,reply);if(!auth||!await requireAuthorizedDevice(req,reply,auth))return;const params=req.params as {id:string;index:string};const body=typeof req.body==="object"&&req.body!==null?req.body as Record<string,unknown>:{};const parsed=EncryptedObjectChunk.safeParse({...body,documentId:params.id,index:Number(params.index)});if(!parsed.success)return reply.code(400).send({error:"invalid encrypted object chunk"});const bytes=Buffer.from(parsed.data.ciphertext,"base64url");if(bytes.length>5*1024*1024||createHash("sha256").update(bytes).digest("hex")!==parsed.data.sha256)return reply.code(400).send({error:"encrypted object chunk hash or size is invalid"});try{await repository.putObjectChunk(auth,parsed.data);return {accepted:true,index:parsed.data.index};}catch(error){return sendRepositoryError(req,reply,error,"object chunk upload failed");}});
  app.post("/v1/objects/complete",async(req,reply)=>{const auth=await requireAuth(req,reply);if(!auth||!await requireAuthorizedDevice(req,reply,auth))return;const documentId=(req.body as {documentId?:unknown})?.documentId;if(typeof documentId!=="string")return reply.code(400).send({error:"document ID is required"});try{await repository.completeObject(auth,documentId);return {completed:true,documentId};}catch(error){return sendRepositoryError(req,reply,error,"object completion failed");}});
  app.get("/v1/objects/:id/download",async(req,reply)=>{const auth=await requireAuth(req,reply);if(!auth||!await requireAuthorizedDevice(req,reply,auth))return;const documentId=(req.params as {id:string}).id;try{const object=await repository.downloadObject(auth,documentId);if(!object)return reply.code(404).send({error:"encrypted object was not found"});return object;}catch(error){return sendRepositoryError(req,reply,error,"object download failed");}});
  app.get("/v1/releases/:platform/:arch/latest",async req=>({channel:"private-beta",platform:(req.params as Record<string,string>).platform,arch:(req.params as Record<string,string>).arch,available:false}));

  app.post("/v1/ai/structure",async(req,reply)=>{
    const auth=await requireAuth(req,reply);if(!auth)return;
    const input=AiStructureRequest.safeParse(req.body);if(!input.success)return reply.code(400).send({error:"invalid AI request"});
    if(!aiProvider)return reply.code(503).send({error:"managed AI is not configured"});
    try{
      const providerResult=await aiProvider(input.data);
      let decoded:unknown;
      try{decoded=JSON.parse(providerResult.outputText);}catch{return reply.code(502).send({error:"model returned invalid structured output"});}
      const result=AiStructureResult.safeParse(decoded);
      if(!result.success)return reply.code(502).send({error:"model output failed the review schema"});
      if(input.data.capability==="explanation"&&result.data.candidates.length)return reply.code(502).send({error:"explanation output attempted to create academic records"});
      if(input.data.capability!=="explanation"&&result.data.explanation)return reply.code(502).send({error:"structuring output contained an unexpected explanation"});
      return {candidates:result.data.candidates,explanation:result.data.explanation,reviewRequired:true,accountId:auth.accountId,model:providerResult.model,usage:{inputTokens:providerResult.inputTokens??0,outputTokens:providerResult.outputTokens??0}};
    }catch(error){
      const status=typeof error==="object"&&error!==null&&"status" in error?Number((error as {status?:unknown}).status):0;
      const name=error instanceof Error?error.name:"";
      if(status===429)return reply.code(429).send({error:"managed AI quota is temporarily unavailable"});
      if(name.includes("Timeout")||name.includes("Abort"))return reply.code(504).send({error:"managed AI timed out without changing local data"});
      req.log.warn({capability:input.data.capability,providerStatus:status||undefined},"managed AI request failed");
      return reply.code(502).send({error:"managed AI failed without changing local data"});
    }
  });
  return app;
}
