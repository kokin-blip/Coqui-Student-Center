import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, Paperclip, Plus, X } from "lucide-react";
import { save as chooseSavePath } from "@tauri-apps/plugin-dialog";
import { isDesktop } from "../../native";
import {
  taskDetailsApi,
  type TaskDetails,
  type TaskActivityPage,
} from "./taskDetailsApi";
import { useTaskDetailsSession } from "./TaskDetailsSession";
import "./task-details.css";

const activityLabels: Record<string, string> = {
  task_created: "Task created",
  task_completed: "Task completed",
  task_updated: "Task updated",
  task_received: "Task changes received",
  description_updated: "Description updated",
  tags_updated: "Tags updated",
  progress_updated: "Progress updated",
  subtasks_updated: "Subtasks updated",
  attachment_added: "File attached",
  attachment_removed: "File detached",
};

export function TaskDetailsEditor({
  taskId,
  completed,
}: {
  taskId: string;
  completed: boolean;
}) {
  const session = useTaskDetailsSession();
  const api = isDesktop() ? taskDetailsApi : session.preview;
  const prefix = useId();
  const [details, setDetails] = useState<TaskDetails | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<TaskActivityPage>({
    entries: [],
    nextCursor: null,
  });
  const [reload, setReload] = useState(0);
  const [incoming, setIncoming] = useState<TaskDetails | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    kind: string;
    content?: string;
    truncated?: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    setDetails(null);
    setError("");
    setIncoming(null);
    setPreview(null);
    const draft = session.drafts.get(taskId);
    Promise.all([
      draft ? Promise.resolve(draft) : api.load(taskId),
      api.activity(taskId),
    ])
      .then(([value, activity]) => {
        if (active) {
          setDetails(value);
          setDirty(Boolean(draft));
          setHistory(activity);
        }
      })
      .catch(() => {
        if (active) setError("Task details could not be opened. Try again.");
      });
    return () => {
      active = false;
    };
  }, [taskId, session, api, reload]);

  const edit = (changes: Partial<TaskDetails>) => {
    if (!details) return;
    const next = { ...details, ...changes };
    session.drafts.set(taskId, next);
    setDetails(next);
    setDirty(true);
    setNotice("");
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const acceptSaved = async (next: TaskDetails) => {
    // A save may finish after another inspector has opened and edited this task.
    // Do not clear that newer unsaved draft.
    if (session.drafts.get(taskId) === details) session.drafts.delete(taskId);
    setDetails(next);
    setDirty(false);
    setIncoming(null);
    setNotice(
      isDesktop() ? "Saved on this device." : "Saved for this preview session.",
    );
    try {
      setHistory(await api.activity(taskId));
    } catch {
      setNotice("Details saved. Reopen the inspector to refresh activity.");
    }
  };

  if (!details)
    return (
      <section className="task-details-editor" aria-label="Task details">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => setReload((value) => value + 1)}>
              Retry task details
            </button>
          </>
        ) : (
          <p role="status">Opening task details…</p>
        )}
      </section>
    );

  return (
    <section
      className="task-details-editor"
      aria-label="Task details"
      aria-busy={busy}
    >
      <p className="task-local-note">
        {isDesktop()
          ? "Details and files are stored on this device and included in backups."
          : "Browser preview: details last for this session only. Use the desktop app for encrypted storage and files."}
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setIncoming(await api.load(taskId));
              })
            }
          >
            Review latest saved version
          </button>
        </div>
      )}
      {incoming && (
        <div className="task-revision-review">
          <h3>Latest saved version</h3>
          <p>Your unsaved work is retained until you choose to replace it.</p>
          <p>{incoming.description || "No description"}</p>
          <p>
            {incoming.tags.join(", ") || "No tags"} · {incoming.subtasks.length}{" "}
            subtasks
          </p>
          <button
            disabled={busy}
            onClick={() => {
              session.drafts.delete(taskId);
              setDetails(incoming);
              setDirty(false);
              setIncoming(null);
              setError("");
            }}
          >
            Discard my edits and reload
          </button>
          <button onClick={() => setIncoming(null)}>Keep my edits</button>
        </div>
      )}
      <fieldset disabled={busy}>
        <label htmlFor={`${prefix}-progress`}>Status</label>
        {completed ? (
          <p>Completed</p>
        ) : (
          <select
            id={`${prefix}-progress`}
            value={details.progress}
            onChange={(event) =>
              edit({ progress: event.target.value as TaskDetails["progress"] })
            }
          >
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
          </select>
        )}
        <label htmlFor={`${prefix}-description`}>Description</label>
        <textarea
          id={`${prefix}-description`}
          rows={4}
          maxLength={20_000}
          value={details.description}
          placeholder="What does finishing this task involve?"
          onChange={(event) => edit({ description: event.target.value })}
        />
        <label htmlFor={`${prefix}-tags`}>
          Tags <span>(separate with commas)</span>
        </label>
        <input
          id={`${prefix}-tags`}
          value={details.tags.join(",")}
          onChange={(event) => edit({ tags: event.target.value.split(",") })}
        />
        <h3>
          Subtasks{" "}
          <span>
            {details.subtasks.filter((item) => item.completed).length} /{" "}
            {details.subtasks.length}
          </span>
        </h3>
        {!details.subtasks.length && (
          <p className="task-empty-note">
            Break the work into small, checkable steps.
          </p>
        )}
        <ol className="task-subtasks">
          {details.subtasks.map((item, index) => (
            <li key={item.id}>
              <input
                type="checkbox"
                aria-label={`Complete subtask ${index + 1}`}
                checked={item.completed}
                onChange={(event) =>
                  edit({
                    subtasks: details.subtasks.map((subtask) =>
                      subtask.id === item.id
                        ? { ...subtask, completed: event.target.checked }
                        : subtask,
                    ),
                  })
                }
              />
              <input
                aria-label={`Subtask ${index + 1}`}
                maxLength={500}
                value={item.title}
                placeholder="Name this step"
                onChange={(event) =>
                  edit({
                    subtasks: details.subtasks.map((subtask) =>
                      subtask.id === item.id
                        ? { ...subtask, title: event.target.value }
                        : subtask,
                    ),
                  })
                }
              />
              <div className="subtask-tools">
                <button
                  type="button"
                  disabled={index === 0}
                  aria-label={`Move subtask ${index + 1} up`}
                  onClick={() => {
                    const next = [...details.subtasks];
                    [next[index - 1], next[index]] = [
                      next[index],
                      next[index - 1],
                    ];
                    edit({ subtasks: next });
                  }}
                >
                  <ArrowUp />
                </button>
                <button
                  type="button"
                  disabled={index === details.subtasks.length - 1}
                  aria-label={`Move subtask ${index + 1} down`}
                  onClick={() => {
                    const next = [...details.subtasks];
                    [next[index + 1], next[index]] = [
                      next[index],
                      next[index + 1],
                    ];
                    edit({ subtasks: next });
                  }}
                >
                  <ArrowDown />
                </button>
                <button
                  type="button"
                  aria-label={`Remove subtask ${index + 1}`}
                  onClick={() =>
                    edit({
                      subtasks: details.subtasks.filter(
                        (subtask) => subtask.id !== item.id,
                      ),
                    })
                  }
                >
                  <X />
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button
          type="button"
          disabled={details.subtasks.length >= 200}
          onClick={() =>
            edit({
              subtasks: [
                ...details.subtasks,
                { id: crypto.randomUUID(), title: "", completed: false },
              ],
            })
          }
        >
          <Plus /> Add subtask
        </button>
        <p className="task-empty-note">
          Checking every subtask does not complete the parent task.
        </p>
        <button
          className="today-primary"
          disabled={!dirty}
          onClick={() =>
            void run(async () => {
              const tags = details.tags
                .map((tag) => tag.trim())
                .filter(Boolean);
              if (
                tags.length > 30 ||
                tags.some((tag) => tag.length > 60) ||
                new Set(tags.map((tag) => tag.toLowerCase())).size !==
                  tags.length
              )
                throw new Error(
                  "Use up to 30 unique tags, each 60 characters or fewer.",
                );
              if (details.subtasks.some((item) => !item.title.trim()))
                throw new Error("Name each subtask before saving.");
              await acceptSaved(
                await api.save(taskId, {
                  expectedRevision: details.revision,
                  description: details.description,
                  tags,
                  progress: details.progress,
                  subtasks: details.subtasks.map((item) => ({
                    ...item,
                    title: item.title.trim(),
                  })),
                }),
              );
            })
          }
        >
          {busy ? "Saving…" : "Save details"}
        </button>
        {dirty && (
          <p className="task-empty-note">
            Unsaved changes · kept while switching views or layouts.
          </p>
        )}
      </fieldset>
      {notice && <p role="status">{notice}</p>}
      <h3>Attachments</h3>
      {dirty && (
        <p className="task-empty-note">
          Save your details before changing attached files.
        </p>
      )}
      <ul className="task-attachments">
        {details.attachments.map((file) => (
          <li key={file.documentId}>
            <span>
              <Paperclip />
              {file.fileName}
            </span>
            <div>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setPreview({
                      name: file.fileName,
                      ...(await taskDetailsApi.preview(
                        taskId,
                        file.documentId,
                      )),
                    }),
                  )
                }
              >
                Preview
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const path = await chooseSavePath({
                      defaultPath: file.fileName,
                      title:
                        "Export an unencrypted copy — choose a new filename",
                    });
                    if (path) {
                      await taskDetailsApi.export(
                        taskId,
                        file.documentId,
                        path,
                      );
                      setNotice(
                        "Unencrypted copy exported to your chosen location.",
                      );
                    }
                  })
                }
              >
                Export
              </button>
              <button
                disabled={busy || dirty}
                onClick={() =>
                  void run(async () =>
                    acceptSaved(
                      await taskDetailsApi.detach(
                        taskId,
                        file.documentId,
                        details.revision,
                      ),
                    ),
                  )
                }
              >
                Detach
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!details.attachments.length && (
        <p className="task-empty-note">No files attached.</p>
      )}
      <label className="task-file-input">
        Attach a file (up to 25 MB)
        <input
          type="file"
          disabled={busy || dirty || !isDesktop()}
          accept=".pdf,.docx,.xlsx,.pptx,.txt,.csv,.ics,.png,.jpg,.jpeg,.tif,.tiff"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file)
              void run(async () =>
                acceptSaved(
                  await taskDetailsApi.attach(taskId, file, details.revision),
                ),
              );
          }}
        />
      </label>
      <p className="task-empty-note">
        Detaching removes this link, not the shared vault file. Export creates
        an unencrypted copy.
      </p>
      {preview && (
        <section
          className="task-file-preview"
          aria-label={`Preview ${preview.name}`}
        >
          <button onClick={() => setPreview(null)}>Close preview</button>
          {preview.kind === "image" ? (
            <img src={preview.content} alt={preview.name} />
          ) : preview.kind === "text" ? (
            <>
              <pre>{preview.content}</pre>
              {preview.truncated && (
                <p>Preview shortened. Export to read the whole file.</p>
              )}
            </>
          ) : (
            <p>
              This format is available through explicit export, not an embedded
              preview.
            </p>
          )}
        </section>
      )}
      <h3>Activity</h3>
      {!history.entries.length && (
        <p className="task-empty-note">
          Changes appear here from now on. Earlier history is not reconstructed.
        </p>
      )}
      <ol className="task-activity">
        {history.entries.map((entry) => (
          <li key={entry.sequence}>
            <span>{activityLabels[entry.kind] ?? "Task changed"}</span>
            <small>
              {entry.origin === "received"
                ? "Received from sync"
                : "This device"}{" "}
              ·{" "}
              <time dateTime={entry.createdAt}>
                {new Date(entry.createdAt).toLocaleString()}
              </time>
            </small>
          </li>
        ))}
      </ol>
      {history.nextCursor !== null && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const page = await api.activity(taskId, history.nextCursor);
              setHistory({
                entries: [...history.entries, ...page.entries],
                nextCursor: page.nextCursor,
              });
            })
          }
        >
          Earlier activity
        </button>
      )}
    </section>
  );
}
