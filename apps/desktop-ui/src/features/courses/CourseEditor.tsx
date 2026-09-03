import type { Dispatch, SetStateAction } from "react";
import { searchCourseSuggestions } from "../../native";
import {
  WorkspaceSnapshot,
  CourseRecord,
  CourseInput,
  CourseSuggestion,
} from "../../native";
export function CourseEditor({
  workspace,
  course,
  edit,
  suggestions,
  busy,
  setCourse,
  setSuggestions,
  cancel,
  save,
}: {
  workspace: WorkspaceSnapshot;
  course: CourseInput;
  edit: CourseRecord | null;
  suggestions: CourseSuggestion[];
  busy: boolean;
  setCourse: Dispatch<SetStateAction<CourseInput>>;
  setSuggestions: (value: CourseSuggestion[]) => void;
  cancel: () => void;
  save: () => void;
}) {
  return (
    <div className="inline-editor course-master-editor">
      <h3>{edit ? "Edit course" : "Add a course"}</h3>
      <label className="field">
        Course name
        <input
          value={course.title}
          onChange={(event) =>
            setCourse((current) => ({ ...current, title: event.target.value }))
          }
          placeholder="English Composition"
        />
      </label>
      <label className="field">
        Code
        <input
          value={course.code}
          onChange={(event) => {
            const code = event.target.value;
            setCourse((current) => ({ ...current, code }));
            const institutionId = workspace.institution?.id ?? "";
            if (!code.trim() || !institutionId) return setSuggestions([]);
            void searchCourseSuggestions(institutionId, code)
              .then(setSuggestions)
              .catch(() => setSuggestions([]));
          }}
          placeholder="ENG 102"
        />
      </label>
      <label className="field">
        Academic term
        <select
          value={course.termId ?? ""}
          onChange={(event) =>
            setCourse((current) => ({
              ...current,
              termId: event.target.value || undefined,
            }))
          }
        >
          <option value="">Current active term</option>
          {workspace.terms.map((term) => (
            <option value={term.id} key={term.id}>
              {term.name}
            </option>
          ))}
        </select>
      </label>
      {suggestions.length > 0 && (
        <div className="course-suggestions">
          {suggestions.map((suggestion) => (
            <button
              key={`${suggestion.source}-${suggestion.code}`}
              onClick={() => {
                setCourse((current) => ({
                  ...current,
                  code: suggestion.code,
                  title: suggestion.title,
                }));
                setSuggestions([]);
              }}
            >
              <span>
                <strong>
                  {suggestion.code} · {suggestion.title}
                </strong>
                <small>
                  {suggestion.sourceLabel}
                  {suggestion.termLabel ? ` · ${suggestion.termLabel}` : ""}
                </small>
              </span>
              <em>{Math.round(suggestion.confidence * 100)}%</em>
            </button>
          ))}
        </div>
      )}
      <div className="modal-actions">
        {edit && (
          <button className="outline" onClick={cancel}>
            Cancel
          </button>
        )}
        <button
          className="solid"
          disabled={busy || !course.title.trim()}
          onClick={save}
        >
          {edit ? "Save course" : "Add course"}
        </button>
      </div>
    </div>
  );
}
