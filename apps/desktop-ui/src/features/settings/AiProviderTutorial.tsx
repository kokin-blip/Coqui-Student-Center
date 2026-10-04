import { Modal } from "../../components/Modal";
import type { AiProviderId } from "../../native";

export const providerGuides = {
  gemini: {
    name: "Google Gemini",
    availability: "Free tier available for eligible models, within usage limits.",
    account: "Sign in to Google AI Studio with your Google account and accept its terms if prompted.",
    key: "Open API Keys. Use the default project and key if provided, or create a key in a new or imported project. Copy the key.",
    keyUrl: "https://aistudio.google.com/api-keys",
    keyLabel: "Open Google AI Studio",
    billing: "To use the free tier, keep your project on the free tier and choose a model listed as free in the pricing page. Availability and quotas depend on your model, account, and region. Enabling paid billing can incur charges. Free-tier data terms also differ from the paid tier.",
    billingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    billingLabel: "Check Gemini free-tier models and pricing",
    docsUrl: "https://ai.google.dev/gemini-api/docs/api-key",
  },
  openai: {
    name: "OpenAI",
    availability: "Paid API usage. Free credits only if available on your account.",
    account: "Sign in to the OpenAI API platform and select the project you want to use with Coqui.",
    key: "Open API keys and create a new secret key for your project. Name it Coqui and copy the secret when it is shown.",
    keyUrl: "https://platform.openai.com/api-keys",
    keyLabel: "Open OpenAI API keys",
    billing: "Creating a key does not include free API usage. Check your API billing balance for any available free credits; otherwise, paid usage requires billing. ChatGPT subscriptions and credits are separate from API billing. Review auto-recharge settings before buying credits.",
    billingUrl: "https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing",
    billingLabel: "Review OpenAI API billing and credits",
    docsUrl: "https://developers.openai.com/api/docs/quickstart",
  },
  anthropic: {
    name: "Anthropic",
    availability: "Paid API usage through Claude Console credits.",
    account: "Sign in to Claude Console, which manages Anthropic API access separately from the Claude chat app.",
    key: "Go to Settings → API keys and create a key. Name it Coqui, choose an expiration, and copy the secret key.",
    keyUrl: "https://platform.claude.com/settings/keys",
    keyLabel: "Open Claude Console API keys",
    billing: "API usage generally requires prepaid credits. Check Settings → Billing for your balance and buy credits if needed. A Claude chat subscription does not pay for API usage. Review auto-reload before enabling automatic credit purchases.",
    billingUrl: "https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage",
    billingLabel: "Review Anthropic API billing",
    docsUrl: "https://platform.claude.com/docs/en/manage-claude/authentication",
  },
} satisfies Record<AiProviderId, {
  name: string;
  availability: string;
  account: string;
  key: string;
  keyUrl: string;
  keyLabel: string;
  billing: string;
  billingUrl: string;
  billingLabel: string;
  docsUrl: string;
}>;

export function AiProviderTutorial({ provider, close }: { provider: AiProviderId; close: () => void }) {
  const guide = providerGuides[provider];
  return (
    <Modal title={`${guide.name} setup tutorial`} subtitle={guide.availability} close={close} className="ai-provider-tutorial">
      <ol className="ai-tutorial-steps">
        <li><h3>Sign in to your provider</h3><p>{guide.account}</p><a href={guide.keyUrl} target="_blank" rel="noreferrer">{guide.keyLabel} (opens in a new tab)</a></li>
        <li><h3>Create and copy your API key</h3><p>{guide.key}</p></li>
        <li><h3>Check free access and billing</h3><p>{guide.billing}</p><a href={guide.billingUrl} target="_blank" rel="noreferrer">{guide.billingLabel} (opens in a new tab)</a></li>
        <li><h3>Connect in Coqui</h3><p>Close this tutorial and choose Configure on the {guide.name} card. Paste your key into API key, use a model available to your account, confirm the age and billing acknowledgment, then choose Validate and connect.</p></li>
      </ol>
      <p className="field-help">Keep your key private. In the desktop app, Coqui saves it in your OS credential vault. If validation fails, check your key, model access, quota, and credit balance.</p>
      <a href={guide.docsUrl} target="_blank" rel="noreferrer">Official key setup guide (opens in a new tab)</a>
      <div className="modal-actions"><button className="outline" onClick={close}>Back to provider settings</button></div>
    </Modal>
  );
}
