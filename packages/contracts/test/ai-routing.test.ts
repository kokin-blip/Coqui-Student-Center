import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderStatus, AiRoutingPreference } from "../src/index.js";

test("ChatGPT routing includes every connector exactly once", () => {
  assert.equal(AiRoutingPreference.safeParse({ order: ["chatgpt", "openai", "anthropic", "gemini"] }).success, true);
  assert.equal(AiRoutingPreference.safeParse({ order: ["chatgpt", "chatgpt", "anthropic", "gemini"] }).success, false);
  assert.equal(AiRoutingPreference.safeParse({ order: ["openai", "anthropic", "gemini"] }).success, false);
});

test("subscription status carries account and model choices without credentials", () => {
  const status = AiProviderStatus.parse({ provider: "chatgpt", connected: true, healthy: true, model: "account-model", capabilities: ["automatic_planning"], disclosureUrl: "https://openai.com/policies/privacy-policy/", accountLabel: "Student", activeAccountId: "oaiapp_fixture", accounts: [{ id: "oaiapp_fixture", label: "Student" }], availableModels: [{ id: "account-model", name: "Account model" }], accessToken: "must-not-cross-boundary" });
  assert.equal(status.provider, "chatgpt");
  assert.equal("accessToken" in status, false);
});
