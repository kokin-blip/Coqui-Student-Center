import { useEffect, useState } from "react";
import { BookOpen, CalendarDays, ListChecks, Search } from "lucide-react";
import { getLocalWorkspace, type WorkspaceSnapshot } from "../native";
import type { StudentDestination } from "./AppNavigation";
import { Modal } from "./Modal";

type SearchDestination = Extract<
  StudentDestination,
  "courses" | "work" | "calendar"
>;

type WorkspaceSearchModalProps = {
  close: () => void;
  navigate: (destination: SearchDestination) => void;
};

const formatDateTime = (iso?: string) =>
  iso
    ? new Intl.DateTimeFormat([], {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso))
    : "Not set";

export function WorkspaceSearchModal({
  close,
  navigate,
}: WorkspaceSearchModalProps) {
  const [query, setQuery] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getLocalWorkspace()
      .then((next) => {
        if (active) setWorkspace(next);
      })
      .catch((next) => {
        if (active) setError(String(next));
      });
    return () => {
      active = false;
    };
  }, []);

  const go = (destination: SearchDestination) => {
    close();
    navigate(destination);
  };
  const needle = query.trim().toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(needle);
  const courses = workspace?.courses.filter(
    (item) => matches(item.title) || matches(item.code),
  );
  const tasks = workspace?.tasks.filter((item) => matches(item.title));
  const commitments = workspace?.commitments.filter(
    (item) => matches(item.title) || matches(item.location),
  );

  return (
    <Modal
      title="Search"
      subtitle="Find a course, assignment, or commitment. Everything is searched locally."
      close={close}
    >
      <label className="field">
        Search
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Statistics, ENG 102, midterm…"
        />
      </label>
      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : !workspace ? (
        <div className="empty-state" role="status">
          <Search />
          <strong>Loading your local records…</strong>
        </div>
      ) : !needle ? (
        <div className="empty-state">
          <Search />
          <strong>Search your workspace</strong>
          <p>
            {workspace.courses.length} courses, {workspace.tasks.length}{" "}
            assignments, and {workspace.commitments.length} commitments.
          </p>
        </div>
      ) : !courses?.length && !tasks?.length && !commitments?.length ? (
        <div className="empty-state">
          <Search />
          <strong>No matches</strong>
          <p>Nothing local matches “{query.trim()}”.</p>
        </div>
      ) : (
        <div className="record-list compact">
          {courses?.map((item) => (
            <article key={item.id}>
              <div className="record-icon course">
                <BookOpen />
              </div>
              <div>
                <strong>{item.code || item.title}</strong>
                <small>{item.title}</small>
              </div>
              <div className="record-actions">
                <button className="outline" onClick={() => go("courses")}>
                  Open
                </button>
              </div>
            </article>
          ))}
          {tasks?.map((item) => (
            <article
              className={item.completed ? "record-complete" : ""}
              key={item.id}
            >
              <div className="record-icon task">
                <ListChecks />
              </div>
              <div>
                <strong>{item.title}</strong>
                <small>
                  {item.minutes} min
                  {item.dueAt ? ` · Due ${formatDateTime(item.dueAt)}` : ""}
                </small>
              </div>
              <div className="record-actions">
                <button className="outline" onClick={() => go("work")}>
                  Open
                </button>
              </div>
            </article>
          ))}
          {commitments?.map((item) => (
            <article key={item.id}>
              <div className="record-icon commitment">
                <CalendarDays />
              </div>
              <div>
                <strong>{item.title}</strong>
                <small>
                  {formatDateTime(item.startsAt)}
                  {item.location ? ` · ${item.location}` : ""}
                </small>
              </div>
              <div className="record-actions">
                <button className="outline" onClick={() => go("calendar")}>
                  Open
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}
