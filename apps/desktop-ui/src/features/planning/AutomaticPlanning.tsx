import { useEffect, useRef, useState } from "react";
import { Sparkles, ArrowUp } from "lucide-react";
import { Modal } from "../../components/Modal";
import { type Dashboard } from "../../native";
import { applyPlanning, discardPlanning, getPlanningStatus, preparePlanning, requestPlanning, savePlanningPreferences, validatePlanning, type PlanningDisclosure, type PlanningPreview, type PlanningStatus, type SuggestedSession } from "./planningApi";
import "./planning.css";

const displayTime = (value: string) => new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const localTime = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

export function AutomaticPlanning({ refreshKey, onboarding = false, blocked = false, onDashboard, onLocalPlanning }: { refreshKey: unknown; onboarding?: boolean; blocked?: boolean; onDashboard?: (data: Dashboard) => void; onLocalPlanning?: () => void }) {
  const [status, setStatus] = useState<PlanningStatus | null>(null);
  const [screen, setScreen] = useState<"choice" | "scope" | "onboarding-scope" | "preview" | null>(null);
  const [disclosure, setDisclosure] = useState<PlanningDisclosure | null>(null);
  const [preview, setPreview] = useState<PlanningPreview | null>(null);
  const [sessions, setSessions] = useState<SuggestedSession[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [consent, setConsent] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [applyConsent, setApplyConsent] = useState(false);
  const [offer, setOffer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const baseline = useRef<string | null>(null);
  const activeRequest = useRef(false);
  const currentRevision = useRef<number | null>(null);
  const mounted = useRef(true);
  const operation = useRef(0);
  const previewRef = useRef(preview); previewRef.current = preview;
  const screenRef = useRef(screen); screenRef.current = screen;
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const showPreview = (value: PlanningPreview) => { setPreview(value); setSessions(value.sessions); setExcluded(value.excluded); setDirty(false); setApplyConsent(false); };
  async function send(value: PlanningDisclosure, standing: boolean) {
    if (activeRequest.current) return;
    activeRequest.current = true; setBusy(true); setError("");
    const revision = currentRevision.current;
    try {
      const next = await requestPlanning(value.token, !standing && consent, standing, !standing && consent && value.includeIdentifying);
      if (!mounted.current || currentRevision.current !== revision) return;
      showPreview(next); setOffer(false); if (!standing) setScreen("preview");
    } catch (reason) { if (mounted.current) { setError(String(reason)); setConsent(false); if (standing) setOffer(true); } }
    finally { activeRequest.current = false; if (mounted.current) setBusy(false); }
  }
  async function load() {
    try {
      const next = await getPlanningStatus();
      if (!mounted.current) return;
      const previousRevision = currentRevision.current;
      currentRevision.current = next.preferences.revision;
      setStatus(next);
      if (previousRevision !== null && previousRevision !== next.preferences.revision) {
        operation.current++; setDisclosure(null); setConsent(false); setApplyConsent(false); setPreview(null); setScreen(null); setOffer(false);
      }
      if (next.preferences.choice !== "enabled") { setPreview(null); setOffer(false); }
      else if (next.pending && !activeRequest.current && next.pending.reviewId !== previewRef.current?.reviewId) showPreview(next.pending);
      if (next.prompt && !blockedRef.current) setScreen("choice");
      const changed = baseline.current !== null && next.fingerprint !== baseline.current;
      baseline.current = next.fingerprint;
      if (!changed || onboarding || next.preferences.choice !== "enabled" || next.pending || activeRequest.current) return;
      setOffer(true);
      if (next.preferences.consentMode === "standing_deidentified" && !screenRef.current) {
        const revision = next.preferences.revision;
        const scope = await preparePlanning(false);
        if (!mounted.current || currentRevision.current !== revision) return;
        await send(scope, true);
      }
    } catch (reason) { if (mounted.current) setError(String(reason)); }
  }
  async function openScope(includeIdentifying = false) {
    if (busy || activeRequest.current) return;
    setError(""); setConsent(false); setApplyConsent(false); setIdentifying(includeIdentifying);
    if (onboarding) { setScreen("onboarding-scope"); return; }
    setScreen("scope"); setDisclosure(null); setBusy(true);
    const id = ++operation.current;
    try { const next = await preparePlanning(includeIdentifying); if (mounted.current && operation.current === id) setDisclosure(next); }
    catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void load(), 600);
    const reload = () => void load();
    const open = () => void openScope();
    window.addEventListener("coqui-planning-settings", reload);
    window.addEventListener("coqui-open-ai-planning", open);
    return () => { mounted.current = false; window.clearTimeout(timer); window.removeEventListener("coqui-planning-settings", reload); window.removeEventListener("coqui-open-ai-planning", open); };
  }, [refreshKey, onboarding, blocked]);
  async function choose(enabled: boolean) {
    setBusy(true); setError("");
    try { const next = await savePlanningPreferences(enabled ? "enabled" : "disabled"); currentRevision.current = next.revision; setStatus(old => old ? { ...old, preferences: next, prompt: false } : null); setScreen(enabled ? (onboarding ? "onboarding-scope" : "scope") : null); }
    catch (reason) { setError(String(reason)); return; } finally { setBusy(false); }
    if (enabled && !onboarding) await openScope();
  }
  async function discard() {
    setBusy(true); setError("");
    try { await discardPlanning(); operation.current++; setPreview(null); setDisclosure(null); setScreen(null); setOffer(false); setApplyConsent(false); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  async function validate(order = preview?.order ?? [], proposed: SuggestedSession[] | null = sessions, excludedTasks = excluded) {
    if (!preview) return;
    setBusy(true); setError(""); setApplyConsent(false);
    try { showPreview(await validatePlanning(preview.token, order, proposed, excludedTasks)); }
    catch (reason) { setError(String(reason)); setDirty(true); } finally { setBusy(false); }
  }
  const recovery = onLocalPlanning && <button className="outline" disabled={busy} onClick={async () => { await discard(); onLocalPlanning(); }}>Use deterministic planning</button>;
  const disclosureText = <>
    <p>AI may suggest ordering and session times for existing assignments, study sessions, and other unfinished tasks. It cannot create tasks, change deadlines or priorities, or replace completed, past, fixed, locked, or manually moved calendar blocks.</p>
    <p>De-identified requests contain temporary work references, durations, deadlines, priorities, dependencies, availability, sleep/break preferences, timezone, and occupied intervals. Names, titles, locations, documents, accounts, and written goals are excluded. Schedule patterns may still be distinctive.</p>
    <p>You will review and edit a preview, then separately confirm applying it. Undo is available until newer calendar edits make restoration unsafe. Deterministic planning stays available.</p>
  </>;
  return <>
    {!onboarding && (offer || preview) && <div className="planning-offer" role="status"><Sparkles aria-hidden="true" /><span>{preview ? "An AI-assisted plan is ready for review." : "Your work or schedule changed. AI can help review your plan."}</span><button className="outline" disabled={busy} onClick={() => preview ? setScreen("preview") : void openScope()}>{preview ? "Review proposed plan" : "Review AI planning"}</button><button className="text-button" disabled={busy} onClick={() => void discard()}>Dismiss</button></div>}
    {!screen && error && <p className="planning-error" role="alert">{error} <button className="text-button" onClick={() => setError("")}>Dismiss</button></p>}
    {screen === "choice" && <Modal title="Enable AI-assisted automatic planning?" subtitle="Your first provider is ready. Planning assistance is optional." close={() => { if (!busy) void choose(false); }}>
      <p>Coqui can use your connected provider to help organize assignments, study sessions, and other eligible work around your schedule and priorities.</p>
      <p>Enabling does not send data. Review what AI may access and change next. By default, each request needs your consent, and every calendar change needs your approval.</p>
      <p>You can change or reset this choice later in Settings → AI providers. If you decline, Coqui keeps its existing local planning behavior.</p>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="modal-actions"><button className="outline" disabled={busy} onClick={() => void choose(false)}>No thanks</button><button className="solid" disabled={busy} onClick={() => void choose(true)}>Enable and review access</button></div>
    </Modal>}
    {screen === "onboarding-scope" && <Modal title="Review AI planning access" subtitle="No planning data has been sent." close={() => setScreen(null)}>{disclosureText}<p>Finish local setup first. Then choose AI-assisted planning to review the exact facts and provider before consenting. Settings also offers optional standing consent for future de-identified requests.</p><div className="modal-actions"><button className="solid" onClick={() => setScreen(null)}>Continue local setup</button></div></Modal>}
    {screen === "scope" && <Modal title="Review AI planning access" subtitle="Creating a preview does not change your calendar." close={() => { if (!busy) void discard(); }}>
      {disclosureText}
      <label className="check-row"><input type="checkbox" checked={identifying} disabled={busy} onChange={event => void openScope(event.target.checked)} /><span>Include identifying task and commitment titles and my written planning goals for this request only.</span></label>
      {disclosure ? <div className="planning-disclosure"><strong>{disclosure.provider} · {disclosure.model}</strong><a href={disclosure.disclosureUrl} target="_blank" rel="noreferrer">Provider data terms</a><details><summary>Exact outgoing planning facts</summary><pre>{JSON.stringify(disclosure.facts, null, 2)}</pre></details><details><summary>Local work labels — titles stay on this device unless included above</summary><ul>{disclosure.labels.map(label => <li key={label.reference}>{label.reference}: {label.title}</li>)}</ul></details><label className="check-row"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>I consent to sending these reviewed facts{disclosure.includeIdentifying ? ", including the identifying titles and written goals" : ""} to {disclosure.provider} · {disclosure.model} for this request.</span></label></div> : busy ? <p role="status">Preparing local disclosure…</p> : null}
      <p className="field-help">No silent retries with another provider. Settings offers optional standing consent for automatic de-identified requests after eligible changes.</p>
      {error && <div><p className="alert" role="alert">{error}</p><button className="outline" disabled={busy} onClick={() => void openScope(identifying)}>Refresh local disclosure</button>{recovery}</div>}
      <div className="modal-actions"><button className="outline" disabled={busy} onClick={() => void discard()}>Keep current plan</button><button className="solid" disabled={busy || !consent || !disclosure} onClick={() => disclosure && void send(disclosure, false)}>{busy ? "Working…" : "Send facts and create preview"}</button></div>
    </Modal>}
    {screen === "preview" && preview && <Modal title="Review proposed plan" subtitle={`${preview.provider} · ${preview.model}. Your calendar has not changed.`} close={() => { if (!busy) setScreen(null); }} className="planning-preview">
      <p>{preview.explanation}</p>
      <p>{preview.protected.length} protected blocks stay in place. {preview.outcome.capacity.overloadMinutes} minutes remain unscheduled.</p>
      <details><summary>Protected calendar blocks</summary><ul>{preview.protected.map(block => <li key={block.id}>{block.title}: {displayTime(block.startsAt)} – {displayTime(block.endsAt)}</li>)}</ul></details>
      <details><summary>Current sessions being replaced or removed</summary><ul>{preview.before.filter(block => !preview.protected.some(protectedBlock => protectedBlock.id === block.id)).map(block => <li key={block.id}>{block.title}: {displayTime(block.startsAt)} – {displayTime(block.endsAt)}</li>)}</ul></details>
      <h3>Work order</h3>
      <ol className="planning-order">{preview.order.map((reference, index) => <li key={reference}><span>{preview.labels.find(label => label.reference === reference)?.title}</span><label className="check-row"><input type="checkbox" disabled={busy} checked={!excluded.includes(reference)} onChange={event => { const next = event.target.checked ? excluded.filter(item => item !== reference) : [...excluded, reference]; setExcluded(next); setDirty(true); setApplyConsent(false); }} /><span>Use proposed sessions</span></label><button className="outline" disabled={busy || dirty || index === 0} aria-label={`Move ${preview.labels.find(label => label.reference === reference)?.title} earlier in work order`} onClick={() => { const order = [...preview.order]; [order[index - 1], order[index]] = [order[index], order[index - 1]]; void validate(order, null); }}><ArrowUp aria-hidden="true" />Move earlier</button></li>)}</ol>
      <p className="field-help">Excluding work retains its current sessions. Changing order rebuilds proposed times locally. All edits require validation.</p>
      <h3>Proposed sessions</h3>
      <div className="planning-sessions">{sessions.map((session, index) => <fieldset key={`${session.reference}-${index}`} disabled={busy || excluded.includes(session.reference)}><legend>{preview.labels.find(label => label.reference === session.reference)?.title} · {preview.before.some(block => block.taskId === preview.labels.find(label => label.reference === session.reference)?.taskId && !preview.protected.some(item => item.id === block.id)) ? "Moved or retained session" : "Added session"}</legend>{(["startsAt", "endsAt"] as const).map(field => <label className="field" key={field}>{field === "startsAt" ? "Starts" : "Ends"}<input type="datetime-local" step="300" value={localTime(session[field])} onChange={event => { if (!event.target.value) return; const next = [...sessions]; next[index] = { ...session, [field]: new Date(event.target.value).toISOString() }; setSessions(next); setDirty(true); setApplyConsent(false); }} /></label>)}</fieldset>)}</div>
      {preview.outcome.overloadConflicts.length > 0 && <div><h3>Unscheduled work</h3><ul>{preview.outcome.overloadConflicts.map(conflict => <li key={conflict.taskId}>{conflict.title}: {conflict.unscheduledMinutes} minutes</li>)}</ul></div>}
      {error && <div><p className="alert" role="alert">{error}</p>{recovery}</div>}
      {dirty && <button className="outline" disabled={busy} onClick={() => void validate()}>Validate edited preview</button>}
      <label className="check-row"><input type="checkbox" checked={applyConsent} disabled={busy || dirty} onChange={event => setApplyConsent(event.target.checked)} /><span>I approve applying the reviewed additions, moves, and removals to my calendar.</span></label>
      <div className="modal-actions"><button className="outline" disabled={busy} onClick={() => void discard()}>Discard proposal</button><button className="solid" disabled={busy || dirty || !applyConsent} onClick={async () => { setBusy(true); setError(""); try { const next = await applyPlanning(preview.token, preview.reviewId, applyConsent); onDashboard?.(next); setPreview(null); setScreen(null); setOffer(false); } catch (reason) { setError(String(reason)); setApplyConsent(false); } finally { setBusy(false); } }}>Apply reviewed plan</button></div>
    </Modal>}
  </>;
}
