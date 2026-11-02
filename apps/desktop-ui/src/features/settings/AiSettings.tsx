import { useEffect, useRef, useState } from "react";
import { PlanningSettings } from "../planning/PlanningSettings";
import { BookOpen, Brain } from "lucide-react";
import { AiProviderTutorial, providerGuides } from "./AiProviderTutorial";
import { SettingsDetail } from "../../components/SettingsDetail";
import {
  listAiProviders,
  connectChatgpt,
  cancelChatgptLogin,
  setChatgptModel,
  getAiUsage,
  saveAiProviderKey,
  testAiProvider,
  removeAiProvider,
  setAiProviderOrder,
  type AiProviderId,
  type AiProviderStatus,
  type AiUsageSummary,
} from "../../native";
export function AiSettings({
  aiProviders,
  setAiProviders,
  close,
  setToast,
}: {
  aiProviders: AiProviderStatus[];
  setAiProviders: (providers: AiProviderStatus[]) => void;
  close: () => void;
  setToast: (message: string) => void;
}) {
  const [aiUsage, setAiUsage] = useState<AiUsageSummary[]>([]);
  const [aiProvider, setAiProvider] = useState<AiProviderId>("chatgpt");
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiAgeConfirmed, setAiAgeConfirmed] = useState(false);
  const [chatgptPending, setChatgptPending] = useState(false);
  const [chatgptAccount, setChatgptAccount] = useState("");
  const pendingSignIn = useRef(false);
  useEffect(() => () => { if (pendingSignIn.current) void cancelChatgptLogin().catch(() => {}); }, []);
  const chatgpt = aiProviders.find(item => item.provider === "chatgpt");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [tutorialProvider, setTutorialProvider] = useState<AiProviderId | null>(null);
  const providersCallback = useRef(setAiProviders);
  providersCallback.current = setAiProviders;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([listAiProviders(), getAiUsage()])
      .then(([providers, usage]) => {
        if (!active) return;
        providersCallback.current(providers);
        setAiUsage(usage);
        setChatgptAccount(providers.find(item => item.provider === "chatgpt")?.activeAccountId ?? "");
        setAiModel(
          providers.find((item) => item.provider === "openai")?.model ?? "",
        );
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  const updateProviders = async (action: () => Promise<AiProviderStatus[]>) => {
    setBusy(true);
    setError("");
    try {
      setAiProviders(await action());
    } catch (reason) {
      setError(String(reason));
      // Disconnect can clear local credentials even if remote revocation fails.
      try { setAiProviders(await listAiProviders()); } catch { /* Keep the action error visible. */ }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDetail
      title="AI providers"
      subtitle="Connect your ChatGPT subscription or bring an API key. Review the provider, model, and data scope before each request."
      close={() => {
        setAiKey("");
        if (!busy) close();
      }}
    >
      {error && (
        <p className="alert" role="alert">
          {error}{" "}
          <button
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload providers
          </button>
        </p>
      )}
      {chatgptPending && <div role="status">
        <p>Finish signing in with ChatGPT in your browser, then return to Coqui.</p>
        <button className="outline" onClick={() => { void cancelChatgptLogin().catch(reason => setError(String(reason))); }}>Cancel sign-in</button>
      </div>}
      {loading ? (
        <p role="status">Loading local provider settings…</p>
      ) : (
        <fieldset className="settings-fields ai-provider-fields" disabled={busy}>
          <legend className="sr-only">AI provider settings</legend>
          <section className="setup-fieldset">
          <h2>
              Connect{" "}
              {providerGuides[aiProvider].name}
          </h2>
            <button className="outline ai-tutorial-trigger" onClick={() => setTutorialProvider(aiProvider)}>
              <BookOpen aria-hidden="true" /> {aiProvider === "chatgpt" ? "How to connect ChatGPT" : "How to get an API key"}
            </button>
            {aiProvider === "chatgpt" ? <>
              <p>Use your ChatGPT plan with Coqui. Account eligibility, workspace permissions, and your authorized usage limits apply.</p>
              {!!chatgpt?.accounts?.length && <label className="field">
                ChatGPT account
                <select value={chatgptAccount} onChange={event => setChatgptAccount(event.target.value)}>
                  {chatgpt.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
                  <option value="">Add another account</option>
                </select>
              </label>}
              {chatgpt?.activeAccountId && !chatgpt.connected && <p className="field-help">Reconnect to enable ChatGPT plan usage or renew your sign-in.</p>}
              {!!chatgpt?.availableModels?.length && <label className="field">
                ChatGPT model
                <select value={chatgpt.model} onChange={event => void updateProviders(() => setChatgptModel(event.target.value))}>
                  {chatgpt.availableModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>}
              <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage ChatGPT usage and app access</a>
            </> : <>
            <label className="field">
              API key
              <input
                type="password"
                value={aiKey}
                onChange={(event) => setAiKey(event.target.value)}
                autoComplete="off"
                placeholder="Saved only in the OS credential vault"
              />
            </label>
            <label className="field">
              Model
              <input
                value={aiModel}
                onChange={(event) => setAiModel(event.target.value)}
                placeholder="Recommended default"
              />
            </label>
            </>}
            <label className="check-row">
              <input
                type="checkbox"
                checked={aiAgeConfirmed}
                onChange={(event) => setAiAgeConfirmed(event.target.checked)}
              />
              <span>
                I am 18 or older and understand that my own provider account,
                billing, and data terms apply.
              </span>
            </label>
            <p className="field-help">
              Coqui sends only the scope shown before each request. It never
              silently retries with another provider.{" "}
              <a
                href={
                  aiProviders.find((item) => item.provider === aiProvider)
                    ?.disclosureUrl
                }
                target="_blank"
                rel="noreferrer"
              >
                Review this provider’s data terms
              </a>
              .
            </p>
            <button
              className="solid"
              disabled={busy || (aiProvider !== "chatgpt" && aiKey.length < 20) || !aiAgeConfirmed}
              data-oai-siwc-button={aiProvider === "chatgpt" ? "" : undefined}
              onClick={async () => {
                if (aiProvider === "chatgpt") {
                  setBusy(true); setChatgptPending(true); pendingSignIn.current = true; setError("");
                  try {
                    const next = await connectChatgpt(chatgptAccount || undefined, aiAgeConfirmed);
                    setAiProviders(next);
                    const connected = next.find(item => item.provider === "chatgpt");
                    setChatgptAccount(connected?.activeAccountId ?? "");
                    if (connected?.healthy) setToast("ChatGPT connected as your primary connector.");
                    else setError("ChatGPT sign-in was saved, but plan access or model availability needs attention. Reconnect to enable plan usage, or choose another provider.");
                  } catch (reason) { setError(String(reason)); }
                  finally { setBusy(false); setChatgptPending(false); pendingSignIn.current = false; }
                  return;
                }
                const submittedKey = aiKey;
                setAiKey("");
                setBusy(true);
                setError("");
                try {
                  const next = await saveAiProviderKey(
                    aiProvider,
                    submittedKey,
                    aiModel || undefined,
                    aiAgeConfirmed,
                  );
                  setAiProviders(next);
                  setToast(`${aiProvider} connected securely.`);
                } catch (next) {
                  setError(String(next));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {aiProvider === "chatgpt" ? "Continue with ChatGPT" : "Validate and connect"}
            </button>
          </section>
          <div className="connection-list">
            {aiProviders.map((provider, index) => (
              <article className="connection" key={provider.provider}>
                <div className="connection-head">
                  <span>
                    <Brain />
                    <strong>
                      {providerGuides[provider.provider].name}
                    </strong>
                    <small>
                      {provider.model || "Choose a model after sign-in"} · {provider.accountLabel ?? provider.maskedKey ?? "Not connected"}
                    </small>
                  </span>
                  <b
                    className={`status ${provider.healthy ? "connected" : provider.connected ? "error" : "disconnected"}`}
                  >
                    {provider.healthy
                      ? "ready"
                      : provider.connected
                        ? "check needed"
                        : "not connected"}
                  </b>
                </div>
                <p>{index === 0 ? "Primary connector." : `Priority ${index + 1}.`} Usage never changes this order.</p>
                <p className="field-help">{providerGuides[provider.provider].availability}</p>
                <div className="connection-actions">
                  <button
                    className="outline"
                    disabled={index === 0 || busy}
                    onClick={() => {
                      const order = aiProviders.map((item) => item.provider);
                      [order[index - 1], order[index]] = [
                        order[index],
                        order[index - 1],
                      ];
                      void updateProviders(() => setAiProviderOrder(order));
                    }}
                  >
                    Move up
                  </button>
                  {provider.connected && (
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() =>
                        void updateProviders(() =>
                          testAiProvider(provider.provider),
                        )
                      }
                    >
                      Test
                    </button>
                  )}
                  {(provider.connected || (provider.provider === "chatgpt" && provider.activeAccountId)) && (
                    <button
                      className="outline danger"
                      disabled={busy}
                      onClick={() =>
                        void updateProviders(() =>
                          removeAiProvider(provider.provider),
                        )
                      }
                    >
                      Disconnect
                    </button>
                  )}
                  <button
                    className="outline"
                    onClick={() => {
                      setAiProvider(provider.provider);
                      setAiModel(provider.model);
                      setAiKey("");
                      if (provider.provider === "chatgpt") setChatgptAccount(provider.activeAccountId ?? "");
                    }}
                  >
                    Configure
                  </button>
                  <button
                    className="outline"
                    aria-label={`${providerGuides[provider.provider].name} setup tutorial`}
                    onClick={() => setTutorialProvider(provider.provider)}
                  >
                    <BookOpen aria-hidden="true" /> Setup tutorial
                  </button>
                </div>
              </article>
            ))}
          </div>
          <PlanningSettings />
          <section className="setup-fieldset">
          <h2>Local usage</h2>
            {aiUsage.length ? (
              aiUsage.map((item) => (
                <p
                  className="field-help"
                  key={`${item.provider}:${item.model}`}
                >
                  <strong>
                    {item.provider} · {item.model}
                  </strong>{" "}
                  — {item.requests} requests,{" "}
                  {item.inputTokens.toLocaleString()} input tokens,{" "}
                  {item.outputTokens.toLocaleString()} output tokens,{" "}
                  {item.failures} failures.
                </p>
              ))
            ) : (
              <p className="field-help">
                No AI requests recorded on this device.
              </p>
            )}
          </section>
        </fieldset>
      )}
      {tutorialProvider && <AiProviderTutorial provider={tutorialProvider} close={() => setTutorialProvider(null)} />}
    </SettingsDetail>
  );
}
