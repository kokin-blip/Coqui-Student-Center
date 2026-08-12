export type Energy = "low" | "medium" | "high";

export type PlanningTask = {
  id: string;
  title: string;
  durationMinutes: number;
  dueAt: string;
  priority: 1 | 2 | 3 | 4 | 5;
  earliestStart?: string;
  energy?: Energy;
  splittable?: boolean;
  completed?: boolean;
};

export type FixedBlock = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  locked?: boolean;
};

export type PlanBlock = FixedBlock & {
  taskId?: string;
  reasonCodes: Array<"deadline_soon" | "high_energy_match" | "only_feasible_window" | "fixed_commitment">;
};

export type PlanConflict = { taskId: string; unscheduledMinutes: number; reason: "insufficient_capacity" };
export type PlanResult = { blocks: PlanBlock[]; conflicts: PlanConflict[] };

const MINUTE = 60_000;

function overlaps(start: number, end: number, block: PlanBlock) {
  return start < Date.parse(block.endsAt) && end > Date.parse(block.startsAt);
}

function scoreTask(task: PlanningTask, now: number) {
  const hoursUntilDue = Math.max(1, (Date.parse(task.dueAt) - now) / (60 * MINUTE));
  return task.priority * 10_000 + 10_000 / hoursUntilDue;
}

export function generatePlan(input: {
  now: string;
  horizonEnd: string;
  tasks: PlanningTask[];
  fixedBlocks: FixedBlock[];
  dayStartHour?: number;
  dayEndHour?: number;
  slotMinutes?: number;
  maxSessionMinutes?: number;
}): PlanResult {
  const now = Date.parse(input.now);
  const horizonEnd = Date.parse(input.horizonEnd);
  const slot = input.slotMinutes ?? 15;
  const maxSession = input.maxSessionMinutes ?? 60;
  const dayStart = input.dayStartHour ?? 8;
  const dayEnd = input.dayEndHour ?? 21;
  const blocks: PlanBlock[] = input.fixedBlocks.map(block => ({ ...block, reasonCodes: ["fixed_commitment"] }));
  const conflicts: PlanConflict[] = [];
  const tasks = input.tasks.filter(task => !task.completed).sort((a, b) => {
    const scoreDifference = scoreTask(b, now) - scoreTask(a, now);
    return scoreDifference || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id);
  });

  for (const task of tasks) {
    let remaining = task.durationMinutes;
    let cursor = Math.max(now, task.earliestStart ? Date.parse(task.earliestStart) : now);
    const due = Math.min(Date.parse(task.dueAt), horizonEnd);

    while (remaining > 0 && cursor < due) {
      const date = new Date(cursor);
      if (date.getUTCHours() < dayStart) date.setUTCHours(dayStart, 0, 0, 0);
      if (date.getUTCHours() >= dayEnd) {
        date.setUTCDate(date.getUTCDate() + 1);
        date.setUTCHours(dayStart, 0, 0, 0);
      }
      cursor = date.getTime();
      const session = task.splittable === false ? remaining : Math.min(remaining, maxSession);
      const end = cursor + session * MINUTE;

      if (end <= due && new Date(end).getUTCHours() <= dayEnd && !blocks.some(block => overlaps(cursor, end, block))) {
        const hoursUntilDue = (Date.parse(task.dueAt) - cursor) / (60 * MINUTE);
        const reasonCodes: PlanBlock["reasonCodes"] = [hoursUntilDue <= 48 ? "deadline_soon" : "only_feasible_window"];
        blocks.push({
          id: `plan-${task.id}-${cursor}`,
          taskId: task.id,
          title: task.title,
          startsAt: new Date(cursor).toISOString(),
          endsAt: new Date(end).toISOString(),
          reasonCodes,
        });
        remaining -= session;
        cursor = end + slot * MINUTE;
      } else {
        cursor += slot * MINUTE;
      }
    }

    if (remaining > 0) conflicts.push({ taskId: task.id, unscheduledMinutes: remaining, reason: "insufficient_capacity" });
  }

  return { blocks: blocks.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id)), conflicts };
}

export function replan(input: Parameters<typeof generatePlan>[0] & { effectiveAt: string; existingBlocks: PlanBlock[] }) {
  const effectiveAt = Date.parse(input.effectiveAt);
  const protectedBlocks = input.existingBlocks.filter(block => block.locked || Date.parse(block.startsAt) < effectiveAt);
  return generatePlan({ ...input, now: input.effectiveAt, fixedBlocks: [...input.fixedBlocks, ...protectedBlocks] });
}

export function recommendNext(input: { now: string; availableMinutes: number; tasks: PlanningTask[] }) {
  const now = Date.parse(input.now);
  const eligible = input.tasks.filter(task => !task.completed && task.durationMinutes <= input.availableMinutes && (!task.earliestStart || Date.parse(task.earliestStart) <= now));
  const ranked = eligible.sort((a, b) => scoreTask(b, now) - scoreTask(a, now) || a.id.localeCompare(b.id));
  const toAction = (task: PlanningTask) => ({ taskId: task.id, title: task.title, durationMinutes: task.durationMinutes, reasonCodes: [(Date.parse(task.dueAt) - now) / (60 * MINUTE) <= 48 ? "deadline_soon" : "fits_available_window"] });
  return ranked.length ? { action: toAction(ranked[0]), alternatives: ranked.slice(1, 3).map(toAction) } : { action: null, alternatives: [] };
}
