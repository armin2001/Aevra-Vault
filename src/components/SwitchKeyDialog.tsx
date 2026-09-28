'use client';

import { useState, type FormEvent } from 'react';
import { CryptoWorkerError } from '../crypto/crypto.client';
import { switchToRotatedKey } from '../services/sync.service';
import { Alert, Button, Dialog, Field, Spinner, errorMessage, inputClass } from './ui';

/**
 * Shown when a sync finds that another browser replaced the vault key. It
 * can't be dismissed: until this browser switches, it can neither read new
 * items from the server nor back up its own changes.
 */
export function SwitchKeyDialog({
  onSwitched,
  onLock,
}: {
  onSwitched: (result: { carriedOver: number; lost: number }) => void;
  onLock: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Anything that can't be moved over is unreadable here already.
      onSwitched(await switchToRotatedKey(password, { allowLoss: true }));
    } catch (caught) {
      setBusy(false);
      setError(
        caught instanceof CryptoWorkerError && caught.code === 'WRONG_PASSWORD'
          ? 'Incorrect master password. Use the new one set in the other browser.'
          : errorMessage(caught, 'Could not switch to the new vault key.'),
      );
    }
  }

  return (
    <Dialog title="Vault key replaced in another browser" busy={busy}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Enter the current master password to switch this browser to the new key. Changes made here
          that were not backed up yet are moved over.
        </p>
        <Field label="Master password" htmlFor="switch-key-password">
          <input
            id="switch-key-password"
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
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onLock} disabled={busy}>
            Lock
          </Button>
          <Button type="submit" disabled={busy || !password}>
            {busy ? (
              <>
                <Spinner /> Switching…
              </>
            ) : (
              'Switch key'
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
