import { useEffect, useRef, useState } from "react";
import { AccountModal } from "../../components/AccountModal";
import {
  getAccountStatus,
  requestEmailCode,
  verifyEmailCode,
  startGoogleSignIn,
  cancelGoogleSignIn,
  refreshAccountSession,
  signOutAccount,
  type AccountStatus,
} from "../../native";
export function AccountSettings({
  accountStatus,
  setAccountStatus,
  setToast,
  close,
}: {
  accountStatus: AccountStatus | null;
  setAccountStatus: (status: AccountStatus) => void;
  setToast: (message: string) => void;
  close: () => void;
}) {
  const [accountMode, setAccountMode] = useState<"email" | "verify">("email");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [codeRetryAfter, setCodeRetryAfter] = useState(0);

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const statusCallback = useRef(setAccountStatus);
  statusCallback.current = setAccountStatus;
  useEffect(() => {
    let active = true;
    getAccountStatus()
      .then((status) => {
        if (!active) return;
        statusCallback.current(status);
        if (status.email) setAccountEmail(status.email);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
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

  useEffect(() => {
    if (codeRetryAfter <= 0) return;
    const timer = setTimeout(
      () => setCodeRetryAfter((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [codeRetryAfter]);

  return (
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
      close={() => {
        if (!busy) close();
      }}
      presentation="settings"
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
  );
}
