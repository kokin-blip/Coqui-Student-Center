import { invoke } from "@tauri-apps/api/core";
import { isDesktop, getLocalWorkspace, toggleTask } from "../../native";
export type QuickNote = { id: string; content: string; courseId: string | null; taskId: string | null; pinned: boolean; revision: number; createdAt: string; updatedAt: string };
export type NoteInput = Omit<QuickNote, "id" | "revision" | "createdAt" | "updatedAt"> & { id?: string; expectedRevision: number };
export type CheckinSettings = { enabled: boolean; time: string; followRhythm: boolean; offerDismissed: boolean; streakVisible: boolean };
export const defaultCheckinSettings: CheckinSettings = { enabled: false, time: "20:00", followRhythm: true, offerDismissed: false, streakVisible: true };
export type CheckinItem = { taskId: string; title: string; response: string | null; completed: boolean; unavailable: boolean; taskVersion: number | null; rescheduled?: boolean };
export type Checkin = { day: string; timezone: string; dueAt: string; items: CheckinItem[] };
export type AssignmentHistory = { kind:string; dueAt:string|null; completedAt:string|null; recordedAt:string };
export type StreakEntry = { taskId: string; title: string; kind: string; dueAt: string; completedAt: string | null; outcome: string; frozen: boolean; legacy: boolean; deleted: boolean; currentDueAt: string | null; history?:AssignmentHistory[] };
export type WorkflowState = { version?:1; timezone?: string; settings: CheckinSettings; checkin: Checkin | null; streak: { count: number; entries: StreakEntry[] } };
// Synthetic browser preview, deliberately memory-only; installed profiles use encrypted SQLite.
let previewNotes: QuickNote[] = [];
let previewSettings = { ...defaultCheckinSettings };
export const workflowApi = {
  async notes(query = ""): Promise<QuickNote[]> { return isDesktop() ? invoke("list_quick_notes", { query }) : structuredClone(previewNotes.filter(n => n.content.toLowerCase().includes(query.toLowerCase()))); },
  async saveNote(input: NoteInput): Promise<QuickNote[]> {
    if (isDesktop()) return invoke("save_quick_note", { input: { id: input.id ?? null, expectedRevision: input.expectedRevision, content: input.content, courseId: input.courseId, taskId: input.taskId, pinned: input.pinned } });
    if (!input.content.trim() || input.content.length > 4000) throw new Error("Write a note of 1–4,000 characters.");
    const current = previewNotes.find(n => n.id === input.id);
    if (input.id && current?.revision !== input.expectedRevision) throw new Error("This note changed. Reload before saving.");
    const now = new Date().toISOString();
    const note = { ...input, id: input.id ?? crypto.randomUUID(), revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
    previewNotes = [note, ...previewNotes.filter(n => n.id !== note.id)];
    return structuredClone(previewNotes);
  },
  async deleteNote(id: string, expectedRevision: number): Promise<QuickNote[]> {
    if (isDesktop()) return invoke("delete_quick_note", { id, expectedRevision });
    if (previewNotes.find(n => n.id === id)?.revision !== expectedRevision) throw new Error("This note changed. Reload before deleting.");
    previewNotes = previewNotes.filter(n => n.id !== id); return structuredClone(previewNotes);
  },
  async state(offer = false): Promise<WorkflowState> {
    if (isDesktop()) return invoke("get_student_workflows", { offer });
    const { tasks, profile } = await getLocalWorkspace();
    const eligible = new Set(["assignment", "homework", "project", "paper", "lab", "quiz", "test", "exam", "midterm", "final"]);
    const entries: StreakEntry[] = tasks.filter(t => t.dueAt && eligible.has(t.kind)).sort((a,b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!) || a.id.localeCompare(b.id)).map(t => ({ taskId:t.id,title:t.title,kind:t.kind,dueAt:t.dueAt!,completedAt:t.completedAt ?? null,outcome:t.completed ? (t.completedAt ? (Date.parse(t.completedAt)<=Date.parse(t.dueAt!) ? "on_time":"late") : "unknown") : Date.parse(t.dueAt!)<=Date.now()?"missing":"pending",frozen:t.completed,legacy:true,deleted:false,currentDueAt:t.dueAt! }));
    let count=0; for(const e of entries) {if(e.outcome==="on_time") count++; else if(["late","missing"].includes(e.outcome))count=0;}
    return { timezone:profile?.timezone??"America/Phoenix",settings: structuredClone(previewSettings), checkin: null, streak: {count,entries} };
  },
  async settings(input: CheckinSettings): Promise<CheckinSettings> { if(isDesktop())return invoke("save_checkin_settings",{input}); previewSettings={...input};return {...input}; },
  claimCelebration: () => isDesktop() ? invoke<boolean>("claim_assignment_celebration") : Promise.resolve(false),
  control(day: string, action: "snooze" | "dismiss") { return isDesktop()?invoke<void>("control_checkin", {day,action}):Promise.resolve(); },
  async respond(input: {day:string;taskId:string;action:string;expectedVersion:number;completedAt:string|null}) { if(isDesktop())return invoke<Awaited<ReturnType<typeof toggleTask>>>("respond_checkin",{input});return toggleTask(input.taskId); },
};
