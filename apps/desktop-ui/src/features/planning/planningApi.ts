import { invoke } from "@tauri-apps/api/core";
import { isDesktop, listAiProviders, getLocalWorkspace, type Dashboard, type PlanBlock } from "../../native";
export type PlanningChoice = "undecided" | "enabled" | "disabled";
export type ConsentMode = "per_request" | "standing_deidentified";
export type PlanningPreferences = { version: 1; choice: PlanningChoice; consentMode: ConsentMode; revision: number };
export type TaskLabel = { reference: string; title: string; taskId: string };
export type PlanningDisclosure = { token: string; provider: string; model: string; disclosureUrl: string; facts: unknown; labels: TaskLabel[]; includeIdentifying: boolean };
export type SuggestedSession = { reference: string; startsAt: string; endsAt: string };
export type PlanningPreview = { token: string; reviewId: string; provider: string; model: string; labels: TaskLabel[]; order: string[]; sessions: SuggestedSession[]; explanation: string; before: PlanBlock[]; protected: PlanBlock[]; excluded: string[]; outcome: { blocks: { taskId: string; title: string; startsAt: string; endsAt: string }[]; overloadConflicts: { taskId: string; title: string; unscheduledMinutes: number }[]; capacity: { plannedMinutes: number; overloadMinutes: number } } };
export type PlanningStatus = { preferences: PlanningPreferences; prompt: boolean; fingerprint: string | null; pending: PlanningPreview | null };
const key = "coqui.automatic-planning.v1";
export const planningChanged = () => window.dispatchEvent(new Event("coqui-planning-settings"));
export async function getPlanningPreferences(): Promise<PlanningPreferences> {
  if (isDesktop()) return invoke("get_automatic_planning_preferences");
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : { version: 1, choice: "undecided", consentMode: "per_request", revision: 0 };
}
export async function savePlanningPreferences(choice: PlanningChoice, consentMode: ConsentMode = "per_request", standingConfirmed = false): Promise<PlanningPreferences> {
  if (consentMode === "standing_deidentified" && (!standingConfirmed || choice !== "enabled")) throw new Error("Confirm standing consent first.");
  const next: PlanningPreferences = isDesktop() ? await invoke("set_automatic_planning_preferences", { choice, consentMode, standingConfirmed }) : { version: 1, choice, consentMode, revision: (await getPlanningPreferences()).revision + 1 };
  if (!isDesktop()) localStorage.setItem(key, JSON.stringify(next));
  planningChanged();
  return next;
}
export async function getPlanningStatus(): Promise<PlanningStatus> {
  if (isDesktop()) return invoke("get_automatic_planning_status");
  const [preferences, providers, workspace] = await Promise.all([getPlanningPreferences(), listAiProviders(), getLocalWorkspace()]);
  return { preferences, prompt: preferences.choice === "undecided" && providers.some(provider => provider.connected && provider.healthy), fingerprint: JSON.stringify({ tasks: workspace.tasks, availability: workspace.availability, commitments: workspace.commitments, classMeetings: workspace.classMeetings, preferences: workspace.preferences }), pending: null };
}
export async function preparePlanning(includeIdentifying = false): Promise<PlanningDisclosure> {
  if (!isDesktop()) throw new Error("AI planning requests are available in the installed desktop app. Deterministic planning remains available here.");
  return invoke("prepare_automatic_planning", { includeIdentifying });
}
export async function requestPlanning(token: string, consent: boolean, standing = false, identifyingConsent = false): Promise<PlanningPreview> {
  return invoke("request_automatic_planning", { token, consent, standing, identifyingConsent });
}
export async function validatePlanning(token: string, order: string[], sessions: SuggestedSession[] | null, excluded: string[]): Promise<PlanningPreview> {
  return invoke("validate_automatic_planning", { token, order, sessions, excluded });
}
export async function applyPlanning(token: string, reviewId: string, confirmed: boolean): Promise<Dashboard> {
  return invoke("apply_automatic_planning", { token, reviewId, confirmed });
}
export async function discardPlanning(): Promise<void> {
  if (isDesktop()) await invoke("discard_automatic_planning");
}
