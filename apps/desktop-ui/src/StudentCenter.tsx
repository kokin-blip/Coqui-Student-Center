import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileLock2,
  FileUp,
  HardDrive,
  Home,
  LayoutGrid,
  Link2,
  ListChecks,
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
import { AppLogo } from "./components/AppLogo";
import { OnboardingExperience } from "./components/OnboardingExperience";
import {
  isSetupChecklistDismissed,
  SetupChecklist,
} from "./components/SetupChecklist";
import {
  applyAppearance,
  AppearancePreference,
  initialAppearance,
  ThemeControls,
} from "./components/ThemeControls";
import {
  AccountStatus,
  AcademicCalendarEventInput,
  addTask,
  approveCandidates,
  BackupPreview,
  CalendarAgenda,
  cancelGoogleSignIn,
  changePin,
  checkForUpdates,
  CommitmentEditorInput,
  CommitmentRecord,
  connectCanvas,
  CourseInput,
  CourseRecord,
  createCommitment,
  createAcademicEvent,
  createAcademicTerm,
  createClassMeeting,
  createCourse,
  createInstructor,
  createLocalTask,
  AcademicCalendarEventRecord,
  AcademicTermInput,
  AcademicTermRecord,
  ClassMeetingSeriesRecord,
  InstructorRecord,
  Dashboard,
  deleteAcademicEvent,
  deleteAcademicTerm,
  deleteClassMeeting,
  deleteCommitment,
  deleteCourse,
  deleteInstructor,
  deleteLocalProfile,
  deleteLocalTask,
  DocumentSummary,
  disablePin,
  dismissReminder,
  disconnectCanvas,
  enablePin,
  exportEncryptedBackup,
  getAccountStatus,
  getCalendarAgenda,
  getDocumentEvidence,
  getDashboard,
  getLocalWorkspace,
  getUpdateStatus,
  initialize,
  isDesktop,
  importDocumentPath,
  listenForAccountChanges,
  listenForOcrStatus,
  OcrStatus,
  listenForFileDrops,
  listenForNavigation,
  lockApp,
  listDocuments,
  NavigationTarget,
  OnboardingState,
  PreferenceInput,
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
  setPlanBlockLock,
  signOutAccount,
  snoozeReminder,
  startGoogleSignIn,
  startPlanBlock,
  syncCanvas,
  takePendingNavigation,
  TaskInput,
  TaskRecord,
  toggleTask,
  unlockWithPin,
  updateCommitment,
  updateAcademicEvent,
  updateAcademicTerm,
  updateClassMeeting,
  updateCourse,
  updateInstructor,
  updateAppearance,
  updateLocalTask,
  updateNotificationSettings,
  updatePlanningPreferences,
  updateStudentProfile,
  UpdateStatus,
  verifyEmailCode,
  WorkspaceSnapshot,
  LegacyQuarantineItem,
  listLegacyQuarantine,
  restoreLegacyQuarantine,
  purgeLegacyQuarantine,
} from "./native";
import {
  beginSyncProtection,
  approveSyncDevice,
  cancelSyncProtection,
  checkExistingDeviceApproval,
  confirmSyncProtection,
  connectEncryptedSync,
  EncryptedSyncStatus,
  getEncryptedSyncStatus,
  getSyncProtectionStatus,
  listAuthorizedSyncDevices,
  listPendingSyncDevices,
  PendingSyncDevice,
  pullEncryptedMutations,
  pushEncryptedMutations,
  recoverSyncProtection,
  RecoverySetup,
  requestExistingDeviceApproval,
  revokeSyncDevice,
  SyncProtectionStatus,
} from "./native";

type Modal =
  | "search"
  | "import"
  | "review"
  | "conflicts"
  | "replan"
  | "task"
  | "assistant"
  | "canvas"
  | "backups"
  | "security"
  | "notifications"
  | "updates"
  | "account"
  | "delete-profile"
  | "recovery"
  | null;
const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
};
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
const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const zonedDateKey = (value: string | Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

type BootPhase = "loading" | "ready" | "error";
const BOOT_WATCHDOG_MS = 15000;
const BOOT_RECOVERY_DELAY_MS = 1200;
const BOOT_MAX_ATTEMPTS = 3;

export function StudentCenter() {
  const [view, setView] = useState<
    "today" | "timetable" | "assignments" | "courses"
  >(
    "today",
  );
  const [appearance, setAppearance] = useState<AppearancePreference>(initialAppearance);
  const [data, setData] = useState<Dashboard | null>(null);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replanReason, setReplanReason] = useState("I woke up late");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskMinutes, setTaskMinutes] = useState(30);
  const [taskDue, setTaskDue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState<WorkspaceSnapshot | null>(null);
  const [canvasUrl, setCanvasUrl] = useState("");
  const [canvasToken, setCanvasToken] = useState("");
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
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
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
    "brain_dump" | "document_extraction" | "task_decomposition" | "explanation"
  >("brain_dump");
  const [assistantExcerpt, setAssistantExcerpt] = useState("");
  const [assistantConsent, setAssistantConsent] = useState(false);
  const [assistantExplanation, setAssistantExplanation] = useState("");
  const [legacyItems, setLegacyItems] = useState<LegacyQuarantineItem[]>([]);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [ocrStatus, setOcrStatus] = useState<OcrStatus | null>(null);
  const [todayWorkspace, setTodayWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [checklistDismissed, setChecklistDismissed] = useState(isSetupChecklistDismissed);
  const [bootPhase, setBootPhase] = useState<BootPhase>("loading");
  const [bootError, setBootError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);
  const retryBoot = useCallback(() => setBootAttempt((attempt) => attempt + 1), []);

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
        getLocalWorkspace().then((workspace) => {
          setTodayWorkspace(workspace);
          setAppearance(workspace.appearance);
          applyAppearance(workspace.appearance);
        }).catch(() => undefined);
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
    listenForOcrStatus((status) => { if (active) setOcrStatus(status); })
      .then((dispose) => { if (active) stop = dispose; else dispose(); })
      .catch(() => undefined);
    return () => { active = false; stop(); };
  }, []);

  // Keep the Today checklist honest as the student adds courses and work. Only
  // runs while the checklist can still be shown.
  useEffect(() => {
    if (checklistDismissed || !data) return;
    let active = true;
    getLocalWorkspace()
      .then((workspace) => { if (active) setTodayWorkspace(workspace); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [data, checklistDismissed]);
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
  useEffect(() => {
    if (modal !== "import" || !isDesktop()) return;
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
  }, [modal]);
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
  const reviewablePending = pending.filter(
    (candidate) => !conflictCandidateIds.has(candidate.id),
  );
  useEffect(() => {
    if (modal === "review")
      setSelectedCandidates(reviewablePending.map((candidate) => candidate.id));
  }, [modal, data?.candidates.length, data?.conflicts.length]);
  const remaining = useMemo(
    () =>
      data?.blocks
        .filter((b) => !b.completed)
        .reduce((sum, b) => sum + minutesBetween(b.startsAt, b.endsAt), 0) ?? 0,
    [data],
  );
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
    } catch (e) {
      setError(String(e));
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
    setModal("backups");
  };
  const openDataRecovery = async () => {
    setModal("recovery");
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
    setModal(null);
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
      setBackupPassphrase("");
      setModal(null);
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
    setModal("security");
  };
  const closeSecurity = () => {
    resetPinFields();
    setPinMode("home");
    setModal(null);
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
    setModal("notifications");
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
    ).then(() => setModal(null));
  const openUpdates = async () => {
    setError("");
    setModal("updates");
    setBusy(true);
    try {
      setUpdateStatus(await getUpdateStatus());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const runUpdateCheck = async () => {
    setBusy(true);
    setError("");
    try {
      setUpdateStatus(await checkForUpdates());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const openAccount = async () => {
    setError("");
    setAccountCode("");
    setAccountMode("email");
    setModal("account");
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
            <button className="solid" onClick={retryBoot}>Try again</button>
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
          if (result.dashboard) setData(result.dashboard);
          else retryBoot();
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
            <button className="solid" onClick={retryBoot}>Reload plan</button>
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
    <div className="app-shell">
      {modal === "account" && (
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
          close={() => setModal(null)}
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
      )}
      <aside className="sidebar">
        <div className="brand">
          <AppLogo wordmark />
        </div>
        <p className="nav-label">Plan</p>
        <nav aria-label="Primary navigation">
          <button
            className={`nav-item ${view === "today" ? "active" : ""}`}
            aria-label="Today"
            onClick={() => setView("today")}
          >
            <Home />
            <span>Today</span>
          </button>
          <button
            className={`nav-item ${view === "timetable" ? "active" : ""}`}
            aria-label="Timetable"
            onClick={() => setView("timetable")}
          >
            <CalendarDays />
            <span>Timetable</span>
          </button>
          <button
            className={`nav-item ${view === "assignments" ? "active" : ""}`}
            aria-label="Assignments"
            onClick={() => setView("assignments")}
          >
            <ListChecks />
            <span>Assignments</span>
          </button>
          <button
            className={`nav-item ${view === "courses" ? "active" : ""}`}
            aria-label="Courses"
            onClick={() => setView("courses")}
          >
            <BookOpen />
            <span>Courses</span>
          </button>
        </nav>
        <p className="nav-label">More</p>
        <nav>
          <button
            className="nav-item"
            aria-label="Document vault"
            onClick={() => setModal("import")}
          >
            <FileLock2 />
            <span>Document vault</span>
            {pending.length > 0 && <b>{pending.length}</b>}
          </button>
          <button
            className="nav-item"
            aria-label="Canvas"
            onClick={() => setModal("canvas")}
          >
            <Link2 />
            <span>Canvas</span>
            {data.canvasConnections.some(
              (connection) => connection.status === "error",
            ) && <b>!</b>}
          </button>
          <button
            className="nav-item"
            aria-label="Backups"
            onClick={openBackups}
          >
            <HardDrive />
            <span>Backups</span>
          </button>
          <button
            className="nav-item"
            aria-label="Data recovery"
            onClick={() => void openDataRecovery()}
          >
            <RefreshCw />
            <span>Data recovery</span>
          </button>
          <button
            className="nav-item"
            aria-label="Optional account"
            onClick={openAccount}
          >
            <UserRound />
            <span>Optional account</span>
            {accountStatus?.signedIn && <b>✓</b>}
          </button>
          <button
            className="nav-item"
            aria-label="App updates"
            onClick={openUpdates}
          >
            <RefreshCw />
            <span>App updates</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <button
            className="nav-item"
            aria-label="Settings"
            onClick={openSecurity}
          >
            <Settings />
            <span>App lock</span>
          </button>
          <button
            className="nav-item danger-nav"
            aria-label="Delete local profile"
            onClick={() => {
              setDeleteConfirmation("");
              setError("");
              setModal("delete-profile");
            }}
          >
            <LogOut />
            <span>Delete local profile</span>
          </button>
          <div className="privacy">
            <ShieldCheck />
            <span>
              <strong>Private by default</strong>
              <small>Encrypted on this device</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">
            <LayoutGrid />
            <span>
              {view === "today" ? "Today" : view === "timetable" ? "Timetable" : view === "assignments" ? "Assignments" : "Courses"}
            </span>
            <ChevronRight />
            <span>{view === "today" ? "Agenda" : "Local workspace"}</span>
          </div>
          <div className="top-actions">
            <ThemeControls
              compact
              value={appearance}
              onChange={(next) => {
                setAppearance(next);
                applyAppearance(next);
                void updateAppearance(next).catch((value) => setError(String(value)));
              }}
            />
            <span className="offline">
              <WifiOff /> Works offline
            </span>
            <button
              className="icon-btn"
              aria-label="Search"
              onClick={() => {
                setSearchQuery("");
                setModal("search");
                getLocalWorkspace()
                  .then(setSearchIndex)
                  .catch((next) => setError(String(next)));
              }}
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
        {view === "today" ? (
          <div className="content">
            <div className="page-head">
              <div>
                <p className="eyebrow">
                  {new Intl.DateTimeFormat([], {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  }).format(new Date())}
                </p>
                <h1>
                  {greeting()}, {data.studentName.split(" ")[0]}.
                </h1>
                <p>
                  Your plan is stored locally and ready, even without internet.
                </p>
              </div>
              <span className="mode-pill">
                <HardDrive />{" "}
                {isDesktop() ? "Desktop workspace" : "UI test mode"}
              </span>
            </div>
            {error && (
              <div className="alert">
                <CircleAlert />
                <span>{error}</span>
                <button onClick={() => setError("")}>
                  <X />
                </button>
              </div>
            )}
            {!checklistDismissed && todayWorkspace && (
              <SetupChecklist
                workspace={todayWorkspace}
                onOpenCourses={() => setView("courses")}
                onAddTask={() => setModal("task")}
                onImport={() => setModal("import")}
                onDismiss={() => setChecklistDismissed(true)}
              />
            )}
            <div className="hero-grid">
              <section className="next-card">
                <div className="next-top">
                  <span>
                    <Zap /> Your next best action
                  </span>
                  <b>{data.nextAction?.durationMinutes ?? 0} minutes</b>
                </div>
                <h2>{data.nextAction?.title ?? "Your plan is clear"}</h2>
                <p>
                  {data.nextAction?.explanation ??
                    "Add a task or import a syllabus to build your plan."}
                </p>
                <div className="reason-row">
                  {data.nextAction?.reasonCodes.map((code) => (
                    <span key={code}>{code.replaceAll("_", " ")}</span>
                  ))}
                </div>
                {Boolean(data.nextAction?.alternatives.length) && (
                  <p className="alternatives">
                    <strong>Other feasible options:</strong>{" "}
                    {data.nextAction?.alternatives
                      .map(
                        (item) => `${item.title} (${item.durationMinutes} min)`,
                      )
                      .join(" · ")}
                  </p>
                )}
                <div className="next-actions">
                  <button
                    className="primary"
                    disabled={!data.nextAction || busy}
                    onClick={() => {
                      const action = data.nextAction;
                      if (action)
                        void run(
                          () => startPlanBlock(action.blockId),
                          "Focus session started — you’ve got this.",
                        );
                    }}
                  >
                    <Play /> Start this now
                  </button>
                  <button className="ghost" onClick={() => setModal("replan")}>
                    Something changed
                  </button>
                </div>
              </section>
              <aside className="capacity">
                <p>Today’s capacity</p>
                <div>
                  <strong>
                    {Math.floor(remaining / 60)}h {remaining % 60}m
                  </strong>
                  <span>remaining</span>
                </div>
                <div className="meter">
                  <i
                    style={{
                      width: `${Math.min(100, (remaining / 360) * 100)}%`,
                    }}
                  />
                </div>
                <dl>
                  <div>
                    <dt>{data.blocks.filter((b) => b.completed).length}</dt>
                    <dd>completed</dd>
                  </div>
                  <div>
                    <dt>{data.conflicts.length}</dt>
                    <dd>conflicts</dd>
                  </div>
                </dl>
              </aside>
            </div>
            <div className="section-head">
              <h2>Today’s plan</h2>
              <button onClick={() => setModal("replan")}>
                <RefreshCw /> Replan my day
              </button>
            </div>
            <div className="body-grid">
              <section className="timeline">
                {data.blocks.length ? (
                  data.blocks.map((block) => (
                    <div
                      className="timeline-row"
                      id={`plan-block-${block.id}`}
                      key={block.id}
                    >
                      <time>{formatTime(block.startsAt)}</time>
                      <div className="rail">
                        <i />
                      </div>
                      <article
                        className={`event ${block.kind} ${block.completed ? "done" : ""} ${block.startedAt ? "started" : ""}`}
                      >
                        <div>
                          <strong>{block.title}</strong>
                          <p>
                            {minutesBetween(block.startsAt, block.endsAt)} min ·{" "}
                            {block.locked ? "Fixed" : "Flexible"}
                            {block.startedAt ? " · In progress" : ""}
                          </p>
                          <div className="reason-row small">
                            {block.reasonCodes.slice(0, 2).map((code) => (
                              <span key={code}>
                                {code.replaceAll("_", " ")}
                              </span>
                            ))}
                          </div>
                        </div>
                        <button
                          className="check"
                          aria-label={`Mark ${block.title} ${block.completed ? "incomplete" : "complete"}`}
                          disabled={!block.taskId || busy}
                          onClick={() =>
                            run(
                              () => toggleTask(block.taskId!),
                              "Progress saved locally.",
                            )
                          }
                        >
                          {block.completed && <Check />}
                        </button>
                      </article>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <CalendarDays />
                    <strong>Nothing scheduled today</strong>
                    <p>
                      Add a task or import a syllabus. Student Center will only
                      place work in feasible windows.
                    </p>
                  </div>
                )}
              </section>
              <aside className="side-stack">
                <section className="small-card">
                  <div className="small-head">
                    <h3>Quick capture</h3>
                    <span>Local</span>
                  </div>
                  <div className="quick-grid">
                    <button onClick={() => setModal("import")}>
                      <FileUp /> Import work
                    </button>
                    <button onClick={() => setModal("task")}>
                      <ListChecks /> Add a task
                    </button>
                    <button
                      onClick={() => {
                        setAssistantExplanation("");
                        setModal("assistant");
                        getAccountStatus()
                          .then(setAccountStatus)
                          .catch((e) => setError(String(e)));
                      }}
                    >
                      <Brain /> Brain dump
                    </button>
                    <button onClick={() => setModal("replan")}>
                      <RefreshCw /> Adjust day
                    </button>
                  </div>
                </section>
                {data.conflicts.length > 0 && (
                  <section className="small-card vault-card conflict-summary">
                    <CircleAlert />
                    <div>
                      <h3>
                        {data.conflicts.length} decision
                        {data.conflicts.length === 1 ? "" : "s"} needed
                      </h3>
                      <p>
                        {data.conflicts.some(
                          (conflict) => conflict.kind === "source_change",
                        )
                          ? "Canvas reported a critical date change. Your current plan remains unchanged until you choose."
                          : "Some work does not fit without a conflict."}
                      </p>
                      <button onClick={() => setModal("conflicts")}>
                        Review conflicts
                      </button>
                    </div>
                  </section>
                )}
                <section className="small-card vault-card">
                  <FileLock2 />
                  <div>
                    <h3>Encrypted vault</h3>
                    <p>
                      {pending.length
                        ? `${pending.length} extracted item${pending.length === 1 ? "" : "s"} awaiting your review.`
                        : "Imported files and evidence stay encrypted on this device."}
                    </p>
                    {pending.length > 0 && (
                      <button onClick={() => setModal("review")}>
                        Review candidates
                      </button>
                    )}
                  </div>
                </section>
                <section
                  className={`small-card vault-card ${ocr.phase === "ready" ? "ocr-ready" : ocr.phase === "checking" ? "ocr-checking" : "ocr-attention"}`}
                >
                  {ocr.phase === "ready" ? (
                    <ShieldCheck />
                  ) : ocr.phase === "checking" ? (
                    <Loader />
                  ) : (
                    <CircleAlert />
                  )}
                  <div>
                    <h3>
                      {ocr.phase === "ready"
                        ? "Local OCR ready"
                        : ocr.phase === "checking"
                          ? "Checking local OCR"
                          : "OCR runtime needed"}
                    </h3>
                    <p>{ocr.message}</p>
                    <small>
                      Engine: {ocr.engineSource} · PDF renderer:{" "}
                      {ocr.rendererSource}
                    </small>
                  </div>
                </section>
                <section className="small-card vault-card">
                  <Link2 />
                  <div>
                    <h3>Canvas read-only</h3>
                    <p>
                      {data.canvasConnections.length
                        ? `${data.canvasConnections.length} local connection${data.canvasConnections.length === 1 ? "" : "s"}. ${data.canvasConnections.reduce((sum, connection) => sum + connection.pendingCandidates, 0)} changes await review.`
                        : "Connect with a personal token. Credentials stay in the OS vault."}
                    </p>
                    <button onClick={() => setModal("canvas")}>
                      {data.canvasConnections.length
                        ? "Manage sync"
                        : "Connect Canvas"}
                    </button>
                  </div>
                </section>
              </aside>
            </div>
          </div>
        ) : (
          <WorkspaceView mode={view} onDashboard={(next) => setData(next)} />
        )}
      </main>
      <button className="fab" onClick={() => setModal("task")} aria-label="Quick add">
        <Plus />
        <span>Quick add</span>
      </button>
      <nav className="mobile-nav">
        <button
          className={view === "today" ? "active" : ""}
          onClick={() => setView("today")}
        >
          <Home />
          Today
        </button>
        <button
          className={view === "timetable" ? "active" : ""}
          onClick={() => setView("timetable")}
        >
          <CalendarDays />
          Timetable
        </button>
        <button
          className={view === "assignments" ? "active" : ""}
          onClick={() => setView("assignments")}
        >
          <ListChecks />
          Assignments
        </button>
        <button onClick={() => setModal("import")}>
          <FileLock2 />
          Vault
        </button>
        <button onClick={() => setModal("task")}>
          <Plus />
          Add
        </button>
        <button
          className={view === "courses" ? "active" : ""}
          onClick={() => setView("courses")}
        >
          <BookOpen />
          Courses
        </button>
      </nav>
      {modal === "import" && (
        <Modal
          title="Import into your encrypted vault"
          subtitle="Student Center copies and encrypts the file. Nothing changes until you approve extracted facts."
          close={() => setModal(null)}
        >
          <button
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
            <strong>Choose or drop academic files</strong>
            <span>PDF, image, ICS, Word, Excel, CSV, PowerPoint, or text</span>
          </button>
          <p className="privacy-note">
            <ShieldCheck /> The original stays private. AI is never used without
            sign-in and explicit consent.
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
                        {document.approvedCount} approved · {document.pendingCount}{" "}
                        pending
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
              <div className="candidate-list">
                {pending.map((c) => {
                  const conflicted = conflictCandidateIds.has(c.id);
                  return (
                    <label
                      className={`candidate ${conflicted ? "candidate-conflicted" : ""}`}
                      key={c.id}
                    >
                      <input
                        type="checkbox"
                        disabled={conflicted}
                        checked={
                          !conflicted && selectedCandidates.includes(c.id)
                        }
                        onChange={(event) =>
                          setSelectedCandidates((current) =>
                            event.target.checked
                              ? [...current, c.id]
                              : current.filter((id) => id !== c.id),
                          )
                        }
                      />
                      <span>
                        <strong>{c.title}</strong>
                        <small>
                          {c.kind === "commitment"
                            ? "Calendar commitment"
                            : c.kind === "course"
                              ? "Active course"
                              : "Academic task"}{" "}
                          · {c.course}
                          {c.dueAt
                            ? ` · Due ${new Date(c.dueAt).toLocaleString()}`
                            : ""}
                          {c.startsAt
                            ? ` · ${new Date(c.startsAt).toLocaleString()}`
                            : ""}
                          {c.durationMinutes
                            ? ` · ${c.durationMinutes} min`
                            : ""}
                        </small>
                        <q>{c.evidence}</q>
                        <em>
                          {c.sourceLocator} ·{" "}
                          {c.sourceType.replaceAll("_", " ")}
                        </em>
                        {conflicted && (
                          <mark>
                            Resolve this critical date separately; bulk approval
                            is disabled.
                          </mark>
                        )}
                        {c.warnings.map((warning) => (
                          <mark key={warning}>{warning}</mark>
                        ))}
                      </span>
                      <b>{Math.round(c.confidence * 100)}%</b>
                    </label>
                  );
                })}
              </div>
              <div className="modal-actions split-actions">
                <button
                  className="outline danger"
                  disabled={!selectedCandidates.length || busy}
                  onClick={() =>
                    run(
                      () => rejectCandidates(selectedCandidates),
                      `${selectedCandidates.length} candidates rejected.`,
                    ).then(() => setModal(null))
                  }
                >
                  Reject selected
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
                    ).then(() => setModal(null))
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
        <Modal
          title="Search"
          subtitle="Find a course, assignment, or commitment. Everything is searched locally."
          close={() => setModal(null)}
        >
          <label className="field">
            Search
            <input
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Statistics, ENG 102, midterm…"
            />
          </label>
          {(() => {
            if (!searchIndex)
              return (
                <div className="empty-state">
                  <Search />
                  <strong>Loading your local records…</strong>
                </div>
              );
            const needle = searchQuery.trim().toLowerCase();
            if (!needle)
              return (
                <div className="empty-state">
                  <Search />
                  <strong>Search your workspace</strong>
                  <p>
                    {searchIndex.courses.length} courses,{" "}
                    {searchIndex.tasks.length} assignments, and{" "}
                    {searchIndex.commitments.length} commitments.
                  </p>
                </div>
              );
            const matches = (value: string) =>
              value.toLowerCase().includes(needle);
            const courses = searchIndex.courses.filter(
              (item) => matches(item.title) || matches(item.code),
            );
            const tasks = searchIndex.tasks.filter((item) =>
              matches(item.title),
            );
            const commitments = searchIndex.commitments.filter(
              (item) => matches(item.title) || matches(item.location),
            );
            if (!courses.length && !tasks.length && !commitments.length)
              return (
                <div className="empty-state">
                  <Search />
                  <strong>No matches</strong>
                  <p>Nothing local matches “{searchQuery.trim()}”.</p>
                </div>
              );
            const go = (destination: "courses" | "assignments" | "timetable") => {
              setModal(null);
              setView(destination);
            };
            return (
              <div className="record-list compact">
                {courses.map((item) => (
                  <article key={item.id}>
                    <div className="record-icon course">
                      <BookOpen />
                    </div>
                    <div>
                      <strong>{item.code || item.title}</strong>
                      <small>{item.title}</small>
                    </div>
                    <div className="record-actions">
                      <button className="outline" onClick={() => go("courses")}>
                        Open
                      </button>
                    </div>
                  </article>
                ))}
                {tasks.map((item) => (
                  <article
                    className={item.completed ? "record-complete" : ""}
                    key={item.id}
                  >
                    <div className="record-icon task">
                      <ListChecks />
                    </div>
                    <div>
                      <strong>{item.title}</strong>
                      <small>
                        {item.minutes} min
                        {item.dueAt ? ` · Due ${formatDateTime(item.dueAt)}` : ""}
                      </small>
                    </div>
                    <div className="record-actions">
                      <button
                        className="outline"
                        onClick={() => go("assignments")}
                      >
                        Open
                      </button>
                    </div>
                  </article>
                ))}
                {commitments.map((item) => (
                  <article key={item.id}>
                    <div className="record-icon commitment">
                      <CalendarDays />
                    </div>
                    <div>
                      <strong>{item.title}</strong>
                      <small>
                        {formatDateTime(item.startsAt)}
                        {item.location ? ` · ${item.location}` : ""}
                      </small>
                    </div>
                    <div className="record-actions">
                      <button
                        className="outline"
                        onClick={() => go("timetable")}
                      >
                        Open
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            );
          })()}
        </Modal>
      )}
      {modal === "task" && (
        <Modal
          title="Quick add"
          subtitle="Capture an assignment now, or use the detailed editor for exams and constraints."
          close={() => setModal(null)}
        >
          <label className="field">
            Assignment title
            <input
              autoFocus
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="Finish statistics problem set"
            />
          </label>
          <label className="field">
            Estimate in minutes
            <input
              type="number"
              min="5"
              max="480"
              step="5"
              value={taskMinutes}
              onChange={(e) => setTaskMinutes(Number(e.target.value))}
            />
          </label>
          <label className="field">
            Due (optional)
            <input
              type="datetime-local"
              value={taskDue}
              onChange={(e) => setTaskDue(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button className="outline" onClick={() => setModal(null)}>
              Cancel
            </button>
            <button
              className="solid"
              disabled={!taskTitle.trim() || busy}
              onClick={() =>
                run(
                  () =>
                    addTask(
                      taskTitle.trim(),
                      taskMinutes,
                      taskDue ? new Date(taskDue).toISOString() : undefined,
                    ),
                  "Assignment saved and planned locally.",
                ).then(() => {
                  setTaskTitle("");
                  setTaskDue("");
                  setModal(null);
                })
              }
            >
              Add assignment
            </button>
          </div>
          <button
            className="quick-add-detailed"
            onClick={() => {
              setModal(null);
              setView("assignments");
            }}
          >
            <ListChecks /> Add an exam or detailed assignment
            <ChevronRight />
          </button>
        </Modal>
      )}
      {modal === "canvas" && (
        <Modal
          title="Canvas connection"
          subtitle="Read-only sync runs on this computer. Every imported fact remains pending until you review it."
          close={() => setModal(null)}
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
                    <small>{connection.baseUrl}</small>
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
                        () => syncCanvas(connection.id),
                        "Canvas refresh completed.",
                      )
                    }
                  >
                    <RefreshCw /> Refresh
                  </button>
                  <button
                    className="outline danger"
                    disabled={busy || connection.status === "disconnected"}
                    onClick={() =>
                      run(
                        () => disconnectCanvas(connection.id),
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
              <label className="field">
                Canvas address
                <input
                  value={canvasUrl}
                  onChange={(event) => setCanvasUrl(event.target.value)}
                  placeholder="https://canvas.yourcollege.edu"
                  autoComplete="url"
                />
              </label>
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
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>Read-only and local</strong>
                  <p>
                    Student Center validates the public HTTPS host, blocks
                    redirects and private networks, and never writes to Canvas.
                    The token is never stored in the SQL database or returned to
                    the interface.
                  </p>
                </div>
              </div>
              <div className="modal-actions">
                <button
                  className="solid"
                  disabled={
                    busy || !canvasUrl.trim() || canvasToken.length < 16
                  }
                  onClick={() =>
                    run(
                      () =>
                        connectCanvas(canvasUrl.trim(), canvasToken).then(
                          (next) => {
                            setCanvasToken("");
                            return next;
                          },
                        ),
                      "Canvas connected; review the imported facts.",
                    )
                  }
                >
                  Validate and connect
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {modal === "backups" && (
        <Modal
          title="Encrypted backups"
          subtitle="Create a portable archive or inspect one before replacing this local profile."
          close={closeBackups}
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
                        will be replaced. Canvas credentials are not restored.
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
      {modal === "notifications" && (
        <Modal
          title="Desktop reminders"
          subtitle="Choose when Student Center may alert you. Reminder controls stay available here because native toast buttons are not supported consistently on desktop."
          close={() => setModal(null)}
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
            <button className="outline" onClick={() => setModal(null)}>
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
      {modal === "security" && (
        <Modal
          title="App lock"
          subtitle="Add a private gate when you step away from this computer."
          close={closeSecurity}
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
      {modal === "updates" && (
        <Modal
          title="Student Center updates"
          subtitle="Private-beta builds check only an HTTPS channel and accept installers signed by the public key embedded at build time."
          close={() => setModal(null)}
        >
          {updateStatus ? (
            <>
              <div
                className={`update-state ${updateStatus.available ? "available" : updateStatus.configured ? "current" : "unconfigured"}`}
              >
                <RefreshCw />
                <span>
                  <strong>
                    {updateStatus.available
                      ? `Version ${updateStatus.latestVersion} is available`
                      : `Student Center ${updateStatus.currentVersion}`}
                  </strong>
                  <small>{updateStatus.message}</small>
                </span>
              </div>
              {updateStatus.notes && (
                <div className="release-notes">
                  <strong>Release notes</strong>
                  <p>{updateStatus.notes}</p>
                </div>
              )}
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>Signed artifacts only</strong>
                  <p>
                    Checking does not install anything. Download and
                    installation remain disabled in this alpha interface until
                    signed release infrastructure is configured and exercised on
                    both target platforms.
                  </p>
                </div>
              </div>
              {updateStatus.checkedAt && (
                <p className="privacy-note">
                  Last checked{" "}
                  {new Date(updateStatus.checkedAt).toLocaleString()}
                </p>
              )}
              <div className="modal-actions">
                <button className="outline" onClick={() => setModal(null)}>
                  Close
                </button>
                <button
                  className="solid"
                  disabled={busy || !isDesktop() || !updateStatus.configured}
                  onClick={runUpdateCheck}
                >
                  <RefreshCw /> {busy ? "Checking…" : "Check for updates"}
                </button>
              </div>
            </>
          ) : (
            <div className="empty">Loading update configuration…</div>
          )}
        </Modal>
      )}
      {modal === "assistant" && (
        <Modal
          title="Managed AI is optional"
          subtitle="Brain-dump structuring requires an account and internet. Core planning and local extraction never do."
          close={() => setModal(null)}
        >
          <div className="consent-box">
            <Sparkles />
            <div>
              <strong>
                {accountStatus?.signedIn
                  ? `Signed in as ${accountStatus.email}`
                  : "Sign-in required"}
              </strong>
              <p>
                When enabled, only the excerpt you select is sent over TLS.
                Responses become reviewable candidates and can’t directly alter
                your plan.
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
              <option value="task_decomposition">Break down an assignment</option>
              <option value="document_extraction">Clarify an excerpt</option>
              <option value="explanation">Explain planner facts</option>
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
            <small>{assistantExcerpt.length.toLocaleString()} / 12,000 characters</small>
          </label>
          <label className="check-row consent-check">
            <input
              type="checkbox"
              checked={assistantConsent}
              onChange={(event) => setAssistantConsent(event.target.checked)}
            />
            <span>
              I consent to sending only this excerpt to Student Center’s managed
              AI service for this request.
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
            {!accountStatus?.signedIn && (
              <button className="outline" onClick={() => setModal("account")}>
                Sign in
              </button>
            )}
            <button
              className="solid"
              disabled={
                busy ||
                !accountStatus?.signedIn ||
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
                      "Managed AI response is ready for review.",
                  );
                  setAssistantExplanation(result.explanation ?? "");
                  if (result.candidatesCreated > 0) setModal("review");
                } catch (e) {
                  setError(String(e));
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
      {modal === "recovery" && (
        <Modal
          title="Data recovery"
          subtitle="Untouched legacy mock records are quarantined automatically and never affect your plan."
          close={() => setModal(null)}
        >
          {error && <div className="alert">{error}</div>}
          {legacyItems.length ? (
            <div className="record-list compact">
              {legacyItems.map((item) => (
                <article key={item.id}>
                  <div className="record-icon protected"><RefreshCw /></div>
                  <div><strong>{item.title}</strong><small>{item.entityType} · quarantined {formatDateTime(item.quarantinedAt)}</small></div>
                  <button className="outline" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      await restoreLegacyQuarantine([item.id]);
                      setLegacyItems(await listLegacyQuarantine());
                      const next = await initialize();
                      setData(next.dashboard);
                      setToast("Legacy record restored to your local workspace.");
                    } catch (next) { setError(String(next)); } finally { setBusy(false); }
                  }}>Restore</button>
                </article>
              ))}
            </div>
          ) : <div className="empty-state"><ShieldCheck /><strong>No quarantined records</strong><p>Fresh installations and completed cleanups have nothing to recover.</p></div>}
          {legacyItems.length > 0 && <><label className="field">Type PURGE LEGACY DATA to permanently remove recovery snapshots<input value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} /></label><div className="modal-actions"><button className="solid danger-solid" disabled={busy || purgeConfirmation !== "PURGE LEGACY DATA"} onClick={async () => { setBusy(true); try { await purgeLegacyQuarantine(purgeConfirmation); setLegacyItems([]); setPurgeConfirmation(""); setToast("Legacy recovery snapshots permanently removed."); } catch (next) { setError(String(next)); } finally { setBusy(false); } }}>Permanently purge snapshots</button></div></>}
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
  );
}

function WorkspaceView({
  mode,
  onDashboard,
}: {
  mode: "timetable" | "assignments" | "courses";
  onDashboard: (dashboard: Dashboard) => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [agenda, setAgenda] = useState<CalendarAgenda | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [courseEdit, setCourseEdit] = useState<CourseRecord | null>(null);
  const [course, setCourse] = useState<CourseInput>({ title: "", code: "" });
  const emptyTask: TaskInput = {
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
  };
  const [taskEdit, setTaskEdit] = useState<TaskRecord | null>(null);
  const [task, setTask] = useState<TaskInput>(emptyTask);
  const emptyCommitment: CommitmentEditorInput = {
    title: "",
    startsAt: "",
    endsAt: "",
    kind: "class",
    location: "",
    travelBeforeMinutes: 0,
    travelAfterMinutes: 0,
    protected: true,
  };
  const [commitmentEdit, setCommitmentEdit] = useState<CommitmentRecord | null>(
    null,
  );
  const [commitment, setCommitment] =
    useState<CommitmentEditorInput>(emptyCommitment);
  const emptyAcademicEvent: AcademicCalendarEventInput = {
    title: "",
    startsOn: new Date().toISOString().slice(0, 10),
    endsOn: new Date().toISOString().slice(0, 10),
    allDay: true,
    noClass: true,
    source: "user",
  };
  const [academicEvent, setAcademicEvent] =
    useState<AcademicCalendarEventInput>(emptyAcademicEvent);
  const [academicEventEdit, setAcademicEventEdit] =
    useState<AcademicCalendarEventRecord | null>(null);
  const emptyInstructor = { courseId: "", name: "", email: "", officeLocation: "", officeHours: "" };
  const emptyMeeting = { courseId: "", weekdays: [1, 3, 5], startsAtLocal: "09:00", endsAtLocal: "09:50", component: "lecture", location: "" };
  const [instructorDraft, setInstructorDraft] = useState(emptyInstructor);
  const [instructorEdit, setInstructorEdit] = useState<InstructorRecord | null>(null);
  const [meetingDraft, setMeetingDraft] = useState(emptyMeeting);
  const [meetingEdit, setMeetingEdit] = useState<ClassMeetingSeriesRecord | null>(null);
  const emptyTerm: AcademicTermInput = { name: "", startsOn: "", endsOn: "", active: true };
  const [term, setTerm] = useState<AcademicTermInput>(emptyTerm);
  const [termEdit, setTermEdit] = useState<AcademicTermRecord | null>(null);
  const [preferences, setPreferences] = useState<PreferenceInput | null>(null);
  const [profileEditor, setProfileEditor] = useState({
    name: "",
    timezone: "",
    expectedVersion: 0,
  });
  useEffect(() => {
    let active = true;
    setWorkspace(null);
    Promise.all([
      getLocalWorkspace(),
      mode === "timetable" ? getCalendarAgenda() : Promise.resolve(null),
    ])
      .then(([next, nextAgenda]) => {
        if (active) {
          setWorkspace(next);
          setAgenda(nextAgenda);
          if (next.profile)
            setProfileEditor({
              name: next.profile.name,
              timezone: next.profile.timezone,
              expectedVersion: next.profile.version,
            });
          if (next.preferences)
            setPreferences({
              ...next.preferences,
              expectedVersion: next.preferences.version,
              availability: next.availability,
            });
        }
      })
      .catch((next) => {
        if (active) setError(String(next));
      });
    return () => {
      active = false;
    };
  }, [mode]);
  const applied = async (next: WorkspaceSnapshot) => {
    setWorkspace(next);
    if (next.profile)
      setProfileEditor({
        name: next.profile.name,
        timezone: next.profile.timezone,
        expectedVersion: next.profile.version,
      });
    if (next.preferences)
      setPreferences({
        ...next.preferences,
        expectedVersion: next.preferences.version,
        availability: next.availability,
      });
    if (mode === "timetable") setAgenda(await getCalendarAgenda());
    // This runs only after a workspace mutation, so onboarding is already
    // complete and the lighter dashboard fetch is enough.
    onDashboard(await getDashboard());
  };
  const act = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      await applied(await operation());
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };
  const editCourse = (value: CourseRecord) => {
    setCourseEdit(value);
    setCourse({
      title: value.title,
      code: value.code,
      termId: value.termId,
      expectedVersion: value.version,
    });
  };
  const editTask = (value: TaskRecord) => {
    setTaskEdit(value);
    setTask({
      title: value.title,
      minutes: value.minutes,
      dueAt: value.dueAt,
      courseId: value.courseId,
      priority: value.priority,
      kind: value.kind,
      academicRisk: value.academicRisk,
      earliestStart: value.earliestStart,
      energyDemand: value.energyDemand,
      location: value.location,
      splittable: value.splittable,
      minSessionMinutes: value.minSessionMinutes,
      maxSessionMinutes: value.maxSessionMinutes,
      dependencies: value.dependencies,
      expectedVersion: value.version,
    });
  };
  const editCommitment = (value: CommitmentRecord) => {
    setCommitmentEdit(value);
    setCommitment({
      title: value.title,
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      kind: value.kind,
      location: value.location,
      travelBeforeMinutes: value.travelBeforeMinutes,
      travelAfterMinutes: value.travelAfterMinutes,
      protected: value.protected,
      expectedVersion: value.version,
    });
  };
  const localValue = (value?: string) =>
    value ? new Date(value).toISOString().slice(0, 16) : "";
  const lockBlock = async (blockId: string, locked: boolean) => {
    setBusy(true);
    setError("");
    try {
      const dashboard = await setPlanBlockLock(blockId, locked);
      onDashboard(dashboard);
      setAgenda(await getCalendarAgenda());
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };
  const toggleAvailabilityDay = (weekday: number, enabled: boolean) =>
    setPreferences((current) =>
      current
        ? {
            ...current,
            availability: enabled
              ? [
                  ...current.availability,
                  { weekday, startsAtLocal: "08:00", endsAtLocal: "21:00" },
                ].sort((left, right) => left.weekday - right.weekday)
              : current.availability.filter((rule) => rule.weekday !== weekday),
          }
        : current,
    );
  const updateAvailabilityDay = (
    weekday: number,
    key: "startsAtLocal" | "endsAtLocal",
    value: string,
  ) =>
    setPreferences((current) =>
      current
        ? {
            ...current,
            availability: current.availability.map((rule) =>
              rule.weekday === weekday ? { ...rule, [key]: value } : rule,
            ),
          }
        : current,
    );
  const agendaDays = useMemo(() => {
    if (!agenda) return [];
    const start = new Date(agenda.startsAt);
    return Array.from({ length: 7 }, (_, index) => {
      const sample = new Date(start.getTime() + index * 86_400_000 + 12 * 3_600_000);
      const key = zonedDateKey(sample, agenda.timezone);
      return {
        key,
        label: new Intl.DateTimeFormat([], {
          timeZone: agenda.timezone,
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(sample),
        blocks: agenda.blocks.filter(
          (block) => zonedDateKey(block.startsAt, agenda.timezone) === key,
        ),
      };
    });
  }, [agenda]);
  if (!workspace)
    return (
      <div className="content workspace-page">
        <div className="loading">
          <strong>Loading your encrypted local records…</strong>
          {error && <p>{error}</p>}
        </div>
      </div>
    );
  return (
    <div className={`content workspace-page mode-${mode}`}>
      <div className="page-head">
        <div>
          <p className="eyebrow">Account-free and offline</p>
          <h1>{mode === "timetable" ? "Timetable" : mode === "assignments" ? "Assignments" : "Courses"}</h1>
          <p>
            {mode === "timetable"
              ? "Your classes, protected time, and study blocks in one readable week."
              : mode === "assignments"
                ? "Assignments and exams, ordered by what needs attention next."
                : "Course details, instructors, meeting patterns, and local preferences."}
          </p>
        </div>
        <span className="mode-pill">
          <HardDrive /> Local authority
        </span>
      </div>
      {error && (
        <div className="alert">
          <CircleAlert />
          <span>{error}</span>
          <button onClick={() => setError("")}>
            <X />
          </button>
        </div>
      )}
      {mode === "timetable" ? (
        <div className="workspace-grid">
          <section className="workspace-panel">
            <div className="section-head">
              <h2>Week calendar</h2>
              <span>{agenda?.blocks.length ?? 0} blocks</span>
            </div>
            <div className="week-calendar" aria-label="Seven-day visual calendar">
              {agendaDays.map((day) => (
                <section key={day.key}>
                  <h3>{day.label}</h3>
                  {day.blocks.length ? (
                    day.blocks.map((block) => (
                      <div
                        className={`week-block ${block.kind}`}
                        key={block.id}
                      >
                        <time>{formatTime(block.startsAt)}</time>
                        <strong>{block.title}</strong>
                        <small>{minutesBetween(block.startsAt, block.endsAt)} min</small>
                      </div>
                    ))
                  ) : (
                    <p>Open</p>
                  )}
                </section>
              ))}
            </div>
            {agenda?.overloadConflicts.map((conflict) => (
              <div className="alert" key={conflict.id}>
                <CircleAlert />
                <span>{conflict.description}</span>
              </div>
            ))}
            {agenda?.blocks.length ? (
              <><h3 className="agenda-fallback-title">Agenda view</h3><ol
                className="record-list calendar-agenda"
                aria-label="Seven-day agenda view"
              >
                {agenda.blocks.map((item) => (
                  <li key={item.id}>
                    <article
                      className={item.completed ? "record-complete" : ""}
                    >
                      <div className={`record-icon ${item.kind}`}>
                        <CalendarDays />
                      </div>
                      <div>
                        <strong>{item.title}</strong>
                        <small>
                          {formatDateTime(item.startsAt)} –{" "}
                          {formatTime(item.endsAt)} ·{" "}
                          {minutesBetween(item.startsAt, item.endsAt)} min
                        </small>
                        <small>
                          {item.location || "Any location"} ·{" "}
                          {item.locked ? "Locked" : "Flexible"} ·{" "}
                          {item.reasonCodes
                            .slice(0, 2)
                            .map((reason) => reason.replaceAll("_", " "))
                            .join(" · ")}
                        </small>
                      </div>
                      {item.taskId && !item.completed && (
                        <div className="record-actions">
                          <button
                            className="outline"
                            disabled={busy}
                            aria-pressed={item.locked}
                            onClick={() =>
                              void lockBlock(item.id, !item.locked)
                            }
                          >
                            {item.locked ? "Unlock" : "Lock"}
                          </button>
                        </div>
                      )}
                    </article>
                  </li>
                ))}
              </ol></>
            ) : (
              <div className="empty-state">
                <CalendarDays />
                <strong>No planned blocks this week</strong>
                <p>
                  Add a task or commitment. Feasible work will appear here
                  without overlaps.
                </p>
              </div>
            )}
            <div className="section-head subhead">
              <h3>Fixed commitments</h3>
              <span>{workspace.commitments.length}</span>
            </div>
            {workspace.commitments.length ? (
              <div className="record-list">
                {workspace.commitments.map((item) => (
                  <article key={item.id}>
                    <div className={`record-icon ${item.kind}`}>
                      <CalendarDays />
                    </div>
                    <div>
                      <strong>{item.title}</strong>
                      <small>
                        {formatDateTime(item.startsAt)} –{" "}
                        {new Intl.DateTimeFormat([], {
                          timeStyle: "short",
                        }).format(new Date(item.endsAt))}
                      </small>
                      <small>
                        {item.location || "No location"} ·{" "}
                        {item.travelBeforeMinutes + item.travelAfterMinutes}{" "}
                        travel minutes ·{" "}
                        {item.protected ? "Protected" : "Flexible"}
                      </small>
                    </div>
                    <div className="record-actions">
                      <button
                        className="outline"
                        onClick={() => editCommitment(item)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Delete ${item.title}?`))
                            void act(() =>
                              deleteCommitment(item.id, item.version),
                            );
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <CalendarDays />
                <strong>No fixed commitments yet</strong>
                <p>
                  Add classes, work, or protected time. Student Center will keep
                  plans out of those windows.
                </p>
              </div>
            )}
            <div className="section-head subhead">
              <h3>Academic calendar</h3>
              <span>{workspace.academicEvents.length}</span>
            </div>
            {workspace.academicEvents.length ? (
              <div className="record-list compact">
                {workspace.academicEvents.map((item) => (
                  <article key={item.id}>
                    <div className="record-icon protected"><CalendarDays /></div>
                    <div><strong>{item.title}</strong><small>{item.startsOn}{item.endsOn !== item.startsOn ? ` – ${item.endsOn}` : ""} · {item.noClass ? "No classes" : "Academic event"}</small></div>
                    <div className="record-actions">
                      <button className="outline" onClick={() => { setAcademicEventEdit(item); setAcademicEvent({ title: item.title, startsOn: item.startsOn, endsOn: item.endsOn, allDay: item.allDay, noClass: item.noClass, source: item.source }); }}>Edit</button>
                      <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm(`Delete ${item.title}?`)) void act(() => deleteAcademicEvent(item.id, item.version)); }}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : <p className="section-empty-copy">No holidays or no-class days added yet.</p>}
          </section>
          <section className="workspace-panel editor">
            <h2>{commitmentEdit ? "Edit commitment" : "Add commitment"}</h2>
            <label className="field">
              Title
              <input
                value={commitment.title}
                onChange={(event) =>
                  setCommitment((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="Chemistry lab"
              />
            </label>
            <div className="form-grid">
              <label className="field">
                Starts
                <input
                  type="datetime-local"
                  value={localValue(commitment.startsAt)}
                  onChange={(event) =>
                    setCommitment((current) => ({
                      ...current,
                      startsAt: event.target.value
                        ? new Date(event.target.value).toISOString()
                        : "",
                    }))
                  }
                />
              </label>
              <label className="field">
                Ends
                <input
                  type="datetime-local"
                  value={localValue(commitment.endsAt)}
                  onChange={(event) =>
                    setCommitment((current) => ({
                      ...current,
                      endsAt: event.target.value
                        ? new Date(event.target.value).toISOString()
                        : "",
                    }))
                  }
                />
              </label>
              <label className="field">
                Type
                <select
                  value={commitment.kind}
                  onChange={(event) =>
                    setCommitment((current) => ({
                      ...current,
                      kind: event.target.value as CommitmentEditorInput["kind"],
                    }))
                  }
                >
                  <option value="class">Class</option>
                  <option value="work">Work</option>
                  <option value="life">Life</option>
                  <option value="protected">Protected time</option>
                </select>
              </label>
              <label className="field">
                Location
                <input
                  value={commitment.location}
                  onChange={(event) =>
                    setCommitment((current) => ({
                      ...current,
                      location: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="field">
                Travel before
                <input
                  type="number"
                  min="0"
                  max="240"
                  step="5"
                  value={commitment.travelBeforeMinutes}
                  onChange={(event) =>
                    setCommitment((current) => ({
                      ...current,
                      travelBeforeMinutes: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="field">
                Travel after
                <input
                  type="number"
                  min="0"
                  max="240"
                  step="5"
                  value={commitment.travelAfterMinutes}
                  onChange={(event) =>
                    setCommitment((current) => ({
                      ...current,
                      travelAfterMinutes: Number(event.target.value),
                    }))
                  }
                />
              </label>
            </div>
            <label className="setting-toggle compact">
              <input
                type="checkbox"
                checked={commitment.protected}
                onChange={(event) =>
                  setCommitment((current) => ({
                    ...current,
                    protected: event.target.checked,
                  }))
                }
              />
              <span>
                <strong>Protect this time during replanning</strong>
                <small>Fixed commitments are never overlapped.</small>
              </span>
            </label>
            <div className="modal-actions">
              {commitmentEdit && (
                <button
                  className="outline"
                  onClick={() => {
                    setCommitmentEdit(null);
                    setCommitment(emptyCommitment);
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                className="solid"
                disabled={
                  busy ||
                  !commitment.title.trim() ||
                  !commitment.startsAt ||
                  !commitment.endsAt
                }
                onClick={() =>
                  void act(() =>
                    commitmentEdit
                      ? updateCommitment(commitmentEdit.id, commitment)
                      : createCommitment(commitment),
                  ).then(() => {
                    setCommitmentEdit(null);
                    setCommitment(emptyCommitment);
                  })
                }
              >
                {commitmentEdit ? "Save changes" : "Add commitment"}
              </button>
            </div>
            <div className="editor-divider" />
            <h2>{academicEventEdit ? "Edit academic event" : "Add a holiday or no-class day"}</h2>
            <label className="field">Title<input value={academicEvent.title} onChange={(event) => setAcademicEvent((current) => ({ ...current, title: event.target.value }))} placeholder="Fall break" /></label>
            <div className="form-grid">
              <label className="field">Starts<input type="date" value={academicEvent.startsOn} onChange={(event) => setAcademicEvent((current) => ({ ...current, startsOn: event.target.value, endsOn: current.endsOn < event.target.value ? event.target.value : current.endsOn }))} /></label>
              <label className="field">Ends<input type="date" value={academicEvent.endsOn} onChange={(event) => setAcademicEvent((current) => ({ ...current, endsOn: event.target.value }))} /></label>
            </div>
            <label className="setting-toggle compact"><input type="checkbox" checked={academicEvent.noClass} onChange={(event) => setAcademicEvent((current) => ({ ...current, noClass: event.target.checked }))} /><span><strong>No classes or schedulable work</strong><small>Coqui treats this as protected capacity.</small></span></label>
            <div className="modal-actions">
              {academicEventEdit && <button className="outline" onClick={() => { setAcademicEventEdit(null); setAcademicEvent(emptyAcademicEvent); }}>Cancel</button>}
              <button className="solid" disabled={busy || !academicEvent.title.trim()} onClick={() => { const input = { ...academicEvent, termId: workspace.terms.find((value) => value.active)?.id }; void act(() => academicEventEdit ? updateAcademicEvent(academicEventEdit.id, { ...input, expectedVersion: academicEventEdit.version }) : createAcademicEvent(input)).then(() => { setAcademicEventEdit(null); setAcademicEvent(emptyAcademicEvent); }); }}>{academicEventEdit ? "Save academic event" : "Add academic event"}</button>
            </div>
          </section>
        </div>
      ) : (
        <>
          <div className={`workspace-grid academics ${mode}`}>
            {mode === "courses" && (
            <section className="workspace-panel">
              <div className="section-head">
                <h2>Courses</h2>
                <span>{workspace.courses.length}</span>
              </div>
              {workspace.courses.length ? (
                <div className="record-list compact">
                  {workspace.courses.map((item) => (
                    <article key={item.id}>
                      <div className="record-icon course">
                        <BookOpen />
                      </div>
                      <div>
                        <strong>{item.code || item.title}</strong>
                        <small>{item.title}</small>
                        {workspace.instructors.filter((instructor) => instructor.courseId === item.id).map((instructor) => (
                          <small key={instructor.id}>
                            Instructor · {instructor.name}{instructor.email ? ` · ${instructor.email}` : ""}
                            <button className="text-button" onClick={() => { setInstructorEdit(instructor); setInstructorDraft({ courseId: instructor.courseId, name: instructor.name, email: instructor.email, officeLocation: instructor.officeLocation, officeHours: instructor.officeHours }); }}>Edit</button>
                            <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${instructor.name} from ${item.code || item.title}?`)) void act(() => deleteInstructor(instructor.id, instructor.version)); }}>Remove</button>
                          </small>
                        ))}
                        {workspace.classMeetings.filter((meeting) => meeting.courseId === item.id).map((meeting) => (
                          <small key={meeting.id}>
                            {meeting.weekdays.map((day) => weekdays[day].slice(0, 3)).join("/")} · {meeting.startsAtLocal}–{meeting.endsAtLocal} · {meeting.component}
                            <button className="text-button" onClick={() => { setMeetingEdit(meeting); setMeetingDraft({ courseId: meeting.courseId, weekdays: meeting.weekdays, startsAtLocal: meeting.startsAtLocal, endsAtLocal: meeting.endsAtLocal, component: meeting.component, location: meeting.location }); }}>Edit</button>
                            <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm(`Remove this ${meeting.component} time from ${item.code || item.title}?`)) void act(() => deleteClassMeeting(meeting.id, meeting.version)); }}>Remove</button>
                          </small>
                        ))}
                      </div>
                      <div className="record-actions">
                        <button
                          className="outline"
                          onClick={() => editCourse(item)}
                        >
                          Edit
                        </button>
                        <button
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete ${item.title}? Tasks will be kept without a course.`,
                              )
                            )
                              void act(() =>
                                deleteCourse(item.id, item.version),
                              );
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <BookOpen />
                  <strong>No courses yet</strong>
                  <p>Add a course manually or approve one from an import.</p>
                </div>
              )}
              <div className="inline-editor">
                <h3>{courseEdit ? "Edit course" : "Add a course"}</h3>
                <div className="form-grid">
                  <label className="field">
                    Course name
                    <input
                      value={course.title}
                      onChange={(event) =>
                        setCourse((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                      placeholder="English Composition"
                    />
                  </label>
                  <label className="field">
                    Code
                    <input
                      value={course.code}
                      onChange={(event) =>
                        setCourse((current) => ({
                          ...current,
                          code: event.target.value,
                        }))
                      }
                      placeholder="ENG 102"
                    />
                  </label>
                </div>
                <div className="modal-actions">
                  {courseEdit && (
                    <button
                      className="outline"
                      onClick={() => {
                        setCourseEdit(null);
                        setCourse({ title: "", code: "" });
                      }}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    className="solid"
                    disabled={busy || !course.title.trim()}
                    onClick={() =>
                      void act(() =>
                        courseEdit
                          ? updateCourse(courseEdit.id, course)
                          : createCourse(course),
                      ).then(() => {
                        setCourseEdit(null);
                        setCourse({ title: "", code: "" });
                      })
                    }
                  >
                    {courseEdit ? "Save course" : "Add course"}
                  </button>
                </div>
              </div>
              {workspace.courses.length > 0 && <div className="course-detail-editors">
                <div className="inline-editor">
                  <h3>{instructorEdit ? "Edit instructor" : "Add an instructor"}</h3>
                  <div className="form-grid"><label className="field">Course<select value={instructorDraft.courseId || workspace.courses[0].id} onChange={(event) => setInstructorDraft((current) => ({ ...current, courseId: event.target.value }))}>{workspace.courses.map((item) => <option value={item.id} key={item.id}>{item.code || item.title}</option>)}</select></label><label className="field">Name<input value={instructorDraft.name} onChange={(event) => setInstructorDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Professor name" /></label><label className="field">Email (optional)<input type="email" value={instructorDraft.email} onChange={(event) => setInstructorDraft((current) => ({ ...current, email: event.target.value }))} /></label><label className="field">Office (optional)<input value={instructorDraft.officeLocation} onChange={(event) => setInstructorDraft((current) => ({ ...current, officeLocation: event.target.value }))} /></label></div>
                  <div className="modal-actions">
                    {instructorEdit && <button className="outline" onClick={() => { setInstructorEdit(null); setInstructorDraft(emptyInstructor); }}>Cancel</button>}
                    <button className="solid" disabled={busy || !instructorDraft.name.trim()} onClick={() => { const input = { ...instructorDraft, courseId: instructorDraft.courseId || workspace.courses[0].id }; void act(() => instructorEdit ? updateInstructor(instructorEdit.id, { ...input, expectedVersion: instructorEdit.version }) : createInstructor(input)).then(() => { setInstructorEdit(null); setInstructorDraft(emptyInstructor); }); }}>{instructorEdit ? "Save instructor" : "Add instructor"}</button>
                  </div>
                </div>
                <div className="inline-editor">
                  <h3>{meetingEdit ? "Edit class time" : "Add a recurring class time"}</h3>
                  <label className="field">Course<select value={meetingDraft.courseId || workspace.courses[0].id} onChange={(event) => setMeetingDraft((current) => ({ ...current, courseId: event.target.value }))}>{workspace.courses.map((item) => <option value={item.id} key={item.id}>{item.code || item.title}</option>)}</select></label>
                  <div className="day-chips">{weekdays.map((day, dayIndex) => <button className={meetingDraft.weekdays.includes(dayIndex) ? "active" : ""} key={day} onClick={() => setMeetingDraft((current) => ({ ...current, weekdays: current.weekdays.includes(dayIndex) ? current.weekdays.filter((value) => value !== dayIndex) : [...current.weekdays, dayIndex].sort() }))}>{day.slice(0, 3)}</button>)}</div>
                  <div className="form-grid"><label className="field">Starts<input type="time" value={meetingDraft.startsAtLocal} onChange={(event) => setMeetingDraft((current) => ({ ...current, startsAtLocal: event.target.value }))} /></label><label className="field">Ends<input type="time" value={meetingDraft.endsAtLocal} onChange={(event) => setMeetingDraft((current) => ({ ...current, endsAtLocal: event.target.value }))} /></label><label className="field">Type<select value={meetingDraft.component} onChange={(event) => setMeetingDraft((current) => ({ ...current, component: event.target.value }))}><option value="lecture">Lecture</option><option value="lab">Lab</option><option value="seminar">Seminar</option></select></label><label className="field">Location<input value={meetingDraft.location} onChange={(event) => setMeetingDraft((current) => ({ ...current, location: event.target.value }))} /></label></div>
                  <div className="modal-actions">
                    {meetingEdit && <button className="outline" onClick={() => { setMeetingEdit(null); setMeetingDraft(emptyMeeting); }}>Cancel</button>}
                    <button className="solid" disabled={busy || meetingDraft.weekdays.length === 0} onClick={() => { const courseId = meetingDraft.courseId || workspace.courses[0].id; const termId = workspace.courses.find((item) => item.id === courseId)?.termId || workspace.terms.find((value) => value.active)?.id; if (!termId || !workspace.profile) return; const input = { ...meetingDraft, courseId, termId, timezone: workspace.profile.timezone }; void act(() => meetingEdit ? updateClassMeeting(meetingEdit.id, { ...input, expectedVersion: meetingEdit.version }) : createClassMeeting(input)).then(() => { setMeetingEdit(null); setMeetingDraft(emptyMeeting); }); }}>{meetingEdit ? "Save class time" : "Add class time"}</button>
                  </div>
                </div>
              </div>}
            </section>
            )}
            {mode === "assignments" && (
            <section className="workspace-panel">
              <div className="section-head">
                <h2>Assignments & exams</h2>
                <span>
                  {workspace.tasks.filter((item) => !item.completed).length}{" "}
                  open
                </span>
              </div>
              {workspace.tasks.length ? (
                <div className="record-list compact">
                  {workspace.tasks.map((item) => (
                    <article
                      className={item.completed ? "record-complete" : ""}
                      key={item.id}
                    >
                      <div className={`record-icon task ${item.kind}`}>
                        <ListChecks />
                      </div>
                      <div>
                        <strong>{item.title}</strong>
                        <small>
                          {item.kind === "exam" ? "Exam" : item.kind === "assignment" ? "Assignment" : "Task"} · {item.minutes} min · Priority {item.priority}
                          {item.dueAt
                            ? ` · Due ${formatDateTime(item.dueAt)}`
                            : " · No deadline"}
                        </small>
                        <small>
                          {item.energyDemand} energy ·{" "}
                          {item.splittable
                            ? `${item.minSessionMinutes}–${item.maxSessionMinutes} min sessions`
                            : "Indivisible"}
                        </small>
                      </div>
                      <div className="record-actions">
                        <button
                          className="outline"
                          onClick={() => editTask(item)}
                        >
                          Edit
                        </button>
                        <button
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Delete ${item.title}?`))
                              void act(() =>
                                deleteLocalTask(item.id, item.version),
                              );
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <ListChecks />
                  <strong>No tasks yet</strong>
                  <p>
                    Add your first task or import a syllabus to create
                    reviewable deadlines.
                  </p>
                </div>
              )}
            </section>
            )}
          </div>
          {mode === "assignments" && (
          <section className="workspace-panel task-editor">
            <h2>{taskEdit ? `Edit ${task.kind}` : "Add an assignment or exam"}</h2>
            <div className="form-grid compact">
              <label className="field full">
                Task
                <input
                  value={task.title}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder="Draft lab report"
                />
              </label>
              <label className="field">
                Type
                <select
                  value={task.kind}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      kind: event.target.value as TaskInput["kind"],
                    }))
                  }
                >
                  <option value="assignment">Assignment</option>
                  <option value="exam">Exam</option>
                  <option value="task">General task</option>
                </select>
              </label>
              <label className="field">
                Course
                <select
                  value={task.courseId ?? ""}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      courseId: event.target.value || undefined,
                    }))
                  }
                >
                  <option value="">No course</option>
                  {workspace.courses.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code || item.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Estimate
                <input
                  type="number"
                  min="5"
                  max="1440"
                  step="5"
                  value={task.minutes}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      minutes: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="field">
                Due
                <input
                  type="datetime-local"
                  value={localValue(task.dueAt)}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      dueAt: event.target.value
                        ? new Date(event.target.value).toISOString()
                        : undefined,
                    }))
                  }
                />
              </label>
              <label className="field">
                Earliest start
                <input
                  type="datetime-local"
                  value={localValue(task.earliestStart)}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      earliestStart: event.target.value
                        ? new Date(event.target.value).toISOString()
                        : undefined,
                    }))
                  }
                />
              </label>
              <label className="field">
                Priority
                <input
                  type="number"
                  min="1"
                  max="5"
                  value={task.priority}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      priority: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="field">
                Academic risk
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={task.academicRisk}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      academicRisk: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="field">
                Energy
                <select
                  value={task.energyDemand}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      energyDemand: event.target
                        .value as TaskInput["energyDemand"],
                    }))
                  }
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="field">
                Location
                <input
                  value={task.location}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      location: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="field">
                Minimum session
                <input
                  type="number"
                  min="5"
                  max="240"
                  step="5"
                  disabled={!task.splittable}
                  value={task.minSessionMinutes}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      minSessionMinutes: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="field">
                Maximum session
                <input
                  type="number"
                  min="5"
                  max="240"
                  step="5"
                  disabled={!task.splittable}
                  value={task.maxSessionMinutes}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      maxSessionMinutes: Number(event.target.value),
                    }))
                  }
                />
              </label>
            </div>
            <label className="setting-toggle compact">
              <input
                type="checkbox"
                checked={task.splittable}
                onChange={(event) =>
                  setTask((current) => ({
                    ...current,
                    splittable: event.target.checked,
                  }))
                }
              />
              <span>
                <strong>Allow this task to split into sessions</strong>
                <small>
                  Student Center will still respect the minimum and maximum
                  session lengths.
                </small>
              </span>
            </label>
            <fieldset className="dependency-picker">
              <legend>Prerequisites</legend>
              {workspace.tasks.filter((item) => item.id !== taskEdit?.id)
                .length ? (
                workspace.tasks
                  .filter((item) => item.id !== taskEdit?.id)
                  .map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={task.dependencies.includes(item.id)}
                        onChange={(event) =>
                          setTask((current) => ({
                            ...current,
                            dependencies: event.target.checked
                              ? [...current.dependencies, item.id]
                              : current.dependencies.filter(
                                  (dependency) => dependency !== item.id,
                                ),
                          }))
                        }
                      />
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.completed ? "Completed" : "Must finish first"}
                        </small>
                      </span>
                    </label>
                  ))
              ) : (
                <p>Add another task to define a prerequisite.</p>
              )}
            </fieldset>
            <div className="modal-actions">
              {taskEdit && (
                <button
                  className="outline"
                  onClick={() => {
                    setTaskEdit(null);
                    setTask(emptyTask);
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                className="solid"
                disabled={busy || !task.title.trim()}
                onClick={() =>
                  void act(() =>
                    taskEdit
                      ? updateLocalTask(taskEdit.id, task)
                      : createLocalTask(task),
                  ).then(() => {
                    setTaskEdit(null);
                    setTask(emptyTask);
                  })
                }
              >
                {taskEdit ? "Save task" : "Add task and replan"}
              </button>
            </div>
          </section>
          )}
          {mode === "courses" && (
          <>
          <section className="workspace-panel preference-editor">
            <div className="section-head">
              <h2>Academic terms</h2>
              <span>{workspace.terms.length}</span>
            </div>
            {workspace.terms.length ? (
              <div className="record-list compact">
                {workspace.terms.map((item) => (
                  <article key={item.id}>
                    <div className="record-icon course">
                      <CalendarDays />
                    </div>
                    <div>
                      <strong>
                        {item.name}
                        {item.active ? " · Active" : ""}
                      </strong>
                      <small>
                        {item.startsOn} – {item.endsOn}
                      </small>
                    </div>
                    <div className="record-actions">
                      <button
                        className="outline"
                        onClick={() => {
                          setTermEdit(item);
                          setTerm({
                            name: item.name,
                            startsOn: item.startsOn,
                            endsOn: item.endsOn,
                            active: item.active,
                            expectedVersion: item.version,
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ${item.name}? Courses and class times in this term are removed with it.`,
                            )
                          )
                            void act(() => deleteAcademicTerm(item.id, item.version));
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <CalendarDays />
                <strong>No terms yet</strong>
                <p>Add the term your courses belong to.</p>
              </div>
            )}
            <div className="inline-editor">
              <h3>{termEdit ? "Edit term" : "Add a term"}</h3>
              <div className="form-grid">
                <label className="field">
                  Term name
                  <input
                    value={term.name}
                    onChange={(event) =>
                      setTerm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Fall 2026"
                  />
                </label>
                <label className="field">
                  Starts
                  <input
                    type="date"
                    value={term.startsOn}
                    onChange={(event) =>
                      setTerm((current) => ({ ...current, startsOn: event.target.value }))
                    }
                  />
                </label>
                <label className="field">
                  Ends
                  <input
                    type="date"
                    value={term.endsOn}
                    onChange={(event) =>
                      setTerm((current) => ({ ...current, endsOn: event.target.value }))
                    }
                  />
                </label>
                <label className="setting-toggle compact">
                  <input
                    type="checkbox"
                    checked={term.active}
                    onChange={(event) =>
                      setTerm((current) => ({ ...current, active: event.target.checked }))
                    }
                  />
                  <span>Current term</span>
                </label>
              </div>
              <div className="modal-actions">
                {termEdit && (
                  <button
                    className="outline"
                    onClick={() => {
                      setTermEdit(null);
                      setTerm(emptyTerm);
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  className="solid"
                  disabled={
                    busy || !term.name.trim() || !term.startsOn || !term.endsOn
                  }
                  onClick={() =>
                    void act(() =>
                      termEdit
                        ? updateAcademicTerm(termEdit.id, term)
                        : createAcademicTerm(term),
                    ).then(() => {
                      setTermEdit(null);
                      setTerm(emptyTerm);
                    })
                  }
                >
                  {termEdit ? "Save term" : "Add term"}
                </button>
              </div>
            </div>
          </section>
          <section className="workspace-panel preference-editor">
            <h2>Local profile</h2>
            <div className="form-grid compact">
              <label className="field">
                Name
                <input
                  value={profileEditor.name}
                  onChange={(event) =>
                    setProfileEditor((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="field">
                IANA timezone
                <input
                  value={profileEditor.timezone}
                  onChange={(event) =>
                    setProfileEditor((current) => ({
                      ...current,
                      timezone: event.target.value,
                    }))
                  }
                  placeholder="America/Phoenix"
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="solid"
                disabled={
                  busy ||
                  !profileEditor.name.trim() ||
                  !profileEditor.timezone.trim()
                }
                onClick={() =>
                  void act(() => updateStudentProfile(profileEditor))
                }
              >
                Save profile and replan
              </button>
            </div>
          </section>
          {preferences && (
            <section className="workspace-panel preference-editor">
              <h2>Planning preferences</h2>
              <div className="form-grid compact">
                <label className="field">
                  Sleep begins
                  <input
                    type="time"
                    value={preferences.sleepStart}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? { ...current, sleepStart: event.target.value }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Sleep ends
                  <input
                    type="time"
                    value={preferences.sleepEnd}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? { ...current, sleepEnd: event.target.value }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Max session
                  <input
                    type="number"
                    min="15"
                    max="240"
                    step="5"
                    value={preferences.maxSessionMinutes}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? {
                              ...current,
                              maxSessionMinutes: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Break minutes
                  <input
                    type="number"
                    min="0"
                    max="60"
                    step="5"
                    value={preferences.breakMinutes}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? {
                              ...current,
                              breakMinutes: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Transition minutes
                  <input
                    type="number"
                    min="0"
                    max="120"
                    step="5"
                    value={preferences.transitionMinutes}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? {
                              ...current,
                              transitionMinutes: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Default commute
                  <input
                    type="number"
                    min="0"
                    max="240"
                    step="5"
                    value={preferences.defaultCommuteMinutes}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? {
                              ...current,
                              defaultCommuteMinutes: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
              </div>
              <fieldset className="availability compact-availability">
                <legend>Weekly availability</legend>
                {weekdays.map((name, weekday) => {
                  const rule = preferences.availability.find(
                    (item) => item.weekday === weekday,
                  );
                  return (
                    <div key={name}>
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(rule)}
                          onChange={(event) =>
                            toggleAvailabilityDay(weekday, event.target.checked)
                          }
                        />
                        <span>{name}</span>
                      </label>
                      <input
                        aria-label={`${name} availability starts`}
                        type="time"
                        disabled={!rule}
                        value={rule?.startsAtLocal ?? "08:00"}
                        onChange={(event) =>
                          updateAvailabilityDay(
                            weekday,
                            "startsAtLocal",
                            event.target.value,
                          )
                        }
                      />
                      <span>to</span>
                      <input
                        aria-label={`${name} availability ends`}
                        type="time"
                        disabled={!rule}
                        value={rule?.endsAtLocal ?? "21:00"}
                        onChange={(event) =>
                          updateAvailabilityDay(
                            weekday,
                            "endsAtLocal",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  );
                })}
              </fieldset>
              <div className="modal-actions">
                <button
                  className="solid"
                  disabled={busy}
                  onClick={() =>
                    void act(() => updatePlanningPreferences(preferences))
                  }
                >
                  Save and replan
                </button>
              </div>
            </section>
          )}
          </>
          )}
        </>
      )}
    </div>
  );
}

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type LegacyOnboardingState = OnboardingState & {
  demoReviewRequired: boolean;
  demoCandidates: Array<{ id: string; title: string; detail: string }>;
};

function AccountModal({
  status,
  mode,
  email,
  code,
  retryAfter,
  busy,
  error,
  setEmail,
  setCode,
  clearError,
  close,
  changeEmail,
  useEmail,
  google,
  sendCode,
  verifyCode,
  refresh,
  signOut,
}: {
  status: AccountStatus | null;
  mode: "email" | "verify";
  email: string;
  code: string;
  retryAfter: number;
  busy: boolean;
  error: string;
  setEmail: (value: string) => void;
  setCode: (value: string) => void;
  clearError: () => void;
  close: () => void;
  changeEmail: () => void;
  useEmail: () => void;
  google: () => void;
  sendCode: () => void;
  verifyCode: () => void;
  refresh: () => void;
  signOut: () => void;
}) {
  const [syncStatus, setSyncStatus] = useState<SyncProtectionStatus | null>(
    null,
  );
  const [cloudSyncStatus, setCloudSyncStatus] =
    useState<EncryptedSyncStatus | null>(null);
  const [syncMode, setSyncMode] = useState<
    "home" | "words" | "confirm" | "recover" | "approval"
  >("home");
  const [recoverySetup, setRecoverySetup] = useState<RecoverySetup | null>(
    null,
  );
  const [recoveryConfirmations, setRecoveryConfirmations] = useState<
    Record<number, string>
  >({});
  const [recoveryPhrase, setRecoveryPhrase] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [pendingDevices, setPendingDevices] = useState<PendingSyncDevice[]>([]);
  const [authorizedDevices, setAuthorizedDevices] = useState<PendingSyncDevice[]>([]);
  useEffect(() => {
    let active = true;
    if (!status?.signedIn) {
      setSyncStatus(null);
      setCloudSyncStatus(null);
      return () => {
        active = false;
      };
    }
    Promise.all([getSyncProtectionStatus(), getEncryptedSyncStatus()])
      .then(([protection, cloud]) => {
        if (active) {
          setSyncStatus(protection);
          setCloudSyncStatus(cloud);
          if (cloud.connected) {
            void Promise.all([listPendingSyncDevices(), listAuthorizedSyncDevices()])
              .then(([pending, authorized]) => {
                if (active) {
                  setPendingDevices(pending);
                  setAuthorizedDevices(authorized);
                }
              })
              .catch(() => {
                if (active) {
                  setPendingDevices([]);
                  setAuthorizedDevices([]);
                }
              });
          }
        }
      })
      .catch((next) => {
        if (active) setSyncError(String(next));
      });
    return () => {
      active = false;
    };
  }, [status?.signedIn, status?.accountId]);
  const resetRecovery = () => {
    setSyncMode("home");
    setRecoverySetup(null);
    setRecoveryConfirmations({});
    setRecoveryPhrase("");
    setSyncError("");
  };
  const closeAccount = () => {
    void cancelSyncProtection();
    resetRecovery();
    close();
  };
  const createRecovery = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      const setup = await beginSyncProtection();
      setRecoverySetup(setup);
      setRecoveryConfirmations({});
      setSyncMode("words");
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const confirmRecovery = async () => {
    if (!recoverySetup) return;
    setSyncBusy(true);
    setSyncError("");
    try {
      const confirmations = recoverySetup.confirmationPositions.map(
        (position) => ({
          position,
          word: recoveryConfirmations[position] ?? "",
        }),
      );
      setSyncStatus(await confirmSyncProtection(confirmations));
      setCloudSyncStatus(await getEncryptedSyncStatus());
      resetRecovery();
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const restoreRecovery = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      setSyncStatus(await recoverSyncProtection(recoveryPhrase));
      setCloudSyncStatus(await getEncryptedSyncStatus());
      resetRecovery();
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const requestDeviceApproval = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      await requestExistingDeviceApproval();
      setSyncMode("approval");
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const checkDeviceApproval = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      setSyncStatus(await checkExistingDeviceApproval());
      setCloudSyncStatus(await getEncryptedSyncStatus());
      resetRecovery();
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const connectCloudSync = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      setCloudSyncStatus(await connectEncryptedSync());
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const pushCloudSync = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      await pushEncryptedMutations();
      setCloudSyncStatus(await pullEncryptedMutations());
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const approvePendingDevice = async (deviceId: string) => {
    setSyncBusy(true);
    setSyncError("");
    try {
      setPendingDevices(await approveSyncDevice(deviceId));
      setAuthorizedDevices(await listAuthorizedSyncDevices());
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const revokeAuthorizedDevice = async (device: PendingSyncDevice) => {
    if (
      !window.confirm(
        `Revoke ${device.displayName}? It will immediately lose access to new encrypted changes and documents.`,
      )
    )
      return;
    setSyncBusy(true);
    setSyncError("");
    try {
      const next = await revokeSyncDevice(device.deviceId);
      setCloudSyncStatus(next);
      if (next.connected) setAuthorizedDevices(await listAuthorizedSyncDevices());
      else setAuthorizedDevices([]);
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const leaveRecovery = () => {
    void cancelSyncProtection();
    resetRecovery();
  };
  return (
    <Modal
      title="Optional Student Center account"
      subtitle="Your planner and encrypted local data never require an account or internet connection."
      close={closeAccount}
    >
      {error && (
        <div className="alert account-alert">
          <CircleAlert />
          <span>{error}</span>
          <button onClick={clearError}>
            <X />
          </button>
        </div>
      )}
      {!status ? (
        <div className="empty">Loading account security…</div>
      ) : !status.credentialAvailable ? (
        <div className="consent-box security-warning">
          <CircleAlert />
          <div>
            <strong>Credential vault unavailable</strong>
            <p>{status.message}</p>
          </div>
        </div>
      ) : !status.configured ? (
        <div className="update-state unconfigured">
          <UserRound />
          <span>
            <strong>No account service in this build</strong>
            <small>{status.message}</small>
          </span>
        </div>
      ) : status.signedIn ? (
        <>
          <div className="account-identity">
            <UserRound />
            <span>
              <strong>{status.email}</strong>
              <small>
                Account ID {status.accountId?.slice(0, 8)}… · Refresh token
                protected by the operating-system credential vault
              </small>
            </span>
            <b>{status.accessReady ? "Ready" : "Refresh needed"}</b>
          </div>
          {syncError && (
            <div className="alert account-alert">
              <CircleAlert />
              <span>{syncError}</span>
              <button onClick={() => setSyncError("")}>
                <X />
              </button>
            </div>
          )}
          {!syncStatus ? (
            <div className="empty">Checking recovery protection…</div>
          ) : syncStatus.protected ? (
            <>
              <div className="update-state current">
                <ShieldCheck />
                <span>
                  <strong>Recovery protected on this device</strong>
                  <small>
                    {syncStatus.message} Device{" "}
                    {syncStatus.deviceId?.slice(0, 8)}…
                  </small>
                </span>
              </div>
              <div className="consent-box">
                <LockKeyhole />
                <div>
                  <strong>Keys stay in the operating-system vault</strong>
                  <p>
                    The account key and this computer&apos;s X25519 private key
                    are never stored in SQLite or returned to the interface. A
                    separate Ed25519 identity signs device approvals. Mutation
                    content is encrypted locally before upload.
                  </p>
                </div>
              </div>
              {cloudSyncStatus && (
                <div
                  className={`update-state ${cloudSyncStatus.connected ? "current" : "unconfigured"}`}
                >
                  <RefreshCw />
                  <span>
                    <strong>
                      {cloudSyncStatus.connected
                        ? "Encrypted sync connected"
                        : cloudSyncStatus.configured
                          ? "Device registration required"
                          : "No sync service in this build"}
                    </strong>
                    <small>
                      {cloudSyncStatus.message}
                      {cloudSyncStatus.connected
                        ? ` ${cloudSyncStatus.pendingMutations} local change${cloudSyncStatus.pendingMutations === 1 ? "" : "s"} pending.`
                        : ""}
                    </small>
                  </span>
                </div>
              )}
              {!!cloudSyncStatus?.pendingDownloadedMutations && (
                <div className="consent-box security-warning">
                  <CircleAlert />
                  <div>
                    <strong>Downloaded changes are safely staged</strong>
                    <p>
                      {cloudSyncStatus.pendingDownloadedMutations} decrypted
                      mutation
                      {cloudSyncStatus.pendingDownloadedMutations === 1
                        ? " is"
                        : "s are"}{" "}
                      from an interrupted transaction will be retried as one
                      validated batch. Student Center never advances the cursor
                      until canonical validation and replanning succeed.
                    </p>
                  </div>
                </div>
              )}
              {cloudSyncStatus?.connected && pendingDevices.length > 0 && (
                <section className="account-device-review" aria-label="Pending devices">
                  <h3>Devices awaiting approval</h3>
                  <p className="privacy-note">
                    Approve only a computer you recognize. The account key is
                    encrypted to that device and the envelope expires after 15
                    minutes.
                  </p>
                  {pendingDevices.map((device) => (
                    <div className="update-state unconfigured" key={device.deviceId}>
                      <HardDrive />
                      <span>
                        <strong>{device.displayName}</strong>
                        <small>
                          {device.platform} · {device.deviceId.slice(0, 8)}…
                        </small>
                      </span>
                      <button
                        disabled={syncBusy}
                        onClick={() => approvePendingDevice(device.deviceId)}
                      >
                        Approve
                      </button>
                    </div>
                  ))}
                </section>
              )}
              {cloudSyncStatus?.connected && authorizedDevices.length > 0 && (
                <section className="account-device-review" aria-label="Authorized devices">
                  <h3>Authorized devices</h3>
                  <p className="privacy-note">
                    Revoke a lost or retired computer to block new sync,
                    approval-envelope, and document access immediately.
                  </p>
                  {authorizedDevices.map((device) => {
                    const current = device.deviceId === cloudSyncStatus.deviceId;
                    return (
                      <div className="update-state configured" key={device.deviceId}>
                        <HardDrive />
                        <span>
                          <strong>
                            {device.displayName}{current ? " · This device" : ""}
                          </strong>
                          <small>
                            {device.platform} · {device.deviceId.slice(0, 8)}…
                          </small>
                        </span>
                        <button
                          disabled={syncBusy}
                          onClick={() => revokeAuthorizedDevice(device)}
                        >
                          {current ? "Disconnect" : "Revoke"}
                        </button>
                      </div>
                    );
                  })}
                </section>
              )}
              {cloudSyncStatus?.connected && cloudSyncStatus.lastPushedAt && (
                <p className="privacy-note">
                  Last encrypted upload{" "}
                  {new Date(cloudSyncStatus.lastPushedAt).toLocaleString()}
                </p>
              )}
              <div className="modal-actions">
                {cloudSyncStatus?.connected ? (
                  <button
                    className="solid"
                    disabled={syncBusy}
                    onClick={pushCloudSync}
                  >
                    <RefreshCw />{" "}
                    {cloudSyncStatus.pendingMutations === 0
                      ? "Check encrypted sync"
                      : "Encrypt and sync now"}
                  </button>
                ) : (
                  <button
                    className="solid"
                    disabled={syncBusy || !cloudSyncStatus?.configured}
                    onClick={connectCloudSync}
                  >
                    <Link2 /> Register this device
                  </button>
                )}
              </div>
            </>
          ) : syncMode === "home" ? (
            <>
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>Protect encrypted sync before connecting it</strong>
                  <p>
                    Create a one-time 24-word recovery code or enter the code
                    from another authorized computer. Losing every device and
                    this code makes synced data unrecoverable.
                  </p>
                </div>
              </div>
              <div className="backup-options">
                <button disabled={syncBusy} onClick={createRecovery}>
                  <LockKeyhole />
                  <span>
                    <strong>Create recovery code</strong>
                    <small>
                      Generate an account key and a separate device key locally.
                    </small>
                  </span>
                  <ChevronRight />
                </button>
                <button
                  disabled={syncBusy}
                  onClick={() => {
                    setSyncError("");
                    setSyncMode("recover");
                  }}
                >
                  <RefreshCw />
                  <span>
                    <strong>Use an existing code</strong>
                    <small>
                      Recover the account key and create a new key for this
                      computer.
                    </small>
                  </span>
                  <ChevronRight />
                </button>
                <button disabled={syncBusy} onClick={requestDeviceApproval}>
                  <HardDrive />
                  <span>
                    <strong>Ask an existing device</strong>
                    <small>
                      Approve this computer without typing the recovery code.
                    </small>
                  </span>
                  <ChevronRight />
                </button>
              </div>
            </>
          ) : syncMode === "words" && recoverySetup ? (
            <>
              <div className="consent-box security-warning">
                <CircleAlert />
                <div>
                  <strong>Write these words down now</strong>
                  <p>
                    Keep them offline and in order. Student Center will not
                    display them again after confirmation, and support cannot
                    recover them.
                  </p>
                </div>
              </div>
              <ol className="recovery-words">
                {recoverySetup.words.map((word, index) => (
                  <li key={`${index}-${word}`}>
                    <span>{index + 1}</span>
                    <strong>{word}</strong>
                  </li>
                ))}
              </ol>
              <div className="modal-actions">
                <button
                  className="outline"
                  disabled={syncBusy}
                  onClick={leaveRecovery}
                >
                  Cancel
                </button>
                <button
                  className="solid"
                  disabled={syncBusy}
                  onClick={() => setSyncMode("confirm")}
                >
                  I saved all 24 words
                </button>
              </div>
            </>
          ) : syncMode === "confirm" && recoverySetup ? (
            <>
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>Confirm your written copy</strong>
                  <p>
                    Enter the requested words. The account key is saved to the
                    OS credential vault only after all three match.
                  </p>
                </div>
              </div>
              <div className="recovery-confirmations">
                {recoverySetup.confirmationPositions.map((position) => (
                  <label className="field" key={position}>
                    Word {position}
                    <input
                      autoFocus={
                        position === recoverySetup.confirmationPositions[0]
                      }
                      value={recoveryConfirmations[position] ?? ""}
                      onChange={(event) =>
                        setRecoveryConfirmations((current) => ({
                          ...current,
                          [position]: event.target.value,
                        }))
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
              <div className="modal-actions">
                <button
                  className="outline"
                  disabled={syncBusy}
                  onClick={() => setSyncMode("words")}
                >
                  Back to words
                </button>
                <button
                  className="solid"
                  disabled={
                    syncBusy ||
                    recoverySetup.confirmationPositions.some(
                      (position) =>
                        !(recoveryConfirmations[position] ?? "").trim(),
                    )
                  }
                  onClick={confirmRecovery}
                >
                  Confirm and protect sync
                </button>
              </div>
            </>
          ) : syncMode === "recover" ? (
            <>
              <div className="consent-box">
                <RefreshCw />
                <div>
                  <strong>Recover on this computer</strong>
                  <p>
                    Enter all 24 words in order. Validation and key recovery
                    happen locally; the phrase is never sent to the account
                    service.
                  </p>
                </div>
              </div>
              <label className="field">
                24-word recovery code
                <textarea
                  autoFocus
                  value={recoveryPhrase}
                  onChange={(event) => setRecoveryPhrase(event.target.value)}
                  rows={5}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="word1 word2 word3 …"
                />
              </label>
              <div className="modal-actions">
                <button
                  className="outline"
                  disabled={syncBusy}
                  onClick={leaveRecovery}
                >
                  Back
                </button>
                <button
                  className="solid"
                  disabled={
                    syncBusy || recoveryPhrase.trim().split(/\s+/).length !== 24
                  }
                  onClick={restoreRecovery}
                >
                  Recover account key
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="consent-box security-warning">
                <HardDrive />
                <div>
                  <strong>Approval requested</strong>
                  <p>
                    On an already connected Student Center computer, open this
                    account panel and approve the pending device. The signed,
                    encrypted account-key envelope expires after 15 minutes.
                  </p>
                </div>
              </div>
              <div className="modal-actions">
                <button className="outline" disabled={syncBusy} onClick={leaveRecovery}>
                  Back
                </button>
                <button className="solid" disabled={syncBusy} onClick={checkDeviceApproval}>
                  <RefreshCw /> Check for approval
                </button>
              </div>
            </>
          )}
          {(syncStatus?.protected || syncMode === "home") && (
            <div className="modal-actions">
              <button
                className="outline danger"
                disabled={busy || syncBusy}
                onClick={signOut}
              >
                <LogOut /> Sign out on this computer
              </button>
              <button
                className="solid"
                disabled={busy || syncBusy || status.accessReady}
                onClick={refresh}
              >
                <RefreshCw /> Refresh session
              </button>
            </div>
          )}
        </>
      ) : status.googleSignInPending ? (
        <>
          <div className="account-browser-wait">
            <ExternalLink />
            <span>
              <strong>Finish in your system browser</strong>
              <small>{status.message}</small>
            </span>
          </div>
          <div className="consent-box">
            <ShieldCheck />
            <div>
              <strong>Native PKCE return</strong>
              <p>
                The browser receives no local student data. A one-time
                authorization code returns through the registered Student Center
                deep link and is exchanged only by the native app.
              </p>
            </div>
          </div>
          <div className="modal-actions">
            <button className="outline" disabled={busy} onClick={useEmail}>
              Use email code
            </button>
            <button className="solid" disabled={busy} onClick={google}>
              <ExternalLink /> Open Google again
            </button>
          </div>
        </>
      ) : mode === "email" ? (
        <>
          <button className="google-auth" disabled={busy} onClick={google}>
            <ExternalLink />
            <span>
              <strong>Continue with Google</strong>
              <small>
                Opens your system browser and returns securely to this app.
              </small>
            </span>
            <ChevronRight />
          </button>
          <div className="account-divider">
            <span>or use an email code</span>
          </div>
          <div className="consent-box">
            <Mail />
            <div>
              <strong>Email one-time code</strong>
              <p>
                Student Center asks Supabase to send a 6-digit code. The code is
                entered directly here and is never stored.
              </p>
            </div>
          </div>
          <label className="field">
            College or personal email
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="alex@example.edu"
            />
          </label>
          <p className="privacy-note">
            <ShieldCheck /> Only the refresh token is persisted, inside Windows
            Credential Manager or macOS Keychain. Access tokens stay in
            native-process memory.
          </p>
          <div className="modal-actions">
            <button className="outline" onClick={close}>
              Not now
            </button>
            <button
              className="solid"
              disabled={busy || !email.includes("@") || retryAfter > 0}
              onClick={sendCode}
            >
              <Mail />{" "}
              {retryAfter > 0
                ? `Try again in ${retryAfter}s`
                : "Send sign-in code"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="account-code-destination">
            <Mail />
            <span>
              <strong>Check {email}</strong>
              <small>Enter the six digits from the Student Center email.</small>
            </span>
          </div>
          <label className="field">
            6-digit code
            <input
              className="otp-input"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              autoComplete="one-time-code"
              placeholder="000000"
            />
          </label>
          <div className="modal-actions">
            <button className="outline" disabled={busy} onClick={changeEmail}>
              Change email
            </button>
            <button
              className="solid"
              disabled={busy || code.length !== 6}
              onClick={verifyCode}
            >
              Verify and sign in
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Modal({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <div>
            <h2 id="modal-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button onClick={close} aria-label="Close">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function LockScreen({
  security,
  unlock,
}: {
  security: SecurityStatus;
  unlock: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await unlock(pin);
      setPin("");
    } catch (e) {
      setPin("");
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="lock-screen">
      <section className="lock-card" aria-labelledby="lock-title">
        <AppLogo className="brand-mark" />
        <p className="eyebrow">Private local workspace</p>
        <h1 id="lock-title">Student Center is locked</h1>
        <p>
          Your plan, documents, and connected services stay unavailable until
          you enter your PIN.
        </p>
        <form onSubmit={submit}>
          <label className="field">
            Student Center PIN
            <input
              type="password"
              autoFocus
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              autoComplete="current-password"
              disabled={busy || security.retryAfterSeconds > 0}
            />
          </label>
          {error && (
            <div className="alert">
              <CircleAlert />
              <span>{error}</span>
            </div>
          )}
          <button
            className="solid unlock-button"
            disabled={busy || pin.length < 6 || security.retryAfterSeconds > 0}
          >
            {busy
              ? "Checking…"
              : security.retryAfterSeconds > 0
                ? `Try again in ${security.retryAfterSeconds}s`
                : "Unlock Student Center"}
          </button>
        </form>
        <div className="lock-foot">
          <ShieldCheck />
          <span>
            <strong>Encrypted on this device</strong>
            <small>The PIN never leaves this computer.</small>
          </span>
        </div>
      </section>
    </main>
  );
}

function BackupSummary({
  preview,
  title,
}: {
  preview: BackupPreview;
  title: string;
}) {
  return (
    <section className="backup-summary">
      <div>
        <ShieldCheck />
        <span>
          <strong>{title}</strong>
          <small>SHA-256 {preview.fingerprint.slice(0, 16)}…</small>
        </span>
      </div>
      <dl>
        <div>
          <dt>{preview.studentName}</dt>
          <dd>Profile</dd>
        </div>
        <div>
          <dt>{new Date(preview.createdAt).toLocaleString()}</dt>
          <dd>Created</dd>
        </div>
        <div>
          <dt>{preview.counts.tasks}</dt>
          <dd>Tasks</dd>
        </div>
        <div>
          <dt>{preview.counts.documents}</dt>
          <dd>Sources</dd>
        </div>
        <div>
          <dt>{formatBytes(preview.encryptedBytes)}</dt>
          <dd>Encrypted size</dd>
        </div>
        <div>
          <dt>v{preview.appVersion}</dt>
          <dd>App version</dd>
        </div>
      </dl>
    </section>
  );
}
