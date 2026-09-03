import { CircleAlert } from "lucide-react";
import { Modal } from "../../components/Modal";

export function DeleteProfileDialog({
  busy,
  confirmation,
  close,
  setConfirmation,
  erase,
}: {
  busy: boolean;
  confirmation: string;
  close: () => void;
  setConfirmation: (value: string) => void;
  erase: () => void;
}) {
  return (
    <Modal
      title="Delete this local profile"
      subtitle="This permanently removes the encrypted database, document vault, plans, imports, and local integration history from this computer."
      close={close}
    >
      <div className="consent-box security-warning">
        <CircleAlert aria-hidden="true" />
        <div>
          <strong>Create an encrypted backup first if you may need this data again.</strong>
          <p>
            Close this dialog and use Backups to export. Deletion cannot be undone
            and Student Center will return to first-run onboarding.
          </p>
        </div>
      </div>
      <label className="field">
        Type DELETE MY PROFILE
        <input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
        />
      </label>
      <div className="modal-actions">
        <button className="outline" onClick={close}>Cancel</button>
        <button
          className="solid danger-solid"
          disabled={busy || confirmation !== "DELETE MY PROFILE"}
          onClick={erase}
        >
          Permanently delete local profile
        </button>
      </div>
    </Modal>
  );
}
