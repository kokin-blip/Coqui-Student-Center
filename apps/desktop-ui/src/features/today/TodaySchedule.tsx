import { Check, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import type { PlanBlock, TaskRecord } from "../../native";
import {
  clockLabel,
  dateLabel,
  dayKey,
  minuteOfDay,
  positionBlocks,
} from "./todayModel";

type Props = {
  days: string[];
  blocks: PlanBlock[];
  tasks: TaskRecord[];
  timezone: string;
  now: Date;
  compact: boolean;
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  onComplete: (id: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onAdd: () => void;
  busy: boolean;
};

export function TodaySchedule(p: Props) {
  const [list, setList] = useState(false);
  const positions = p.days.map((day) =>
    positionBlocks(p.blocks, day, p.timezone),
  );
  const all = positions.flat();
  const startHour = Math.min(8, ...all.map((b) => Math.floor(b.start / 60)));
  const endHour = Math.min(
    24,
    Math.max(p.compact ? 22 : 18, ...all.map((b) => Math.ceil(b.end / 60))),
  );
  const hours = Array.from(
    { length: endHour - startHour + 1 },
    (_, i) => startHour + i,
  );
  const total = (endHour - startHour) * 60;
  const today = dayKey(p.now, p.timezone);
  const nowMinute = minuteOfDay(p.now, p.timezone);
  return (
    <section
      className={`day-schedule ${p.compact ? "week-schedule" : ""}`}
      aria-label={p.compact ? "Weekly schedule" : "Daily timeline"}
    >
      <header className="schedule-toolbar">
        <span>
          {p.compact
            ? `${dateLabel(p.days[0], { month: "short", day: "numeric" })} – ${dateLabel(p.days[6], { month: "short", day: "numeric" })}`
            : `All times in ${p.timezone}`}
        </span>
        <div>
          <button onClick={() => setList(!list)} aria-pressed={list}>
            {list ? "Show grid" : "Show list"}
          </button>
          <button onClick={p.onToday}>Today</button>
          <button
            aria-label={p.compact ? "Previous week" : "Previous day"}
            onClick={p.onPrevious}
          >
            <ChevronLeft />
          </button>
          <button
            aria-label={p.compact ? "Next week" : "Next day"}
            onClick={p.onNext}
          >
            <ChevronRight />
          </button>
        </div>
      </header>
      {list ? (
        <div className="schedule-list">
          {p.days.map((day, index) => (
            <section key={day}>
              <h3>
                {dateLabel(day, {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </h3>
              {p.tasks
                .filter(
                  (t) =>
                    t.dueAt &&
                    dayKey(t.dueAt, p.timezone) === day &&
                    !t.completed,
                )
                .map((t) => (
                  <button key={t.id} onClick={() => p.onSelect(t.id)}>
                    <span>Due</span>
                    <strong>{t.title}</strong>
                  </button>
                ))}
              {positions[index].map(({ block, start, end }) => (
                <button
                  key={block.id}
                  onClick={() =>
                    block.taskId ? p.onSelect(block.taskId) : p.onAdd()
                  }
                >
                  <span>
                    {clockLabel(start)}–{clockLabel(end)}
                  </span>
                  <strong>{block.title}</strong>
                  <small>
                    {block.location}
                    {block.completed ? " · Completed" : ""}
                  </small>
                </button>
              ))}
              {!positions[index].length && <p>No scheduled blocks.</p>}
            </section>
          ))}
        </div>
      ) : (
        <div
          className="schedule-scroll"
          tabIndex={0}
          role="region"
          aria-label="Scrollable schedule"
        >
          {p.compact && (
            <div className="week-dates">
              <span />
              <div>
                {p.days.map((day) => (
                  <span className={day === today ? "is-today" : ""} key={day}>
                    {dateLabel(day, { weekday: "short" })}{" "}
                    {dateLabel(day, { day: "numeric" })}
                  </span>
                ))}
              </div>
            </div>
          )}
          {p.compact && (
            <div className="all-day-row">
              <span>Due</span>
              <div>
                {p.days.map((day) => {
                  const due = p.tasks.filter(
                    (t) =>
                      t.dueAt &&
                      dayKey(t.dueAt, p.timezone) === day &&
                      !t.completed,
                  );
                  return (
                    <div key={day}>
                      {due[0] && (
                        <button
                          onClick={() => p.onSelect(due[0].id)}
                          title={due[0].title}
                        >
                          {due[0].title}
                        </button>
                      )}
                      {due.length > 1 && (
                        <button
                          className="due-more"
                          onClick={() => setList(true)}
                          aria-label={`Show all ${due.length} deadlines on ${day}`}
                        >
                          +{due.length - 1}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div
            className="schedule-grid"
            style={{
              height: `${(endHour - startHour) * (p.compact ? 19 : 62)}px`,
              minHeight: p.compact ? 266 : 620,
            }}
          >
            <div className="hour-axis">
              {hours.map((hour) => (
                <time
                  key={hour}
                  style={{
                    top: `${((hour - startHour) / (endHour - startHour)) * 100}%`,
                  }}
                >
                  {clockLabel(hour * 60)}
                </time>
              ))}
            </div>
            <div className="day-columns">
              {p.days.map((day, index) => (
                <div
                  key={day}
                  className={`day-column ${day === today ? "is-today" : ""}`}
                >
                  {hours.map((hour) => (
                    <i
                      className="hour-line"
                      aria-hidden="true"
                      key={hour}
                      style={{
                        top: `${((hour - startHour) / (endHour - startHour)) * 100}%`,
                      }}
                    />
                  ))}
                  {positions[index].map(
                    ({ block, start, end, lane, lanes }) => (
                      <article
                        id={`plan-block-${block.id}`}
                        key={block.id}
                        className={`schedule-event ${block.kind} ${end - start < (p.compact ? 110 : 48) ? "short" : ""} ${block.completed ? "done" : ""} ${p.selectedTaskId === block.taskId ? "selected" : ""}`}
                        style={{
                          top: `${((start - startHour * 60) / total) * 100}%`,
                          height: `${(Math.max(1, end - start) / total) * 100}%`,
                          left: `${(lane / lanes) * 100}%`,
                          width: `calc(${100 / lanes}% - 6px)`,
                        }}
                      >
                        <button
                          className="event-body"
                          onClick={() =>
                            block.taskId ? p.onSelect(block.taskId) : p.onAdd()
                          }
                          aria-label={`${block.title} · ${clockLabel(start)}–${clockLabel(end)}${block.location ? ` · ${block.location}` : ""}`}
                          title={`${block.title} · ${clockLabel(start)}–${clockLabel(end)}${block.location ? ` · ${block.location}` : ""}`}
                        >
                          <strong>{block.title}</strong>
                          <small>
                            {p.compact
                              ? `${clockLabel(start)}–${clockLabel(end)}`
                              : block.location ||
                                `${end - start} min · ${block.locked ? "Fixed" : "Flexible"}`}
                          </small>
                        </button>
                        {!p.compact && block.taskId && (
                          <button
                            className="event-check"
                            aria-label={`Mark ${block.title} ${block.completed ? "incomplete" : "complete"}`}
                            onClick={() => p.onComplete(block.taskId!)}
                            disabled={p.busy}
                          >
                            {block.completed ? <Check /> : <span />}
                          </button>
                        )}
                      </article>
                    ),
                  )}
                  {day === today &&
                    nowMinute >= startHour * 60 &&
                    nowMinute <= endHour * 60 && (
                      <div
                        className="now-line"
                        style={{
                          top: `${((nowMinute - startHour * 60) / total) * 100}%`,
                          ...(p.compact
                            ? {
                                left: `${-index * 100}%`,
                                right: `${-(6 - index) * 100}%`,
                              }
                            : {}),
                        }}
                      >
                        <time>{clockLabel(nowMinute)}</time>
                      </div>
                    )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {!p.compact && (
        <button className="add-time-block" onClick={p.onAdd}>
          <Plus /> Add time block
        </button>
      )}
    </section>
  );
}
