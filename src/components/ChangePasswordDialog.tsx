'use client';

import { useState, type FormEvent } from 'react';
import { CryptoWorkerError } from '../crypto/crypto.client';
import { changePasswordAndReplaceKey } from '../services/sync.service';
import { changeMasterPassword } from '../services/vault.service';
import { Alert, Button, Dialog, Field, Spinner, errorMessage, inputClass } from './ui';
import { MIN_PASSWORD_LENGTH } from './VaultGate';

export function ChangePasswordDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [replaceKey, setReplaceKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'password' | 'key' | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for the new password.`);
      return;
    }
    if (next !== confirmation) {
      setError('The new passwords do not match.');
      return;
    }
    if (next === current) {
      setError('The new password must be different from the current one.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (replaceKey) {
        await changePasswordAndReplaceKey(current, next);
      } else {
        await changeMasterPassword(current, next);
      }
      setDone(replaceKey ? 'key' : 'password');
      onChanged();
    } catch (caught) {
      setError(
        caught instanceof CryptoWorkerError && caught.code === 'WRONG_PASSWORD'
          ? 'The current master password is incorrect.'
          : caught instanceof CryptoWorkerError && caught.code === 'VAULT_LOCKED'
            ? 'The vault locked itself. Unlock it and try again.'
            : errorMessage(caught, 'Could not change the master password.'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Dialog title={done === 'key' ? 'Vault key replaced' : 'Master password changed'} onClose={onClose}>
        <div className="space-y-4 text-sm text-zinc-600 dark:text-zinc-300">
          {done === 'key' ? (
            <>
              <p>
                Every item was re-encrypted under a new vault key, and the backup server now holds only
                the new version. Use the new master password from now on.
              </p>
              <p>
                Other browsers ask for the new password on their next sync to switch to the new key.
                Changes they had not backed up yet are moved over.
              </p>
            </>
          ) : (
            <>
              <p>Use the new password from now on. The backup server is updated in the background.</p>
              <p>
                Other browsers switch over after their next sync. Until you unlock them with the new
                password once, they still accept the old one.
              </p>
            </>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose} autoFocus>
              Done
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Change master password" busy={busy} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Current master password" htmlFor="current-master-password">
          <input
            id="current-master-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field
          label="New master password"
          htmlFor="new-master-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        >
          <input
            id="new-master-password"
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(event) => setNext(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Confirm new master password" htmlFor="confirm-master-password">
          <input
            id="confirm-master-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className={inputClass}
          />
        </Field>

        <label className="flex cursor-pointer gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
          <input
            type="checkbox"
            checked={replaceKey}
            onChange={(event) => setReplaceKey(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">Also replace the vault key</span>
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
              Re-encrypts every item under a new key, so someone holding an old copy of your vault
              and the old password can&apos;t read anything you save from now on. Needs the backup
              server to be reachable.
            </span>
          </span>
        </label>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {replaceKey
            ? 'Old copies of the vault still contain the items as they were, readable with the old password.'
            : 'Your items are not re-encrypted; the vault key is locked with the new password instead. Copies of the vault taken before this change can still be opened with the old password.'}
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> {replaceKey ? 'Re-encrypting…' : 'Changing…'}
              </>
            ) : (
              'Change password'
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
