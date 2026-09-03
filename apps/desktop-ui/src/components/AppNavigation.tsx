import {
  BookOpen,
  Brain,
  CalendarDays,
  Home,
  ListChecks,
  LockKeyhole,
  Settings,
  GraduationCap,
  ShieldCheck,
  Plus,
  Upload,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { AppLogo } from "./AppLogo";
import type { InterfaceMode } from "../features/shell/interfacePreferences";

export type StudentDestination =
  | "today"
  | "calendar"
  | "work"
  | "courses"
  | "study"
  | "scholarships";

type AppNavigationProps = {
  mode?: InterfaceMode;
  studentName?: string;
  onImport?: () => void;
  onWorkFilter?: (filter: "all" | "high" | "completed") => void;
  active: StudentDestination | "academic-settings" | "settings";
  onNavigate: (destination: StudentDestination) => void;
  onQuickAdd: () => void;
  onSettings: () => void;
  onSecurity: () => void;
  onDeleteProfile: () => void;
};

const destinations = [
  { id: "today", label: "Today", icon: Home },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "work", label: "Work", icon: ListChecks },
  { id: "courses", label: "Courses", icon: BookOpen },
  { id: "study", label: "Study", icon: Brain },
  { id: "scholarships", label: "Scholarships", icon: GraduationCap },
] as const;

export function DesktopNavigation({
  mode = "comfy",
  studentName,
  onQuickAdd,
  onImport,
  onWorkFilter,
  active,
  onNavigate,
  onSettings,
  onSecurity,
  onDeleteProfile,
}: AppNavigationProps) {
  return (
    <aside className="sidebar" aria-label="Application navigation">
      <div className="brand">
        <AppLogo wordmark />
      </div>
      <p className="nav-label">Plan</p>
      <nav aria-label="Primary navigation">
        {destinations.map(({ id, label, icon: Icon }, index) => (
          <button
            key={id}
            className={`nav-item ${active === id ? "active" : ""}`}
            aria-label={label}
            onClick={() => onNavigate(id)}
          >
            <Icon />
            <span>{label}</span>
            {mode === "compact" && <kbd aria-hidden="true">{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} {index + 1}</kbd>}
          </button>
        ))}
      </nav>
      {mode === "compact" && <>
        <div className="sidebar-quick"><p>Quick actions</p><button onClick={onQuickAdd}><Plus /> Add task</button><button onClick={() => onNavigate("calendar")}><CalendarDays /> Add event</button><button onClick={onImport}><Upload /> Import work</button></div>
        <div className="sidebar-quick"><p>Views</p><button onClick={() => onWorkFilter?.("all")}><ListChecks /> All tasks</button><button onClick={() => onWorkFilter?.("high")}><ShieldCheck /> High priority</button><button onClick={() => onNavigate("calendar")}><CalendarDays /> Calendar feed</button><button onClick={() => onWorkFilter?.("completed")}><ListChecks /> Completed</button></div>
      </>}
      <div className="sidebar-foot">
        {studentName && <div className="sidebar-student"><UserRound /><span><strong>{studentName}</strong><small>Student workspace</small></span></div>}
        <button
          className={`nav-item ${active === "settings" ? "active" : ""}`}
          aria-label="Settings"
          onClick={onSettings}
        >
          <Settings />
          <span>Settings</span>
        </button>
        <button className="nav-item" aria-label="App lock" onClick={onSecurity}>
          <LockKeyhole />
          <span>App lock</span>
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
  );
}

export function MobileNavigation({
  active,
  onNavigate,
  onSettings,
}: AppNavigationProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {destinations
          .filter(({ id }) =>
            ["today", "calendar", "work", "study"].includes(id),
          )
          .map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={active === id ? "active" : ""}
              onClick={() => onNavigate(id)}
            >
              <Icon />
              {label}
            </button>
          ))}
        <button
          aria-expanded={moreOpen}
          className={
            active === "courses" ||
            active === "scholarships" ||
            active === "settings" ||
            active === "academic-settings"
              ? "active"
              : ""
          }
          onClick={() => setMoreOpen((value) => !value)}
        >
          <BookOpen />
          More
        </button>
      </nav>
      {moreOpen && (
        <div className="mobile-more" role="menu" aria-label="More destinations">
          <button
            role="menuitem"
            onClick={() => {
              onNavigate("courses");
              setMoreOpen(false);
            }}
          >
            <BookOpen />
            Courses
          </button>
          <button
            role="menuitem"
            onClick={() => {
              onNavigate("scholarships");
              setMoreOpen(false);
            }}
          >
            <GraduationCap />
            Scholarships
          </button>
          <button
            role="menuitem"
            onClick={() => {
              onSettings();
              setMoreOpen(false);
            }}
          >
            <Settings />
            Settings
          </button>
        </div>
      )}
    </>
  );
}
