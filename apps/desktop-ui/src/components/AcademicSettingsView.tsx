import { useEffect, useState } from "react";
import { CalendarDays, CircleAlert, HardDrive, X } from "lucide-react";
import {
  applyAcademicCleanup,
  createAcademicTerm,
  deleteAcademicTerm,
  getAcademicCleanupPreview,
  getDashboard,
  getLocalWorkspace,
  updateAcademicTerm,
  updatePlanningPreferences,
  updateStudentProfile,
} from "../native";
import type {
  AcademicCleanupPreview,
  AcademicTermInput,
  AcademicTermRecord,
  PreferenceInput,
  WorkspaceSnapshot,
} from "../native";
import type { WorkspaceRouteProps } from "./workspaceTypes";

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const emptyTerm = (): AcademicTermInput => ({
  name: "",
  startsOn: "",
  endsOn: "",
  active: true,
});

export function AcademicSettingsView({
  onDashboard,
  embedded = false,
}: WorkspaceRouteProps & { embedded?: boolean }) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [cleanup, setCleanup] = useState<AcademicCleanupPreview | null>(null);
  const [term, setTerm] = useState<AcademicTermInput>(emptyTerm);
  const [termEdit, setTermEdit] = useState<AcademicTermRecord | null>(null);
  const [profile, setProfile] = useState({
    name: "",
    timezone: "",
    expectedVersion: 0,
  });
  const [preferences, setPreferences] = useState<PreferenceInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const syncEditors = (next: WorkspaceSnapshot) => {
    setWorkspace(next);
    if (next.profile)
      setProfile({
        name: next.profile.name,
        timezone: next.profile.timezone,
        expectedVersion: next.profile.version,
      });
    if (next.preferences)
      setPreferences({
        ...next.preferences,
        expectedVersion: next.preferences.version,
        availability: next.availability,
      });
  };

  useEffect(() => {
    let active = true;
    void Promise.all([getLocalWorkspace(), getAcademicCleanupPreview()])
      .then(([next, preview]) => {
        if (active) {
          syncEditors(next);
          setCleanup(preview);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const act = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      syncEditors(await operation());
      onDashboard(await getDashboard());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleDay = (weekday: number, enabled: boolean) =>
    setPreferences((current) =>
      current
        ? {
            ...current,
            availability: enabled
              ? [
                  ...current.availability,
                  { weekday, startsAtLocal: "08:00", endsAtLocal: "21:00" },
                ].sort((left, right) => left.weekday - right.weekday)
              : current.availability.filter((rule) => rule.weekday !== weekday),
          }
        : current,
    );
  const updateDay = (
    weekday: number,
    key: "startsAtLocal" | "endsAtLocal",
    value: string,
  ) =>
    setPreferences((current) =>
      current
        ? {
            ...current,
            availability: current.availability.map((rule) =>
              rule.weekday === weekday ? { ...rule, [key]: value } : rule,
            ),
          }
        : current,
    );
  const resetTerm = () => {
    setTermEdit(null);
    setTerm(emptyTerm());
  };
  const refreshCleanup = () =>
    void getAcademicCleanupPreview()
      .then(setCleanup)
      .catch((reason) => setError(String(reason)));

  if (!workspace)
    return (
      <div className="content workspace-page">
        <div className="loading">
          <strong>Loading academic settings…</strong>
          {error && <p>{error}</p>}
        </div>
      </div>
    );

  return (
    <section
      className={`content workspace-page mode-settings ${embedded ? "settings-academic-content" : ""}`}
      data-route="academic-settings"
      aria-label="Academic and planning settings"
    >
      {!embedded && (
        <div className="page-head">
          <div>
            <p className="eyebrow">Academic and planning</p>
            <h1>Academic & planning settings</h1>
            <p>
              Manage terms, profile timezone, availability, and planning
              preferences.
            </p>
          </div>
          <span className="mode-pill">
            <HardDrive />
            Local authority
          </span>
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          <CircleAlert />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X />
          </button>
        </div>
      )}
      <div className="academic-settings-grid">
        <TermSettings
          workspace={workspace}
          term={term}
          edit={termEdit}
          busy={busy}
          setTerm={setTerm}
          setTermEdit={setTermEdit}
          reset={resetTerm}
          act={act}
        />
        <section className="workspace-panel preference-editor">
          <h2>Local profile</h2>
          <p className="field-help">
            Your timezone anchors deadlines, sleep boundaries, and recurring
            class times.
          </p>
          <div className="form-grid compact">
            <label className="field">
              Name
              <input
                value={profile.name}
                onChange={(event) =>
                  setProfile((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <label className="field">
              IANA timezone
              <input
                value={profile.timezone}
                onChange={(event) =>
                  setProfile((current) => ({
                    ...current,
                    timezone: event.target.value,
                  }))
                }
                placeholder="America/Phoenix"
              />
            </label>
          </div>
          <div className="modal-actions">
            <button
              className="solid"
              disabled={
                busy || !profile.name.trim() || !profile.timezone.trim()
              }
              onClick={() => void act(() => updateStudentProfile(profile))}
            >
              Save profile and replan
            </button>
          </div>
        </section>
        {preferences && (
          <PlanningPreferences
            preferences={preferences}
            busy={busy}
            setPreferences={setPreferences}
            toggleDay={toggleDay}
            updateDay={updateDay}
            save={() => void act(() => updatePlanningPreferences(preferences))}
          />
        )}
        <section className="workspace-panel preference-editor cleanup-panel">
          <h2>Legacy data cleanup</h2>
          <p className="field-help">
            Coqui only offers cleanup when it can prove records are duplicates
            or a weekly class series. Nothing is removed automatically.
          </p>
          {cleanup?.duplicateCourseGroups.length ? (
            <div className="cleanup-option">
              <span>
                <strong>
                  {cleanup.duplicateCourseGroups.length} duplicate course group
                  {cleanup.duplicateCourseGroups.length === 1 ? "" : "s"}
                </strong>
                <small>
                  Tasks, instructors, grades, materials, and provenance move to
                  the earliest course record.
                </small>
              </span>
              <button
                className="outline"
                disabled={busy}
                onClick={() =>
                  void act(() => applyAcademicCleanup(true, false)).then(
                    refreshCleanup,
                  )
                }
              >
                Merge duplicates
              </button>
            </div>
          ) : (
            <p className="source-note">
              No duplicate course titles or codes found.
            </p>
          )}
          {cleanup?.repeatedCommitmentSeries.length ? (
            <div className="cleanup-option">
              <span>
                <strong>
                  {cleanup.repeatedCommitmentSeries.length} repeated class
                  series
                </strong>
                <small>
                  {cleanup.repeatedCommitmentSeries
                    .map((item) => `${item.title} (${item.count} events)`)
                    .join(" · ")}
                </small>
              </span>
              <button
                className="outline"
                disabled={busy}
                onClick={() =>
                  void act(() => applyAcademicCleanup(false, true)).then(
                    refreshCleanup,
                  )
                }
              >
                Collapse to recurring classes
              </button>
            </div>
          ) : (
            <p className="source-note">No safe legacy class series found.</p>
          )}
        </section>
      </div>
    </section>
  );
}

function TermSettings({
  workspace,
  term,
  edit,
  busy,
  setTerm,
  setTermEdit,
  reset,
  act,
}: {
  workspace: WorkspaceSnapshot;
  term: AcademicTermInput;
  edit: AcademicTermRecord | null;
  busy: boolean;
  setTerm: React.Dispatch<React.SetStateAction<AcademicTermInput>>;
  setTermEdit: (value: AcademicTermRecord | null) => void;
  reset: () => void;
  act: (operation: () => Promise<WorkspaceSnapshot>) => Promise<void>;
}) {
  return (
    <section className="workspace-panel preference-editor">
      <div className="section-head">
        <h2>Academic terms</h2>
        <span>{workspace.terms.length}</span>
      </div>
      {workspace.terms.length ? (
        <div className="record-list compact">
          {workspace.terms.map((item) => (
            <article key={item.id}>
              <div className="record-icon course">
                <CalendarDays />
              </div>
              <div>
                <strong>
                  {item.name}
                  {item.active ? " · Active" : ""}
                </strong>
                <small>
                  {item.startsOn} – {item.endsOn}
                </small>
              </div>
              <div className="record-actions">
                <button
                  className="outline"
                  onClick={() => {
                    setTermEdit(item);
                    setTerm({
                      name: item.name,
                      startsOn: item.startsOn,
                      endsOn: item.endsOn,
                      active: item.active,
                      expectedVersion: item.version,
                    });
                  }}
                >
                  Edit
                </button>
                <button
                  className="text-button danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${item.name}? Courses and class times in this term are removed with it.`,
                      )
                    )
                      void act(() => deleteAcademicTerm(item.id, item.version));
                  }}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <CalendarDays />
          <strong>No terms yet</strong>
          <p>Add the term your courses belong to.</p>
        </div>
      )}
      <div className="inline-editor">
        <h3>{edit ? "Edit term" : "Add a term"}</h3>
        <div className="form-grid">
          <label className="field">
            Term name
            <input
              value={term.name}
              onChange={(event) =>
                setTerm((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Fall 2026"
            />
          </label>
          <label className="field">
            Starts
            <input
              type="date"
              value={term.startsOn}
              onChange={(event) =>
                setTerm((current) => ({
                  ...current,
                  startsOn: event.target.value,
                }))
              }
            />
          </label>
          <label className="field">
            Ends
            <input
              type="date"
              value={term.endsOn}
              onChange={(event) =>
                setTerm((current) => ({
                  ...current,
                  endsOn: event.target.value,
                }))
              }
            />
          </label>
          <label className="setting-toggle compact">
            <input
              type="checkbox"
              checked={term.active}
              onChange={(event) =>
                setTerm((current) => ({
                  ...current,
                  active: event.target.checked,
                }))
              }
            />
            <span>Current term</span>
          </label>
        </div>
        <div className="modal-actions">
          {edit && (
            <button className="outline" onClick={reset}>
              Cancel
            </button>
          )}
          <button
            className="solid"
            disabled={
              busy || !term.name.trim() || !term.startsOn || !term.endsOn
            }
            onClick={() =>
              void act(() =>
                edit
                  ? updateAcademicTerm(edit.id, term)
                  : createAcademicTerm(term),
              ).then(reset)
            }
          >
            {edit ? "Save term" : "Add term"}
          </button>
        </div>
      </div>
    </section>
  );
}

function PlanningPreferences({
  preferences,
  busy,
  setPreferences,
  toggleDay,
  updateDay,
  save,
}: {
  preferences: PreferenceInput;
  busy: boolean;
  setPreferences: React.Dispatch<React.SetStateAction<PreferenceInput | null>>;
  toggleDay: (weekday: number, enabled: boolean) => void;
  updateDay: (
    weekday: number,
    key: "startsAtLocal" | "endsAtLocal",
    value: string,
  ) => void;
  save: () => void;
}) {
  return (
    <section className="workspace-panel preference-editor planning-preferences">
      <h2>Planning preferences</h2>
      <div className="form-grid compact">
        <label className="field">
          Sleep begins
          <input
            type="time"
            value={preferences.sleepStart}
            onChange={(event) =>
              setPreferences((current) =>
                current
                  ? { ...current, sleepStart: event.target.value }
                  : current,
              )
            }
          />
        </label>
        <label className="field">
          Sleep ends
          <input
            type="time"
            value={preferences.sleepEnd}
            onChange={(event) =>
              setPreferences((current) =>
                current
                  ? { ...current, sleepEnd: event.target.value }
                  : current,
              )
            }
          />
        </label>
        <label className="field">
          Max session
          <input
            type="number"
            min="15"
            max="240"
            step="5"
            value={preferences.maxSessionMinutes}
            onChange={(event) =>
              setPreferences((current) =>
                current
                  ? {
                      ...current,
                      maxSessionMinutes: Number(event.target.value),
                    }
                  : current,
              )
            }
          />
        </label>
        <label className="field">
          Break minutes
          <input
            type="number"
            min="0"
            max="60"
            step="5"
            value={preferences.breakMinutes}
            onChange={(event) =>
              setPreferences((current) =>
                current
                  ? { ...current, breakMinutes: Number(event.target.value) }
                  : current,
              )
            }
          />
        </label>
        <label className="field">
          Transition minutes
          <input
            type="number"
            min="0"
            max="120"
            step="5"
            value={preferences.transitionMinutes}
            onChange={(event) =>
              setPreferences((current) =>
                current
                  ? {
                      ...current,
                      transitionMinutes: Number(event.target.value),
                    }
                  : current,
              )
            }
          />
        </label>
        <label className="field">
          Default commute
          <input
            type="number"
            min="0"
            max="240"
            step="5"
            value={preferences.defaultCommuteMinutes}
            onChange={(event) =>
              setPreferences((current) =>
                current
                  ? {
                      ...current,
                      defaultCommuteMinutes: Number(event.target.value),
                    }
                  : current,
              )
            }
          />
        </label>
      </div>
      <fieldset className="availability compact-availability">
        <legend>Weekly availability</legend>
        {weekdays.map((name, weekday) => {
          const rule = preferences.availability.find(
            (item) => item.weekday === weekday,
          );
          return (
            <div key={name}>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(rule)}
                  onChange={(event) => toggleDay(weekday, event.target.checked)}
                />
                <span>{name}</span>
              </label>
              <input
                aria-label={`${name} availability starts`}
                type="time"
                disabled={!rule}
                value={rule?.startsAtLocal ?? "08:00"}
                onChange={(event) =>
                  updateDay(weekday, "startsAtLocal", event.target.value)
                }
              />
              <span>to</span>
              <input
                aria-label={`${name} availability ends`}
                type="time"
                disabled={!rule}
                value={rule?.endsAtLocal ?? "21:00"}
                onChange={(event) =>
                  updateDay(weekday, "endsAtLocal", event.target.value)
                }
              />
            </div>
          );
        })}
      </fieldset>
      <div className="modal-actions">
        <button className="solid" disabled={busy} onClick={save}>
          Save and replan
        </button>
      </div>
    </section>
  );
}
