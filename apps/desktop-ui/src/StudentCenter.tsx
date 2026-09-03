import { TaskDetailsSession } from "./features/tasks/TaskDetailsSession";
import type { WorkFilter } from "./components/WorkView";
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
  ChevronRight,
  CircleAlert,
  FileLock2,
  LayoutGrid,
  Link2,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  WifiOff,
  X,
} from "lucide-react";
import {
  DesktopNavigation,
  MobileNavigation,
  StudentDestination,
} from "./components/AppNavigation";
import { AppLogo } from "./components/AppLogo";
import {
  applyInterfacePreferences,
  initialInterfacePreferences,
  loadInterfacePreferences,
  saveInterfacePreferences,
  type InterfacePreferences,
} from "./features/shell/interfacePreferences";
import { ScheduleImportReview } from "./components/ScheduleImportReview";
import { SchedulePhotoEditor } from "./components/SchedulePhotoEditor";
import { OnboardingExperience } from "./components/OnboardingExperience";
import {
  isSetupChecklistDismissed,
  rememberDismissal,
} from "./components/SetupChecklist";
import type { SettingsSection } from "./components/SettingsView";
import { TodayView } from "./components/TodayView";
import { Modal } from "./components/Modal";
import { SettingsDetail } from "./components/SettingsDetail";
import { LockScreen } from "./components/SecurityPrimitives";
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
  CalendarDiff,
  Dashboard,
  TermChange,
  deleteLocalProfile,
  DocumentSummary,
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
  rejectCandidates,
  replan,
  requestManagedAi,
  resolveSourceConflict,
  SecurityStatus,
  selectAndImport,
  startPlanBlock,
  settleScheduleSource,
  takePendingNavigation,
  toggleTask,
  unlockWithPin,
  updateAccent,
  WorkspaceSnapshot,
  AiProviderStatus,
} from "./native";

const BackupSettings = lazy(() =>
  import("./features/settings/BackupSettings").then((module) => ({
    default: module.BackupSettings,
  })),
);
const SecuritySettings = lazy(() =>
  import("./features/settings/SecuritySettings").then((module) => ({
    default: module.SecuritySettings,
  })),
);
const AiSettings = lazy(() =>
  import("./features/settings/AiSettings").then((module) => ({
    default: module.AiSettings,
  })),
);
const CanvasSettings = lazy(() =>
  import("./features/settings/CanvasSettings").then((module) => ({
    default: module.CanvasSettings,
  })),
);
const NotificationsSettings = lazy(() =>
  import("./features/settings/NotificationsSettings").then((module) => ({
    default: module.NotificationsSettings,
  })),
);
const DataRecoverySettings = lazy(() =>
  import("./features/settings/DataRecoverySettings").then((module) => ({
    default: module.DataRecoverySettings,
  })),
);
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
const AccountSettings = lazy(() =>
  import("./features/settings/AccountSettings").then((module) => ({
    default: module.AccountSettings,
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
const formatDateTime = (iso?: string) =>
  iso
    ? new Intl.DateTimeFormat([], {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso))
    : "Not set";
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
  const [interfacePreferences, setInterfacePreferences] = useState(
    initialInterfacePreferences,
  );
  const [interfaceBusy, setInterfaceBusy] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() =>
    import.meta.env.DEV &&
    !isDesktop() &&
    new URLSearchParams(location.search).get("reference") === "compact"
      ? "reference-task-0"
      : null,
  );
  const [workFilter, setWorkFilter] = useState<WorkFilter>("all");
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
      if (
        event.defaultPrevented ||
        event.isComposing ||
        modal ||
        security?.locked ||
        !data
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]',
        )
      )
        return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setModal("search");
        return;
      }
      const destinations: StudentDestination[] = [
        "today",
        "calendar",
        "work",
        "courses",
        "study",
        "scholarships",
      ];
      const destination = destinations[Number(event.key) - 1];
      if (destination) {
        event.preventDefault();
        setView(destination);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modal, security?.locked, Boolean(data)]);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(null);
  const settingsOpener = useRef<{
    element: HTMLElement | null;
    action?: string;
  }>({ element: null });
  const showSettingsSection = (section: SettingsSection) => {
    const element = document.activeElement as HTMLElement | null;
    settingsOpener.current = {
      element,
      action: element?.closest<HTMLElement>("[data-settings-action]")?.dataset
        .settingsAction,
    };
    setView("settings");
    setModal(null);
    setSettingsSection(section);
  };
  const closeSettingsSection = () => setSettingsSection(null);
  useEffect(() => {
    if (view !== "settings") setSettingsSection(null);
  }, [view]);
  useEffect(() => {
    if (settingsSection || view !== "settings") return;
    const { element, action } = settingsOpener.current;
    const target = element?.isConnected
      ? element
      : Array.from(
          document.querySelectorAll<HTMLElement>("[data-settings-action]"),
        ).find((item) => item.dataset.settingsAction === action);
    target?.focus();
  }, [settingsSection, view]);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const importPasteTarget = useRef<HTMLButtonElement>(null);
  const [replanReason, setReplanReason] = useState("I woke up late");
  const [aiProviders, setAiProviders] = useState<AiProviderStatus[]>([]);
  const [retentionDocumentIds, setRetentionDocumentIds] = useState<string[]>(
    [],
  );
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(
    null,
  );
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
    } catch (error) {
      setError(String(error));
    } finally {
      setInterfaceBusy(false);
    }
  };
  useEffect(() => {
    if (!data) return;
    let active = true;
    void getLocalWorkspace()
      .then((workspace) => {
        if (!active) return;
        setTodayWorkspace(workspace);
        setAccent(workspace.accent);
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [data]);
  useEffect(() => {
    if (!data) return;
    let active = true;
    setInterfaceBusy(true);
    void loadInterfacePreferences()
      .then(async (value) => {
        if (!active) return;
        await saveInterfacePreferences(value);
        if (!active) return;
        setInterfacePreferences(value);
        applyInterfacePreferences(value);
        setAppearance(value.themes[value.mode]);
        applyAppearance(value.themes[value.mode]);
      })
      .catch((error) => {
        if (active) setError(String(error));
      })
      .finally(() => {
        if (active) setInterfaceBusy(false);
      });
    return () => {
      active = false;
    };
  }, [Boolean(data)]);
  const retryBoot = useCallback(
    () => setBootAttempt((attempt) => attempt + 1),
    [],
  );
  useEffect(() => {
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
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
  const openBackups = () => showSettingsSection("backups");
  const openAiSettings = () => showSettingsSection("ai");
  const openDataRecovery = () => showSettingsSection("recovery");
  const onBackupRestored = (next: Dashboard) => {
    setData(next);
    setToast(next.importNotice ?? "Encrypted profile restored.");
    setSelectedTaskId(null);
    setTaskDetailsSession((value) => value + 1);
    setAiProviders([]);
    setAccountStatus(null);
    closeSettingsSection();
    void loadInterfacePreferences()
      .then((restored) => {
        setInterfacePreferences(restored);
        applyInterfacePreferences(restored);
        setAppearance(restored.themes[restored.mode]);
      })
      .catch(() =>
        setError(
          "Backup restored. Restart Coqui to reload its appearance preferences.",
        ),
      );
  };
  const openSecurity = () => {
    setError("");
    showSettingsSection("security");
  };
  const lockWorkspace = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await lockApp();
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
    showSettingsSection("notifications");
  };
  const openAccount = () => showSettingsSection("account");
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
      <div
        className={`app-shell rebuild-shell ${interfaceMode} ${view === "today" ? "today-destination" : ""}`}
      >
        <DesktopNavigation
          mode={interfaceMode}
          studentName={data.studentName}
          onImport={() => setModal("import")}
          onWorkFilter={(filter) => {
            setWorkFilter(filter);
            setView("work");
          }}
          active={view}
          onNavigate={(next) => {
            setSettingsSection(null);
            setView(next);
          }}
          onQuickAdd={() => setModal("task")}
          onSettings={() => {
            setSettingsSection(null);
            setView("settings");
          }}
          onSecurity={openSecurity}
          onDeleteProfile={() => {
            setDeleteConfirmation("");
            setError("");
            setModal("delete-profile");
          }}
        />
        <main className="main">
          <header className="topbar">
            {interfaceMode === "compact" && (
              <button
                className="shell-command"
                aria-label="Open command search"
                onClick={() => setModal("search")}
              >
                <Search /> <span>Search or jump to…</span>
                <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd>
              </button>
            )}
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
              <div
                className="mode-picker"
                role="group"
                aria-label="Workspace layout"
              >
                {(["comfy", "compact"] as const).map((mode) => (
                  <button
                    key={mode}
                    aria-pressed={interfaceMode === mode}
                    disabled={interfaceBusy}
                    onClick={() =>
                      void changeInterface({ ...interfacePreferences, mode })
                    }
                  >
                    {mode === "comfy" ? "Comfy" : "Compact"}
                  </button>
                ))}
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
            {settingsSection ? (
              <>
                {settingsSection === "academic" && (
                  <SettingsDetail
                    title="Academic & planning settings"
                    subtitle="Manage terms, profile timezone, availability, and planning preferences."
                    close={closeSettingsSection}
                  >
                    <AcademicSettingsView
                      embedded
                      onDashboard={setData}
                      onImport={() => setModal("import")}
                      onStudy={() => setView("study")}
                    />
                  </SettingsDetail>
                )}
                {settingsSection === "account" && (
                  <AccountSettings
                    accountStatus={accountStatus}
                    setAccountStatus={setAccountStatus}
                    setToast={setToast}
                    close={closeSettingsSection}
                  />
                )}
                {settingsSection === "ai" && (
                  <AiSettings
                    aiProviders={aiProviders}
                    setAiProviders={setAiProviders}
                    close={closeSettingsSection}
                    setToast={setToast}
                  />
                )}
                {settingsSection === "canvas" && (
                  <CanvasSettings
                    data={data}
                    close={closeSettingsSection}
                    onDashboard={setData}
                    onToast={setToast}
                  />
                )}
                {settingsSection === "backups" && (
                  <BackupSettings
                    close={closeSettingsSection}
                    setToast={setToast}
                    onRestored={onBackupRestored}
                  />
                )}
                {settingsSection === "notifications" && (
                  <NotificationsSettings
                    data={data}
                    close={closeSettingsSection}
                    onDashboard={setData}
                    onToast={setToast}
                  />
                )}
                {settingsSection === "security" && (
                  <SecuritySettings
                    security={security}
                    setSecurity={setSecurity}
                    close={closeSettingsSection}
                    setToast={setToast}
                    lockWorkspace={lockWorkspace}
                  />
                )}
                {settingsSection === "updates" && (
                  <Suspense
                    fallback={
                      <div className="content">
                        <div className="loading" role="status">
                          Loading update configuration…
                        </div>
                      </div>
                    }
                  >
                    <UpdateModal
                      close={closeSettingsSection}
                      presentation="settings"
                    />
                  </Suspense>
                )}
                {settingsSection === "recovery" && (
                  <DataRecoverySettings
                    close={closeSettingsSection}
                    onDashboard={setData}
                    onToast={setToast}
                  />
                )}
              </>
            ) : view === "today" ? (
              <TodayView
                mode={interfaceMode}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                onEditTask={(id) => {
                  setSelectedTaskId(id);
                  setView("work");
                }}
                onCalendar={() => setView("calendar")}
                onWork={() => {
                  setWorkFilter("all");
                  setView("work");
                }}
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
                onDismissChecklist={() => {
                  rememberDismissal();
                  setChecklistDismissed(true);
                }}
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
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                onEditTask={(id) => {
                  setSelectedTaskId(id);
                  setView("work");
                }}
                onDashboard={setData}
                onImport={() => setModal("import")}
                onStudy={() => setView("study")}
                onConnections={() => showSettingsSection("canvas")}
                canvasConnections={data.canvasConnections}
              />
            ) : view === "work" ? (
              <WorkView
                mode={interfaceMode}
                initialTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                initialFilter={workFilter}
                onFilterChange={setWorkFilter}
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
                  void changeInterface({
                    ...interfacePreferences,
                    themes: {
                      ...interfacePreferences.themes,
                      [interfaceMode]: next,
                    },
                  });
                }}
                onAccent={(next) => {
                  setAccent(next);
                  applyAppearance(appearance, next);
                  void updateAccent(next).catch((value) =>
                    setError(String(value)),
                  );
                }}
                interfaceMode={interfaceMode}
                onInterfaceMode={(mode) =>
                  void changeInterface({ ...interfacePreferences, mode })
                }
                onDeleteProfile={() => {
                  setDeleteConfirmation("");
                  setModal("delete-profile");
                }}
                onCanvas={() => {
                  showSettingsSection("canvas");
                }}
                onAi={() => void openAiSettings()}
                onAccount={() => void openAccount()}
                onBackups={openBackups}
                onSecurity={openSecurity}
                onUpdates={() => showSettingsSection("updates")}
                onNotifications={openNotifications}
                onAcademic={() => showSettingsSection("academic")}
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
          {interfaceMode === "compact" && (
            <footer className="shell-shortcuts">
              <button onClick={() => setModal("search")}>
                <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd>{" "}
                Command
              </button>
              <button onClick={() => setModal("task")}>
                <Plus size={14} /> Add task
              </button>
              <button onClick={() => setView("calendar")}>Open Calendar</button>
              <button onClick={() => setModal("replan")}>Replan</button>
            </footer>
          )}
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
              <span>
                PDF, image, ICS, Word, Excel, CSV, PowerPoint, or text
              </span>
              <span>
                Or paste a screenshot of your schedule with Ctrl/Cmd+V
              </span>
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
              <ShieldCheck /> The original stays private. AI is never used
              without a connected provider and explicit consent.
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
                        wrong, it can ask your selected AI provider to try again
                        — that sends{" "}
                        <strong>this image and the text read from it</strong>{" "}
                        off your computer. Everything it proposes still needs
                        your review, and you never have to do this.
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
                No candidates are waiting for review. The encrypted source
                remains available in your vault.
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
                  Keep the original image or document encrypted for later
                  review, or delete the source now. Coqui never makes this
                  choice silently.
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
                      settleScheduleSource(
                        retentionDocumentIds[0],
                        "delete_now",
                      ),
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
                  Responses become reviewable candidates and can’t directly
                  alter your plan. A failure is never retried with another
                  provider without asking.
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
                <option value="planner_explanation">
                  Explain planner facts
                </option>
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
                <button
                  className="outline"
                  onClick={() => void openAiSettings()}
                >
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
                  Close this dialog and use Backups to export. Deletion cannot
                  be undone and Student Center will return to first-run
                  onboarding.
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
