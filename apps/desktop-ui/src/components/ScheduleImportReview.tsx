import { useEffect, useMemo, useState } from "react";
import { FileLock2, Pencil, Save } from "lucide-react";
import {
  CandidateEditInput,
  Dashboard,
  AcademicTermRecord,
  getScheduleSourcePreview,
  ImportCandidate,
  updateImportCandidate,
} from "../native";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const localDateTime = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const utcDateTime = (value: string) =>
  value ? new Date(value).toISOString() : undefined;

const candidateInput = (candidate: ImportCandidate, terms: AcademicTermRecord[]): CandidateEditInput => ({
  title: candidate.title,
  course: candidate.course,
  dueAt: candidate.dueAt,
  startsAt: candidate.startsAt,
  endsAt: candidate.endsAt,
  durationMinutes: candidate.durationMinutes,
  weekdays: candidate.weekdays ?? [],
  startsAtLocal: candidate.startsAtLocal ?? "",
  endsAtLocal: candidate.endsAtLocal ?? "",
  timezone: candidate.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  sectionNumber: candidate.sectionNumber ?? "",
  location: candidate.location ?? "",
  modality: candidate.modality ?? "",
  termId: candidate.termId ?? terms.find((term) => term.active)?.id ?? "",
});

type Props = {
  candidates: ImportCandidate[];
  selectedIds: string[];
  conflictedIds: Set<string>;
  busy: boolean;
  onSelection: (ids: string[]) => void;
  onDashboard: (dashboard: Dashboard) => void;
  onError: (message: string) => void;
  terms: AcademicTermRecord[];
};

export function ScheduleImportReview({
  candidates,
  selectedIds,
  conflictedIds,
  busy,
  onSelection,
  onDashboard,
  onError,
  terms,
}: Props) {
  const sources = useMemo(
    () => [...new Set(candidates.map((candidate) => candidate.documentId))],
    [candidates],
  );
  const [activeSource, setActiveSource] = useState(sources[0] ?? "");
  const [preview, setPreview] = useState<{ fileName: string; mime: string; dataUrl: string } | null>(null);
  const [previewNotice, setPreviewNotice] = useState("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState<CandidateEditInput | null>(null);

  useEffect(() => {
    if (!sources.includes(activeSource)) setActiveSource(sources[0] ?? "");
  }, [activeSource, sources]);

  useEffect(() => {
    let current = true;
    setPreview(null);
    setPreviewNotice("");
    if (!activeSource) return;
    void getScheduleSourcePreview(activeSource)
      .then((value) => {
        if (current) setPreview(value);
      })
      .catch((error) => {
        if (current) setPreviewNotice(String(error));
      });
    return () => {
      current = false;
    };
  }, [activeSource]);

  const visible = candidates.filter((candidate) => candidate.documentId === activeSource);
  const setField = <K extends keyof CandidateEditInput>(field: K, value: CandidateEditInput[K]) =>
    setDraft((current) => (current ? { ...current, [field]: value } : current));

  const save = async (candidate: ImportCandidate) => {
    if (!draft) return;
    try {
      const dashboard = await updateImportCandidate(candidate.id, draft);
      onDashboard(dashboard);
      setEditing("");
      setDraft(null);
    } catch (error) {
      onError(String(error));
    }
  };

  return (
    <div className="schedule-review-layout">
      <aside className="schedule-source-pane" aria-label="Imported schedule source">
        {sources.length > 1 && (
          <label className="field">
            Source
            <select value={activeSource} onChange={(event) => setActiveSource(event.target.value)}>
              {sources.map((source, index) => (
                <option key={source} value={source}>Schedule source {index + 1}</option>
              ))}
            </select>
          </label>
        )}
        {preview?.mime.startsWith("image/") ? (
          <img src={preview.dataUrl} alt={`Imported schedule: ${preview.fileName}`} />
        ) : preview?.mime === "application/pdf" ? (
          <object data={preview.dataUrl} type="application/pdf" aria-label={`Imported schedule: ${preview.fileName}`}>
            <p>PDF preview is unavailable. Review the extracted evidence beside it.</p>
          </object>
        ) : (
          <div className="source-preview-empty">
            <FileLock2 />
            <strong>Source evidence</strong>
            <p>{previewNotice || "Opening the encrypted source preview…"}</p>
          </div>
        )}
      </aside>
      <div className="candidate-list editable-candidates">
        {visible.map((candidate) => {
          const conflicted = conflictedIds.has(candidate.id);
          const selectedTerm = terms.find((term) => term.id === candidate.termId)
            ?? terms.find((term) => term.active);
          const incomplete = !candidate.title.trim()
            || (candidate.kind === "class_meeting" && (!candidate.course.trim() || !candidate.weekdays?.length || !candidate.startsAtLocal || !candidate.endsAtLocal || !selectedTerm));
          const isEditing = editing === candidate.id && draft;
          const action = conflicted ? "Resolve conflict" : candidate.suggestedAction === "update" ? "Update linked record" : "Add new record";
          return (
            <article className={`candidate ${conflicted ? "candidate-conflicted" : ""}`} key={candidate.id}>
              <label className="candidate-select">
                <input
                  type="checkbox"
                  disabled={conflicted || incomplete || busy}
                  checked={!conflicted && !incomplete && selectedIds.includes(candidate.id)}
                  onChange={(event) =>
                    onSelection(
                      event.target.checked
                        ? [...selectedIds, candidate.id]
                        : selectedIds.filter((id) => id !== candidate.id),
                    )
                  }
                />
                {action}
              </label>
              {isEditing ? (
                <div className="candidate-editor">
                  <div className="form-grid compact">
                    <label className="field">Course name or code<input value={draft.course} onChange={(event) => setField("course", event.target.value)} /></label>
                    <label className="field">Title<input value={draft.title} onChange={(event) => setField("title", event.target.value)} /></label>
                    <label className="field">Section<input value={draft.sectionNumber} onChange={(event) => setField("sectionNumber", event.target.value)} /></label>
                    <label className="field">Location<input value={draft.location} onChange={(event) => setField("location", event.target.value)} /></label>
                    <label className="field">Modality<select value={draft.modality} onChange={(event) => setField("modality", event.target.value)}><option value="">Not specified</option><option value="in_person">In person</option><option value="online">Online</option><option value="hybrid">Hybrid</option></select></label>
                    {candidate.kind === "class_meeting" ? (
                      <>
                        <fieldset className="weekday-editor"><legend>Weekdays</legend>{weekdays.map((day, index) => <label key={day}><input type="checkbox" checked={draft.weekdays?.includes(index) ?? false} onChange={(event) => setField("weekdays", event.target.checked ? [...(draft.weekdays ?? []), index] : (draft.weekdays ?? []).filter((value) => value !== index))} />{day}</label>)}</fieldset>
                        <label className="field">Starts<input type="time" value={draft.startsAtLocal} onChange={(event) => setField("startsAtLocal", event.target.value)} /></label>
                        <label className="field">Ends<input type="time" value={draft.endsAtLocal} onChange={(event) => setField("endsAtLocal", event.target.value)} /></label>
                        <label className="field">Timezone<input value={draft.timezone} onChange={(event) => setField("timezone", event.target.value)} /></label>
                        <label className="field">Academic term<select value={draft.termId ?? ""} onChange={(event) => setField("termId", event.target.value)}><option value="">Select a term</option>{terms.map((term)=><option key={term.id} value={term.id}>{term.name} · {term.startsOn}–{term.endsOn}</option>)}</select></label>
                      </>
                    ) : candidate.kind === "commitment" ? (
                      <>
                        <label className="field">Starts<input type="datetime-local" value={localDateTime(draft.startsAt)} onChange={(event) => setField("startsAt", utcDateTime(event.target.value))} /></label>
                        <label className="field">Ends<input type="datetime-local" value={localDateTime(draft.endsAt)} onChange={(event) => setField("endsAt", utcDateTime(event.target.value))} /></label>
                      </>
                    ) : (
                      <>
                        <label className="field">Due<input type="datetime-local" value={localDateTime(draft.dueAt)} onChange={(event) => setField("dueAt", utcDateTime(event.target.value))} /></label>
                        <label className="field">Estimated minutes<input type="number" min="5" max="480" value={draft.durationMinutes ?? 45} onChange={(event) => setField("durationMinutes", Number(event.target.value))} /></label>
                      </>
                    )}
                  </div>
                  <div className="record-actions">
                    <button className="outline" onClick={() => { setEditing(""); setDraft(null); }}>Cancel</button>
                    <button className="solid" disabled={busy} onClick={() => void save(candidate)}><Save /> Save candidate</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="candidate-summary">
                    <strong>{candidate.title}</strong>
                    <small>{candidate.course}{candidate.sectionNumber ? ` · Section ${candidate.sectionNumber}` : ""}</small>
                    <small>{candidate.kind === "class_meeting" ? `${candidate.weekdays?.map((day) => weekdays[day]).join(" ")} · ${candidate.startsAtLocal}–${candidate.endsAtLocal}` : candidate.dueAt ? `Due ${new Date(candidate.dueAt).toLocaleString()}` : candidate.startsAt ? new Date(candidate.startsAt).toLocaleString() : "Date needs review"}</small>
                    {candidate.kind === "class_meeting" && <small>{selectedTerm ? `${selectedTerm.name} · ${selectedTerm.startsOn}–${selectedTerm.endsOn}` : "Academic term/date range needs review"}</small>}
                    {(candidate.location || candidate.modality) && <small>{[candidate.location, candidate.modality?.replaceAll("_", " ")].filter(Boolean).join(" · ")}</small>}
                    <q>{candidate.evidence}</q>
                    <em>{candidate.sourceLocator} · {Math.round(candidate.confidence * 100)}% confidence</em>
                    {candidate.studentEditedFields?.length ? <mark>Edited by you</mark> : null}
                    <small>Approval action: {action.toLowerCase()}.</small>
                    {conflicted && <mark>Resolve this linked-record conflict before approval.</mark>}
                    {incomplete && <mark>Complete the highlighted schedule fields before approval.</mark>}
                    {candidate.warnings.map((warning) => <mark key={warning}>{warning}</mark>)}
                  </div>
                  <button className="outline candidate-edit" disabled={busy} onClick={() => { setEditing(candidate.id); setDraft(candidateInput(candidate, terms)); }}><Pencil /> Edit fields</button>
                </>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
