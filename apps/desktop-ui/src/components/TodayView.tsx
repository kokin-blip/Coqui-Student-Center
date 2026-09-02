import { useMemo } from "react";
import {
  Brain,
  CalendarDays,
  Check,
  CircleAlert,
  FileLock2,
  FileUp,
  HardDrive,
  Link2,
  ListChecks,
  Loader,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import type { Dashboard, OcrStatus, WorkspaceSnapshot } from "../native";
import { SetupChecklist } from "./SetupChecklist";

const greeting = () => {
  const hour = new Date().getHours();
  return hour < 12
    ? "Good morning"
    : hour < 18
      ? "Good afternoon"
      : "Good evening";
};
const formatTime = (iso: string) =>
  new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
const minutesBetween = (from: string, to: string) =>
  Math.max(
    0,
    Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000),
  );

export function TodayView({
  data,
  workspace,
  ocr,
  desktop,
  busy,
  error,
  checklistDismissed,
  pendingCount,
  onClearError,
  onOpenCourses,
  onAddTask,
  onImport,
  onDismissChecklist,
  onStartBlock,
  onReplan,
  onToggleTask,
  onAssistant,
  onConflicts,
  onReview,
  onCanvas,
}: {
  data: Dashboard;
  workspace: WorkspaceSnapshot | null;
  ocr: OcrStatus;
  desktop: boolean;
  busy: boolean;
  error: string;
  checklistDismissed: boolean;
  pendingCount: number;
  onClearError: () => void;
  onOpenCourses: () => void;
  onAddTask: () => void;
  onImport: () => void;
  onDismissChecklist: () => void;
  onStartBlock: (id: string) => void;
  onReplan: () => void;
  onToggleTask: (id: string) => void;
  onAssistant: () => void;
  onConflicts: () => void;
  onReview: () => void;
  onCanvas: () => void;
}) {
  const remaining = useMemo(
    () =>
      data.blocks
        .filter((block) => !block.completed)
        .reduce(
          (sum, block) => sum + minutesBetween(block.startsAt, block.endsAt),
          0,
        ),
    [data.blocks],
  );
  const studyBlocks = useMemo(
    () => data.blocks.filter((block) => block.kind === "study").length,
    [data.blocks],
  );
  const classBlocks = useMemo(
    () => data.blocks.filter((block) => block.kind === "class").length,
    [data.blocks],
  );
  const reflection = useMemo(() => {
    const started = data.blocks.filter((block) => block.startedAt);
    const variance = started.map((block) =>
      Math.round(
        (new Date(block.startedAt!).getTime() -
          new Date(block.startsAt).getTime()) /
          60000,
      ),
    );
    return {
      completed: data.blocks.filter((block) => block.completed).length,
      started: started.length,
      averageVariance: variance.length
        ? Math.round(
            variance.reduce((sum, value) => sum + value, 0) / variance.length,
          )
        : 0,
    };
  }, [data.blocks]);

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <p className="eyebrow">
            {new Intl.DateTimeFormat([], {
              weekday: "long",
              month: "long",
              day: "numeric",
            }).format(new Date())}
          </p>
          <h1>
            {greeting()}, {data.studentName.split(" ")[0]}.
          </h1>
          <p>Your plan is stored locally and ready, even without internet.</p>
        </div>
        <span className="mode-pill">
          <HardDrive />
          {desktop ? "Desktop workspace" : "UI test mode"}
        </span>
      </div>
      {error && (
        <div className="alert" role="alert">
          <CircleAlert />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={onClearError}>
            <X />
          </button>
        </div>
      )}
      {!checklistDismissed && workspace && (
        <SetupChecklist
          workspace={workspace}
          onOpenCourses={onOpenCourses}
          onAddTask={onAddTask}
          onImport={onImport}
          onDismiss={onDismissChecklist}
        />
      )}
      <div className="hero-grid">
        <section className="next-card">
          <div className="next-top">
            <span>
              <Zap />
              Your next best action
            </span>
            <b>{data.nextAction?.durationMinutes ?? 0} minutes</b>
          </div>
          <h2>{data.nextAction?.title ?? "Your plan is clear"}</h2>
          <p>
            {data.nextAction?.explanation ??
              "Add a task or import a syllabus to build your plan."}
          </p>
          <div className="reason-row">
            {data.nextAction?.reasonCodes.map((code) => (
              <span key={code}>{code.replaceAll("_", " ")}</span>
            ))}
          </div>
          {Boolean(data.nextAction?.alternatives.length) && (
            <p className="alternatives">
              <strong>Other feasible options:</strong>{" "}
              {data.nextAction?.alternatives
                .map((item) => `${item.title} (${item.durationMinutes} min)`)
                .join(" · ")}
            </p>
          )}
          <div className="next-actions">
            <button
              className="primary"
              disabled={!data.nextAction || busy}
              onClick={() => {
                if (data.nextAction) onStartBlock(data.nextAction.blockId);
              }}
            >
              <Play />
              Start this now
            </button>
            <button className="ghost" onClick={onReplan}>
              Something changed
            </button>
          </div>
        </section>
        <aside className="capacity" aria-label="Today's capacity">
          <p>Capacity</p>
          {data.blocks.length === 0 ? (
            <div className="capacity-empty">
              <strong>No schedule yet</strong>
              <span>
                Add tasks or classes and Coqui will work out today’s capacity.
              </span>
            </div>
          ) : (
            <>
              <div>
                <strong>
                  {Math.floor(remaining / 60)}h {remaining % 60}m
                </strong>
                <span>available today</span>
              </div>
              <div className="meter">
                <i
                  style={{
                    width: `${Math.min(100, (remaining / 360) * 100)}%`,
                  }}
                />
              </div>
              <ul className="capacity-facts">
                <li>
                  <ListChecks aria-hidden="true" />
                  {studyBlocks} {studyBlocks === 1 ? "task" : "tasks"}
                </li>
                <li>
                  <CalendarDays aria-hidden="true" />
                  {classBlocks} {classBlocks === 1 ? "class" : "classes"}
                </li>
                <li className={data.conflicts.length ? "warn" : ""}>
                  {data.conflicts.length ? (
                    <TriangleAlert aria-hidden="true" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  {data.conflicts.length
                    ? `${data.conflicts.length} ${data.conflicts.length === 1 ? "conflict" : "conflicts"}`
                    : "No conflicts"}
                </li>
              </ul>
            </>
          )}
        </aside>
      </div>
      <div className="section-head">
        <h2>Today’s plan</h2>
        <button onClick={onReplan}>
          <RefreshCw />
          Replan my day
        </button>
      </div>
      <div className="body-grid">
        <section className="timeline">
          {data.blocks.length ? (
            data.blocks.map((block) => (
              <div
                className="timeline-row"
                id={`plan-block-${block.id}`}
                key={block.id}
              >
                <time>{formatTime(block.startsAt)}</time>
                <div className="rail">
                  <i />
                </div>
                <article
                  className={`event ${block.kind} ${block.completed ? "done" : ""} ${block.startedAt ? "started" : ""}`}
                >
                  <div>
                    <strong>{block.title}</strong>
                    <p>
                      {minutesBetween(block.startsAt, block.endsAt)} min ·{" "}
                      {block.locked ? "Fixed" : "Flexible"}
                      {block.startedAt ? " · In progress" : ""}
                    </p>
                    <div className="reason-row small">
                      {block.reasonCodes.slice(0, 2).map((code) => (
                        <span key={code}>{code.replaceAll("_", " ")}</span>
                      ))}
                    </div>
                  </div>
                  <button
                    className="check"
                    aria-label={`Mark ${block.title} ${block.completed ? "incomplete" : "complete"}`}
                    disabled={!block.taskId || busy}
                    onClick={() => block.taskId && onToggleTask(block.taskId)}
                  >
                    {block.completed && <Check />}
                  </button>
                </article>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <CalendarDays />
              <strong>Your day is open.</strong>
              <p>
                Add an assignment, class, or study session and Coqui will build
                your plan around the time you actually have.
              </p>
              <button className="solid" onClick={onAddTask}>
                <Plus />
                Add something
              </button>
            </div>
          )}
        </section>
        <aside className="side-stack" aria-label="Today details">
          <section className="small-card">
            <div className="small-head">
              <h3>Quick capture</h3>
              <span>Local</span>
            </div>
            <div className="quick-grid">
              <button onClick={onImport}>
                <FileUp />
                Import work
              </button>
              <button onClick={onAssistant}>
                <Brain />
                Brain dump
              </button>
              <button onClick={onReplan}>
                <RefreshCw />
                Adjust day
              </button>
            </div>
          </section>
          <section className="small-card">
            <div className="small-head">
              <h3>Planned vs actual</h3>
              <span>Today</span>
            </div>
            {reflection.started ? (
              <>
                <p>
                  {reflection.completed} completed · {reflection.started}{" "}
                  started.
                </p>
                <p>
                  You started {Math.abs(reflection.averageVariance)} minutes{" "}
                  {reflection.averageVariance > 0 ? "later" : "earlier"} than
                  planned on average.
                </p>
              </>
            ) : (
              <p>
                Start a focus block to build a private reflection. Coqui records
                timing locally.
              </p>
            )}
          </section>
          {data.conflicts.length > 0 && (
            <section className="small-card vault-card conflict-summary">
              <CircleAlert />
              <div>
                <h3>
                  {data.conflicts.length} decision
                  {data.conflicts.length === 1 ? "" : "s"} needed
                </h3>
                <p>
                  {data.conflicts.some(
                    (conflict) => conflict.kind === "source_change",
                  )
                    ? "Canvas reported a critical date change. Your current plan remains unchanged until you choose."
                    : "Some work does not fit without a conflict."}
                </p>
                <button onClick={onConflicts}>Review conflicts</button>
              </div>
            </section>
          )}
          <section className="small-card vault-card">
            <FileLock2 />
            <div>
              <h3>Encrypted vault</h3>
              <p>
                {pendingCount
                  ? `${pendingCount} extracted item${pendingCount === 1 ? "" : "s"} awaiting your review.`
                  : "Imported files and evidence stay encrypted on this device."}
              </p>
              {pendingCount > 0 && (
                <button onClick={onReview}>Review candidates</button>
              )}
            </div>
          </section>
          <section
            className={`small-card vault-card ${ocr.phase === "ready" ? "ocr-ready" : ocr.phase === "checking" ? "ocr-checking" : "ocr-attention"}`}
          >
            {ocr.phase === "ready" ? (
              <ShieldCheck />
            ) : ocr.phase === "checking" ? (
              <Loader />
            ) : (
              <CircleAlert />
            )}
            <div>
              <h3>
                {ocr.phase === "ready"
                  ? "Local OCR ready"
                  : ocr.phase === "checking"
                    ? "Checking local OCR"
                    : "OCR runtime needed"}
              </h3>
              <p>{ocr.message}</p>
              <small>
                Engine: {ocr.engineSource} · PDF renderer: {ocr.rendererSource}
              </small>
            </div>
          </section>
          <section className="small-card vault-card">
            <Link2 />
            <div>
              <h3>Canvas connections</h3>
              <p>
                {data.canvasConnections.length
                  ? `${data.canvasConnections.length} local connection${data.canvasConnections.length === 1 ? "" : "s"}. ${data.canvasConnections.reduce((sum, connection) => sum + connection.pendingCandidates, 0)} changes await review.`
                  : "Paste the Canvas calendar-feed link for a quick read-only setup, or use the full connection in Advanced."}
              </p>
              <button onClick={onCanvas}>
                {data.canvasConnections.length
                  ? "Manage sync"
                  : "Connect Canvas"}
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
