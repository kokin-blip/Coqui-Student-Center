import { useState } from "react";
import { ShieldCheck, Upload } from "lucide-react";
import { SettingsDetail } from "../../components/SettingsDetail";
import { selectAndImportBrightspace, type Dashboard } from "../../native";

export function BrightspaceSettings({ data, close, onDashboard, onToast, onReview }: {
  data: Dashboard;
  close: () => void;
  onDashboard: (data: Dashboard) => void;
  onToast: (message: string) => void;
  onReview: (documentId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingSources = [...new Set(data.candidates.filter(candidate => candidate.status === "pending" && candidate.sourceType.startsWith("brightspace_")).map(candidate => candidate.documentId))];
  const importFile = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await selectAndImportBrightspace();
      if (!result) return;
      onDashboard(result.dashboard);
      onToast(result.dashboard.importNotice ?? "Brightspace file read locally. Review before adding it to your plan.");
      if (result.dashboard.candidates.some(candidate => candidate.documentId === result.documentId && candidate.status === "pending")) onReview(result.documentId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return <SettingsDetail title="Import Brightspace" subtitle="Bring in a downloaded calendar or academic document. Review every item before it changes your plan." close={close}>
    <section className="canvas-guide" aria-labelledby="brightspace-guide-title">
      <div className="canvas-guide-heading"><div><h2 id="brightspace-guide-title">Download your calendar</h2><p>In Brightspace, open Calendar, choose Subscribe, select the calendars you need, then download the .ics file. Your school may hide or disable subscriptions.</p></div>
        <a href="https://community.d2l.com/brightspace/kb/articles/18042-manage-course-events-with-the-calendar-tool" target="_blank" rel="noreferrer">Brightspace Calendar guide</a>
      </div>
      <p>This imports a snapshot. Download and import a fresh file when dates change. There is no live Brightspace API connection, calendar-link subscription, or automatic refresh.</p>
    </section>
    <section className="canvas-connect-form" aria-labelledby="brightspace-formats-title">
      <div className="canvas-connect-heading"><div><h2 id="brightspace-formats-title">Accepted files</h2><p>Calendar .ics; PDF, DOCX, PPTX, CSV, XLSX, TXT; PNG, JPEG, and TIFF images. Files must be non-empty and 25 MB or smaller.</p></div></div>
      <p>Documents are read for academic dates and class schedules, not a complete course. Images and scanned PDFs need local OCR; a failed read stays encrypted in the document library with an explanation.</p>
      <p>Spreadsheets need a title or assignment column and a due-date column. For example:</p>
      <pre className="brightspace-example" aria-label="Assignment spreadsheet example">{"title,course,due_date\nEssay,ENG 101,2026-10-15 23:59"}</pre>
      <p>Grade exports are not assignment schedules. ZIP course packages, IMSCC, HTML/login pages, and password-protected files are unsupported. Only work present in the file can be found; missing assignments must be added manually. Date-only deadlines use 11:59 PM in the source or saved timezone and need review.</p>
      <p>Calendar UIDs let a fresh export match earlier work. Changed documents and events without UIDs cannot reliably match earlier assignments; check for duplicates before approving.</p>
      <button className="solid canvas-connect-action" disabled={busy} onClick={() => void importFile()}><Upload aria-hidden="true" />{busy ? "Reading file…" : "Choose Brightspace file"}</button>
      {error && <p role="alert">{error}</p>}
      {pendingSources.map((documentId, index) => <button className="outline" disabled={busy} key={documentId} onClick={() => onReview(documentId)}>Review Brightspace source {index + 1}</button>)}
      <p className="privacy-note"><ShieldCheck aria-hidden="true" />Files are read on this device and originals are encrypted. Nothing enters your plan until approval. AI rereading requires separate explicit consent. After review, choose whether to keep or delete the original.</p>
    </section>
  </SettingsDetail>;
}
