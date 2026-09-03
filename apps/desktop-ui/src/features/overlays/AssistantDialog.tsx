import { Sparkles } from "lucide-react";
import type { AiProviderStatus } from "../../native";
import { Modal } from "../../components/Modal";

export type AssistantCapability =
  | "brain_dump"
  | "task_decomposition"
  | "document_extraction"
  | "planner_explanation";

export function AssistantDialog({
  providers,
  busy,
  capability,
  excerpt,
  consent,
  explanation,
  close,
  openSettings,
  setCapability,
  setExcerpt,
  setConsent,
  submit,
}: {
  providers: AiProviderStatus[];
  busy: boolean;
  capability: AssistantCapability;
  excerpt: string;
  consent: boolean;
  explanation: string;
  close: () => void;
  openSettings: () => void;
  setCapability: (value: AssistantCapability) => void;
  setExcerpt: (value: string) => void;
  setConsent: (value: boolean) => void;
  submit: () => void;
}) {
  const provider = providers.find((item) => item.connected && item.healthy);
  return (
    <Modal
      title="AI is optional"
      subtitle="Core planning and local extraction remain available without an account, internet, or API key."
      close={close}
    >
      <div className="consent-box">
        <Sparkles aria-hidden="true" />
        <div>
          <strong>
            {provider
              ? `${provider.provider} · ${provider.model}`
              : "Connect an AI provider first"}
          </strong>
          <p>
            Data scope: only the excerpt shown below is sent over TLS. Responses become reviewable candidates and can’t directly alter your plan. A failure is never retried with another provider without asking.
          </p>
        </div>
      </div>
      <label className="field">
        AI action
        <select
          value={capability}
          onChange={(event) =>
            setCapability(event.target.value as AssistantCapability)
          }
        >
          <option value="brain_dump">Structure a brain dump</option>
          <option value="task_decomposition">Break down an assignment</option>
          <option value="document_extraction">Clarify an excerpt</option>
          <option value="planner_explanation">Explain planner facts</option>
        </select>
      </label>
      <label className="field">
        Selected excerpt
        <textarea
          value={excerpt}
          onChange={(event) => setExcerpt(event.target.value)}
          maxLength={12000}
          rows={7}
          placeholder="Paste only the brain dump, assignment excerpt, or deterministic facts needed for this request."
        />
        <small>{excerpt.length.toLocaleString()} / 12,000 characters</small>
      </label>
      <label className="check-row consent-check">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>
          I consent to sending only this excerpt to the provider and model shown
          above for this request.
        </span>
      </label>
      {explanation && (
        <div className="consent-box ai-explanation" role="status">
          <Sparkles aria-hidden="true" />
          <div>
            <strong>Explanation</strong>
            <p>{explanation}</p>
          </div>
        </div>
      )}
      <div className="modal-actions">
        <button className="outline" onClick={close}>Cancel</button>
        {!provider && (
          <button className="outline" onClick={openSettings}>
            Configure providers
          </button>
        )}
        <button
          className="solid"
          disabled={busy || !provider || !consent || !excerpt.trim()}
          onClick={submit}
        >
          <Sparkles aria-hidden="true" />
          {busy ? "Working…" : "Create reviewable result"}
        </button>
      </div>
    </Modal>
  );
}
