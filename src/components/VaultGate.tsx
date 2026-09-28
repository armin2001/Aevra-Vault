'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CryptoWorkerError } from '../crypto/crypto.client';
import { UnsyncedChangesError, restoreFromServer, switchToRotatedKey } from '../services/sync.service';
import { getPendingChange, unlockVault } from '../services/vault.service';
import { Alert, Button, Field, LockIcon, Spinner, errorMessage, inputClass } from './ui';

export const MIN_PASSWORD_LENGTH = 12;

function GateCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:py-20">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-600 text-white">
            <LockIcon />
          </span>
          <div>
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingChange, setPendingChange] = useState<'password' | 'key' | null>(null);
  /** Unsynced changes that would be lost by switching to the new vault key now. */
  const [unsynced, setUnsynced] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPendingChange().then(
      (change) => {
        if (!cancelled) setPendingChange(change);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function unlock(allowLoss: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { needsKeySwitch } = await unlockVault(password);
      if (needsKeySwitch) await switchToRotatedKey(password, { allowLoss });
      onUnlocked();
    } catch (caught) {
      setBusy(false);
      if (caught instanceof UnsyncedChangesError) {
        setUnsynced(caught.count);
        return;
      }
      setError(
        caught instanceof CryptoWorkerError && caught.code === 'WRONG_PASSWORD'
          ? 'Incorrect master password.'
          : errorMessage(caught, 'Could not unlock the vault.'),
      );
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || busy) return;
    setUnsynced(null);
    void unlock(false);
  }

  return (
    <GateCard title="Unlock your vault" subtitle="Enter your master password to continue.">
      <form onSubmit={handleSubmit} className="space-y-4">
        {pendingChange === 'password' && (
          <Alert tone="info" title="Master password changed in another browser">
            Use the new password. Once it has unlocked this browser, the old one stops working here.
          </Alert>
        )}
        {pendingChange === 'key' && unsynced === null && (
          <Alert tone="info" title="Vault key replaced in another browser">
            Unlock with the new master password to switch this browser to the new key.
          </Alert>
        )}
        {unsynced !== null && (
          <Alert tone="warning" title="Changes not backed up">
            <p>
              {unsynced} {unsynced === 1 ? 'change' : 'changes'} made in this browser never reached the
              backup and can only be moved to the new key with the old key. To keep{' '}
              {unsynced === 1 ? 'it' : 'them'}, unlock with your previous master password instead.
            </p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => unlock(true)} disabled={busy}>
              Discard {unsynced === 1 ? 'it' : 'them'} and continue
            </Button>
          </Alert>
        )}
        <Field label="Master password" htmlFor="unlock-password">
          <input
            id="unlock-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={inputClass}
          />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" disabled={busy || !password} className="w-full">
          {busy ? (
            <>
              <Spinner /> Unlocking…
            </>
          ) : (
            'Unlock'
          )}
        </Button>
      </form>
    </GateCard>
  );
}

export function SetupScreen({
  serverBackup,
  onCreated,
  onRestored,
}: {
  serverBackup: boolean;
  onCreated: () => void;
  onRestored: () => void;
}) {
  const [creating, setCreating] = useState(!serverBackup);

  if (!creating) {
    return <RestoreScreen onRestored={onRestored} onCreateInstead={() => setCreating(true)} />;
  }
  return <CreateVaultScreen onCreated={onCreated} serverBackup={serverBackup} />;
}

function RestoreScreen({ onRestored, onCreateInstead }: { onRestored: () => void; onCreateInstead: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      await restoreFromServer();
      onRestored();
    } catch (caught) {
      setBusy(false);
      setError(errorMessage(caught, 'Could not restore the backup.'));
    }
  }

  return (
    <GateCard title="Backup found" subtitle="This server holds an encrypted copy of a vault.">
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Restore it into this browser, then unlock it with the master password you used when you
          created it. The server cannot read the backup; only your password can.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <Button onClick={restore} disabled={busy} className="w-full">
          {busy ? (
            <>
              <Spinner /> Restoring…
            </>
          ) : (
            'Restore backup'
          )}
        </Button>
        <Button variant="ghost" onClick={onCreateInstead} disabled={busy} className="w-full">
          Create a new vault instead
        </Button>
      </div>
    </GateCard>
  );
}

function CreateVaultScreen({ onCreated, serverBackup }: { onCreated: () => void; serverBackup: boolean }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== password;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unlockVault(password);
      onCreated();
    } catch (caught) {
      setBusy(false);
      setError(errorMessage(caught, 'Could not create the vault.'));
    }
  }

  return (
    <GateCard title="Create your vault" subtitle="Choose a master password to encrypt everything.">
      <form onSubmit={handleSubmit} className="space-y-4">
        {serverBackup && (
          <Alert tone="warning">
            The server already backs up another vault. A new vault works locally, but it will not be
            backed up to this server.
          </Alert>
        )}
        <Field
          label="Master password"
          htmlFor="new-password"
          hint={tooShort ? `${MIN_PASSWORD_LENGTH - password.length} more characters needed.` : `At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words work well.`}
        >
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Confirm master password" htmlFor="confirm-password" hint={mismatch ? 'Does not match yet.' : undefined}>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Alert tone="info">
          Your master password never leaves this device and cannot be reset. If you forget it, the
          vault cannot be recovered.
        </Alert>
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? (
            <>
              <Spinner /> Creating vault…
            </>
          ) : (
            'Create vault'
          )}
        </Button>
      </form>
    </GateCard>
  );
}
