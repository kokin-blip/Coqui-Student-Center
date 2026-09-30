import type { Dashboard, TaskRecord } from "../../native";
import { blocksForDay } from "../today/todayModel";

export type CelebrationReason = "plan" | "major" | "early" | "streak" | "weekly" | "on-time";
export type CompletionMomentum = {
  seenTaskIds: string[];
  seenPlanDates: string[];
  recent: { taskId: string; at: number }[];
  lastCelebratedAt: number;
};

export const initialCompletionMomentum: CompletionMomentum = { seenTaskIds: [], seenPlanDates: [], recent: [], lastCelebratedAt: -Infinity };

const majorKinds = new Set<TaskRecord["kind"]>(["exam", "midterm", "final", "test", "quiz", "project", "paper", "lab"]);
const streakWindowMs = 20 * 60 * 1000;
const celebrationCooldownMs = 45 * 1000;
const earlyMarginMs = 48 * 60 * 60 * 1000;

export function weeklyGoalReached(tasks: Pick<TaskRecord, "completed" | "completedAt">[], goal: number, now: number, timezone: string, lastCelebratedWeek: string): string | null {
  if (!Number.isInteger(goal) || goal < 1 || goal > 20) return null;
  const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const weekOf = (timestamp: number) => {
    const parts = dateFormat.formatToParts(timestamp);
    const number = (kind: string) => Number(parts.find((part) => part.type === kind)?.value);
    const monday = new Date(Date.UTC(number("year"), number("month") - 1, number("day")));
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    return monday.toISOString().slice(0, 10);
  };
  const week = weekOf(now);
  if (lastCelebratedWeek === week) return null;
  const completedThisWeek = tasks.filter((task) => task.completed && task.completedAt && Number.isFinite(Date.parse(task.completedAt)) && weekOf(Date.parse(task.completedAt)) === week).length;
  return completedThisWeek === goal ? week : null;
}

export function completedStudyPlan(before: Dashboard, after: Dashboard, taskId: string): string | null {
  if (before.planDate !== after.planDate || before.timezone !== after.timezone) return null;
  const planned = blocksForDay(before.blocks, before.planDate, before.timezone).filter((block) => block.kind === "study" && block.taskId);
  if (planned.length < 2 || !planned.some((block) => block.taskId === taskId && !block.completed) || planned.every((block) => block.completed)) return null;
  const persisted = new Map(after.blocks.map((block) => [block.id, block]));
  return planned.every((block) => persisted.get(block.id)?.completed) ? before.planDate : null;
}

export function recordTaskCompletion(
  state: CompletionMomentum,
  task: Pick<TaskRecord, "id" | "kind" | "dueAt">,
  now: number,
  celebrationsEnabled: boolean,
  momentumEnabled: boolean,
  completedPlanDate?: string | null,
  weeklyGoalWeek?: string | null,
): { state: CompletionMomentum; reason: CelebrationReason | null; newCompletion: boolean } {
  if (state.seenTaskIds.includes(task.id)) return { state, reason: null, newCompletion: false };
  const recent = [...state.recent.filter((entry) => now - entry.at < streakWindowMs), { taskId: task.id, at: now }];
  const newPlan = completedPlanDate && !state.seenPlanDates.includes(completedPlanDate) ? completedPlanDate : null;
  const updated = { ...state, seenTaskIds: [...state.seenTaskIds, task.id], seenPlanDates: newPlan ? [...state.seenPlanDates, newPlan] : state.seenPlanDates, recent };
  const due = task.dueAt ? Date.parse(task.dueAt) : NaN;
  const reason = weeklyGoalWeek ? "weekly"
    : newPlan ? "plan"
    : majorKinds.has(task.kind) ? "major"
    : Number.isFinite(due) && due - now >= earlyMarginMs ? "early"
    : momentumEnabled && recent.length >= 3 ? "streak" : null;
  if (!celebrationsEnabled || !reason || now - state.lastCelebratedAt < celebrationCooldownMs) {
    return { state: updated, reason: null, newCompletion: true };
  }
  return { state: { ...updated, lastCelebratedAt: now }, reason, newCompletion: true };
}
