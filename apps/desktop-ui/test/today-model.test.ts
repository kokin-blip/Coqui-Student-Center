import { describe, expect, test } from "vitest";
import { getLocalWorkspace, type PlanBlock } from "../src/native";
import {
  capacityForDay,
  dayKey,
  mondayOf,
  positionBlocks,
} from "../src/features/today/todayModel";
import {
  applyInterfacePreferences,
  initialInterfacePreferences,
} from "../src/features/shell/interfacePreferences";

const block = (id: string, startsAt: string, endsAt: string): PlanBlock => ({
  id,
  startsAt,
  endsAt,
  title: id,
  kind: "study",
  completed: false,
  locked: false,
  sessionIndex: 0,
  location: "",
  reasonCodes: [],
});

describe("Today calendar model", () => {
  test("date-only deadlines do not shift into the previous day", () => {
    expect(dayKey("2026-09-02", "America/Phoenix")).toBe("2026-09-02");
    expect(dayKey("2026-09-02T01:00:00Z", "America/Phoenix")).toBe(
      "2026-09-01",
    );
    expect(mondayOf("2026-09-06")).toBe("2026-08-31");
  });
  test("overlapping events receive lanes, touching events reuse the full width", () => {
    const placed = positionBlocks(
      [
        block("a", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z"),
        block("b", "2026-09-02T09:30:00Z", "2026-09-02T10:30:00Z"),
        block("c", "2026-09-02T10:30:00Z", "2026-09-02T11:00:00Z"),
      ],
      "2026-09-02",
      "UTC",
    );
    expect(placed.map((p) => [p.lane, p.lanes])).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });
  test("cross-midnight blocks are clipped to the selected local day", () => {
    const placed = positionBlocks(
      [block("night", "2026-09-01T23:00:00Z", "2026-09-02T02:00:00Z")],
      "2026-09-02",
      "UTC",
    );
    expect(placed.map((p) => [p.start, p.end])).toEqual([[0, 120]]);
  });
  test("DST boundaries use the selected timezone's wall clock", () => {
    const placed = positionBlocks(
      [block("spring", "2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z")],
      "2026-03-08",
      "America/New_York",
    );
    expect(placed.map((p) => [p.start, p.end])).toEqual([[90, 210]]);
  });
  test("capacity unions overlapping availability and work rather than reporting scheduled minutes as free", async () => {
    const workspace = await getLocalWorkspace();
    workspace.availability = [
      { weekday: 3, startsAtLocal: "09:00", endsAtLocal: "12:00" },
      { weekday: 3, startsAtLocal: "10:00", endsAtLocal: "12:00" },
    ];
    workspace.commitments = [];
    const result = capacityForDay(
      workspace,
      [
        block("a", "2026-09-02T09:00:00Z", "2026-09-02T10:00:00Z"),
        block("b", "2026-09-02T09:30:00Z", "2026-09-02T10:30:00Z"),
      ],
      "2026-09-02",
      "UTC",
      new Date("2026-09-01T00:00:00Z"),
    );
    expect(result).toEqual({ available: 180, free: 90, label: "Moderate" });
    expect(
      capacityForDay(null, [], "2026-09-02", "UTC", new Date()),
    ).toBeNull();
  });
});

describe("interface preference cache", () => {
  test("fresh defaults are Comfy/light and Compact/dark", () => {
    expect(initialInterfacePreferences()).toEqual({
      mode: "comfy",
      themes: { comfy: "light", compact: "coqui-dark" },
    });
  });
  test("legacy Power and explicit theme migrate without changing the other mode", () => {
    localStorage.setItem("student-center-density", "power");
    localStorage.setItem("student-center-appearance", "forest");
    expect(initialInterfacePreferences()).toEqual({
      mode: "compact",
      themes: { comfy: "light", compact: "forest" },
    });
  });
  test("both mode themes survive cache reload and malformed JSON does not block startup", () => {
    const prefs = {
      mode: "compact" as const,
      themes: { comfy: "system" as const, compact: "graphite" as const },
    };
    applyInterfacePreferences(prefs);
    expect(initialInterfacePreferences()).toEqual(prefs);
    localStorage.setItem("coqui-interface-preferences-v1", "broken");
    expect(initialInterfacePreferences().mode).toBe("compact");
  });
});
