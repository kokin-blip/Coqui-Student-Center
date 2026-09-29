import { useEffect, useState } from "react";
import { getPlanningPreferences, savePlanningPreferences, type PlanningPreferences } from "./planningApi";
export function PlanningSettings() {
  const [preferences, setPreferences] = useState<PlanningPreferences | null>(null);
  const [standingReview, setStandingReview] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = () => void getPlanningPreferences().then(value => { if (active) setPreferences(value); }).catch(reason => { if (active) setError(String(reason)); });
    load(); window.addEventListener("coqui-planning-settings", load);
    return () => { active = false; window.removeEventListener("coqui-planning-settings", load); };
  }, []);
  async function save(choice: PlanningPreferences["choice"], mode: PlanningPreferences["consentMode"] = "per_request", confirm = false) {
    setBusy(true); setError("");
    try { setPreferences(await savePlanningPreferences(choice, mode, confirm)); setStandingReview(false); setAuthorized(false); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  return <section className="setup-fieldset">
    <h2>AI-assisted automatic planning</h2>
    <p>Coqui can use your connected provider to organize assignments, study sessions, and other eligible work around your schedule and priorities. Every proposed calendar change stays in a preview until you approve it. Deterministic planning is always available.</p>
    {error && <p role="alert" className="alert">{error}</p>}
    {!preferences ? <p role="status">Loading planning preferences…</p> : <>
      <label className="check-row"><input type="checkbox" disabled={busy} checked={preferences.choice === "enabled"} onChange={event => void save(event.target.checked ? "enabled" : "disabled")} /><span>Enable AI-assisted planning</span></label>
      {preferences.choice === "enabled" && <>
        <p className="field-help">By default, review the provider, model, and outgoing facts and consent before every request. De-identified facts exclude names, task titles, documents, locations, and written goals. Schedule patterns may still be distinctive; de-identification does not guarantee anonymity.</p>
        <button type="button" className="outline" disabled={busy} onClick={() => window.dispatchEvent(new Event("coqui-open-ai-planning"))}>Review planning data</button>
        <label className="check-row"><input type="checkbox" disabled={busy} checked={preferences.consentMode === "standing_deidentified" || standingReview} onChange={event => { if (event.target.checked) { setStandingReview(true); setAuthorized(false); } else { setStandingReview(false); void save("enabled"); } }} /><span>Allow automatic requests with de-identified planning facts</span></label>
        {standingReview && <div className="planning-disclosure">
          <strong>Review standing consent</strong>
          <p>After eligible task or schedule changes, Coqui may send temporary work references, durations, deadlines, priorities, dependencies, availability, sleep/break preferences, timezone, and occupied time intervals to the active provider and model in the priority order shown above. This can use your provider’s paid quota. Names, titles, documents, locations, account details, and written goals are excluded.</p>
          <p>Coqui will create one pending preview at a time. It will never apply it automatically or silently retry with another provider. Disable this option to stop future requests. Data already sent cannot be recalled.</p>
          <label className="check-row"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} /><span>I authorize these future de-identified requests after eligible changes.</span></label>
          <button className="solid" type="button" disabled={busy || !authorized} onClick={() => void save("enabled", "standing_deidentified", true)}>Save standing consent</button>
        </div>}
        {preferences.consentMode === "standing_deidentified" && <p role="status">Standing consent is active. Eligible changes can send de-identified facts automatically. You must still review and confirm every application.</p>}
      </>}
      <p className="field-help">Disabling stops queued requests and discards pending previews. Already sent data cannot be recalled. Your current calendar remains in place.</p>
      <button className="outline" type="button" disabled={busy} onClick={() => void save("undecided")}>Reset planning choice</button>
    </>}
  </section>;
}
