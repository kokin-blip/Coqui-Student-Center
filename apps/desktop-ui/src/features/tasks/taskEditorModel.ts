import type { TaskInput, TaskRecord } from "../../native";

export const emptyTask = (): TaskInput => ({
  title: "",
  kind: "assignment",
  minutes: 30,
  priority: 3,
  academicRisk: 0,
  energyDemand: "medium",
  location: "",
  splittable: true,
  minSessionMinutes: 20,
  maxSessionMinutes: 60,
  dependencies: [],
});

export function taskInput(value: TaskRecord): TaskInput {
  const {
    id: _id,
    completed: _completed,
    version,
    recordOrigin: _origin,
    ...input
  } = value;
  return { ...input, expectedVersion: version };
}

// datetime-local represents this computer's wall clock, not a UTC ISO prefix.
export function dateTimeValue(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
