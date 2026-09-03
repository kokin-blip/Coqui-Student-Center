import { TaskDetailsSession } from "./features/tasks/TaskDetailsSession";
import type { WorkFilter } from "./components/WorkView";
import type { StudyTab } from "./features/study/studyModel";
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
  ChevronRight,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Search,
  WifiOff,
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
import { OnboardingExperience } from "./components/OnboardingExperience";
import {
  isSetupChecklistDismissed,
  rememberDismissal,
} from "./components/SetupChecklist";
import type { SettingsSection } from "./components/SettingsView";
import { TodayView } from "./components/TodayView";
import { PlanningDialogs } from "./features/overlays/PlanningDialogs";
import {
  AssistantDialog,
  type AssistantCapability,
} from "./features/overlays/AssistantDialog";
import { DeleteProfileDialog } from "./features/overlays/DeleteProfileDialog";
import { ImportDialog } from "./features/overlays/ImportDialog";
import {
  CalendarRefreshDialog,
  changeKey,
  RetentionDialog,
  ReviewDialog,
} from "./features/overlays/ReviewDialogs";
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

type Overlay =
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
  const [studyTarget, setStudyTarget] = useState<{
    courseId?: string;
    tab?: StudyTab;
  }>({});
  const interfaceMode = interfacePreferences.mode;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  // A "system" preference has to keep following the OS while the app is open.
  useEffect(() => watchSystemAppearance(() => appearanceRef.current), []);
  const [data, setData] = useState<Dashboard | null>(null);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [taskDetailsSession, setTaskDetailsSession] = useState(0);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [modal, setModal] = useState<Overlay>(null);
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
  const [assistantCapability, setAssistantCapability] =
    useState<AssistantCapability>("brain_dump");
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
  const decideCandidates = async (choice: "approve" | "reject") => {
    const selectedSources = [
      ...new Set(
        pending
          .filter((item) => selectedCandidates.includes(item.id))
          .map((item) => item.documentId),
      ),
    ];
    const next = await run(
      () =>
        choice === "approve"
          ? approveCandidates(selectedCandidates)
          : rejectCandidates(selectedCandidates),
      choice === "approve"
        ? `${selectedCandidates.length} items approved and planned.`
        : `${selectedCandidates.length} candidates rejected.`,
    );
    if (!next) return;
    const ready = selectedSources.filter(
      (id) =>
        next.unsettledScheduleSources.includes(id) &&
        !next.candidates.some(
          (item) => item.documentId === id && item.status === "pending",
        ),
    );
    if (ready.length) {
      setRetentionDocumentIds(ready);
      setModal("retention");
    } else {
      setModal(null);
    }
  };
  const chooseRetention = async (
    choice: "delete_now" | "keep_encrypted",
  ) => {
    const next = await run(
      () => settleScheduleSource(retentionDocumentIds[0], choice),
      choice === "delete_now"
        ? "Schedule source deleted."
        : "Schedule source kept encrypted.",
    );
    if (!next) return;
    const remaining = retentionDocumentIds.slice(1);
    setRetentionDocumentIds(remaining);
    if (!remaining.length) setModal(null);
  };
  const applySchoolCalendar = async () => {
    if (!calendarDiff) return;
    const next = await run(
      () =>
        applyCalendarDiff({
          termChanges: calendarDiff.changedTerms.filter(
            (change) => !declinedChanges.includes(changeKey(change)),
          ),
          noClassDates: calendarDiff.addedNoClassDates,
        }),
      "Calendar updated.",
    );
    if (!next) return;
    setCalendarDiff(null);
    setDeclinedChanges([]);
    setModal(null);
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
              <ModularStudyView
                onOpenAssistant={() => void openAiSettings()}
                initialCourseId={studyTarget.courseId}
                initialTab={studyTarget.tab}
              />
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
                onOpenTask={(id) => {
                  setSelectedTaskId(id);
                  setWorkFilter("all");
                  setView("work");
                }}
                onOpenStudy={(courseId, tab) => {
                  setStudyTarget({ courseId, tab });
                  setView("study");
                }}
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
          <ImportDialog
            busy={busy}
            pasteTarget={importPasteTarget}
            documents={documents}
            documentSearch={documentSearch}
            evidence={vaultEvidence}
            close={() => setModal(null)}
            openCanvas={() => showSettingsSection("canvas")}
            capture={async () => {
              setBusy(true);
              setError("");
              try {
                setToast(await launchScheduleCapture());
                window.setTimeout(() => importPasteTarget.current?.focus(), 0);
              } catch (next) {
                setError(String(next));
              } finally {
                setBusy(false);
              }
            }}
            photosImported={(next, count) => {
              setData(next);
              setToast(
                `${count} corrected photo${count === 1 ? "" : "s"} encrypted and extracted.`,
              );
              setModal("review");
            }}
            selectFile={() => {
              void run(async () => {
                const next = await selectAndImport();
                if (next) setModal("review");
                return next;
              }, "File encrypted and extraction completed.");
            }}
            enterManually={() => {
              setModal(null);
              setView("courses");
            }}
            setDocumentSearch={setDocumentSearch}
            openEvidence={async (documentId) => {
              setError("");
              try {
                const items = await getDocumentEvidence(documentId);
                setVaultEvidence({ documentId, items });
              } catch (next) {
                setError(String(next));
              }
            }}
            closeEvidence={() => setVaultEvidence(null)}
            rereadWithAi={(documentId) => {
              void run(async () => {
                const available = await listAiProviders();
                const resolved = available.find(
                  (item) => item.connected && item.healthy,
                );
                if (!resolved) {
                  throw new Error(
                    "Connect and test an AI provider in Settings first.",
                  );
                }
                const approved = window.confirm(
                  `Send this screenshot and its locally extracted text to ${resolved.provider} (${resolved.model})? Nothing else in your vault is included.`,
                );
                if (!approved) return null;
                const result = await readScheduleWithAi(documentId, true);
                setModal("review");
                return result.dashboard;
              }, "Your selected AI provider proposed classes for review; nothing was added to your plan.");
            }}
            onError={setError}
          />
        )}
        {modal === "review" && (
          <ReviewDialog
            candidates={pending}
            selectedIds={selectedCandidates}
            conflictedIds={conflictCandidateIds}
            busy={busy}
            terms={todayWorkspace?.terms ?? []}
            hasSourceChanges={data.conflicts.some(
              (conflict) => conflict.kind === "source_change",
            )}
            close={() => setModal(null)}
            openConflicts={() => setModal("conflicts")}
            onSelection={setSelectedCandidates}
            onDashboard={setData}
            onError={setError}
            decide={(choice) => void decideCandidates(choice)}
          />
        )}
        {modal === "retention" && (
          <RetentionDialog
            count={retentionDocumentIds.length}
            busy={busy}
            close={() => setModal(null)}
            choose={(choice) => void chooseRetention(choice)}
          />
        )}
        {modal === "calendar-refresh" && calendarDiff && (
          <CalendarRefreshDialog
            diff={calendarDiff}
            declinedChanges={declinedChanges}
            busy={busy}
            close={() => setModal(null)}
            setDeclinedChanges={setDeclinedChanges}
            apply={() => void applySchoolCalendar()}
          />
        )}
        <PlanningDialogs
          active={
            modal === "conflicts" || modal === "replan" ? modal : null
          }
          dashboard={data}
          busy={busy}
          replanReason={replanReason}
          close={() => setModal(null)}
          openReplan={() => setModal("replan")}
          setReplanReason={setReplanReason}
          resolveConflict={(id, resolution, message) => {
            void run(
              () => resolveSourceConflict(id, resolution),
              message,
            );
          }}
          submitReplan={() => {
            void run(
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
            ).then(() => setModal(null));
          }}
        />
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
          <AssistantDialog
            providers={aiProviders}
            busy={busy}
            capability={assistantCapability}
            excerpt={assistantExcerpt}
            consent={assistantConsent}
            explanation={assistantExplanation}
            close={() => setModal(null)}
            openSettings={() => void openAiSettings()}
            setCapability={setAssistantCapability}
            setExcerpt={setAssistantExcerpt}
            setConsent={setAssistantConsent}
            submit={async () => {
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
          />
        )}
        {modal === "delete-profile" && (
          <DeleteProfileDialog
            busy={busy}
            confirmation={deleteConfirmation}
            close={() => setModal(null)}
            setConfirmation={setDeleteConfirmation}
            erase={() => void eraseProfile()}
          />
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
