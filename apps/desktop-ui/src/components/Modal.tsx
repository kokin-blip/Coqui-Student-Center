import { useEffect, useRef } from "react";
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
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = modalRef.current;
    const focusable = () =>
      Array.from(
        root?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
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
