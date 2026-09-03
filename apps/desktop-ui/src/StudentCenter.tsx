import { TaskDetailsSession } from "./features/tasks/TaskDetailsSession";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bell,
  BookOpen,
  Brain,
  Check,
  TriangleAlert,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileLock2,
  FileUp,
  HardDrive,
  LayoutGrid,
  Link2,
  Loader,
  LockKeyhole,
  LogOut,
  Mail,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Unplug,
  Upload,
  UserRound,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import {
  DesktopNavigation,
  MobileNavigation,
  StudentDestination,
} from "./components/AppNavigation";
import { AppLogo } from "./components/AppLogo";
import { applyInterfacePreferences, initialInterfacePreferences, loadInterfacePreferences, saveInterfacePreferences, type InterfacePreferences } from "./features/shell/interfacePreferences";
import { ScheduleImportReview } from "./components/ScheduleImportReview";
import { SchedulePhotoEditor } from "./components/SchedulePhotoEditor";
import { OnboardingExperience } from "./components/OnboardingExperience";
import { isSetupChecklistDismissed, rememberDismissal } from "./components/SetupChecklist";
import type { SettingsSection } from "./components/SettingsView";
import { TodayView } from "./components/TodayView";
import { Modal } from "./components/Modal";
import { BackupSummary, LockScreen } from "./components/SecurityPrimitives";
import {
  applyAppearance,
  AccentPreference,
  AppearancePreference,
  initialAccent,
  initialAppearance,
  watchSystemAppearance,
} from "./components/ThemeControls";
import {
  AccountStatus,
  approveCandidates,
  BackupPreview,
  cancelGoogleSignIn,
  changePin,
  connectCanvas,
  connectCanvasCalendar,
  CalendarDiff,
  Dashboard,
  TermChange,
  deleteLocalProfile,
  DocumentSummary,
  disablePin,
  dismissReminder,
  disconnectCanvas,
  disconnectCanvasCalendar,
  enablePin,
  exportEncryptedBackup,
  getAccountStatus,
  getDocumentEvidence,
  getLocalWorkspace,
  initialize,
  isDesktop,
  importDocumentBytes,
  importDocumentPath,
  listenForAccountChanges,
  listenForOcrStatus,
  OcrStatus,
  applyCalendarDiff,
  listenForFileDrops,
  pastedScheduleImage,
  refreshSchoolCalendar,
  readScheduleWithAi,
  listenForNavigation,
  lockApp,
  listDocuments,
  listAiProviders,
  launchScheduleCapture,
  NavigationTarget,
  OnboardingState,
  previewEncryptedBackup,
  refreshAccountSession,
  rejectCandidates,
  replan,
  requestEmailCode,
  requestManagedAi,
  resolveSourceConflict,
  restoreEncryptedBackup,
  SecurityStatus,
  selectAndImport,
  selectBackupFile,
  signOutAccount,
  snoozeReminder,
  startGoogleSignIn,
  startPlanBlock,
  syncCanvas,
  refreshCanvasCalendar,
  setCanvasCalendarRefresh,
  saveAiProviderKey,
  testAiProvider,
  removeAiProvider,
  setAiProviderOrder,
  getAiUsage,
  settleScheduleSource,
  takePendingNavigation,
  toggleTask,
  unlockWithPin,
  updateAccent,
  updateNotificationSettings,
  verifyEmailCode,
  WorkspaceSnapshot,
  LegacyQuarantineItem,
  listLegacyQuarantine,
  restoreLegacyQuarantine,
  purgeLegacyQuarantine,
  AiProviderId,
  AiProviderStatus,
  AiUsageSummary,
} from "./native";

const ModularStudyView = lazy(() =>
  import("./components/StudyView").then((module) => ({
    default: module.StudyView,
  })),
);
const AcademicSettingsView = lazy(() =>
  import("./components/AcademicSettingsView").then((module) => ({
    default: module.AcademicSettingsView,
  })),
);
const CalendarView = lazy(() =>
  import("./components/CalendarView").then((module) => ({
    default: module.CalendarView,
  })),
);
const CoursesView = lazy(() =>
  import("./components/CoursesView").then((module) => ({
    default: module.CoursesView,
  })),
);
const WorkView = lazy(() =>
  import("./components/WorkView").then((module) => ({
    default: module.WorkView,
  })),
);
const ScholarshipsView = lazy(() =>
  import("./components/ScholarshipsView").then((module) => ({
    default: module.ScholarshipsView,
  })),
);
const AccountModal = lazy(() =>
  import("./components/AccountModal").then((module) => ({
    default: module.AccountModal,
  })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);
const UpdateModal = lazy(() =>
  import("./components/UpdateModal").then((module) => ({
    default: module.UpdateModal,
  })),
);
const WorkspaceSearchModal = lazy(() =>
  import("./components/WorkspaceSearchModal").then((module) => ({
    default: module.WorkspaceSearchModal,
  })),
);
const QuickAddTaskModal = lazy(() =>
  import("./components/QuickAddTaskModal").then((module) => ({
    default: module.QuickAddTaskModal,
  })),
);

type Modal =
  | "search"
  | "import"
  | "review"
  | "retention"
  | "conflicts"
  | "replan"
  | "task"
  | "assistant"
  | "calendar-refresh"
  | "delete-profile"
  | null;
const formatTime = (iso: string) =>
  new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
const formatDateTime = (iso?: string) =>
  iso
    ? new Intl.DateTimeFormat([], {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso))
    : "Not set";
const minutesBetween = (from: string, to: string) =>
  Math.max(
    0,
    Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000),
  );
type BootPhase = "loading" | "ready" | "error";
const BOOT_WATCHDOG_MS = 15000;
const BOOT_RECOVERY_DELAY_MS = 1200;
const BOOT_MAX_ATTEMPTS = 3;

export function StudentCenter() {
  const [view, setView] = useState<
    StudentDestination | "academic-settings" | "settings"
  >("today");
  const [appearance, setAppearance] =
    useState<AppearancePreference>(initialAppearance);
  const [accent, setAccent] = useState<AccentPreference>(initialAccent);
  useEffect(() => applyAppearance(appearance, accent), [appearance, accent]);
  const [interfacePreferences, setInterfacePreferences] = useState(initialInterfacePreferences);
  const [interfaceBusy, setInterfaceBusy] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => import.meta.env.DEV && !isDesktop() && new URLSearchParams(location.search).get("reference") === "compact" ? "reference-task-0" : null);
  const [workFilter, setWorkFilter] = useState<"all" | "high" | "completed">("all");
  const interfaceMode = interfacePreferences.mode;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  // A "system" preference has to keep following the OS while the app is open.
  useEffect(() => watchSystemAppearance(() => appearanceRef.current), []);
  const [data, setData] = useState<Dashboard | null>(null);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [taskDetailsSession, setTaskDetailsSession] = useState(0);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || modal || security?.locked || !data) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setModal("search"); return; }
      const destinations: StudentDestination[] = ["today", "calendar", "work", "courses", "study", "scholarships"];
      const destination = destinations[Number(event.key) - 1];
      if (destination) { event.preventDefault(); setView(destination); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modal, security?.locked, Boolean(data)]);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(null);
  const showSettingsSection = (section: SettingsSection) => {
    setView("settings");
    setModal(null);
    setSettingsSection(section);
  };
  const closeSettingsSection = () => setSettingsSection(null);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const importPasteTarget = useRef<HTMLButtonElement>(null);
  const [replanReason, setReplanReason] = useState("I woke up late");
  const [canvasUrl, setCanvasUrl] = useState("");
  const [canvasToken, setCanvasToken] = useState("");
  const [canvasMode, setCanvasMode] = useState<"calendar" | "full">("calendar");
  const [canvasRefreshOnStartup, setCanvasRefreshOnStartup] = useState(true);
  const [aiProviders, setAiProviders] = useState<AiProviderStatus[]>([]);
  const [aiUsage, setAiUsage] = useState<AiUsageSummary[]>([]);
  const [aiProvider, setAiProvider] = useState<AiProviderId>("openai");
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiAgeConfirmed, setAiAgeConfirmed] = useState(false);
  const [retentionDocumentIds, setRetentionDocumentIds] = useState<string[]>(
    [],
  );
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [backupView, setBackupView] = useState<"home" | "export" | "restore">(
    "home",
  );
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupConfirmation, setBackupConfirmation] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(
    null,
  );
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false);
  const [pinMode, setPinMode] = useState<
    "home" | "enable" | "change" | "disable"
  >("home");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinConfirmation, setPinConfirmation] = useState("");
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationLead, setNotificationLead] = useState(10);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("07:00");
  const [showNotificationTitles, setShowNotificationTitles] = useState(false);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(
    null,
  );
  const [accountMode, setAccountMode] = useState<"email" | "verify">("email");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [codeRetryAfter, setCodeRetryAfter] = useState(0);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [documentSearch, setDocumentSearch] = useState("");
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [vaultEvidence, setVaultEvidence] = useState<{
    documentId: string;
    items: Dashboard["candidates"];
  } | null>(null);
  const [assistantCapability, setAssistantCapability] = useState<
    | "brain_dump"
    | "document_extraction"
    | "task_decomposition"
    | "planner_explanation"
  >("brain_dump");
  const [assistantExcerpt, setAssistantExcerpt] = useState("");
  const [assistantConsent, setAssistantConsent] = useState(false);
  const [assistantExplanation, setAssistantExplanation] = useState("");
  const [legacyItems, setLegacyItems] = useState<LegacyQuarantineItem[]>([]);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [ocrStatus, setOcrStatus] = useState<OcrStatus | null>(null);
  const [todayWorkspace, setTodayWorkspace] =
    useState<WorkspaceSnapshot | null>(null);
  const [checklistDismissed, setChecklistDismissed] = useState(
    isSetupChecklistDismissed,
  );
  const [bootPhase, setBootPhase] = useState<BootPhase>("loading");
  const [bootError, setBootError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);
  const changeInterface = async (next: InterfacePreferences) => {
    if (interfaceBusy) return;
    setInterfaceBusy(true);
    try {
      const saved = await saveInterfacePreferences(next);
      setInterfacePreferences(saved);
      applyInterfacePreferences(saved);
      const theme = saved.themes[saved.mode];
      setAppearance(theme);
      applyAppearance(theme, accent);
    } catch (error) { setError(String(error)); }
    finally { setInterfaceBusy(false); }
  };
  useEffect(() => {
    if (!data) return;
    let active = true;
    void getLocalWorkspace().then(workspace => {
      if (!active) return;
      setTodayWorkspace(workspace);
      setAccent(workspace.accent);
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [data]);
  useEffect(() => {
    if (!data) return;
    let active = true;
    setInterfaceBusy(true);
    void loadInterfacePreferences().then(async value => {
      if (!active) return;
      await saveInterfacePreferences(value);
      if (!active) return;
      setInterfacePreferences(value);
      applyInterfacePreferences(value);
      setAppearance(value.themes[value.mode]);
      applyAppearance(value.themes[value.mode]);
    }).catch(error => { if (active) setError(String(error)); })
      .finally(() => { if (active) setInterfaceBusy(false); });
    return () => { active = false; };
  }, [Boolean(data)]);
  const retryBoot = useCallback(
    () => setBootAttempt((attempt) => attempt + 1),
    [],
  );
  useEffect(() => {
    const main = document.querySelector<HTMLElement>(".main");
    if (!main) return;
    if (typeof main.scrollTo === "function") main.scrollTo({ top: 0 });
    else main.scrollTop = 0;
  }, [view]);

  useEffect(() => {
    let active = true;
    setBootPhase("loading");
    setBootError("");
    // The watchdog only makes the screen interactive while we wait. It never
    // cancels the in-flight call, so a slow start that resolves late still heals.
    const watchdog = window.setTimeout(() => {
      if (!active) return;
      setBootError("Startup is taking longer than expected.");
      setBootPhase("error");
    }, BOOT_WATCHDOG_MS);
    initialize()
      .then((result) => {
        if (!active) return;
        window.clearTimeout(watchdog);
        setSecurity(result.security);
        setOnboarding(result.onboarding);
        setData(result.dashboard);
        setBootPhase("ready");
      })
      .catch((e) => {
        if (!active) return;
        window.clearTimeout(watchdog);
        setError(String(e));
        setBootError(String(e));
        setBootPhase("error");
      });
    return () => {
      active = false;
      window.clearTimeout(watchdog);
    };
  }, [bootAttempt]);

  // Backstop: the workspace unlocked and finished onboarding, but no dashboard
  // arrived. Without this the app parks on "Loading your plan…" permanently.
  useEffect(() => {
    if (!security || security.locked) return;
    if (!onboarding || onboarding.required) return;
    if (data || bootPhase !== "ready") return;
    if (bootAttempt >= BOOT_MAX_ATTEMPTS) {
      setBootError("Your plan did not load.");
      setBootPhase("error");
      return;
    }
    const timer = window.setTimeout(retryBoot, BOOT_RECOVERY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [data, security, onboarding, bootPhase, bootAttempt, retryBoot]);

  // The readiness probe finishes after startup now, so listen unconditionally —
  // it can land before the first dashboard does.
  useEffect(() => {
    let active = true;
    let stop = () => {};
    listenForOcrStatus((status) => {
      if (active) setOcrStatus(status);
    })
      .then((dispose) => {
        if (active) stop = dispose;
        else dispose();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      stop();
    };
  }, []);

  useEffect(() => {
    if (!security?.locked || security.retryAfterSeconds <= 0) return;
    const timer = setTimeout(
      () =>
        setSecurity((current) =>
          current
            ? {
                ...current,
                retryAfterSeconds: Math.max(0, current.retryAfterSeconds - 1),
              }
            : current,
        ),
      1000,
    );
    return () => clearTimeout(timer);
  }, [security?.locked, security?.retryAfterSeconds]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (modal !== "import") return;
    const timer = setTimeout(() => {
      listDocuments(documentSearch)
        .then(setDocuments)
        .catch((e) => setError(String(e)));
    }, 150);
    return () => clearTimeout(timer);
  }, [modal, documentSearch, data?.candidates.length]);
  // What the registrar currently publishes, once the student has asked. Held
  // rather than applied: a term date is a critical academic date and a page
  // that changed under us is not authority to move anyone's finals.
  const [calendarDiff, setCalendarDiff] = useState<CalendarDiff | null>(null);
  const [declinedChanges, setDeclinedChanges] = useState<string[]>([]);
  const changeKey = (change: TermChange) =>
    `${change.termName}:${change.field}`;
  // The school on this profile. Empty for a custom or unset school, in which
  // case there is no published calendar to read and the control says so.
  const institutionId = onboarding?.draft.institution.custom
    ? ""
    : (onboarding?.draft.institution.id ?? "");
  /**
   * Paste a screenshot straight into the vault.
   *
   * Ctrl/Cmd+V with an image on the clipboard is the interaction this whole
   * feature exists for, so it is bound at the document rather than inside one
   * panel. The image comes off the DOM paste event, which needs no clipboard
   * permission: the app reads what the student handed it, not the clipboard
   * whenever it likes.
   */
  useEffect(() => {
    // Onboarding renders instead of the workspace, so setToast/setError/setModal
    // would write to state nobody displays. Onboarding runs its own handler.
    if (!isDesktop() || onboarding?.required) return;
    const onPaste = (event: ClipboardEvent) => {
      const image = pastedScheduleImage(event);
      if (!image) return;
      event.preventDefault();
      void (async () => {
        setBusy(true);
        setError("");
        try {
          const bytes = new Uint8Array(await image.arrayBuffer());
          const next = await importDocumentBytes(
            image.name || "pasted-image.png",
            bytes,
          );
          setData(next);
          setToast(
            next.importNotice ??
              "Screenshot encrypted and read. Review every class before it is added.",
          );
          setModal("review");
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      })();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [onboarding?.required]);
  useEffect(() => {
    // Subscribed across the whole workspace rather than only while the import
    // modal is open, so a schedule can be dropped anywhere in it. Onboarding is
    // excluded for the same reason as paste: nothing here is rendered there.
    if (!isDesktop() || onboarding?.required) return;
    let disposed = false;
    let unlisten = () => {};
    listenForFileDrops(async (paths) => {
      if (disposed || !paths.length) return;
      setBusy(true);
      setError("");
      try {
        let next: Dashboard | null = null;
        for (const path of paths.slice(0, 20))
          next = await importDocumentPath(path);
        if (next) setData(next);
        setToast(
          next?.importNotice ??
            `${Math.min(paths.length, 20)} files encrypted and extracted.`,
        );
        setModal("review");
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [onboarding?.required]);
  const pending = data?.candidates.filter((c) => c.status === "pending") ?? [];
  const conflictCandidateIds = useMemo(
    () =>
      new Set(
        data?.conflicts.flatMap((conflict) =>
          conflict.candidateId ? [conflict.candidateId] : [],
        ) ?? [],
      ),
    [data?.conflicts],
  );
  const activeImportTerm = todayWorkspace?.terms.find((term) => term.active);
  const reviewablePending = pending.filter((candidate) => {
    if (conflictCandidateIds.has(candidate.id) || !candidate.title.trim())
      return false;
    if (candidate.kind !== "class_meeting") return true;
    const term =
      todayWorkspace?.terms.find((item) => item.id === candidate.termId) ??
      activeImportTerm;
    return Boolean(
      candidate.course.trim() &&
      candidate.weekdays?.length &&
      candidate.startsAtLocal &&
      candidate.endsAtLocal &&
      term,
    );
  });
  useEffect(() => {
    if (modal === "review")
      setSelectedCandidates(reviewablePending.map((candidate) => candidate.id));
  }, [
    modal,
    data?.candidates.length,
    data?.conflicts.length,
    todayWorkspace?.terms.map((term) => `${term.id}:${term.active}`).join("|"),
  ]);
  useEffect(() => {
    if (modal !== "review") return;
    getLocalWorkspace()
      .then(setTodayWorkspace)
      .catch((next) => setError(String(next)));
  }, [modal]);
  useEffect(() => {
    if (
      modal !== "review" ||
      pending.length ||
      !data?.unsettledScheduleSources.length
    )
      return;
    setRetentionDocumentIds(data.unsettledScheduleSources);
    setModal("retention");
  }, [modal, pending.length, data?.unsettledScheduleSources.join("|")]);
  const reminderBlocks = useMemo(
    () =>
      data?.blocks
        .filter((block) => block.taskId && !block.completed)
        .slice(0, 4) ?? [],
    [data],
  );
  const run = async (
    action: () => Promise<Dashboard | null>,
    success: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      if (next) setData(next);
      setToast(next?.importNotice ?? success);
      return next;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const resetBackupFields = () => {
    setBackupPassphrase("");
    setBackupConfirmation("");
    setBackupPath("");
    setBackupPreview(null);
    setRestoreAcknowledged(false);
  };
  const switchBackupView = (view: "home" | "export" | "restore") => {
    resetBackupFields();
    setBackupView(view);
  };
  const openBackups = () => {
    switchBackupView("home");
    setError("");
    showSettingsSection("backups");
  };
  const openAiSettings = async () => {
    showSettingsSection("ai");
    setAiKey("");
    setAiAgeConfirmed(false);
    setError("");
    setBusy(true);
    try {
      const [providers, usage] = await Promise.all([
        listAiProviders(),
        getAiUsage(),
      ]);
      setAiProviders(providers);
      setAiUsage(usage);
      const selected = providers.find((item) => item.provider === aiProvider);
      setAiModel(selected?.model ?? "");
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };
  const openDataRecovery = async () => {
    showSettingsSection("recovery");
    setPurgeConfirmation("");
    setError("");
    try {
      setLegacyItems(await listLegacyQuarantine());
    } catch (next) {
      setError(String(next));
    }
  };
  const closeBackups = () => {
    resetBackupFields();
    setBackupView("home");
    closeSettingsSection();
  };
  const createBackup = async () => {
    setBusy(true);
    setError("");
    try {
      const preview = await exportEncryptedBackup(backupPassphrase);
      if (preview) {
        setBackupPreview(preview);
        setBackupPassphrase("");
        setBackupConfirmation("");
        setToast("Encrypted backup created and verified.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const chooseRestore = async () => {
    setError("");
    const path = await selectBackupFile();
    if (path) {
      setBackupPath(path);
      setBackupPreview(null);
      setRestoreAcknowledged(false);
    }
  };
  const inspectBackup = async () => {
    setBusy(true);
    setError("");
    try {
      setBackupPreview(
        await previewEncryptedBackup(backupPath, backupPassphrase),
      );
      setRestoreAcknowledged(false);
    } catch (e) {
      setBackupPreview(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const restoreBackup = async () => {
    if (!backupPreview) return;
    setBusy(true);
    setError("");
    try {
      const next = await restoreEncryptedBackup(
        backupPath,
        backupPassphrase,
        backupPreview.fingerprint,
        restoreAcknowledged,
      );
      setData(next);
      setToast(next.importNotice ?? "Encrypted profile restored.");
      setSelectedTaskId(null);
      setTaskDetailsSession((value) => value + 1);
      setBackupPassphrase("");
      closeSettingsSection();
      void loadInterfacePreferences().then(restored => {
        setInterfacePreferences(restored);
        applyInterfacePreferences(restored);
        setAppearance(restored.themes[restored.mode]);
      }).catch(() => setError("Backup restored. Restart Coqui to reload its appearance preferences."));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const resetPinFields = () => {
    setCurrentPin("");
    setNewPin("");
    setPinConfirmation("");
  };
  const openSecurity = () => {
    resetPinFields();
    setPinMode(security?.pinEnabled ? "home" : "enable");
    setError("");
    showSettingsSection("security");
  };
  const closeSecurity = () => {
    resetPinFields();
    setPinMode("home");
    closeSettingsSection();
  };
  const savePin = async () => {
    setBusy(true);
    setError("");
    try {
      let next: SecurityStatus;
      if (pinMode === "enable") next = await enablePin(newPin);
      else if (pinMode === "change") next = await changePin(currentPin, newPin);
      else next = await disablePin(currentPin);
      setSecurity(next);
      setToast(
        pinMode === "disable"
          ? "App PIN disabled."
          : pinMode === "change"
            ? "App PIN changed."
            : "App PIN enabled.",
      );
      closeSecurity();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const lockWorkspace = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await lockApp();
      resetPinFields();
      setData(null);
      setOnboarding(null);
      setSecurity(next);
      setModal(null);
      setSettingsSection(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const unlockWorkspace = async (pinValue: string) => {
    try {
      const next = await unlockWithPin(pinValue);
      setData(next.dashboard);
      setOnboarding(next.onboarding);
      setSecurity(next.security);
      setError("");
    } catch (e) {
      try {
        const refreshed = await initialize();
        setSecurity(refreshed.security);
      } catch {}
      throw e;
    }
  };
  const openNotifications = () => {
    if (!data) return;
    const settings = data.notificationSettings;
    setNotificationsEnabled(settings.enabled);
    setNotificationLead(settings.leadMinutes);
    setQuietStart(settings.quietStart);
    setQuietEnd(settings.quietEnd);
    setShowNotificationTitles(settings.showTitles);
    setError("");
    showSettingsSection("notifications");
  };
  const saveNotifications = () =>
    run(
      () =>
        updateNotificationSettings(
          notificationsEnabled,
          notificationLead,
          quietStart,
          quietEnd,
          showNotificationTitles,
        ),
      notificationsEnabled
        ? "Private desktop reminders enabled."
        : "Desktop reminders disabled.",
    ).then(closeSettingsSection);
  const openAccount = async () => {
    setError("");
    setAccountCode("");
    setAccountMode("email");
    showSettingsSection("account");
    setBusy(true);
    try {
      const status = await getAccountStatus();
      setAccountStatus(status);
      if (status.email) setAccountEmail(status.email);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const sendAccountCode = async () => {
    setBusy(true);
    setError("");
    try {
      const sent = await requestEmailCode(accountEmail);
      setAccountEmail(sent.email);
      setCodeRetryAfter(sent.retryAfterSeconds);
      setAccountMode("verify");
      setToast("A private sign-in code was sent to your email.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const confirmAccountCode = async () => {
    setBusy(true);
    setError("");
    try {
      const status = await verifyEmailCode(accountEmail, accountCode);
      setAccountStatus(status);
      setAccountCode("");
      setToast("Signed in. Local planning remains available offline.");
    } catch (e) {
      setAccountCode("");
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const beginGoogleAccount = async () => {
    setBusy(true);
    setError("");
    try {
      const status = await startGoogleSignIn();
      setAccountStatus(status);
      if (status.signedIn)
        setToast(
          "Signed in with Google. Local planning remains available offline.",
        );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const useEmailAccount = async () => {
    setBusy(true);
    setError("");
    try {
      setAccountStatus(await cancelGoogleSignIn());
      setAccountCode("");
      setAccountMode("email");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const refreshAccount = async () => {
    setBusy(true);
    setError("");
    try {
      setAccountStatus(await refreshAccountSession());
      setToast("Account session refreshed securely.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const disconnectAccount = async () => {
    setBusy(true);
    setError("");
    try {
      setAccountStatus(await signOutAccount());
      setAccountEmail("");
      setAccountCode("");
      setAccountMode("email");
      setToast("Signed out on this computer. Local data was not changed.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const eraseProfile = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await deleteLocalProfile(deleteConfirmation);
      setModal(null);
      setDeleteConfirmation("");
      setData(next.dashboard);
      setOnboarding(next.onboarding);
      setSecurity(next.security);
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (codeRetryAfter <= 0) return;
    const timer = setTimeout(
      () => setCodeRetryAfter((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [codeRetryAfter]);
  const applyNavigation = (target: NavigationTarget) => {
    setModal(null);
    setSettingsSection(null);
    if (target.view === "my-day") {
      setView("today");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    requestAnimationFrame(() => {
      const element = document.getElementById(`plan-block-${target.blockId}`);
      if (!element) {
        setToast("That plan block is no longer scheduled today.");
        return;
      }
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("deep-link-target");
      window.setTimeout(
        () => element.classList.remove("deep-link-target"),
        2400,
      );
    });
  };
  useEffect(() => {
    if (!data || !isDesktop()) return;
    let active = true;
    let stop = () => {};
    const consume = async () => {
      try {
        const target = await takePendingNavigation();
        if (active && target) applyNavigation(target);
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void consume();
    void listenForNavigation(() => {
      void consume();
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop();
    };
  }, [Boolean(data)]);
  useEffect(() => {
    if (!data || !isDesktop()) return;
    let active = true;
    let stop = () => {};
    const refreshStatus = async () => {
      try {
        const status = await getAccountStatus();
        if (!active) return;
        setAccountStatus(status);
        setToast(
          status.signedIn
            ? "Signed in with Google. Local planning remains available offline."
            : status.message,
        );
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void listenForAccountChanges(() => {
      void refreshStatus();
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop();
    };
  }, [Boolean(data)]);

  if (!security)
    return (
      <div className="loading">
        <AppLogo />
        {bootPhase === "error" ? (
          <>
            <strong>We could not open your workspace.</strong>
            <p role="alert">{bootError || error}</p>
            <button className="solid" onClick={retryBoot}>
              Try again
            </button>
          </>
        ) : (
          <>
            <strong>Opening your private workspace…</strong>
            {error && <p>{error}</p>}
          </>
        )}
      </div>
    );
  if (security.locked)
    return <LockScreen security={security} unlock={unlockWorkspace} />;
  if (onboarding?.required)
    return (
      <OnboardingExperience
        state={onboarding}
        onState={setOnboarding}
        onComplete={(result) => {
          setSecurity(result.security);
          setOnboarding(result.onboarding);
          // A null dashboard used to strand the app on the loading screen with
          // no way back. Onboarding is finished now, so re-running the bootstrap
          // is guaranteed to return one.
          if (result.dashboard) {
            setData(result.dashboard);
            if (
              result.dashboard.candidates.some(
                (candidate) => candidate.status === "pending",
              )
            ) {
              setModal("review");
            }
          } else retryBoot();
        }}
      />
    );
  if (!data)
    return (
      <div className="loading">
        <AppLogo />
        {bootPhase === "error" ? (
          <>
            <strong>We could not load your plan.</strong>
            <p role="alert">{bootError || error}</p>
            <button className="solid" onClick={retryBoot}>
              Reload plan
            </button>
          </>
        ) : (
          <>
            <strong>Loading your plan…</strong>
            {error && <p>{error}</p>}
          </>
        )}
      </div>
    );
  // The live event wins over the snapshot baked into the dashboard, which may
  // still say "checking" if it was built before the probe finished.
  const ocr = ocrStatus ?? data.ocr;
  return (
    <TaskDetailsSession key={taskDetailsSession}>
    <div className={`app-shell rebuild-shell ${interfaceMode} ${view === "today" ? "today-destination" : ""}`}>
      {settingsSection === "account" && (
        <Suspense
          fallback={
            <div className="overlay">
              <div className="modal loading" role="status">
                Opening account and sync settings…
              </div>
            </div>
          }
        >
          <AccountModal
            status={accountStatus}
            mode={accountMode}
            email={accountEmail}
            code={accountCode}
            retryAfter={codeRetryAfter}
            busy={busy}
            error={error}
            setEmail={setAccountEmail}
            setCode={setAccountCode}
            clearError={() => setError("")}
            close={closeSettingsSection}
            presentation="settings"
            changeEmail={() => {
              setAccountCode("");
              setAccountMode("email");
            }}
            useEmail={useEmailAccount}
            google={beginGoogleAccount}
            sendCode={sendAccountCode}
            verifyCode={confirmAccountCode}
            refresh={refreshAccount}
            signOut={disconnectAccount}
          />
        </Suspense>
      )}
      <DesktopNavigation
        mode={interfaceMode}
        studentName={data.studentName}
        onImport={() => setModal("import")}
        onWorkFilter={(filter) => { setWorkFilter(filter); setView("work"); }}
        active={view}
        onNavigate={(next) => {
          setSettingsSection(null);
          setView(next);
        }}
        onQuickAdd={() => setModal("task")}
        onSettings={() => setView("settings")}
        onSecurity={openSecurity}
        onDeleteProfile={() => {
          setDeleteConfirmation("");
          setError("");
          setModal("delete-profile");
        }}
      />
      <main className="main" aria-hidden={settingsSection ? true : undefined}>
        <header className="topbar">
          {interfaceMode === "compact" && <button className="shell-command" aria-label="Open command search" onClick={() => setModal("search")}><Search /> <span>Search or jump to…</span><kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd></button>}
          <div className="crumb" hidden={interfaceMode === "compact"}>
            <LayoutGrid />
            <span>
              {view === "today"
                ? "Today"
                : view === "calendar"
                  ? "Calendar"
                  : view === "work"
                    ? "Work"
                    : view === "courses"
                      ? "Courses"
                      : view === "scholarships"
                        ? "Scholarships"
                        : view === "settings" || view === "academic-settings"
                          ? "Settings"
                          : "Study"}
            </span>
            <ChevronRight />
            <span>{view === "today" ? "Agenda" : "Local workspace"}</span>
          </div>
          <div className="top-actions">
            <div className="mode-picker" role="group" aria-label="Workspace layout">
              {(["comfy", "compact"] as const).map(mode => <button key={mode} aria-pressed={interfaceMode === mode} disabled={interfaceBusy} onClick={() => void changeInterface({ ...interfacePreferences, mode })}>{mode === "comfy" ? "Comfy" : "Compact"}</button>)}
            </div>
            <span className="offline">
              <WifiOff /> Works offline
            </span>
            <button
              className="icon-btn"
              aria-label="Search"
              onClick={() => setModal("search")}
            >
              <Search />
            </button>
            <button
              className={`icon-btn ${data.notificationSettings.enabled ? "enabled" : ""}`}
              aria-label="Reminders"
              onClick={openNotifications}
            >
              <Bell />
            </button>
            <button
              className="icon-btn"
              aria-label="Security settings"
              onClick={openSecurity}
            >
              <MoreHorizontal />
            </button>
          </div>
        </header>
        <Suspense
          fallback={
            <div className="content">
              <div className="loading">
                <strong>Opening your local workspace…</strong>
              </div>
            </div>
          }
        >
          {view === "today" ? (
            <TodayView
              mode={interfaceMode}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
              onEditTask={(id) => { setSelectedTaskId(id); setView("work"); }}
              onCalendar={() => setView("calendar")}
              onWork={() => { setWorkFilter("all"); setView("work"); }}
              data={data}
              workspace={todayWorkspace}
              ocr={ocr}
              desktop={isDesktop()}
              busy={busy}
              error={error}
              checklistDismissed={checklistDismissed}
              pendingCount={pending.length}
              onClearError={() => setError("")}
              onOpenCourses={() => setView("courses")}
              onAddTask={() => setModal("task")}
              onImport={() => setModal("import")}
              onDismissChecklist={() => { rememberDismissal(); setChecklistDismissed(true); }}
              onStartBlock={(blockId) =>
                void run(
                  () => startPlanBlock(blockId),
                  "Focus session started — you’ve got this.",
                )
              }
              onReplan={() => setModal("replan")}
              onToggleTask={(taskId) =>
                void run(() => toggleTask(taskId), "Progress saved locally.")
              }
              onAssistant={() => {
                setAssistantExplanation("");
                setModal("assistant");
                listAiProviders()
                  .then(setAiProviders)
                  .catch((next) => setError(String(next)));
              }}
              onConflicts={() => setModal("conflicts")}
              onReview={() => setModal("review")}
              onCanvas={() => showSettingsSection("canvas")}
            />
          ) : view === "study" ? (
            <ModularStudyView onOpenAssistant={() => void openAiSettings()} />
          ) : view === "calendar" ? (
            <CalendarView
              onDashboard={setData}
              onImport={() => setModal("import")}
              onStudy={() => setView("study")}
              onConnections={() => showSettingsSection("canvas")}
              canvasConnections={data.canvasConnections}
            />
          ) : view === "work" ? (
            <WorkView
              initialTaskId={selectedTaskId}
              initialFilter={workFilter}
              onDashboard={setData}
              onImport={() => setModal("import")}
              onStudy={() => setView("study")}
            />
          ) : view === "scholarships" ? (
            <ScholarshipsView />
          ) : view === "settings" ? (
            <SettingsView
              appearance={appearance}
              accent={accent}
              busy={busy}
              institutionConfigured={Boolean(institutionId)}
              onAppearance={(next) => {
                void changeInterface({ ...interfacePreferences, themes: { ...interfacePreferences.themes, [interfaceMode]: next } });
              }}
              onAccent={(next) => {
                setAccent(next);
                applyAppearance(appearance, next);
                void updateAccent(next).catch((value) =>
                  setError(String(value)),
                );
              }}
              interfaceMode={interfaceMode}
              onInterfaceMode={(mode) => void changeInterface({ ...interfacePreferences, mode })}
              onDeleteProfile={() => { setDeleteConfirmation(""); setModal("delete-profile"); }}
              onCanvas={() => {
                setCanvasMode("calendar");
                showSettingsSection("canvas");
              }}
              onAi={() => void openAiSettings()}
              onAccount={() => void openAccount()}
              onBackups={openBackups}
              onSecurity={openSecurity}
              onUpdates={() => showSettingsSection("updates")}
              onAcademic={() => setView("academic-settings")}
              onRecovery={() => void openDataRecovery()}
              onCalendarRefresh={() =>
                void run(async () => {
                  const diff = await refreshSchoolCalendar(institutionId);
                  setCalendarDiff(diff);
                  setDeclinedChanges([]);
                  setModal("calendar-refresh");
                  return null;
                }, "")
              }
            />
          ) : view === "academic-settings" ? (
            <AcademicSettingsView
              onDashboard={setData}
              onImport={() => setModal("import")}
              onStudy={() => setView("study")}
            />
          ) : (
            <CoursesView
              onDashboard={setData}
              onImport={() => setModal("import")}
              onStudy={() => setView("study")}
            />
          )}
        </Suspense>
        {interfaceMode === "compact" && <footer className="shell-shortcuts"><button onClick={() => setModal("search")}><kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd> Command</button><button onClick={() => setModal("task")}><Plus size={14} /> Add task</button><button onClick={() => setView("calendar")}>Open Calendar</button><button onClick={() => setModal("replan")}>Replan</button></footer>}
      </main>
      <button
        className="fab"
        onClick={() => setModal("task")}
        aria-label="Quick add"
      >
        <Plus />
        <span>Quick add</span>
      </button>
      <MobileNavigation
        active={view}
        onNavigate={(next) => {
          setSettingsSection(null);
          setView(next);
        }}
        onQuickAdd={() => setModal("task")}
        onSettings={() => setView("settings")}
        onSecurity={openSecurity}
        onDeleteProfile={() => setModal("delete-profile")}
      />
      {modal === "import" && (
        <Modal
          title="Bring in my schedule"
          subtitle="Choose the quickest source. Coqui shows a review before anything reaches your plan."
          close={() => setModal(null)}
        >
          <div className="import-choice-grid">
            <button
              className="outline"
              onClick={() => {
                setCanvasMode("calendar");
                showSettingsSection("canvas");
              }}
            >
              <Link2 />
              <strong>Canvas calendar link</strong>
              <span>Paste the one link Canvas provides</span>
            </button>
            <button
              className="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  setToast(await launchScheduleCapture());
                  window.setTimeout(
                    () => importPasteTarget.current?.focus(),
                    0,
                  );
                } catch (next) {
                  setError(String(next));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <LayoutGrid />
              <strong>Capture screen area</strong>
              <span>Use the system snipping tool, then paste</span>
            </button>
          </div>
          <SchedulePhotoEditor
            disabled={busy}
            onError={setError}
            onImported={(next, count) => {
              setData(next);
              setToast(
                `${count} corrected photo${count === 1 ? "" : "s"} encrypted and extracted.`,
              );
              setModal("review");
            }}
          />
          <button
            ref={importPasteTarget}
            className="dropzone"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const next = await selectAndImport();
                if (next) setModal("review");
                return next;
              }, "File encrypted and extraction completed.")
            }
          >
            <Upload />
            <strong>Paste, choose, or drop a schedule</strong>
            <span>PDF, image, ICS, Word, Excel, CSV, PowerPoint, or text</span>
            <span>Or paste a screenshot of your schedule with Ctrl/Cmd+V</span>
          </button>
          <button
            className="quick-add-detailed"
            onClick={() => {
              setModal(null);
              setView("courses");
            }}
          >
            <BookOpen /> Enter classes manually <ChevronRight />
          </button>
          <p className="privacy-note">
            <ShieldCheck /> The original stays private. AI is never used without
            a connected provider and explicit consent.
          </p>
          <section className="vault-library" aria-labelledby="vault-heading">
            <div className="small-head">
              <h3 id="vault-heading">Document library</h3>
              <span>{documents.length}</span>
            </div>
            <label className="search-field">
              <Search aria-hidden="true" />
              <span className="sr-only">Search encrypted documents</span>
              <input
                type="search"
                value={documentSearch}
                onChange={(event) => setDocumentSearch(event.target.value)}
                placeholder="Search file names"
              />
            </label>
            {documents.length ? (
              <div className="document-list">
                {documents.map((document) => (
                  <button
                    className="document-row"
                    key={document.id}
                    onClick={async () => {
                      setError("");
                      try {
                        const items = await getDocumentEvidence(document.id);
                        setVaultEvidence({ documentId: document.id, items });
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    <FileLock2 aria-hidden="true" />
                    <span>
                      <strong>{document.fileName}</strong>
                      <small>
                        {new Date(document.importedAt).toLocaleString()} ·{" "}
                        {document.approvedCount} approved ·{" "}
                        {document.pendingCount} pending
                      </small>
                      {document.extractionError && (
                        <em>{document.extractionError}</em>
                      )}
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty compact-empty">
                No encrypted documents match this search.
              </div>
            )}
            {vaultEvidence && (
              <div className="vault-evidence" aria-live="polite">
                <div className="small-head">
                  <h3>Saved source evidence</h3>
                  <button
                    className="icon-button"
                    aria-label="Close source evidence"
                    onClick={() => setVaultEvidence(null)}
                  >
                    <X />
                  </button>
                </div>
                {vaultEvidence.items.length ? (
                  vaultEvidence.items.map((candidate) => (
                    <article key={candidate.id}>
                      <strong>{candidate.title}</strong>
                      <q>{candidate.evidence}</q>
                      <small>
                        {candidate.sourceLocator} · {candidate.status}
                      </small>
                    </article>
                  ))
                ) : (
                  <p>No academic facts were extracted from this source.</p>
                )}
                {/* Offered only for an image, and only ever offered: the app
                    never sends a picture of a student's screen on its own
                    initiative, and the copy has to read that way rather than
                    burying it in a settings toggle. */}
                {/* Only while the image is still stored. Shredding happens
                    exactly when every candidate is settled, which is also when a
                    student is most likely to be reading the evidence — so
                    offering this then would put the failure on the common path. */}
                {(() => {
                  const source = documents.find(
                    (document) => document.id === vaultEvidence.documentId,
                  );
                  return (
                    source?.mime.startsWith("image/") &&
                    source.originalAvailable
                  );
                })() && (
                  <div className="ai-reread">
                    <p>
                      <ShieldCheck aria-hidden="true" /> Coqui read this
                      screenshot on your computer. If the class times came out
                      wrong, it can ask your selected AI provider to try again —
                      that sends{" "}
                      <strong>this image and the text read from it</strong> off
                      your computer. Everything it proposes still needs your
                      review, and you never have to do this.
                    </p>
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const available = await listAiProviders();
                          const resolved = available.find(
                            (item) => item.connected && item.healthy,
                          );
                          if (!resolved)
                            throw new Error(
                              "Connect and test an AI provider in Settings first.",
                            );
                          const approved = window.confirm(
                            `Send this screenshot and its locally extracted text to ${resolved.provider} (${resolved.model})? Nothing else in your vault is included.`,
                          );
                          if (!approved) return null;
                          const result = await readScheduleWithAi(
                            vaultEvidence.documentId,
                            true,
                          );
                          setModal("review");
                          return result.dashboard;
                        }, "Your selected AI provider proposed classes for review; nothing was added to your plan.")
                      }
                    >
                      Ask AI to re-read this screenshot
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </Modal>
      )}
      {modal === "review" && (
        <Modal
          title="Review extracted facts"
          subtitle="Every candidate shows its source evidence. Approve only what is correct."
          close={() => setModal(null)}
        >
          {pending.length ? (
            <>
              <ScheduleImportReview
                candidates={pending}
                selectedIds={selectedCandidates}
                conflictedIds={conflictCandidateIds}
                busy={busy}
                onSelection={setSelectedCandidates}
                onDashboard={setData}
                onError={setError}
                terms={todayWorkspace?.terms ?? []}
              />
              <div className="modal-actions split-actions">
                <button
                  className="outline danger"
                  disabled={!selectedCandidates.length || busy}
                  onClick={() =>
                    run(
                      () => rejectCandidates(selectedCandidates),
                      `${selectedCandidates.length} candidates rejected.`,
                    ).then((next) => {
                      if (!next) return;
                      const selectedSources = [
                        ...new Set(
                          pending
                            .filter((item) =>
                              selectedCandidates.includes(item.id),
                            )
                            .map((item) => item.documentId),
                        ),
                      ];
                      const ready = selectedSources.filter(
                        (id) =>
                          next.unsettledScheduleSources.includes(id) &&
                          !next.candidates.some(
                            (item) =>
                              item.documentId === id &&
                              item.status === "pending",
                          ),
                      );
                      if (ready.length) {
                        setRetentionDocumentIds(ready);
                        setModal("retention");
                      } else setModal(null);
                    })
                  }
                >
                  Ignore selected
                </button>
                <span />
                <button className="outline" onClick={() => setModal(null)}>
                  Keep for later
                </button>
                {data.conflicts.some(
                  (conflict) => conflict.kind === "source_change",
                ) && (
                  <button
                    className="outline"
                    onClick={() => setModal("conflicts")}
                  >
                    Resolve date changes
                  </button>
                )}
                <button
                  className="solid"
                  disabled={!selectedCandidates.length || busy}
                  onClick={() =>
                    run(
                      () => approveCandidates(selectedCandidates),
                      `${selectedCandidates.length} items approved and planned.`,
                    ).then((next) => {
                      if (!next) return;
                      const selectedSources = [
                        ...new Set(
                          pending
                            .filter((item) =>
                              selectedCandidates.includes(item.id),
                            )
                            .map((item) => item.documentId),
                        ),
                      ];
                      const ready = selectedSources.filter(
                        (id) =>
                          next.unsettledScheduleSources.includes(id) &&
                          !next.candidates.some(
                            (item) =>
                              item.documentId === id &&
                              item.status === "pending",
                          ),
                      );
                      if (ready.length) {
                        setRetentionDocumentIds(ready);
                        setModal("retention");
                      } else setModal(null);
                    })
                  }
                >
                  Approve and plan
                </button>
              </div>
            </>
          ) : (
            <div className="empty">
              No candidates are waiting for review. The encrypted source remains
              available in your vault.
            </div>
          )}
        </Modal>
      )}
      {modal === "retention" && (
        <Modal
          title="Keep the schedule source?"
          subtitle="Your approved classes and evidence stay either way."
          close={() => setModal(null)}
        >
          <div className="consent-box">
            <ShieldCheck />
            <div>
              <strong>Your choice, every import</strong>
              <p>
                Keep the original image or document encrypted for later review,
                or delete the source now. Coqui never makes this choice
                silently.
              </p>
            </div>
          </div>
          {retentionDocumentIds.length > 1 && (
            <p className="field-help">
              Source 1 of {retentionDocumentIds.length}. You will choose
              separately for every imported source file.
            </p>
          )}
          <div className="modal-actions">
            <button
              className="outline danger"
              disabled={busy || !retentionDocumentIds.length}
              onClick={() =>
                run(
                  () =>
                    settleScheduleSource(retentionDocumentIds[0], "delete_now"),
                  "Schedule source deleted.",
                ).then((next) => {
                  if (!next) return;
                  const remaining = retentionDocumentIds.slice(1);
                  setRetentionDocumentIds(remaining);
                  if (!remaining.length) setModal(null);
                })
              }
            >
              Delete source now
            </button>
            <button
              className="solid"
              disabled={busy || !retentionDocumentIds.length}
              onClick={() =>
                run(
                  () =>
                    settleScheduleSource(
                      retentionDocumentIds[0],
                      "keep_encrypted",
                    ),
                  "Schedule source kept encrypted.",
                ).then((next) => {
                  if (!next) return;
                  const remaining = retentionDocumentIds.slice(1);
                  setRetentionDocumentIds(remaining);
                  if (!remaining.length) setModal(null);
                })
              }
            >
              Keep encrypted source
            </button>
          </div>
        </Modal>
      )}
      {modal === "calendar-refresh" && calendarDiff && (
        <Modal
          title="Your school's calendar"
          subtitle={`Read from ${calendarDiff.sourceLabel || "the registrar"} just now. Nothing changes until you approve it.`}
          close={() => setModal(null)}
        >
          {calendarDiff.changedTerms.length ||
          calendarDiff.addedNoClassDates.length ? (
            <>
              {calendarDiff.changedTerms.length > 0 && (
                <div className="candidate-list">
                  <p className="field-help">
                    A term date is a critical academic date, so each one is
                    shown with the value you have now beside the one the
                    registrar publishes. Anything you have edited yourself is
                    left alone.
                  </p>
                  {calendarDiff.changedTerms.map((change) => {
                    const declined = declinedChanges.includes(
                      changeKey(change),
                    );
                    return (
                      <label key={changeKey(change)}>
                        <input
                          type="checkbox"
                          checked={!declined}
                          onChange={(event) =>
                            setDeclinedChanges((current) =>
                              event.target.checked
                                ? current.filter(
                                    (key) => key !== changeKey(change),
                                  )
                                : [...current, changeKey(change)],
                            )
                          }
                        />
                        <span>
                          <strong>{change.termName}</strong>
                          <small>
                            {change.field} · {change.current || "unset"} →{" "}
                            {change.proposed}
                          </small>
                          <q>{change.evidence}</q>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {calendarDiff.addedNoClassDates.length > 0 && (
                <div className="candidate-list">
                  <p className="field-help">
                    Holidays and breaks. Approving these stops the planner
                    scheduling on those days.
                  </p>
                  {calendarDiff.addedNoClassDates.map((date) => (
                    <label key={`${date.startsOn}-${date.label}`}>
                      <input type="checkbox" checked readOnly />
                      <span>
                        <strong>{date.label}</strong>
                        <small>
                          {date.startsOn}
                          {date.endsOn ? ` – ${date.endsOn}` : ""}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="modal-actions split-actions">
                <span />
                <button className="outline" onClick={() => setModal(null)}>
                  Not now
                </button>
                <button
                  className="solid"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        applyCalendarDiff({
                          termChanges: calendarDiff.changedTerms.filter(
                            (change) =>
                              !declinedChanges.includes(changeKey(change)),
                          ),
                          noClassDates: calendarDiff.addedNoClassDates,
                        }),
                      "Calendar updated.",
                    ).then(() => {
                      setCalendarDiff(null);
                      setDeclinedChanges([]);
                      setModal(null);
                    })
                  }
                >
                  Apply selected
                </button>
              </div>
            </>
          ) : (
            <div className="empty compact-empty">
              Your calendar already matches what{" "}
              {calendarDiff.sourceLabel || "your school"} publishes.
            </div>
          )}
        </Modal>
      )}
      {modal === "conflicts" && (
        <Modal
          title="Resolve planning conflicts"
          subtitle="Student Center never replaces a critical date silently. Compare the current value with the newest source evidence."
          close={() => setModal(null)}
        >
          {data.conflicts.length ? (
            <div className="conflict-list">
              {data.conflicts.map((conflict) => {
                const candidate = data.candidates.find(
                  (item) => item.id === conflict.candidateId,
                );
                return (
                  <article className="conflict-card" key={conflict.id}>
                    <div className="conflict-title">
                      <CircleAlert />
                      <span>
                        <strong>
                          {candidate?.title ?? "Planning overload"}
                        </strong>
                        <small>{conflict.description}</small>
                      </span>
                    </div>
                    {["source_change", "sync_critical_date"].includes(
                      conflict.kind,
                    ) ? (
                      <>
                        <div className="conflict-compare">
                          <div>
                            <small>Current plan</small>
                            <strong>
                              {["commitment", "academic_term"].includes(
                                conflict.entityType ?? "",
                              )
                                ? `${formatDateTime(conflict.currentStartsAt)} – ${formatDateTime(conflict.currentEndsAt)}`
                                : formatDateTime(conflict.currentDueAt)}
                            </strong>
                          </div>
                          <ChevronRight />
                          <div>
                            <small>
                              {conflict.kind === "sync_critical_date"
                                ? "Newest device value"
                                : "Newest Canvas value"}
                            </small>
                            <strong>
                              {["commitment", "academic_term"].includes(
                                conflict.entityType ?? "",
                              )
                                ? `${formatDateTime(conflict.proposedStartsAt)} – ${formatDateTime(conflict.proposedEndsAt)}`
                                : formatDateTime(conflict.proposedDueAt)}
                            </strong>
                          </div>
                        </div>
                        {candidate && <q>{candidate.evidence}</q>}
                        <div className="conflict-actions">
                          <button
                            className="outline"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () =>
                                  resolveSourceConflict(
                                    conflict.id,
                                    "keep_existing",
                                  ),
                                "Your current value was preserved.",
                              )
                            }
                          >
                            Keep my current value
                          </button>
                          <button
                            className="solid"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () =>
                                  resolveSourceConflict(
                                    conflict.id,
                                    "use_source",
                                  ),
                                "Canvas value accepted and plan rebuilt.",
                              )
                            }
                          >
                            Use Canvas value
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="conflict-actions">
                        <button
                          className="solid"
                          onClick={() => setModal("replan")}
                        >
                          Adjust my plan
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty">All conflicts are resolved.</div>
          )}
        </Modal>
      )}
      {modal === "replan" && (
        <Modal
          title="What changed?"
          subtitle="Completed, past, fixed, and locked blocks remain protected."
          close={() => setModal(null)}
        >
          <div className="options">
            {[
              "I woke up late",
              "This took 30 minutes longer",
              "I have less energy",
              "Replan everything after now",
            ].map((reason) => (
              <button
                className={reason === replanReason ? "active" : ""}
                key={reason}
                onClick={() => setReplanReason(reason)}
              >
                {reason}
              </button>
            ))}
          </div>
          <div className="modal-actions">
            <button className="outline" onClick={() => setModal(null)}>
              Keep current plan
            </button>
            <button
              className="solid"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    replan(
                      new Date(
                        Date.now() +
                          (replanReason === "This took 30 minutes longer"
                            ? 30 * 60_000
                            : 0),
                      ).toISOString(),
                      replanReason,
                    ),
                  "Plan rebuilt without moving protected work.",
                ).then(() => setModal(null))
              }
            >
              Build a realistic plan
            </button>
          </div>
        </Modal>
      )}
      {settingsSection === "ai" && (
        <Modal
          title="AI providers"
          subtitle="Bring your own key. Requests leave this computer only after you review the provider, model, and data scope."
          close={() => {
            setAiKey("");
            closeSettingsSection();
          }}
          presentation="settings"
        >
          <div className="connection-list">
            {aiProviders.map((provider, index) => (
              <article className="connection" key={provider.provider}>
                <div className="connection-head">
                  <span>
                    <Brain />
                    <strong>
                      {provider.provider === "openai"
                        ? "OpenAI"
                        : provider.provider === "anthropic"
                          ? "Anthropic"
                          : "Google Gemini"}
                    </strong>
                    <small>
                      {provider.model} · {provider.maskedKey ?? "Not connected"}
                    </small>
                  </span>
                  <b
                    className={`status ${provider.healthy ? "connected" : provider.connected ? "error" : "disconnected"}`}
                  >
                    {provider.healthy
                      ? "ready"
                      : provider.connected
                        ? "check needed"
                        : "not connected"}
                  </b>
                </div>
                <p>Priority {index + 1}. Usage never changes this order.</p>
                <div className="connection-actions">
                  <button
                    className="outline"
                    disabled={index === 0 || busy}
                    onClick={() => {
                      const order = aiProviders.map((item) => item.provider);
                      [order[index - 1], order[index]] = [
                        order[index],
                        order[index - 1],
                      ];
                      void setAiProviderOrder(order)
                        .then(setAiProviders)
                        .catch((next) => setError(String(next)));
                    }}
                  >
                    Move up
                  </button>
                  {provider.connected && (
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() =>
                        void testAiProvider(provider.provider)
                          .then(setAiProviders)
                          .catch((next) => setError(String(next)))
                      }
                    >
                      Test
                    </button>
                  )}
                  {provider.connected && (
                    <button
                      className="outline danger"
                      disabled={busy}
                      onClick={() =>
                        void removeAiProvider(provider.provider)
                          .then(setAiProviders)
                          .catch((next) => setError(String(next)))
                      }
                    >
                      Disconnect
                    </button>
                  )}
                  <button
                    className="outline"
                    onClick={() => {
                      setAiProvider(provider.provider);
                      setAiModel(provider.model);
                      setAiKey("");
                    }}
                  >
                    Configure
                  </button>
                </div>
              </article>
            ))}
          </div>
          <section className="setup-fieldset">
            <h3>
              Connect{" "}
              {aiProvider === "openai"
                ? "OpenAI"
                : aiProvider === "anthropic"
                  ? "Anthropic"
                  : "Gemini"}
            </h3>
            <label className="field">
              API key
              <input
                type="password"
                value={aiKey}
                onChange={(event) => setAiKey(event.target.value)}
                autoComplete="off"
                placeholder="Saved only in the OS credential vault"
              />
            </label>
            <label className="field">
              Model
              <input
                value={aiModel}
                onChange={(event) => setAiModel(event.target.value)}
                placeholder="Recommended default"
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={aiAgeConfirmed}
                onChange={(event) => setAiAgeConfirmed(event.target.checked)}
              />
              <span>
                I am 18 or older and understand that my own provider account,
                billing, and data terms apply.
              </span>
            </label>
            <p className="field-help">
              Coqui sends only the scope shown before each request. It never
              silently retries with another provider.{" "}
              <a
                href={
                  aiProviders.find((item) => item.provider === aiProvider)
                    ?.disclosureUrl
                }
                target="_blank"
                rel="noreferrer"
              >
                Review this provider’s data terms
              </a>
              .
            </p>
            <button
              className="solid"
              disabled={busy || aiKey.length < 20 || !aiAgeConfirmed}
              onClick={async () => {
                const submittedKey = aiKey;
                setAiKey("");
                setBusy(true);
                setError("");
                try {
                  const next = await saveAiProviderKey(
                    aiProvider,
                    submittedKey,
                    aiModel || undefined,
                    aiAgeConfirmed,
                  );
                  setAiProviders(next);
                  setToast(`${aiProvider} connected securely.`);
                } catch (next) {
                  setError(String(next));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Validate and connect
            </button>
          </section>
          <section className="setup-fieldset">
            <h3>Local usage</h3>
            {aiUsage.length ? (
              aiUsage.map((item) => (
                <p
                  className="field-help"
                  key={`${item.provider}:${item.model}`}
                >
                  <strong>
                    {item.provider} · {item.model}
                  </strong>{" "}
                  — {item.requests} requests,{" "}
                  {item.inputTokens.toLocaleString()} input tokens,{" "}
                  {item.outputTokens.toLocaleString()} output tokens,{" "}
                  {item.failures} failures.
                </p>
              ))
            ) : (
              <p className="field-help">
                No AI requests recorded on this device.
              </p>
            )}
          </section>
        </Modal>
      )}
      {modal === "search" && (
        <Suspense
          fallback={
            <div className="overlay">
              <div className="modal loading" role="status">
                Loading your local records…
              </div>
            </div>
          }
        >
          <WorkspaceSearchModal
            close={() => setModal(null)}
            navigate={setView}
          />
        </Suspense>
      )}
      {modal === "task" && (
        <Suspense
          fallback={
            <div className="overlay">
              <div className="modal loading" role="status">
                Opening quick add…
              </div>
            </div>
          }
        >
          <QuickAddTaskModal
            close={() => setModal(null)}
            openDetailed={() => {
              setModal(null);
              setView("work");
            }}
            saved={(dashboard) => {
              setData(dashboard);
              setToast("Assignment saved and planned locally.");
            }}
          />
        </Suspense>
      )}
      {settingsSection === "canvas" && (
        <Modal
          title="Connect Canvas"
          subtitle="The calendar link is the fastest setup. Every imported fact remains pending until you review it."
          close={closeSettingsSection}
          presentation="settings"
        >
          <div className="connection-list">
            {data.canvasConnections.map((connection) => (
              <article className="connection" key={connection.id}>
                <div className="connection-head">
                  <span>
                    <Link2 />
                    <strong>
                      {connection.accountName || connection.baseUrl}
                    </strong>
                    <small>
                      {connection.provider === "canvas_calendar"
                        ? "Calendar link · secret path hidden"
                        : "Canvas Full Connection"}{" "}
                      · {connection.baseUrl}
                    </small>
                  </span>
                  <b className={`status ${connection.status}`}>
                    {connection.status.replaceAll("_", " ")}
                  </b>
                </div>
                <p>
                  {connection.lastSyncedAt
                    ? `Last synced ${new Date(connection.lastSyncedAt).toLocaleString()}`
                    : "Not synced yet"}{" "}
                  · {connection.pendingCandidates} pending
                </p>
                {connection.provider === "canvas_calendar" && (
                  <small>
                    Automatic refresh{" "}
                    {connection.refreshOnStartup ? "on" : "off"}
                    {connection.nextEligibleRefreshAt
                      ? ` · next eligible ${new Date(connection.nextEligibleRefreshAt).toLocaleString()}`
                      : ""}
                  </small>
                )}
                {connection.lastError && <mark>{connection.lastError}</mark>}
                <div className="connection-actions">
                  <button
                    className="outline"
                    disabled={
                      busy ||
                      !["connected", "error"].includes(connection.status)
                    }
                    onClick={() =>
                      run(
                        () =>
                          connection.provider === "canvas_calendar"
                            ? refreshCanvasCalendar(connection.id)
                            : syncCanvas(connection.id),
                        "Canvas refresh completed.",
                      )
                    }
                  >
                    <RefreshCw /> Refresh
                  </button>
                  {connection.provider === "canvas_calendar" &&
                    connection.status !== "disconnected" && (
                      <button
                        className="outline"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () =>
                              setCanvasCalendarRefresh(
                                connection.id,
                                !connection.refreshOnStartup,
                              ),
                            `Automatic Canvas refresh ${connection.refreshOnStartup ? "disabled" : "enabled"}.`,
                          )
                        }
                      >
                        {connection.refreshOnStartup
                          ? "Turn auto refresh off"
                          : "Turn auto refresh on"}
                      </button>
                    )}
                  <button
                    className="outline danger"
                    disabled={busy || connection.status === "disconnected"}
                    onClick={() =>
                      run(
                        () =>
                          connection.provider === "canvas_calendar"
                            ? disconnectCanvasCalendar(connection.id)
                            : disconnectCanvas(connection.id),
                        "Canvas disconnected.",
                      )
                    }
                  >
                    <Unplug /> Disconnect
                  </button>
                </div>
                <div className="sync-history">
                  {data.canvasSyncRuns
                    .filter((run) => run.connectionId === connection.id)
                    .slice(0, 4)
                    .map((run) => (
                      <small key={run.id}>
                        <b>{run.status}</b>
                        <span>{new Date(run.startedAt).toLocaleString()}</span>
                        <span>{run.createdCount} changes</span>
                      </small>
                    ))}
                </div>
              </article>
            ))}
          </div>
          {!data.canvasConnections.some((connection) =>
            ["connected", "error"].includes(connection.status),
          ) && (
            <>
              <div
                className="segmented"
                role="group"
                aria-label="Canvas connection type"
              >
                <button
                  className={canvasMode === "calendar" ? "active" : ""}
                  onClick={() => setCanvasMode("calendar")}
                >
                  Calendar link
                </button>
                <button
                  className={canvasMode === "full" ? "active" : ""}
                  onClick={() => setCanvasMode("full")}
                >
                  Full connection · Advanced
                </button>
              </div>
              <label className="field">
                {canvasMode === "calendar"
                  ? "Canvas calendar feed link"
                  : "Canvas address"}
                <input
                  value={canvasUrl}
                  onChange={(event) => setCanvasUrl(event.target.value)}
                  placeholder={
                    canvasMode === "calendar"
                      ? "https://canvas.yourcollege.edu/feeds/calendars/…ics"
                      : "https://canvas.yourcollege.edu"
                  }
                  autoComplete="url"
                />
              </label>
              {canvasMode === "full" && (
                <label className="field">
                  Personal access token
                  <input
                    type="password"
                    value={canvasToken}
                    onChange={(event) => setCanvasToken(event.target.value)}
                    placeholder="Stored only in the OS credential vault"
                    autoComplete="off"
                  />
                </label>
              )}
              {canvasMode === "calendar" && (
                <>
                  <p className="field-help">
                    In Canvas, open Calendar → Calendar Feed, copy the link, and
                    paste it here. Coqui stores the complete link only in your
                    operating system’s credential vault.
                  </p>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={canvasRefreshOnStartup}
                      onChange={(event) =>
                        setCanvasRefreshOnStartup(event.target.checked)
                      }
                    />
                    <span>
                      Refresh automatically after unlock when at least 24 hours
                      have passed
                    </span>
                  </label>
                </>
              )}
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>Read-only and local</strong>
                  <p>
                    Coqui validates every HTTPS destination, blocks private
                    networks, and never writes to Canvas. The secret link or
                    token is never stored in the SQL database or returned here.
                  </p>
                </div>
              </div>
              <div className="modal-actions">
                <button
                  className="solid"
                  disabled={
                    busy ||
                    !canvasUrl.trim() ||
                    (canvasMode === "full" && canvasToken.length < 16)
                  }
                  onClick={() => {
                    const submittedUrl = canvasUrl.trim();
                    const submittedToken = canvasToken;
                    setCanvasUrl("");
                    setCanvasToken("");
                    void run(
                      () =>
                        canvasMode === "calendar"
                          ? connectCanvasCalendar(
                              submittedUrl,
                              "Canvas calendar",
                              canvasRefreshOnStartup,
                            )
                          : connectCanvas(submittedUrl, submittedToken),
                      "Canvas connected; review the imported facts.",
                    );
                  }}
                >
                  Validate and connect
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {settingsSection === "backups" && (
        <Modal
          title="Encrypted backups"
          subtitle="Create a portable archive or inspect one before replacing this local profile."
          close={closeBackups}
          presentation="settings"
        >
          {backupView === "home" && (
            <div className="backup-options">
              <button onClick={() => switchBackupView("export")}>
                <FileLock2 />
                <span>
                  <strong>Create encrypted backup</strong>
                  <small>
                    Save the complete database and document vault under a
                    passphrase.
                  </small>
                </span>
                <ChevronRight />
              </button>
              <button onClick={() => switchBackupView("restore")}>
                <RefreshCw />
                <span>
                  <strong>Restore from backup</strong>
                  <small>
                    Verify an archive, review its contents, then explicitly
                    replace this profile.
                  </small>
                </span>
                <ChevronRight />
              </button>
              {!isDesktop() && (
                <p className="privacy-note">
                  <CircleAlert /> Backup operations are available only in the
                  installed desktop application.
                </p>
              )}
            </div>
          )}
          {backupView === "export" && (
            <>
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>Portable, end-to-end encrypted archive</strong>
                  <p>
                    The database and vault stay encrypted. Keep this passphrase
                    safe: Student Center cannot recover it.
                  </p>
                </div>
              </div>
              <label className="field">
                Backup passphrase
                <input
                  type="password"
                  autoFocus
                  value={backupPassphrase}
                  onChange={(event) => setBackupPassphrase(event.target.value)}
                  autoComplete="new-password"
                  placeholder="At least 12 characters"
                />
              </label>
              <label className="field">
                Confirm passphrase
                <input
                  type="password"
                  value={backupConfirmation}
                  onChange={(event) =>
                    setBackupConfirmation(event.target.value)
                  }
                  autoComplete="new-password"
                />
              </label>
              {backupPreview && (
                <BackupSummary
                  preview={backupPreview}
                  title="Backup created and verified"
                />
              )}
              <div className="modal-actions">
                <button
                  className="outline"
                  onClick={() => switchBackupView("home")}
                >
                  Back
                </button>
                <button
                  className="solid"
                  disabled={
                    busy ||
                    !isDesktop() ||
                    backupPassphrase.length < 12 ||
                    backupPassphrase !== backupConfirmation
                  }
                  onClick={createBackup}
                >
                  Choose location and create
                </button>
              </div>
            </>
          )}
          {backupView === "restore" && (
            <>
              {!backupPath ? (
                <button
                  className="dropzone"
                  disabled={busy || !isDesktop()}
                  onClick={chooseRestore}
                >
                  <HardDrive />
                  <strong>Choose a .studentcenter backup</strong>
                  <span>
                    The archive is read and verified before anything changes.
                  </span>
                </button>
              ) : (
                <div className="selected-backup">
                  <HardDrive />
                  <span>
                    <strong>{backupPath.split(/[\\/]/).at(-1)}</strong>
                    <small>{backupPath}</small>
                  </span>
                  <button
                    className="outline"
                    disabled={busy}
                    onClick={chooseRestore}
                  >
                    Change
                  </button>
                </div>
              )}
              <label className="field">
                Backup passphrase
                <input
                  type="password"
                  value={backupPassphrase}
                  onChange={(event) => {
                    setBackupPassphrase(event.target.value);
                    setBackupPreview(null);
                    setRestoreAcknowledged(false);
                  }}
                  autoComplete="current-password"
                  placeholder="Required to inspect the archive"
                />
              </label>
              {backupPreview ? (
                <>
                  <BackupSummary
                    preview={backupPreview}
                    title="Verified backup"
                  />
                  <label className="restore-confirm">
                    <input
                      type="checkbox"
                      checked={restoreAcknowledged}
                      onChange={(event) =>
                        setRestoreAcknowledged(event.target.checked)
                      }
                    />
                    <span>
                      <strong>Replace this local profile</strong>
                      <small>
                        I understand the current database and document vault
                        will be replaced. Integration and AI credentials are not
                        restored.
                      </small>
                    </span>
                  </label>
                  <div className="modal-actions">
                    <button
                      className="outline"
                      onClick={() => switchBackupView("home")}
                    >
                      Cancel
                    </button>
                    <button
                      className="solid danger-solid"
                      disabled={busy || !restoreAcknowledged}
                      onClick={restoreBackup}
                    >
                      Replace profile and restore
                    </button>
                  </div>
                </>
              ) : (
                <div className="modal-actions">
                  <button
                    className="outline"
                    onClick={() => switchBackupView("home")}
                  >
                    Back
                  </button>
                  <button
                    className="solid"
                    disabled={
                      busy || !backupPath || backupPassphrase.length < 12
                    }
                    onClick={inspectBackup}
                  >
                    Verify and preview
                  </button>
                </div>
              )}
            </>
          )}
        </Modal>
      )}
      {settingsSection === "notifications" && (
        <Modal
          title="Desktop reminders"
          subtitle="Choose when Student Center may alert you. Reminder controls stay available here because native toast buttons are not supported consistently on desktop."
          close={closeSettingsSection}
          presentation="settings"
        >
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={notificationsEnabled}
              onChange={(event) =>
                setNotificationsEnabled(event.target.checked)
              }
            />
            <span>
              <strong>Allow native reminders</strong>
              <small>
                Uses the operating system’s notification center. Core planning
                remains fully offline.
              </small>
            </span>
          </label>
          <div className="notification-grid">
            <label className="field">
              Remind me before a block
              <input
                type="number"
                min="1"
                max="120"
                value={notificationLead}
                onChange={(event) =>
                  setNotificationLead(Number(event.target.value))
                }
              />
              <small>Minutes</small>
            </label>
            <label className="field">
              Quiet hours begin
              <input
                type="time"
                value={quietStart}
                onChange={(event) => setQuietStart(event.target.value)}
              />
            </label>
            <label className="field">
              Quiet hours end
              <input
                type="time"
                value={quietEnd}
                onChange={(event) => setQuietEnd(event.target.value)}
              />
            </label>
          </div>
          <label className="setting-toggle compact">
            <input
              type="checkbox"
              checked={showNotificationTitles}
              onChange={(event) =>
                setShowNotificationTitles(event.target.checked)
              }
            />
            <span>
              <strong>Show task titles in notifications</strong>
              <small>
                Off by default so lock-screen previews do not reveal academic
                details. Locked-app reminders are always generic.
              </small>
            </span>
          </label>
          <div className="reminder-list">
            <div className="small-head">
              <h3>Upcoming reminder controls</h3>
              <span>{reminderBlocks.length}</span>
            </div>
            {reminderBlocks.length ? (
              reminderBlocks.map((block) => (
                <article className="reminder-item" key={block.id}>
                  <div>
                    <strong>{block.title}</strong>
                    <small>
                      {formatTime(block.startsAt)} ·{" "}
                      {minutesBetween(block.startsAt, block.endsAt)} min
                      {block.startedAt ? " · In progress" : ""}
                    </small>
                  </div>
                  <div>
                    <button
                      className="outline"
                      disabled={busy || !isDesktop()}
                      onClick={() =>
                        run(
                          () => startPlanBlock(block.id),
                          "Focus session started.",
                        )
                      }
                    >
                      <Play /> Start
                    </button>
                    <button
                      className="outline"
                      disabled={busy || !isDesktop()}
                      onClick={() =>
                        run(
                          () => snoozeReminder(block.id, 10),
                          "Reminder snoozed for 10 minutes.",
                        )
                      }
                    >
                      Snooze
                    </button>
                    <button
                      className="outline"
                      disabled={busy || !isDesktop()}
                      onClick={() =>
                        run(() => toggleTask(block.taskId!), "Block completed.")
                      }
                    >
                      <Check /> Complete
                    </button>
                    <button
                      className="text-button"
                      disabled={busy || !isDesktop()}
                      onClick={() =>
                        run(
                          () => dismissReminder(block.id),
                          "Reminder dismissed.",
                        )
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <div className="empty">
                No unfinished flexible blocks are scheduled today.
              </div>
            )}
          </div>
          <p className="privacy-note">
            <ShieldCheck /> Reminder settings and delivery history stay in the
            encrypted local database.
          </p>
          <div className="modal-actions">
            <button className="outline" onClick={closeSettingsSection}>
              Cancel
            </button>
            <button
              className="solid"
              disabled={
                busy ||
                !isDesktop() ||
                notificationLead < 1 ||
                notificationLead > 120 ||
                !quietStart ||
                !quietEnd
              }
              onClick={saveNotifications}
            >
              Save reminder settings
            </button>
          </div>
        </Modal>
      )}
      {settingsSection === "security" && (
        <Modal
          title="App lock"
          subtitle="Add a private gate when you step away from this computer."
          close={closeSecurity}
          presentation="settings"
        >
          {pinMode === "home" && (
            <>
              <div className="security-state">
                <LockKeyhole />
                <span>
                  <strong>Student Center PIN is enabled</strong>
                  <small>
                    The app locks again after a restart or when you choose Lock
                    now.
                  </small>
                </span>
              </div>
              <div className="backup-options">
                <button
                  onClick={() => {
                    resetPinFields();
                    setPinMode("change");
                  }}
                >
                  <Settings />
                  <span>
                    <strong>Change PIN</strong>
                    <small>
                      Verify the current PIN, then choose a replacement.
                    </small>
                  </span>
                  <ChevronRight />
                </button>
                <button
                  onClick={() => {
                    resetPinFields();
                    setPinMode("disable");
                  }}
                >
                  <Unplug />
                  <span>
                    <strong>Disable app lock</strong>
                    <small>
                      The signed-in operating-system account will continue
                      protecting the device key.
                    </small>
                  </span>
                  <ChevronRight />
                </button>
              </div>
              <div className="modal-actions">
                <button
                  className="solid"
                  disabled={busy || !isDesktop()}
                  onClick={lockWorkspace}
                >
                  <LockKeyhole /> Lock now
                </button>
              </div>
            </>
          )}
          {pinMode === "enable" && (
            <>
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>An extra local privacy gate</strong>
                  <p>
                    Your PIN is processed only on this computer with Argon2id.
                    It is never stored and cannot be recovered.
                  </p>
                </div>
              </div>
              <label className="field">
                New PIN or passphrase
                <input
                  type="password"
                  autoFocus
                  value={newPin}
                  onChange={(event) => setNewPin(event.target.value)}
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                />
              </label>
              <label className="field">
                Confirm PIN
                <input
                  type="password"
                  value={pinConfirmation}
                  onChange={(event) => setPinConfirmation(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <p className="privacy-note">
                <CircleAlert /> Forgotten PINs cannot be recovered from Student
                Center. Your operating-system account still protects the
                underlying device key.
              </p>
              <div className="modal-actions">
                <button className="outline" onClick={closeSecurity}>
                  Cancel
                </button>
                <button
                  className="solid"
                  disabled={
                    busy ||
                    !isDesktop() ||
                    newPin.length < 6 ||
                    newPin !== pinConfirmation
                  }
                  onClick={savePin}
                >
                  Enable app lock
                </button>
              </div>
            </>
          )}
          {pinMode === "change" && (
            <>
              <label className="field">
                Current PIN
                <input
                  type="password"
                  autoFocus
                  value={currentPin}
                  onChange={(event) => setCurrentPin(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label className="field">
                New PIN or passphrase
                <input
                  type="password"
                  value={newPin}
                  onChange={(event) => setNewPin(event.target.value)}
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                />
              </label>
              <label className="field">
                Confirm new PIN
                <input
                  type="password"
                  value={pinConfirmation}
                  onChange={(event) => setPinConfirmation(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <div className="modal-actions">
                <button
                  className="outline"
                  onClick={() => {
                    resetPinFields();
                    setPinMode("home");
                  }}
                >
                  Back
                </button>
                <button
                  className="solid"
                  disabled={
                    busy ||
                    currentPin.length < 6 ||
                    newPin.length < 6 ||
                    newPin !== pinConfirmation
                  }
                  onClick={savePin}
                >
                  Change PIN
                </button>
              </div>
            </>
          )}
          {pinMode === "disable" && (
            <>
              <div className="consent-box security-warning">
                <CircleAlert />
                <div>
                  <strong>Remove the app privacy gate?</strong>
                  <p>
                    The encrypted database remains protected by the signed-in
                    operating-system account, but Student Center will open
                    without asking for a PIN.
                  </p>
                </div>
              </div>
              <label className="field">
                Current PIN
                <input
                  type="password"
                  autoFocus
                  value={currentPin}
                  onChange={(event) => setCurrentPin(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <div className="modal-actions">
                <button
                  className="outline"
                  onClick={() => {
                    resetPinFields();
                    setPinMode("home");
                  }}
                >
                  Keep app lock
                </button>
                <button
                  className="solid danger-solid"
                  disabled={busy || currentPin.length < 6}
                  onClick={savePin}
                >
                  Disable PIN
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {settingsSection === "updates" && (
        <Suspense
          fallback={
            <div className="overlay">
              <div className="modal loading" role="status">
                Loading update configuration…
              </div>
            </div>
          }
        >
          <UpdateModal close={closeSettingsSection} presentation="settings" />
        </Suspense>
      )}
      {modal === "assistant" && (
        <Modal
          title="AI is optional"
          subtitle="Core planning and local extraction remain available without an account, internet, or API key."
          close={() => setModal(null)}
        >
          <div className="consent-box">
            <Sparkles />
            <div>
              <strong>
                {aiProviders.find((item) => item.connected && item.healthy)
                  ? `${aiProviders.find((item) => item.connected && item.healthy)?.provider} · ${aiProviders.find((item) => item.connected && item.healthy)?.model}`
                  : "Connect an AI provider first"}
              </strong>
              <p>
                Data scope: only the excerpt shown below is sent over TLS.
                Responses become reviewable candidates and can’t directly alter
                your plan. A failure is never retried with another provider
                without asking.
              </p>
            </div>
          </div>
          <label className="field">
            AI action
            <select
              value={assistantCapability}
              onChange={(event) =>
                setAssistantCapability(
                  event.target.value as typeof assistantCapability,
                )
              }
            >
              <option value="brain_dump">Structure a brain dump</option>
              <option value="task_decomposition">
                Break down an assignment
              </option>
              <option value="document_extraction">Clarify an excerpt</option>
              <option value="planner_explanation">Explain planner facts</option>
            </select>
          </label>
          <label className="field">
            Selected excerpt
            <textarea
              value={assistantExcerpt}
              onChange={(event) => setAssistantExcerpt(event.target.value)}
              maxLength={12000}
              rows={7}
              placeholder="Paste only the brain dump, assignment excerpt, or deterministic facts needed for this request."
            />
            <small>
              {assistantExcerpt.length.toLocaleString()} / 12,000 characters
            </small>
          </label>
          <label className="check-row consent-check">
            <input
              type="checkbox"
              checked={assistantConsent}
              onChange={(event) => setAssistantConsent(event.target.checked)}
            />
            <span>
              I consent to sending only this excerpt to the provider and model
              shown above for this request.
            </span>
          </label>
          {assistantExplanation && (
            <div className="consent-box ai-explanation" role="status">
              <Sparkles />
              <div>
                <strong>Explanation</strong>
                <p>{assistantExplanation}</p>
              </div>
            </div>
          )}
          <div className="modal-actions">
            <button className="outline" onClick={() => setModal(null)}>
              Cancel
            </button>
            {!aiProviders.some((item) => item.connected && item.healthy) && (
              <button className="outline" onClick={() => void openAiSettings()}>
                Configure providers
              </button>
            )}
            <button
              className="solid"
              disabled={
                busy ||
                !aiProviders.some((item) => item.connected && item.healthy) ||
                !assistantConsent ||
                !assistantExcerpt.trim()
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await requestManagedAi(
                    assistantCapability,
                    assistantExcerpt.trim(),
                    assistantConsent,
                  );
                  setData(result.dashboard);
                  setToast(
                    result.dashboard.importNotice ??
                      `${result.provider} response is ready for review.`,
                  );
                  setAssistantExplanation(result.explanation ?? "");
                  if (result.candidatesCreated > 0) setModal("review");
                } catch (e) {
                  setAiProviders(
                    await listAiProviders().catch(() => aiProviders),
                  );
                  setAssistantConsent(false);
                  setError(
                    `${String(e)} Nothing was sent to another provider. Review the resolved provider and consent again to retry.`,
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Sparkles /> {busy ? "Working…" : "Create reviewable result"}
            </button>
          </div>
        </Modal>
      )}
      {settingsSection === "recovery" && (
        <Modal
          title="Data recovery"
          subtitle="Untouched legacy mock records are quarantined automatically and never affect your plan."
          close={closeSettingsSection}
          presentation="settings"
        >
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          {legacyItems.length ? (
            <div className="record-list compact">
              {legacyItems.map((item) => (
                <article key={item.id}>
                  <div className="record-icon protected">
                    <RefreshCw />
                  </div>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.entityType} · quarantined{" "}
                      {formatDateTime(item.quarantinedAt)}
                    </small>
                  </div>
                  <button
                    className="outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await restoreLegacyQuarantine([item.id]);
                        setLegacyItems(await listLegacyQuarantine());
                        const next = await initialize();
                        setData(next.dashboard);
                        setToast(
                          "Legacy record restored to your local workspace.",
                        );
                      } catch (next) {
                        setError(String(next));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Restore
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <ShieldCheck />
              <strong>No quarantined records</strong>
              <p>
                Fresh installations and completed cleanups have nothing to
                recover.
              </p>
            </div>
          )}
          {legacyItems.length > 0 && (
            <>
              <label className="field">
                Type PURGE LEGACY DATA to permanently remove recovery snapshots
                <input
                  value={purgeConfirmation}
                  onChange={(event) => setPurgeConfirmation(event.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button
                  className="solid danger-solid"
                  disabled={busy || purgeConfirmation !== "PURGE LEGACY DATA"}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await purgeLegacyQuarantine(purgeConfirmation);
                      setLegacyItems([]);
                      setPurgeConfirmation("");
                      setToast(
                        "Legacy recovery snapshots permanently removed.",
                      );
                    } catch (next) {
                      setError(String(next));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Permanently purge snapshots
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {modal === "delete-profile" && (
        <Modal
          title="Delete this local profile"
          subtitle="This permanently removes the encrypted database, document vault, plans, imports, and local integration history from this computer."
          close={() => setModal(null)}
        >
          <div className="consent-box security-warning">
            <CircleAlert />
            <div>
              <strong>
                Create an encrypted backup first if you may need this data
                again.
              </strong>
              <p>
                Close this dialog and use Backups to export. Deletion cannot be
                undone and Student Center will return to first-run onboarding.
              </p>
            </div>
          </div>
          <label className="field">
            Type DELETE MY PROFILE
            <input
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="modal-actions">
            <button className="outline" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className="solid danger-solid"
              disabled={busy || deleteConfirmation !== "DELETE MY PROFILE"}
              onClick={eraseProfile}
            >
              Permanently delete local profile
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          ✦ {toast}
        </div>
      )}
    </div>
    </TaskDetailsSession>
  );
}
