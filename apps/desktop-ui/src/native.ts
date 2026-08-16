import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";

export type PlanBlock = {
  id: string;
  taskId?: string;
  startsAt: string;
  endsAt: string;
  title: string;
  kind: "class" | "study" | "work" | "life" | "protected";
  completed: boolean;
  locked: boolean;
  startedAt?: string;
  sessionIndex: number;
  location: string;
  reasonCodes: string[];
};
export type ImportCandidate = {
  id: string;
  kind: "task" | "commitment" | "course";
  title: string;
  course: string;
  dueAt?: string;
  startsAt?: string;
  endsAt?: string;
  durationMinutes?: number;
  evidence: string;
  sourceLocator: string;
  sourceType: string;
  sourceUrl?: string;
  confidence: number;
  warnings: string[];
  status: "pending" | "approved" | "rejected";
};
export type DocumentSummary = {
  id: string;
  fileName: string;
  mime: string;
  importedAt: string;
  extractionStatus: string;
  extractionError?: string;
  candidateCount: number;
  pendingCount: number;
  approvedCount: number;
};
export type ManagedAiCapability =
  | "brain_dump"
  | "document_extraction"
  | "task_decomposition"
  | "explanation";
export type ManagedAiResult = {
  dashboard: Dashboard;
  explanation?: string;
  candidatesCreated: number;
  model: string;
};
export type OcrPhase = "checking" | "ready" | "unavailable";
export type OcrStatus = {
  ready: boolean;
  phase: OcrPhase;
  rendererAvailable: boolean;
  engineAvailable: boolean;
  englishDataAvailable: boolean;
  rendererSource: string;
  engineSource: string;
  message: string;
};
export type CanvasConnection = {
  id: string;
  baseUrl: string;
  accountName: string;
  status: string;
  lastSyncedAt?: string;
  lastError?: string;
  pendingCandidates: number;
};
export type CanvasSyncRun = {
  id: string;
  connectionId: string;
  startedAt: string;
  completedAt?: string;
  status: string;
  pulledCount: number;
  createdCount: number;
  error?: string;
};
export type SourceConflict = {
  id: string;
  kind: "source_change" | "overload" | string;
  description: string;
  candidateId?: string;
  entityType?: string;
  entityId?: string;
  currentDueAt?: string;
  proposedDueAt?: string;
  currentStartsAt?: string;
  proposedStartsAt?: string;
  currentEndsAt?: string;
  proposedEndsAt?: string;
  detectedAt?: string;
};
export type NotificationSettings = {
  enabled: boolean;
  permissionGranted: boolean;
  leadMinutes: number;
  quietStart: string;
  quietEnd: string;
  showTitles: boolean;
};
export type NextActionAlternative = {
  blockId: string;
  taskId: string;
  title: string;
  durationMinutes: number;
  reasonCodes: string[];
};
export type NextAction = {
  blockId: string;
  taskId: string;
  title: string;
  durationMinutes: number;
  explanation: string;
  reasonCodes: string[];
  alternatives: NextActionAlternative[];
  validFrom: string;
  validUntil: string;
};
export type Dashboard = {
  studentName: string;
  timezone: string;
  offline: boolean;
  planDate: string;
  blocks: PlanBlock[];
  candidates: ImportCandidate[];
  canvasConnections: CanvasConnection[];
  canvasSyncRuns: CanvasSyncRun[];
  nextAction?: NextAction;
  notificationSettings: NotificationSettings;
  conflicts: SourceConflict[];
  ocr: OcrStatus;
  importNotice?: string;
};
export type CalendarAgenda = {
  timezone: string;
  startsAt: string;
  endsAt: string;
  blocks: PlanBlock[];
  overloadConflicts: SourceConflict[];
};
export type BackupPreview = {
  fingerprint: string;
  archiveId: string;
  createdAt: string;
  appVersion: string;
  studentName: string;
  timezone: string;
  encryptedBytes: number;
  counts: {
    tasks: number;
    commitments: number;
    courses: number;
    documents: number;
    pendingCandidates: number;
  };
};
export type SecurityStatus = {
  pinEnabled: boolean;
  locked: boolean;
  retryAfterSeconds: number;
};
export type AvailabilityInput = {
  weekday: number;
  startsAtLocal: string;
  endsAtLocal: string;
};
export type CommitmentInput = {
  title: string;
  startsAt: string;
  endsAt: string;
  kind: string;
  location: string;
  travelBeforeMinutes: number;
  travelAfterMinutes: number;
};
export type OnboardingDraft = {
  name: string;
  timezone: string;
  termName: string;
  termStartsOn: string;
  termEndsOn: string;
  courseTitle: string;
  courseCode: string;
  institution: InstitutionSelection;
  courses: OnboardingCourseInput[];
  appearance: AppearancePreference;
  sleepStart: string;
  sleepEnd: string;
  maxSessionMinutes: number;
  breakMinutes: number;
  transitionMinutes: number;
  defaultCommuteMinutes: number;
  availability: AvailabilityInput[];
  commitments: CommitmentInput[];
};
export type AppearancePreference = "system" | "light" | "dark";
export type InstitutionSelection = {
  id: string;
  name: string;
  country: string;
  source: string;
  officialDomain?: string;
  catalogProviderStatus: string;
  custom: boolean;
  campusId?: string;
  campusName?: string;
};
export type InstitutionCampusOption = {
  id: string;
  name: string;
  city: string;
  timezone: string;
  sourceLabel: string;
  sourceUrl: string;
};
export type AcademicTermPreset = {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  classEndsOn: string;
  examStartsOn: string;
  details: string;
  sourceLabel: string;
  sourceUrl: string;
};
export type InstitutionSetupOptions = {
  institutionId: string;
  campuses: InstitutionCampusOption[];
  terms: AcademicTermPreset[];
};
export type CourseSuggestion = {
  code: string;
  title: string;
  source: "canvas" | "catalog" | "local" | "generic" | string;
  sourceLabel: string;
  confidence: number;
};
export type TimezoneSuggestion = {
  timezone: string;
  displayName: string;
  source: string;
};
export type OnboardingCourseInput = {
  code: string;
  title: string;
  color: string;
  meetings: ClassMeetingInput[];
};
export type ClassMeetingInput = {
  weekdays: number[];
  startsAtLocal: string;
  endsAtLocal: string;
  component: string;
  location: string;
  instructorName: string;
};
export type LegacyQuarantineStatus = {
  detectedCount: number;
  quarantineComplete: boolean;
  recoveryAvailable: boolean;
};
export type LegacyQuarantineItem = {
  id: string;
  entityType: string;
  title: string;
  quarantinedAt: string;
};
export type OnboardingState = {
  required: boolean;
  onboardingVersion: number;
  legacyQuarantineStatus: LegacyQuarantineStatus;
  draft: OnboardingDraft;
};
export type StudentProfileRecord = {
  name: string;
  timezone: string;
  version: number;
};
export type StudentProfileInput = {
  name: string;
  timezone: string;
  expectedVersion: number;
};
export type AcademicTermRecord = {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  active: boolean;
  version: number;
};
export type CourseRecord = {
  id: string;
  title: string;
  code: string;
  termId?: string;
  version: number;
  recordOrigin: string;
  color: string;
};
export type TaskRecord = {
  id: string;
  title: string;
  minutes: number;
  dueAt?: string;
  courseId?: string;
  priority: number;
  academicRisk: number;
  earliestStart?: string;
  energyDemand: "low" | "medium" | "high";
  location: string;
  splittable: boolean;
  minSessionMinutes: number;
  maxSessionMinutes: number;
  completed: boolean;
  version: number;
  dependencies: string[];
  recordOrigin: string;
  kind: "task" | "assignment" | "exam";
};
export type InstructorRecord = {
  id: string;
  courseId: string;
  name: string;
  email: string;
  officeLocation: string;
  officeHours: string;
  version: number;
};
export type ClassMeetingSeriesRecord = {
  id: string;
  courseId: string;
  termId: string;
  timezone: string;
  weekdays: number[];
  startsAtLocal: string;
  endsAtLocal: string;
  component: string;
  location: string;
  instructorId?: string;
  version: number;
};
export type AcademicCalendarEventRecord = {
  id: string;
  termId?: string;
  title: string;
  startsOn: string;
  endsOn: string;
  allDay: boolean;
  noClass: boolean;
  source: string;
  version: number;
};
export type CommitmentRecord = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  kind: "class" | "work" | "life" | "protected";
  location: string;
  travelBeforeMinutes: number;
  travelAfterMinutes: number;
  protected: boolean;
  version: number;
  recordOrigin: string;
};
export type PlanningPreferenceRecord = {
  sleepStart: string;
  sleepEnd: string;
  maxSessionMinutes: number;
  breakMinutes: number;
  transitionMinutes: number;
  defaultCommuteMinutes: number;
  version: number;
};
export type WorkspaceSnapshot = {
  profile: StudentProfileRecord | null;
  institution: InstitutionSelection | null;
  appearance: AppearancePreference;
  terms: AcademicTermRecord[];
  courses: CourseRecord[];
  tasks: TaskRecord[];
  commitments: CommitmentRecord[];
  instructors: InstructorRecord[];
  classMeetings: ClassMeetingSeriesRecord[];
  academicEvents: AcademicCalendarEventRecord[];
  preferences: PlanningPreferenceRecord | null;
  availability: AvailabilityInput[];
};
export type AcademicTermInput = Omit<AcademicTermRecord, "id" | "version"> & {
  expectedVersion?: number;
};
export type CourseInput = {
  title: string;
  code: string;
  termId?: string;
  expectedVersion?: number;
  color?: string;
};
export type TaskInput = Omit<
  TaskRecord,
  "id" | "completed" | "version" | "recordOrigin"
> & { expectedVersion?: number };
export type CommitmentEditorInput = Omit<
  CommitmentRecord,
  "id" | "version" | "recordOrigin"
> & { expectedVersion?: number };
export type InstructorInput = Omit<InstructorRecord, "id" | "version"> & {
  expectedVersion?: number;
};
export type ClassMeetingSeriesInput = Omit<
  ClassMeetingSeriesRecord,
  "id" | "version"
> & { expectedVersion?: number };
export type AcademicCalendarEventInput = Omit<
  AcademicCalendarEventRecord,
  "id" | "version"
> & { expectedVersion?: number };
export type PreferenceInput = Omit<PlanningPreferenceRecord, "version"> & {
  expectedVersion: number;
  availability: AvailabilityInput[];
};
export type NavigationTarget =
  | { view: "my-day" }
  | { view: "plan-block"; blockId: string };
export type UpdateStatus = {
  configured: boolean;
  currentVersion: string;
  available: boolean;
  latestVersion?: string;
  notes?: string;
  checkedAt?: string;
  message: string;
};
export type AccountStatus = {
  configured: boolean;
  signedIn: boolean;
  email?: string;
  accountId?: string;
  accessReady: boolean;
  credentialAvailable: boolean;
  googleSignInPending: boolean;
  message: string;
};
export type EmailCodeStatus = {
  email: string;
  retryAfterSeconds: number;
  message: string;
};
export type SyncProtectionStatus = {
  protected: boolean;
  accountId: string;
  deviceId?: string;
  publicKey?: string;
  message: string;
};
export type RecoverySetup = {
  words: string[];
  confirmationPositions: number[];
  deviceId: string;
  publicKey: string;
};
export type RecoveryConfirmation = { position: number; word: string };
export type ExistingDeviceSetup = {
  deviceId: string;
  publicKey: string;
  signingPublicKey: string;
};
export type EncryptedSyncStatus = {
  configured: boolean;
  protected: boolean;
  connected: boolean;
  accountId: string;
  deviceId?: string;
  pendingMutations: number;
  pendingDownloadedMutations: number;
  lastPushedAt?: string;
  message: string;
};
export type PendingSyncDevice = {
  deviceId: string;
  publicKey: string;
  signingPublicKey: string;
  displayName: string;
  platform: string;
};
export type AppBootstrap = {
  security: SecurityStatus;
  schemaVersion: number;
  onboarding: OnboardingState | null;
  dashboard: Dashboard | null;
};

const browserDayStart = new Date();
browserDayStart.setHours(0, 0, 0, 0);
const browserAt = (hour: number, minute = 0) => {
  const value = new Date(browserDayStart);
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
};
let browserOnboardingState: OnboardingState = {
  required: true,
  onboardingVersion: 2,
  legacyQuarantineStatus: {
    detectedCount: 0,
    quarantineComplete: true,
    recoveryAvailable: false,
  },
  draft: {
    name: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    termName: "Current term",
    termStartsOn: `${new Date().getFullYear()}-08-01`,
    termEndsOn: `${new Date().getFullYear() + 1}-05-31`,
    courseTitle: "",
    courseCode: "",
    institution: {
      id: "",
      name: "",
      country: "US",
      source: "",
      catalogProviderStatus: "unavailable",
      custom: false,
    },
    courses: [],
    appearance: "system",
    sleepStart: "23:00",
    sleepEnd: "07:00",
    maxSessionMinutes: 60,
    breakMinutes: 10,
    transitionMinutes: 10,
    defaultCommuteMinutes: 0,
    availability: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      startsAtLocal: "08:00",
      endsAtLocal: "21:00",
    })),
    commitments: [],
  },
};

const browserSeed: Dashboard = {
  studentName: "Alex Morgan",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offline: true,
  planDate: new Date().toISOString().slice(0, 10),
  candidates: [
    {
      id: "canvas-change-demo",
      kind: "task",
      title: "Research paper outline",
      course: "English 102",
      dueAt: "2026-08-16T23:59:00-07:00",
      durationMinutes: 45,
      evidence:
        "Canvas now lists this assignment due Sunday, August 16 at 11:59 PM.",
      sourceLocator: "Canvas · English 102 · assignment",
      sourceType: "canvas_assignment",
      confidence: 1,
      warnings: [],
      status: "pending",
    },
  ],
  canvasConnections: [],
  canvasSyncRuns: [],
  conflicts: [
    {
      id: "source-change-demo",
      kind: "source_change",
      description:
        "Research paper outline changed a critical date; choose which value Student Center should use",
      candidateId: "canvas-change-demo",
      entityType: "task",
      entityId: "paper-outline",
      currentDueAt: "2026-08-14T23:59:00-07:00",
      proposedDueAt: "2026-08-16T23:59:00-07:00",
      detectedAt: "2026-08-12T12:00:00-07:00",
    },
  ],
  ocr: {
    ready: true,
    phase: "ready",
    rendererAvailable: true,
    engineAvailable: true,
    englishDataAvailable: true,
    rendererSource: "test",
    engineSource: "test",
    message: "Local image and scanned-PDF OCR is ready",
  },
  notificationSettings: {
    enabled: false,
    permissionGranted: false,
    leadMinutes: 10,
    quietStart: "22:00",
    quietEnd: "07:00",
    showTitles: false,
  },
  blocks: [
    {
      id: "class-stat",
      startsAt: browserAt(9),
      endsAt: browserAt(9, 50),
      title: "Statistics 201",
      kind: "class",
      completed: true,
      locked: true,
      sessionIndex: 0,
      location: "campus",
      reasonCodes: ["fixed_commitment"],
    },
    {
      id: "read-6",
      taskId: "read-6",
      startsAt: browserAt(10, 30),
      endsAt: browserAt(11, 5),
      title: "Read Chapter 6: Social Influence",
      kind: "study",
      completed: false,
      locked: false,
      sessionIndex: 0,
      location: "library",
      reasonCodes: ["deadline_soon", "only_feasible_window"],
    },
    {
      id: "paper-intro",
      taskId: "paper-intro",
      startsAt: browserAt(13),
      endsAt: browserAt(13, 45),
      title: "Draft research paper introduction",
      kind: "study",
      completed: false,
      locked: false,
      sessionIndex: 0,
      location: "",
      reasonCodes: ["energy_match"],
    },
    {
      id: "work",
      startsAt: browserAt(15, 30),
      endsAt: browserAt(18, 30),
      title: "Campus library shift",
      kind: "work",
      completed: false,
      locked: true,
      sessionIndex: 0,
      location: "library",
      reasonCodes: ["fixed_commitment"],
    },
  ],
  nextAction: {
    blockId: "read-6",
    taskId: "read-6",
    title: "Read Chapter 6: Social Influence",
    durationMinutes: 35,
    explanation:
      "This fits before your next fixed commitment and prepares you for tomorrow's discussion.",
    reasonCodes: ["deadline_soon", "only_feasible_window"],
    alternatives: [
      {
        blockId: "paper-intro",
        taskId: "paper-intro",
        title: "Draft research paper introduction",
        durationMinutes: 45,
        reasonCodes: ["energy_match"],
      },
    ],
    validFrom: browserAt(10, 30),
    validUntil: browserAt(11, 5),
  },
};

export const isDesktop = () => "__TAURI_INTERNALS__" in window;
async function call<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!isDesktop())
    throw new Error("Native command unavailable in browser test mode");
  return invoke<T>(command, args);
}

export async function initialize(): Promise<AppBootstrap> {
  if (!isDesktop()) {
    const demoMode = new URLSearchParams(window.location.search).has("demo");
    const onboardingMode = !demoMode;
    return {
      security: { pinEnabled: false, locked: false, retryAfterSeconds: 0 },
      schemaVersion: 11,
      onboarding: onboardingMode ? structuredClone(browserOnboardingState) : null,
      dashboard: onboardingMode ? null : structuredClone(browserSeed),
    };
  }
  return call<AppBootstrap>("app_initialize");
}
export async function getDashboard(): Promise<Dashboard> {
  if (!isDesktop()) {
    return structuredClone(browserSeed);
  }
  return call<Dashboard>("get_dashboard");
}
export async function unlockWithPin(pinValue: string) {
  return call<AppBootstrap>("unlock_with_pin", { pinValue });
}
export async function getOnboardingState() {
  return call<OnboardingState>("get_onboarding_state");
}
export async function getTimezoneSuggestion(): Promise<TimezoneSuggestion> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!isDesktop()) {
    const zone = new Intl.DateTimeFormat([], { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    return { timezone, displayName: `${timezone.split("/").at(-1)?.replaceAll("_", " ")} — ${zone ?? timezone}`, source: "operating_system" };
  }
  return call<TimezoneSuggestion>("get_timezone_suggestion");
}
const browserInstitutions: InstitutionSelection[] = [
  { id: "104151", name: "Arizona State University", country: "US", source: "college_scorecard", officialDomain: "asu.edu", catalogProviderStatus: "unavailable", custom: false },
  { id: "104179", name: "University of Arizona", country: "US", source: "college_scorecard", officialDomain: "arizona.edu", catalogProviderStatus: "unavailable", custom: false },
  { id: "105330", name: "Northern Arizona University", country: "US", source: "college_scorecard", officialDomain: "nau.edu", catalogProviderStatus: "unavailable", custom: false },
  { id: "105154", name: "Phoenix College", country: "US", source: "college_scorecard", officialDomain: "phoenixcollege.edu", catalogProviderStatus: "unavailable", custom: false },
];
export async function searchInstitutions(query: string): Promise<InstitutionSelection[]> {
  if (isDesktop()) return call("search_institutions", { query });
  const needle = query.trim().toLowerCase();
  const matches = browserInstitutions.filter((item) => !needle || item.name.toLowerCase().includes(needle));
  if (needle && !matches.some((item) => item.name.toLowerCase() === needle)) matches.push({ id: `custom:${needle.replaceAll(" ", "-")}`, name: query.trim(), country: "Other", source: "custom", catalogProviderStatus: "local_fallback", custom: true });
  return structuredClone(matches.slice(0, 12));
}
export async function searchCourseSuggestions(institutionId: string, query: string): Promise<CourseSuggestion[]> {
  if (isDesktop()) return call("search_course_suggestions", { institutionId, query });
  const patterns = [["MAT 142", "College Mathematics"], ["ENG 101", "First-Year Composition"], ["ENG 102", "Research and Writing"], ["BIO 181", "General Biology I"], ["PSY 101", "Introduction to Psychology"], ["STA 201", "Introduction to Statistics"]];
  const needle = query.trim().toUpperCase();
  return patterns.filter(([code, title]) => code.includes(needle) || title.toUpperCase().includes(needle)).map(([code, title]) => ({ code, title, source: "generic", sourceLabel: "General course pattern", confidence: 0.62 }));
}
const asuSetupOptions: InstitutionSetupOptions = {
  institutionId: "104151",
  campuses: [
    { id: "tempe", name: "Tempe", city: "Tempe", timezone: "America/Phoenix", sourceLabel: "ASU Campuses and Locations", sourceUrl: "https://campus.asu.edu/" },
    { id: "downtown-phoenix", name: "Downtown Phoenix", city: "Phoenix", timezone: "America/Phoenix", sourceLabel: "ASU Campuses and Locations", sourceUrl: "https://campus.asu.edu/" },
    { id: "west-valley", name: "West Valley", city: "Phoenix", timezone: "America/Phoenix", sourceLabel: "ASU Campuses and Locations", sourceUrl: "https://campus.asu.edu/" },
    { id: "polytechnic", name: "Polytechnic", city: "Mesa", timezone: "America/Phoenix", sourceLabel: "ASU Campuses and Locations", sourceUrl: "https://campus.asu.edu/" },
    { id: "flexible", name: "Online or multiple campuses", city: "Flexible", timezone: "America/Phoenix", sourceLabel: "Student selection", sourceUrl: "" },
  ],
  terms: [
    { id: "asu-fall-2026-c", name: "Fall 2026 — Session C", startsOn: "2026-08-20", endsOn: "2026-12-12", classEndsOn: "2026-12-04", examStartsOn: "2026-12-07", details: "Classes Aug 20–Dec 4 · Finals Dec 7–12", sourceLabel: "ASU University Registrar", sourceUrl: "https://registrar.asu.edu/academic-calendar" },
    { id: "asu-spring-2027-c", name: "Spring 2027 — Session C", startsOn: "2027-01-11", endsOn: "2027-05-08", classEndsOn: "2027-04-30", examStartsOn: "2027-05-03", details: "Classes Jan 11–Apr 30 · Finals May 3–8", sourceLabel: "ASU University Registrar", sourceUrl: "https://registrar.asu.edu/academic-calendar" },
    { id: "asu-fall-2027-c", name: "Fall 2027 — Session C", startsOn: "2027-08-19", endsOn: "2027-12-11", classEndsOn: "2027-12-03", examStartsOn: "2027-12-06", details: "Classes Aug 19–Dec 3 · Finals Dec 6–11", sourceLabel: "ASU University Registrar", sourceUrl: "https://registrar.asu.edu/academic-calendar" },
  ],
};
export async function getInstitutionSetupOptions(institutionId: string): Promise<InstitutionSetupOptions> {
  if (isDesktop()) return call("get_institution_setup_options", { institutionId });
  return structuredClone(institutionId === asuSetupOptions.institutionId ? asuSetupOptions : { institutionId, campuses: [], terms: [] });
}
export async function saveOnboardingDraft(draft: OnboardingDraft) {
  if (!isDesktop()) {
    browserOnboardingState = {
      ...browserOnboardingState,
      draft: structuredClone(draft),
    };
    return structuredClone(browserOnboardingState);
  }
  return call<OnboardingState>("save_onboarding_draft", { draft });
}
export async function completeOnboarding(draft: OnboardingDraft) {
  if (!isDesktop()) {
    browserOnboardingState = {
      ...browserOnboardingState,
      required: false,
      draft: structuredClone(draft),
    };
    browserSeed.studentName = draft.name.trim();
    browserSeed.timezone = draft.timezone;
    browserWorkspace.profile = {
      name: draft.name.trim(),
      timezone: draft.timezone,
      version: 1,
    };
    browserWorkspace.institution = structuredClone(draft.institution);
    browserWorkspace.appearance = draft.appearance;
    browserWorkspace.courses = draft.courses.map((course) => ({ id: crypto.randomUUID(), title: course.title, code: course.code, termId: "term", version: 1, recordOrigin: "user", color: course.color || "#3155B7" }));
    browserWorkspace.tasks = [];
    browserWorkspace.commitments = [];
    browserWorkspace.instructors = [];
    browserWorkspace.classMeetings = [];
    browserWorkspace.academicEvents = [];
    browserSeed.blocks = [];
    browserSeed.candidates = [];
    browserSeed.conflicts = [];
    browserSeed.nextAction = undefined;
    return {
      security: { pinEnabled: false, locked: false, retryAfterSeconds: 0 },
      schemaVersion: 11,
      onboarding: structuredClone(browserOnboardingState),
      dashboard: structuredClone(browserSeed),
    };
  }
  return call<AppBootstrap>("complete_onboarding", { draft });
}
const browserWorkspace: WorkspaceSnapshot = {
  profile: {
    name: "Alex Morgan",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    version: 1,
  },
  institution: {
    id: "104151",
    name: "Arizona State University",
    country: "US",
    source: "college_scorecard",
    officialDomain: "asu.edu",
    catalogProviderStatus: "supported",
    custom: false,
  },
  appearance: "system",
  terms: [
    {
      id: "term",
      name: "Fall 2026",
      startsOn: "2026-08-01",
      endsOn: "2026-12-20",
      active: true,
      version: 1,
    },
  ],
  courses: [
    {
      id: "course",
      title: "Statistics 201",
      code: "STA 201",
      termId: "term",
      version: 1,
      recordOrigin: "demo",
      color: "#3155B7",
    },
  ],
  tasks: [
    {
      id: "read-6",
      title: "Read Chapter 6: Social Influence",
      minutes: 35,
      courseId: "course",
      priority: 3,
      academicRisk: 1,
      energyDemand: "medium",
      location: "",
      splittable: true,
      minSessionMinutes: 20,
      maxSessionMinutes: 60,
      completed: false,
      version: 1,
      dependencies: [],
      recordOrigin: "demo",
      kind: "assignment",
    },
  ],
  commitments: [],
  instructors: [],
  classMeetings: [],
  academicEvents: [],
  preferences: {
    sleepStart: "23:00",
    sleepEnd: "07:00",
    maxSessionMinutes: 60,
    breakMinutes: 10,
    transitionMinutes: 10,
    defaultCommuteMinutes: 0,
    version: 1,
  },
  availability: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    startsAtLocal: "08:00",
    endsAtLocal: "21:00",
  })),
};
export async function getLocalWorkspace() {
  return isDesktop()
    ? call<WorkspaceSnapshot>("get_local_workspace")
    : structuredClone(browserWorkspace);
}
export async function updateStudentProfile(input: StudentProfileInput) {
  if (!isDesktop()) {
    if (browserWorkspace.profile) {
      browserWorkspace.profile = {
        name: input.name.trim(),
        timezone: input.timezone,
        version: browserWorkspace.profile.version + 1,
      };
      browserSeed.studentName = input.name.trim();
      browserSeed.timezone = input.timezone;
    }
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("update_student_profile", { input });
}
export async function getCalendarAgenda(
  startDate?: string,
): Promise<CalendarAgenda> {
  if (isDesktop())
    return call<CalendarAgenda>("get_calendar_agenda", { startDate });
  return {
    timezone: browserSeed.timezone,
    startsAt: browserDayStart.toISOString(),
    endsAt: new Date(browserDayStart.getTime() + 7 * 86400000).toISOString(),
    blocks: structuredClone(browserSeed.blocks),
    overloadConflicts: structuredClone(
      browserSeed.conflicts.filter((conflict) => conflict.kind === "overload"),
    ),
  };
}
export async function setPlanBlockLock(blockId: string, locked: boolean) {
  if (!isDesktop()) {
    browserSeed.blocks = browserSeed.blocks.map((block) =>
      block.id === blockId ? { ...block, locked } : block,
    );
    return structuredClone(browserSeed);
  }
  return call<Dashboard>("set_plan_block_lock", { blockId, locked });
}
export async function createAcademicTerm(input: AcademicTermInput) {
  return call<WorkspaceSnapshot>("create_academic_term", { input });
}
export async function updateAcademicTerm(id: string, input: AcademicTermInput) {
  return call<WorkspaceSnapshot>("update_academic_term", { id, input });
}
export async function deleteAcademicTerm(id: string, expectedVersion: number) {
  return call<WorkspaceSnapshot>("delete_academic_term", {
    id,
    expectedVersion,
  });
}
export async function createCourse(input: CourseInput) {
  if (!isDesktop()) {
    browserWorkspace.courses.push({
      id: crypto.randomUUID(),
      title: input.title.trim(),
      code: input.code.trim(),
      termId: input.termId,
      version: 1,
      recordOrigin: "user",
      color: input.color || "#3155B7",
    });
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("create_course", { input });
}
export async function updateCourse(id: string, input: CourseInput) {
  if (!isDesktop()) {
    browserWorkspace.courses = browserWorkspace.courses.map((course) =>
      course.id === id
        ? {
            ...course,
            title: input.title.trim(),
            code: input.code.trim(),
            termId: input.termId,
            version: course.version + 1,
            color: input.color || course.color,
          }
        : course,
    );
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("update_course", { id, input });
}
export async function deleteCourse(id: string, expectedVersion: number) {
  if (!isDesktop()) {
    browserWorkspace.courses = browserWorkspace.courses.filter(
      (course) => course.id !== id,
    );
    browserWorkspace.tasks = browserWorkspace.tasks.map((task) =>
      task.courseId === id ? { ...task, courseId: undefined } : task,
    );
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("delete_course", { id, expectedVersion });
}
export async function createLocalTask(input: TaskInput) {
  if (!isDesktop()) {
    browserWorkspace.tasks.push({
      ...input,
      id: crypto.randomUUID(),
      completed: false,
      version: 1,
      recordOrigin: "user",
    });
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("create_local_task", { input });
}
export async function updateLocalTask(id: string, input: TaskInput) {
  if (!isDesktop()) {
    browserWorkspace.tasks = browserWorkspace.tasks.map((task) =>
      task.id === id
        ? { ...task, ...input, version: task.version + 1 }
        : task,
    );
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("update_local_task", { id, input });
}
export async function deleteLocalTask(id: string, expectedVersion: number) {
  if (!isDesktop()) {
    browserWorkspace.tasks = browserWorkspace.tasks
      .filter((task) => task.id !== id)
      .map((task) => ({
        ...task,
        dependencies: task.dependencies.filter((dependency) => dependency !== id),
      }));
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("delete_local_task", { id, expectedVersion });
}
export async function createCommitment(input: CommitmentEditorInput) {
  if (!isDesktop()) {
    browserWorkspace.commitments.push({
      ...input,
      id: crypto.randomUUID(),
      version: 1,
      recordOrigin: "user",
    });
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("create_commitment", { input });
}
export async function updateCommitment(
  id: string,
  input: CommitmentEditorInput,
) {
  if (!isDesktop()) {
    browserWorkspace.commitments = browserWorkspace.commitments.map((item) =>
      item.id === id ? { ...item, ...input, version: item.version + 1 } : item,
    );
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("update_commitment", { id, input });
}
export async function deleteCommitment(id: string, expectedVersion: number) {
  if (!isDesktop()) {
    browserWorkspace.commitments = browserWorkspace.commitments.filter(
      (item) => item.id !== id,
    );
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("delete_commitment", { id, expectedVersion });
}
export async function updatePlanningPreferences(input: PreferenceInput) {
  if (!isDesktop()) {
    browserWorkspace.preferences = {
      sleepStart: input.sleepStart,
      sleepEnd: input.sleepEnd,
      maxSessionMinutes: input.maxSessionMinutes,
      breakMinutes: input.breakMinutes,
      transitionMinutes: input.transitionMinutes,
      defaultCommuteMinutes: input.defaultCommuteMinutes,
      version: (browserWorkspace.preferences?.version ?? 0) + 1,
    };
    browserWorkspace.availability = structuredClone(input.availability);
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("update_planning_preferences", { input });
}
export async function updateAppearance(appearance: AppearancePreference) {
  if (!isDesktop()) {
    browserWorkspace.appearance = appearance;
    return structuredClone(browserWorkspace);
  }
  return call<WorkspaceSnapshot>("update_appearance", { appearance });
}
export async function listLegacyQuarantine() {
  return isDesktop() ? call<LegacyQuarantineItem[]>("list_legacy_quarantine") : [];
}
export async function restoreLegacyQuarantine(ids: string[]) {
  return call<WorkspaceSnapshot>("restore_legacy_quarantine", { ids });
}
export async function purgeLegacyQuarantine(confirmation: string) {
  return call<LegacyQuarantineStatus>("purge_legacy_quarantine", { confirmation });
}
export async function createInstructor(input: InstructorInput) { return call<WorkspaceSnapshot>("create_instructor", { input }); }
export async function updateInstructor(id: string, input: InstructorInput) { return call<WorkspaceSnapshot>("update_instructor", { id, input }); }
export async function deleteInstructor(id: string, expectedVersion: number) { return call<WorkspaceSnapshot>("delete_instructor", { id, expectedVersion }); }
export async function createClassMeeting(input: ClassMeetingSeriesInput) { return call<WorkspaceSnapshot>("create_class_meeting", { input }); }
export async function updateClassMeeting(id: string, input: ClassMeetingSeriesInput) { return call<WorkspaceSnapshot>("update_class_meeting", { id, input }); }
export async function deleteClassMeeting(id: string, expectedVersion: number) { return call<WorkspaceSnapshot>("delete_class_meeting", { id, expectedVersion }); }
export async function createAcademicEvent(input: AcademicCalendarEventInput) { return call<WorkspaceSnapshot>("create_academic_event", { input }); }
export async function updateAcademicEvent(id: string, input: AcademicCalendarEventInput) { return call<WorkspaceSnapshot>("update_academic_event", { id, input }); }
export async function deleteAcademicEvent(id: string, expectedVersion: number) { return call<WorkspaceSnapshot>("delete_academic_event", { id, expectedVersion }); }
export async function deleteLocalProfile(confirmation: string) {
  return call<AppBootstrap>("delete_local_profile", { confirmation });
}
export async function enablePin(newPin: string) {
  return call<SecurityStatus>("enable_pin", { newPin });
}
export async function changePin(currentPin: string, newPin: string) {
  return call<SecurityStatus>("change_pin", { currentPin, newPin });
}
export async function disablePin(currentPin: string) {
  return call<SecurityStatus>("disable_pin", { currentPin });
}
export async function lockApp() {
  return call<SecurityStatus>("lock_app");
}
export async function takePendingNavigation() {
  return isDesktop()
    ? call<NavigationTarget | null>("take_pending_navigation")
    : null;
}
export async function listenForNavigation(
  handler: () => void,
): Promise<() => void> {
  return isDesktop() ? listen("studentcenter:navigate", handler) : () => {};
}
export async function getUpdateStatus() {
  return isDesktop()
    ? call<UpdateStatus>("get_update_status")
    : {
        configured: false,
        currentVersion: "0.8.0",
        available: false,
        message:
          "Update checks are available only in the installed desktop application.",
      };
}
export async function checkForUpdates() {
  return call<UpdateStatus>("check_for_updates");
}
const browserAccount = (signedIn = false, email?: string): AccountStatus => ({
  configured: true,
  signedIn,
  email,
  accountId: signedIn ? "11111111-1111-4111-8111-111111111111" : undefined,
  accessReady: signedIn,
  credentialAvailable: true,
  googleSignInPending: false,
  message: signedIn
    ? "Optional encrypted backup and sync can be enabled from this account."
    : "Sign in only if you want encrypted backup, sync, or managed AI.",
});
export async function getAccountStatus(): Promise<AccountStatus> {
  if (isDesktop()) return call<AccountStatus>("get_account_status");
  const mode = new URLSearchParams(window.location.search).get("account");
  if (mode === "unsigned") return browserAccount();
  if (mode === "signed") return browserAccount(true, "alex@example.edu");
  if (mode === "pending")
    return {
      ...browserAccount(),
      googleSignInPending: true,
      message:
        "Finish Google sign-in in the system browser. Student Center will return here automatically.",
    };
  return {
    configured: false,
    signedIn: false,
    email: undefined,
    accountId: undefined,
    accessReady: false,
    credentialAvailable: true,
    googleSignInPending: false,
    message: "Accounts are available only in a configured desktop build.",
  };
}
export async function startGoogleSignIn() {
  return isDesktop()
    ? call<AccountStatus>("start_google_sign_in")
    : browserAccount(true, "alex@gmail.com");
}
export async function cancelGoogleSignIn() {
  return isDesktop()
    ? call<AccountStatus>("cancel_google_sign_in")
    : browserAccount();
}
export async function listenForAccountChanges(
  handler: () => void,
): Promise<() => void> {
  return isDesktop()
    ? listen("studentcenter:account-changed", handler)
    : () => {};
}
/** The OCR readiness probe now finishes after startup, so the card updates late. */
export async function listenForOcrStatus(
  handler: (status: OcrStatus) => void,
): Promise<() => void> {
  return isDesktop()
    ? listen<OcrStatus>("studentcenter:ocr-status", (event) =>
        handler(event.payload),
      )
    : () => {};
}
export async function requestEmailCode(email: string) {
  return isDesktop()
    ? call<EmailCodeStatus>("request_email_code", { email })
    : {
        email: email.trim(),
        retryAfterSeconds: 60,
        message: "Browser test code sent.",
      };
}
export async function verifyEmailCode(email: string, code: string) {
  if (!isDesktop() && code.length === 6)
    return browserAccount(true, email.trim());
  return call<AccountStatus>("verify_email_code", { email, code });
}
export async function refreshAccountSession() {
  return isDesktop()
    ? call<AccountStatus>("refresh_account_session")
    : browserAccount(true, "alex@example.edu");
}
export async function signOutAccount() {
  return isDesktop()
    ? call<AccountStatus>("sign_out_account")
    : browserAccount();
}
export async function getSyncProtectionStatus(): Promise<SyncProtectionStatus> {
  return isDesktop()
    ? call<SyncProtectionStatus>("get_sync_protection_status")
    : {
        protected: false,
        accountId: "11111111-1111-4111-8111-111111111111",
        message:
          "Create or enter a 24-word recovery code before encrypted sync can start.",
      };
}
export async function beginSyncProtection(): Promise<RecoverySetup> {
  return isDesktop()
    ? call<RecoverySetup>("begin_sync_protection")
    : {
        words: Array.from({ length: 24 }, (_, index) => `recovery${index + 1}`),
        confirmationPositions: [4, 11, 19],
        deviceId: "22222222-2222-4222-8222-222222222222",
        publicKey: "P".repeat(43),
      };
}
export async function confirmSyncProtection(
  confirmations: RecoveryConfirmation[],
): Promise<SyncProtectionStatus> {
  return isDesktop()
    ? call<SyncProtectionStatus>("confirm_sync_protection", { confirmations })
    : {
        protected: confirmations.length === 3,
        accountId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        publicKey: "P".repeat(43),
        message:
          "Recovery is protected on this device. Encrypted sync can be connected next.",
      };
}
export async function recoverSyncProtection(
  recoveryPhrase: string,
): Promise<SyncProtectionStatus> {
  return isDesktop()
    ? call<SyncProtectionStatus>("recover_sync_protection", { recoveryPhrase })
    : {
        protected: recoveryPhrase.trim().split(/\s+/).length === 24,
        accountId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        publicKey: "P".repeat(43),
        message:
          "Recovery is protected on this device. Encrypted sync can be connected next.",
      };
}
export async function requestExistingDeviceApproval(): Promise<ExistingDeviceSetup> {
  return isDesktop()
    ? call<ExistingDeviceSetup>("request_existing_device_approval")
    : {
        deviceId: "33333333-3333-4333-8333-333333333333",
        publicKey: "Q".repeat(43),
        signingPublicKey: "S".repeat(43),
      };
}
export async function checkExistingDeviceApproval(): Promise<SyncProtectionStatus> {
  return isDesktop()
    ? call<SyncProtectionStatus>("check_existing_device_approval")
    : {
        protected: true,
        accountId: "11111111-1111-4111-8111-111111111111",
        deviceId: "33333333-3333-4333-8333-333333333333",
        publicKey: "Q".repeat(43),
        message: "This device was approved and its account key is protected locally.",
      };
}
export async function cancelSyncProtection() {
  if (isDesktop()) await call<void>("cancel_sync_protection");
}
const browserSyncStatus = (connected = false): EncryptedSyncStatus => ({
  configured: true,
  protected: true,
  connected,
  accountId: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
  pendingMutations: connected ? 3 : 4,
  pendingDownloadedMutations: 0,
  lastPushedAt: connected ? new Date().toISOString() : undefined,
  message: connected
    ? "This device is registered. Pending changes can be encrypted and synchronized."
    : "Recovery is protected. Register this device to connect encrypted sync.",
});
export async function getEncryptedSyncStatus(): Promise<EncryptedSyncStatus> {
  return isDesktop()
    ? call<EncryptedSyncStatus>("get_encrypted_sync_status")
    : browserSyncStatus(false);
}
export async function connectEncryptedSync(): Promise<EncryptedSyncStatus> {
  return isDesktop()
    ? call<EncryptedSyncStatus>("connect_encrypted_sync")
    : browserSyncStatus(true);
}
export async function pushEncryptedMutations(): Promise<EncryptedSyncStatus> {
  return isDesktop()
    ? call<EncryptedSyncStatus>("push_encrypted_mutations")
    : {
        ...browserSyncStatus(true),
        pendingMutations: 0,
        lastPushedAt: new Date().toISOString(),
      };
}
export async function pullEncryptedMutations(): Promise<EncryptedSyncStatus> {
  return isDesktop()
    ? call<EncryptedSyncStatus>("pull_encrypted_mutations")
    : {
        ...browserSyncStatus(true),
        pendingMutations: 0,
        pendingDownloadedMutations: 0,
        lastPushedAt: new Date().toISOString(),
      };
}
export async function listPendingSyncDevices(): Promise<PendingSyncDevice[]> {
  return isDesktop()
    ? call<PendingSyncDevice[]>("list_pending_sync_devices")
    : [
        {
          deviceId: "33333333-3333-4333-8333-333333333333",
          publicKey: "Q".repeat(43),
          signingPublicKey: "S".repeat(43),
          displayName: "New Student Center computer",
          platform: "windows-x64",
        },
      ];
}
export async function listAuthorizedSyncDevices(): Promise<PendingSyncDevice[]> {
  return isDesktop()
    ? call<PendingSyncDevice[]>("list_authorized_sync_devices")
    : [
        {
          deviceId: "22222222-2222-4222-8222-222222222222",
          publicKey: "P".repeat(43),
          signingPublicKey: "S".repeat(43),
          displayName: "This Student Center computer",
          platform: "windows-x64",
        },
        {
          deviceId: "44444444-4444-4444-8444-444444444444",
          publicKey: "Q".repeat(43),
          signingPublicKey: "T".repeat(43),
          displayName: "Library laptop",
          platform: "macos-arm64",
        },
      ];
}
export async function approveSyncDevice(
  targetDeviceId: string,
): Promise<PendingSyncDevice[]> {
  return isDesktop()
    ? call<PendingSyncDevice[]>("approve_sync_device", { targetDeviceId })
    : [];
}
export async function revokeSyncDevice(
  targetDeviceId: string,
): Promise<EncryptedSyncStatus> {
  return isDesktop()
    ? call<EncryptedSyncStatus>("revoke_sync_device", { targetDeviceId })
    : { ...browserSyncStatus(false), deviceId: targetDeviceId };
}
export async function uploadSyncedDocument(documentId: string) {
  return isDesktop()
    ? call<boolean>("upload_synced_document", { documentId })
    : Boolean(documentId);
}
export async function downloadSyncedDocument(documentId: string) {
  return isDesktop()
    ? call<boolean>("download_synced_document", { documentId })
    : Boolean(documentId);
}
export async function addTask(title: string, minutes: number, dueAt?: string) {
  if (!isDesktop()) {
    const id = crypto.randomUUID();
    const startsAt = browserAt(19);
    const endsAt = new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString();
    browserSeed.blocks.push({id,taskId:id,startsAt,endsAt,title,kind:"study",completed:false,locked:false,sessionIndex:0,location:"",reasonCodes:[dueAt?"deadline_soon":"feasible_window"]});
    return structuredClone(browserSeed);
  }
  return call<Dashboard>("add_task", { title, minutes, dueAt });
}
export async function toggleTask(id: string) {
  if (!isDesktop()) {
    browserSeed.blocks = browserSeed.blocks.map((block) =>
      block.taskId === id ? { ...block, completed: !block.completed } : block,
    );
    return structuredClone(browserSeed);
  }
  return call<Dashboard>("toggle_task", { id });
}
export async function replan(effectiveTime: string, reason: string) {
  if (!isDesktop()) {
    browserSeed.blocks = browserSeed.blocks.map((block) =>
      block.taskId && !block.completed && !block.locked
        ? { ...block, reasonCodes: [...block.reasonCodes.filter((code) => code !== "low_energy_adjustment"), ...(reason.toLowerCase().includes("energy") ? ["low_energy_adjustment"] : [])] }
        : block,
    );
    return structuredClone(browserSeed);
  }
  return call<Dashboard>("replan", { effectiveTime, reason });
}
export async function updateNotificationSettings(
  enabled: boolean,
  leadMinutes: number,
  quietStart: string,
  quietEnd: string,
  showTitles: boolean,
) {
  return call<Dashboard>("update_notification_settings", {
    enabled,
    leadMinutes,
    quietStart,
    quietEnd,
    showTitles,
  });
}
export async function startPlanBlock(blockId: string) {
  if (!isDesktop()) {
    browserSeed.blocks = browserSeed.blocks.map((block) =>
      block.id === blockId ? { ...block, startedAt: new Date().toISOString() } : block,
    );
    return structuredClone(browserSeed);
  }
  return call<Dashboard>("start_plan_block", { blockId });
}
export async function snoozeReminder(blockId: string, minutes = 10) {
  return call<Dashboard>("snooze_reminder", { blockId, minutes });
}
export async function dismissReminder(blockId: string) {
  return call<Dashboard>("dismiss_reminder", { blockId });
}
export async function approveCandidates(ids: string[]) {
  return call<Dashboard>("approve_candidates", { ids });
}
export async function rejectCandidates(ids: string[]) {
  return call<Dashboard>("reject_candidates", { ids });
}
export async function resolveSourceConflict(
  conflictId: string,
  resolution: "keep_existing" | "use_source",
) {
  return call<Dashboard>("resolve_source_conflict", { conflictId, resolution });
}
export async function connectCanvas(baseUrl: string, token: string) {
  return call<Dashboard>("connect_canvas", { baseUrl, token });
}
export async function syncCanvas(connectionId: string) {
  return call<Dashboard>("sync_canvas", { connectionId });
}
export async function disconnectCanvas(connectionId: string) {
  return call<Dashboard>("disconnect_canvas", { connectionId });
}
export async function exportEncryptedBackup(
  passphrase: string,
): Promise<BackupPreview | null> {
  if (!isDesktop()) return null;
  const destination = await save({
    defaultPath: `student-center-${new Date().toISOString().slice(0, 10)}.studentcenter`,
    filters: [
      {
        name: "Student Center encrypted backup",
        extensions: ["studentcenter"],
      },
    ],
  });
  if (!destination) return null;
  const normalized = destination.toLowerCase().endsWith(".studentcenter")
    ? destination
    : `${destination}.studentcenter`;
  return call<BackupPreview>("export_backup", {
    destination: normalized,
    passphrase,
  });
}
export async function selectBackupFile(): Promise<string | null> {
  if (!isDesktop()) return null;
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Student Center encrypted backup",
        extensions: ["studentcenter"],
      },
    ],
  });
  return selected ? String(selected) : null;
}
export async function previewEncryptedBackup(path: string, passphrase: string) {
  return call<BackupPreview>("preview_backup", { path, passphrase });
}
export async function restoreEncryptedBackup(
  path: string,
  passphrase: string,
  expectedFingerprint: string,
  confirmed: boolean,
) {
  return call<Dashboard>("restore_backup", {
    path,
    passphrase,
    expectedFingerprint,
    confirmed,
  });
}
export async function selectAndImport(): Promise<Dashboard | null> {
  if (!isDesktop()) return null;
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Academic documents",
        extensions: [
          "pdf",
          "ics",
          "png",
          "jpg",
          "jpeg",
          "docx",
          "xlsx",
          "csv",
          "pptx",
          "txt",
        ],
      },
    ],
  });
  if (!selected) return null;
  return importDocumentPath(String(selected));
}
export async function importDocumentPath(path: string) {
  return call<Dashboard>("import_document", { path });
}
export async function listDocuments(query = "") {
  if (!isDesktop()) {
    const documents: DocumentSummary[] = [
      {
        id: "00000000-0000-4000-8000-000000000101",
        fileName: "course-syllabus.pdf",
        mime: "application/pdf",
        importedAt: new Date().toISOString(),
        extractionStatus: "complete",
        candidateCount: 2,
        pendingCount: 1,
        approvedCount: 1,
      },
    ];
    const needle = query.trim().toLowerCase();
    return documents.filter((item) =>
      item.fileName.toLowerCase().includes(needle),
    );
  }
  return call<DocumentSummary[]>("list_documents", { query });
}
export async function getDocumentEvidence(documentId: string) {
  return isDesktop()
    ? call<ImportCandidate[]>("get_document_evidence", { documentId })
    : structuredClone(browserSeed.candidates);
}
export async function listenForFileDrops(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop" && event.payload.paths.length)
      handler(event.payload.paths);
  });
}
export async function requestManagedAi(
  capability: ManagedAiCapability,
  excerpt: string,
  consent: boolean,
  locale = navigator.language || "en-US",
) {
  if (!isDesktop()) {
    const dashboard = structuredClone(browserSeed);
    const result: ManagedAiResult = {
      dashboard,
      candidatesCreated: capability === "explanation" ? 0 : 1,
      explanation:
        capability === "explanation"
          ? "This action is recommended because it fits the current available window."
          : undefined,
      model: "browser-test-model",
    };
    return result;
  }
  return call<ManagedAiResult>("request_managed_ai", {
    input: { capability, excerpt, locale, consent },
  });
}
