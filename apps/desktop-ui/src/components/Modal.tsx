import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { SettingsDetail } from "./SettingsDetail";

export function Modal({
  title,
  subtitle,
  close,
  children,
  presentation = "dialog",
  className = "",
}: {
  title: string;
  subtitle: string;
  close: () => void;
  children: ReactNode;
  presentation?: "dialog" | "settings";
  className?: string;
}) {
  if (presentation === "settings") {
    return (
      <SettingsDetail title={title} subtitle={subtitle} close={close}>
        {children}
      </SettingsDetail>
    );
  }
  return (
    <DialogModal title={title} subtitle={subtitle} close={close} className={className}>
      {children}
    </DialogModal>
  );
}

function DialogModal({
  title,
  subtitle,
  close,
  children,
  className,
}: {
  title: string;
  subtitle: string;
  close: () => void;
  children: ReactNode;
  className: string;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = modalRef.current;
    const focusable = () =>
      Array.from(
        root?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => {
        if (element.tabIndex < 0 || element.closest('[hidden], [inert]')) return false;
        for (let parent: HTMLElement | null = element; parent && parent !== root; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (parent.tagName === "DETAILS" && !parent.hasAttribute("open") && !parent.querySelector("summary")?.contains(element)) return false;
        }
        return true;
      });
    (focusable()[0] ?? root)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (event.defaultPrevented || dialogs[dialogs.length - 1] !== root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); root?.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!root?.contains(document.activeElement)) {
        event.preventDefault(); first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className={`overlay ${className}`}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
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
