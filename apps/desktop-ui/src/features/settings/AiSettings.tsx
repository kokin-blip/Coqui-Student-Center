import { useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";
import { SettingsDetail } from "../../components/SettingsDetail";
import {
  listAiProviders,
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
  const [aiProvider, setAiProvider] = useState<AiProviderId>("openai");
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiAgeConfirmed, setAiAgeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
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
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDetail
      title="AI providers"
      subtitle="Bring your own key. Requests leave this computer only after you review the provider, model, and data scope."
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
      {loading ? (
        <p role="status">Loading local provider settings…</p>
      ) : (
        <fieldset className="settings-fields" disabled={busy}>
          <legend className="sr-only">AI provider settings</legend>
          <div className="connection-list">
            {aiProviders.map((provider, index) => (
              <article className="connection" key={provider.provider}>
                <div className="connection-head">
                  <span>
                    <Brain />
                    <strong>
                      {provider.provider === "openai"
                        ? "OpenAI"
                        : provider.provider === "anthropic"
                          ? "Anthropic"
                          : "Google Gemini"}
                    </strong>
                    <small>
                      {provider.model} · {provider.maskedKey ?? "Not connected"}
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
                <p>Priority {index + 1}. Usage never changes this order.</p>
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
                  {provider.connected && (
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
                    }}
                  >
                    Configure
                  </button>
                </div>
              </article>
            ))}
          </div>
          <section className="setup-fieldset">
          <h2>
              Connect{" "}
              {aiProvider === "openai"
                ? "OpenAI"
                : aiProvider === "anthropic"
                  ? "Anthropic"
                  : "Gemini"}
          </h2>
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
              disabled={busy || aiKey.length < 20 || !aiAgeConfirmed}
              onClick={async () => {
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
              Validate and connect
            </button>
          </section>
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
    </SettingsDetail>
  );
}
