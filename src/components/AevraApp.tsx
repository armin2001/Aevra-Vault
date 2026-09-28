'use client';

import { useCallback, useEffect, useState } from 'react';
import { cryptoClient } from '../crypto/crypto.client';
import { hasServerBackup } from '../services/sync.service';
import { isVaultInitialized } from '../services/vault.service';
import AevraDashboard from './AevraDashboard';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { SetupScreen, UnlockScreen } from './VaultGate';
import { Alert, Button, LockIcon, Spinner, errorMessage } from './ui';

type Phase =
  | { name: 'checking' }
  | { name: 'setup'; serverBackup: boolean }
  | { name: 'locked' }
  | { name: 'unlocked' }
  | { name: 'error'; message: string };

const AUTO_LOCK_MS = 10 * 60 * 1000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** Calls `onIdle` after AUTO_LOCK_MS without keyboard or pointer activity while `active`. */
function useIdleTimeout(active: boolean, onIdle: () => void) {
  useEffect(() => {
    if (!active) return;
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, touch, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity >= AUTO_LOCK_MS) onIdle();
    }, 15_000);
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, touch);
      window.clearInterval(timer);
    };
  }, [active, onIdle]);
}

export default function AevraApp() {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });
  const [changingPassword, setChangingPassword] = useState(false);
  // Bumped after a password or key change: remounting the dashboard re-reads
  // and re-syncs the vault under the new key material.
  const [dashboardEpoch, setDashboardEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function detect() {
      try {
        if (await isVaultInitialized()) {
          if (!cancelled) setPhase({ name: 'locked' });
          return;
        }
        // An unreachable server just means no restore offer, not an error.
        const serverBackup = await hasServerBackup().catch(() => false);
        if (!cancelled) setPhase({ name: 'setup', serverBackup });
      } catch (error) {
        if (!cancelled) {
          setPhase({ name: 'error', message: errorMessage(error, 'Could not open local storage.') });
        }
      }
    }
    void detect();
    return () => {
      cancelled = true;
    };
  }, []);

  const lock = useCallback(() => {
    // Drop decrypted items from the screen right away; the worker forgets the key next.
    setPhase({ name: 'locked' });
    setChangingPassword(false);
    cryptoClient.lock().catch(() => undefined);
  }, []);

  const showLocked = useCallback(() => {
    setPhase({ name: 'locked' });
    setChangingPassword(false);
  }, []);
  const closePasswordDialog = useCallback(() => setChangingPassword(false), []);
  const passwordChanged = useCallback(() => setDashboardEpoch((epoch) => epoch + 1), []);
  const showUnlocked = useCallback(() => setPhase({ name: 'unlocked' }), []);

  useIdleTimeout(phase.name === 'unlocked', lock);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <span className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-600 text-white">
              <LockIcon className="h-4 w-4" />
            </span>
            Aevra Vault
          </span>
          {phase.name === 'unlocked' && (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setChangingPassword(true)}>
                Change password
              </Button>
              <Button variant="secondary" size="sm" onClick={lock}>
                <LockIcon className="h-3.5 w-3.5" /> Lock
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">
        {phase.name === 'checking' && (
          <div className="flex justify-center py-24 text-zinc-400" role="status" aria-label="Loading">
            <Spinner className="h-6 w-6" />
          </div>
        )}
        {phase.name === 'error' && (
          <div className="mx-auto max-w-md px-4 py-16">
            <Alert tone="error" title="Aevra Vault can't start">
              {phase.message} Private browsing modes may block local storage.
            </Alert>
          </div>
        )}
        {phase.name === 'setup' && (
          <SetupScreen serverBackup={phase.serverBackup} onCreated={showUnlocked} onRestored={showLocked} />
        )}
        {phase.name === 'locked' && <UnlockScreen onUnlocked={showUnlocked} />}
        {phase.name === 'unlocked' && <AevraDashboard key={dashboardEpoch} onVaultLocked={showLocked} onLock={lock} />}
        {phase.name === 'unlocked' && changingPassword && (
          <ChangePasswordDialog onClose={closePasswordDialog} onChanged={passwordChanged} />
        )}
      </main>

      <footer className="py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">
        End-to-end encrypted. Keys stay in an isolated worker and never reach the page or the server.
      </footer>
    </div>
  );
}
