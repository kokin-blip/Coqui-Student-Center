import { useEffect, useRef, useState } from "react";
import { getDashboard, getLocalWorkspace, updatePlanningPreferences, type Dashboard, type SchedulingStyle, type WorkspaceSnapshot } from "../../native";
import { SchedulingStyleField } from "./SchedulingStyleField";

export function LocalScheduling({ dashboard, showChoice, blocked, onDashboard }: { dashboard: Dashboard; showChoice: boolean; blocked: boolean; onDashboard: (data: Dashboard) => void }) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [style, setStyle] = useState<SchedulingStyle>("mixed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(dashboard); current.current = dashboard;
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || blockedRef.current || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const next = await getDashboard();
        const nextWorkspace = await getLocalWorkspace();
        if (!active) return;
        setWorkspace(nextWorkspace);
        setError("");
        if (JSON.stringify(next) !== JSON.stringify(current.current)) {
          current.current = next;
          onDashboard(next);
          window.dispatchEvent(new Event("coqui-local-plan-updated"));
        }
      } catch (reason) { if (active) setError(`Automatic scheduling could not refresh: ${String(reason)}`); }
      finally { pending = false; }
    };
    void refresh();
    const tick = window.setInterval(() => void refresh(), 60_000);
    const resume = () => void refresh();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { active = false; window.clearInterval(tick); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [onDashboard]);
  useEffect(() => { void getLocalWorkspace().then(setWorkspace).catch(reason => setError(String(reason))); }, [dashboard]);
  const choose = async () => {
    if (!workspace?.preferences) return;
    setBusy(true); setError("");
    try {
      const nextWorkspace = await updatePlanningPreferences({ ...workspace.preferences, schedulingStyle:style, expectedVersion:workspace.preferences.version, availability:workspace.availability });
      setWorkspace(nextWorkspace);
      const next = await getDashboard();
      current.current = next;
      onDashboard(next);
      window.dispatchEvent(new Event("coqui-local-plan-updated"));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <>
    {showChoice && workspace?.preferences && !workspace.preferences.schedulingStyle && <section className="workspace-panel" aria-label="Choose assignment scheduling">
      <h2>How should Coqui schedule your assignments?</h2>
      <p>Assignments are placed automatically around your day. Choose a style once; you can change it in Planning preferences.</p>
      <SchedulingStyleField value={style} onChange={setStyle} disabled={busy || blocked} />
      <button className="solid" disabled={busy || blocked} onClick={() => void choose()}>{busy ? "Saving…" : "Save scheduling style"}</button>
    </section>}
    {error && <p className="alert" role="alert">{error}</p>}
  </>;
}
