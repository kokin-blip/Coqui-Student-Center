import {
  BookOpen,
  Brain,
  CalendarDays,
  Home,
  ListChecks,
  LockKeyhole,
  LogOut,
  Plus,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { AppLogo } from "./AppLogo";

export type StudentDestination =
  | "today"
  | "calendar"
  | "work"
  | "courses"
  | "study";

type AppNavigationProps = {
  active: StudentDestination | "academic-settings";
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
] as const;

export function DesktopNavigation({
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
        {destinations.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${active === id ? "active" : ""}`}
            aria-label={label}
            onClick={() => onNavigate(id)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button className="nav-item" aria-label="Settings" onClick={onSettings}>
          <Settings />
          <span>Settings</span>
        </button>
        <button className="nav-item" aria-label="App lock" onClick={onSecurity}>
          <LockKeyhole />
          <span>App lock</span>
        </button>
        <button
          className="nav-item danger-nav"
          aria-label="Delete local profile"
          onClick={onDeleteProfile}
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
  );
}

export function MobileNavigation({
  active,
  onNavigate,
  onQuickAdd,
}: AppNavigationProps) {
  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {destinations.slice(0, 3).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={active === id ? "active" : ""}
          onClick={() => onNavigate(id)}
        >
          <Icon />
          {label}
        </button>
      ))}
      <button onClick={onQuickAdd}>
        <Plus />
        Add
      </button>
      {destinations.slice(3).map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={active === id ? "active" : ""}
          onClick={() => onNavigate(id)}
        >
          <Icon />
          {label}
        </button>
      ))}
    </nav>
  );
}
