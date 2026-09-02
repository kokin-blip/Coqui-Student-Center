import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

export function SettingsDetail({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle: string;
  close: () => void;
  children: ReactNode;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    backRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <section
      className="settings-detail-page"
      aria-labelledby="settings-detail-title"
    >
      <header className="settings-detail-header">
        <button ref={backRef} className="outline" onClick={close}>
          <ArrowLeft /> Back to Settings
        </button>
        <div>
          <h1 id="settings-detail-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </header>
      <div className="settings-detail-content">{children}</div>
    </section>
  );
}
