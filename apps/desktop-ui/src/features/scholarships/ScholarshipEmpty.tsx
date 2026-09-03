import type { ReactNode } from "react";

export function ScholarshipEmpty({
  icon,
  title,
  copy,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="empty-state scholarship-empty">
      {icon}
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

export function ScholarshipEvidence({
  title,
  items,
  tone = "neutral",
}: {
  title: string;
  items: string[];
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <section className={`match-group ${tone}`}>
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>Nothing to report.</p>
      )}
    </section>
  );
}
