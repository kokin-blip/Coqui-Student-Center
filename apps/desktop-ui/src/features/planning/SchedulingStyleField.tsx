import type { SchedulingStyle } from "../../native";

export function SchedulingStyleField({ value, onChange, disabled = false }: { value: SchedulingStyle; onChange: (value: SchedulingStyle) => void; disabled?: boolean }) {
  return <label className="field">
    Assignment scheduling
    <select value={value} disabled={disabled} onChange={event => onChange(event.target.value as SchedulingStyle)}>
      <option value="mixed">Mixed</option>
      <option value="balanced">Balanced sessions</option>
      <option value="earliest">Earliest completion</option>
    </select>
    <span className="field-help">{value === "mixed" ? "Start early, then spread longer assignments across days. Use extra sessions when a deadline is close." : value === "balanced" ? "Spread sessions across available days, using extra sessions when needed to meet a deadline." : "Use the earliest available openings to finish work sooner."} Classes, travel, breaks, and protected time stay reserved.</span>
  </label>;
}
