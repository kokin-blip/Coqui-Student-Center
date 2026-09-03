import type { ScholarshipWorkspace } from "../../native";

export type ScholarshipRunAction = (
  action: () => Promise<ScholarshipWorkspace>,
  success: string,
) => Promise<void>;
