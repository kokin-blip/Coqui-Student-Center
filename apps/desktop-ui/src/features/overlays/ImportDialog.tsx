import type { RefObject } from "react";
import {
  BookOpen,
  ChevronRight,
  FileLock2,
  LayoutGrid,
  Link2,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { SchedulePhotoEditor } from "../../components/SchedulePhotoEditor";
import type { Dashboard, DocumentSummary } from "../../native";

type Evidence = {
  documentId: string;
  items: Dashboard["candidates"];
} | null;

export function ImportDialog({
  busy,
  pasteTarget,
  documents,
  documentSearch,
  evidence,
  close,
  openCanvas,
  capture,
  photosImported,
  selectFile,
  enterManually,
  setDocumentSearch,
  openEvidence,
  closeEvidence,
  rereadWithAi,
  onError,
}: {
  busy: boolean;
  pasteTarget: RefObject<HTMLButtonElement | null>;
  documents: DocumentSummary[];
  documentSearch: string;
  evidence: Evidence;
  close: () => void;
  openCanvas: () => void;
  capture: () => void;
  photosImported: (dashboard: Dashboard, count: number) => void;
  selectFile: () => void;
  enterManually: () => void;
  setDocumentSearch: (value: string) => void;
  openEvidence: (documentId: string) => void;
  closeEvidence: () => void;
  rereadWithAi: (documentId: string) => void;
  onError: (message: string) => void;
}) {
  const evidenceSource = evidence
    ? documents.find((document) => document.id === evidence.documentId)
    : undefined;
  return (
    <Modal
      title="Bring in my schedule"
      subtitle="Choose the quickest source. Coqui shows a review before anything reaches your plan."
      close={close}
    >
      <div className="import-choice-grid">
        <button className="outline" onClick={openCanvas}>
          <Link2 aria-hidden="true" />
          <strong>Canvas calendar link</strong>
          <span>Paste the one link Canvas provides</span>
        </button>
        <button className="outline" disabled={busy} onClick={capture}>
          <LayoutGrid aria-hidden="true" />
          <strong>Capture screen area</strong>
          <span>Use the system snipping tool, then paste</span>
        </button>
      </div>
      <SchedulePhotoEditor
        disabled={busy}
        onError={onError}
        onImported={photosImported}
      />
      <button
        ref={pasteTarget}
        className="dropzone"
        disabled={busy}
        onClick={selectFile}
      >
        <Upload aria-hidden="true" />
        <strong>Paste, choose, or drop a schedule</strong>
        <span>PDF, image, ICS, Word, Excel, CSV, PowerPoint, or text</span>
        <span>Or paste a screenshot of your schedule with Ctrl/Cmd+V</span>
      </button>
      <button className="quick-add-detailed" onClick={enterManually}>
        <BookOpen aria-hidden="true" /> Enter classes manually
        <ChevronRight aria-hidden="true" />
      </button>
      <p className="privacy-note">
        <ShieldCheck aria-hidden="true" /> The original stays private. AI is
        never used without a connected provider and explicit consent.
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
                onClick={() => openEvidence(document.id)}
              >
                <FileLock2 aria-hidden="true" />
                <span>
                  <strong>{document.fileName}</strong>
                  <small>
                    {new Date(document.importedAt).toLocaleString()} · {document.approvedCount} approved · {document.pendingCount} pending
                  </small>
                  {document.extractionError && <em>{document.extractionError}</em>}
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
        {evidence && (
          <div className="vault-evidence" aria-live="polite">
            <div className="small-head">
              <h3>Saved source evidence</h3>
              <button
                className="icon-button"
                aria-label="Close source evidence"
                onClick={closeEvidence}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            {evidence.items.length ? (
              evidence.items.map((candidate) => (
                <article key={candidate.id}>
                  <strong>{candidate.title}</strong>
                  <q>{candidate.evidence}</q>
                  <small>{candidate.sourceLocator} · {candidate.status}</small>
                </article>
              ))
            ) : (
              <p>No academic facts were extracted from this source.</p>
            )}
            {evidenceSource?.mime.startsWith("image/") &&
              evidenceSource.originalAvailable && (
                <div className="ai-reread">
                  <p>
                    <ShieldCheck aria-hidden="true" /> Coqui read this screenshot
                    on your computer. If the class times came out wrong, it can
                    ask your selected AI provider to try again — that sends <strong>
                    this image and the text read from it</strong> off your computer.
                    Everything it proposes still needs your review, and you never
                    have to do this.
                  </p>
                  <button
                    className="outline"
                    disabled={busy}
                    onClick={() => rereadWithAi(evidence.documentId)}
                  >
                    Ask AI to re-read this screenshot
                  </button>
                </div>
              )}
          </div>
        )}
      </section>
    </Modal>
  );
}
