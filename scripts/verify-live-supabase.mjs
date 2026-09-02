import { createHash } from "node:crypto";

const origin = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const tokenA = process.env.STUDENT_CENTER_RLS_TEST_TOKEN_A;
const tokenB = process.env.STUDENT_CENTER_RLS_TEST_TOKEN_B;
if (!origin || !publishableKey || !tokenA || !tokenB) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and two dedicated RLS test-user tokens are required.",
  );
}
const project = new URL(origin);
if (
  project.protocol !== "https:" ||
  project.pathname !== "/" ||
  project.search ||
  project.hash ||
  project.username ||
  project.password
) {
  throw new Error("SUPABASE_URL must be a strict HTTPS project origin.");
}
if (publishableKey.length < 20 || tokenA === tokenB) {
  throw new Error("Use a publishable key and two different dedicated test-user tokens.");
}

function jwtSubject(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("A test-user token is not a JWT.");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (typeof payload.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.sub)) {
    throw new Error("A test-user token has no UUID subject.");
  }
  return payload.sub;
}

const accountA = jwtSubject(tokenA);
const accountB = jwtSubject(tokenB);
if (accountA === accountB) throw new Error("The two test tokens must belong to different users.");

function stableUuid(account, label) {
  const bytes = createHash("sha256").update(`coqui-live-rls:${account}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function rest(token, path, init = {}) {
  return fetch(new URL(`/rest/v1/${path}`, project), {
    ...init,
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function expect(response, allowed, label) {
  if (!allowed.includes(response.status)) {
    throw new Error(`${label} returned unexpected HTTP ${response.status}.`);
  }
  return response;
}

async function expectDenied(response, label) {
  if (response.ok) throw new Error(`${label} unexpectedly bypassed row-level security.`);
  if (![400, 401, 403, 409].includes(response.status)) {
    throw new Error(`${label} failed with unexpected HTTP ${response.status}.`);
  }
}

const approvedDevice = stableUuid(accountA, "approved-device");
const pendingDevice = stableUuid(accountA, "pending-device");
const mutationId = stableUuid(accountA, "mutation");
const entityId = stableUuid(accountA, "entity");
const objectId = stableUuid(accountA, `object-${Date.now()}`);
const now = new Date().toISOString();
const deviceBase = {
  account_id: accountA,
  public_key: "P".repeat(43),
  signing_public_key: "S".repeat(43),
  display_name: "Coqui live RLS certification",
  platform: "macos-arm64",
};

await expect(
  await rest(tokenA, "student_center_devices?on_conflict=account_id,id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ...deviceBase, id: approvedDevice, approved_at: now, revoked_at: null }),
  }),
  [200, 201, 204],
  "own-account device upsert",
);
await expect(
  await rest(tokenA, "student_center_devices?on_conflict=account_id,id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ...deviceBase, id: pendingDevice, approved_at: null, revoked_at: null }),
  }),
  [200, 201, 204],
  "pending-device upsert",
);

const ownDevice = await expect(
  await rest(tokenA, `student_center_devices?select=id&id=eq.${approvedDevice}`),
  [200],
  "own-account device read",
);
if ((await ownDevice.json()).length !== 1) throw new Error("The owner could not read its device row.");
const hiddenDevice = await expect(
  await rest(tokenB, `student_center_devices?select=id&id=eq.${approvedDevice}`),
  [200],
  "cross-account device read",
);
if ((await hiddenDevice.json()).length !== 0) throw new Error("Another account could read the device row.");
await expectDenied(
  await rest(tokenB, "student_center_devices", {
    method: "POST",
    body: JSON.stringify({ ...deviceBase, id: stableUuid(accountA, "forbidden-device") }),
  }),
  "cross-account device insert",
);

function mutation(deviceId, ciphertext = "C".repeat(64)) {
  return {
    mutation_id: mutationId,
    account_id: accountA,
    device_id: deviceId,
    logical_timestamp: `1788154384000-0000000000-${deviceId}`,
    entity_id: entityId,
    entity_type: "live_rls_probe",
    nonce: "N".repeat(32),
    ciphertext,
    schema_version: 3,
    signature: "G".repeat(86),
    tombstone: true,
  };
}
await expectDenied(
  await rest(tokenA, "student_center_encrypted_mutations", {
    method: "POST",
    body: JSON.stringify({ ...mutation(pendingDevice), mutation_id: stableUuid(accountA, "pending-mutation") }),
  }),
  "pending-device mutation insert",
);
await expect(
  await rest(tokenA, "student_center_encrypted_mutations?on_conflict=mutation_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(mutation(approvedDevice)),
  }),
  [200, 201, 204],
  "approved-device mutation insert",
);
await expectDenied(
  await rest(tokenA, "student_center_encrypted_mutations?on_conflict=mutation_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(mutation(approvedDevice, "X".repeat(64))),
  }),
  "mutation substitution",
);
await expectDenied(
  await rest(tokenB, "student_center_encrypted_mutations", {
    method: "POST",
    body: JSON.stringify({ ...mutation(approvedDevice), mutation_id: stableUuid(accountA, "cross-account-mutation") }),
  }),
  "cross-account mutation insert",
);

const object = {
  account_id: accountA,
  document_id: objectId,
  encrypted_metadata: "M".repeat(64),
  wrapped_object_key: "K".repeat(64),
  chunk_hashes: [],
  version: 1,
};
await expect(
  await rest(tokenA, "student_center_encrypted_objects", { method: "POST", body: JSON.stringify(object) }),
  [200, 201, 204],
  "own-account encrypted object insert",
);
const hiddenObject = await expect(
  await rest(tokenB, `student_center_encrypted_objects?select=document_id&document_id=eq.${objectId}`),
  [200],
  "cross-account encrypted object read",
);
if ((await hiddenObject.json()).length !== 0) throw new Error("Another account could read encrypted metadata.");
await expectDenied(
  await rest(tokenB, "student_center_encrypted_objects", {
    method: "POST",
    body: JSON.stringify({ ...object, document_id: stableUuid(accountA, "forbidden-object") }),
  }),
  "cross-account encrypted object insert",
);
await expect(
  await rest(tokenA, `student_center_encrypted_objects?account_id=eq.${accountA}&document_id=eq.${objectId}`, {
    method: "DELETE",
  }),
  [200, 204],
  "live-probe object cleanup",
);

console.log("Live Supabase RLS, authorized-device, and mutation-substitution checks passed.");
