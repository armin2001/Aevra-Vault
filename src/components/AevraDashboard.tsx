'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CryptoWorkerError, cryptoClient } from '../crypto/crypto.client';
import { parseItem, serializeItem, type VaultItemData } from '../lib/vault-item';
import { syncVault, type SyncOutcome } from '../services/sync.service';
import {
  deleteEncryptedItem,
  getAllEncryptedItems,
  putEncryptedItem,
  type EncryptedVaultRecord,
} from '../services/vault.service';
import { ItemCard, type VaultEntry } from './ItemCard';
import { ItemForm } from './ItemForm';
import { SwitchKeyDialog } from './SwitchKeyDialog';
import { Alert, Button, Spinner, errorMessage, inputClass } from './ui';

type DecryptedEntry = Extract<VaultEntry, { status: 'decrypted' }>;

type DashboardState =
  | { status: 'loading'; done: number; total: number }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: VaultEntry[] };

type SyncState =
  | { status: 'syncing' }
  | { status: 'synced'; at: number }
  | { status: 'offline'; message: string }
  | { status: 'conflict'; message: string };

type Editor = { mode: 'create' } | { mode: 'edit'; entry: DecryptedEntry } | null;

const VAULT_LOCKED = Symbol('vault-locked');

function isLockedError(error: unknown): boolean {
  return error instanceof CryptoWorkerError && error.code === 'VAULT_LOCKED';
}

async function decryptRecord(record: EncryptedVaultRecord): Promise<VaultEntry | typeof VAULT_LOCKED> {
  const { id, createdAt, updatedAt } = record;
  try {
    const { plaintext } = await cryptoClient.decryptItem(id, record.payload);
    return { id, createdAt, updatedAt, status: 'decrypted', item: parseItem(plaintext) };
  } catch (error) {
    if (isLockedError(error)) return VAULT_LOCKED;
    const message =
      error instanceof CryptoWorkerError ? error.message : 'Unexpected error while decrypting this record.';
    return { id, createdAt, updatedAt, status: 'failed', error: message };
  }
}

/** Alphabetical by title; unreadable items last. */
function byTitle(a: VaultEntry, b: VaultEntry): number {
  if (a.status === 'decrypted' && b.status === 'decrypted') {
    return a.item.title.localeCompare(b.item.title, undefined, { sensitivity: 'base' });
  }
  if (a.status !== b.status) return a.status === 'decrypted' ? -1 : 1;
  return 0;
}

function matches(entry: VaultEntry, query: string): boolean {
  if (!query) return true;
  if (entry.status === 'failed') return false;
  const needle = query.toLowerCase();
  const { title, username, url } = entry.item;
  return [title, username, url].some((field) => field.toLowerCase().includes(needle));
}

export default function AevraDashboard({
  onVaultLocked,
  onLock,
}: {
  /** The worker reported the vault locked (e.g. it restarted). */
  onVaultLocked: () => void;
  /** Lock on the user's request. */
  onLock: () => void;
}) {
  const [state, setState] = useState<DashboardState>({ status: 'loading', done: 0, total: 0 });
  const [reloadToken, setReloadToken] = useState(0);
  const [sync, setSync] = useState<SyncState>({ status: 'syncing' });
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<Editor>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [passwordChangedElsewhere, setPasswordChangedElsewhere] = useState(false);
  const [keyReplacedElsewhere, setKeyReplacedElsewhere] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Load every encrypted record from IndexedDB and decrypt it in the worker.
  useEffect(() => {
    // Guards against setState after unmount and against the stale first run
    // that React Strict Mode fires in development.
    let cancelled = false;

    async function loadAndDecrypt() {
      let records: EncryptedVaultRecord[];
      try {
        records = await getAllEncryptedItems();
      } catch (error) {
        if (!cancelled) {
          setState({ status: 'error', message: errorMessage(error, 'Could not read the local vault database.') });
        }
        return;
      }
      if (cancelled) return;

      // A reload after sync keeps the current list on screen until it is ready.
      setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading', done: 0, total: records.length }));

      let done = 0;
      const results = await Promise.all(
        records.map(async (record) => {
          const result = await decryptRecord(record);
          done += 1;
          if (!cancelled) {
            const progress = done;
            setState((prev) => (prev.status === 'loading' ? { ...prev, done: progress } : prev));
          }
          return result;
        }),
      );
      if (cancelled) return;

      // sessionVEK is worker-wide, so one VAULT_LOCKED means they all are.
      if (results.includes(VAULT_LOCKED)) {
        onVaultLocked();
        return;
      }
      const entries = results.filter((result): result is VaultEntry => result !== VAULT_LOCKED);
      setState({ status: 'ready', entries });
    }

    void loadAndDecrypt();
    return () => {
      cancelled = true;
    };
  }, [reloadToken, onVaultLocked]);

  const applySync = useCallback((pending: Promise<SyncOutcome>) => {
    pending.then(
      (outcome) => {
        if (outcome.status === 'conflict') {
          setSync({ status: 'conflict', message: outcome.message });
          return;
        }
        if (outcome.status === 'rekeyed') {
          setSync({ status: 'syncing' });
          setKeyReplacedElsewhere(true);
          return;
        }
        setSync({ status: 'synced', at: outcome.at });
        setPasswordChangedElsewhere(outcome.passwordChangedElsewhere);
        if (outcome.pulled > 0) setReloadToken((token) => token + 1);
      },
      (error: unknown) => setSync({ status: 'offline', message: errorMessage(error, 'Backup failed.') }),
    );
  }, []);

  useEffect(() => {
    applySync(syncVault());
  }, [applySync]);

  const syncNow = useCallback(() => {
    setSync({ status: 'syncing' });
    applySync(syncVault());
  }, [applySync]);

  const closeEditor = useCallback(() => setEditor(null), []);

  function keySwitched({ carriedOver, lost }: { carriedOver: number; lost: number }) {
    setKeyReplacedElsewhere(false);
    setPasswordChangedElsewhere(false);
    const moved = carriedOver > 0 ? ` ${carriedOver} unsynced ${carriedOver === 1 ? 'change was' : 'changes were'} moved over.` : '';
    const dropped = lost > 0 ? ` ${lost} unreadable ${lost === 1 ? 'item was' : 'items were'} dropped.` : '';
    setNotice(`This browser now uses the new vault key.${moved}${dropped}`);
    setReloadToken((token) => token + 1);
    syncNow();
  }

  async function saveItem(item: VaultItemData, existing?: DecryptedEntry) {
    let payload;
    try {
      payload = await cryptoClient.encryptItem(serializeItem(item));
    } catch (error) {
      if (isLockedError(error)) {
        onVaultLocked();
        return;
      }
      throw error;
    }

    const now = Date.now();
    const record: EncryptedVaultRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      payload,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await putEncryptedItem(record);

    const entry: DecryptedEntry = {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: now,
      status: 'decrypted',
      item,
    };
    setState((prev) =>
      prev.status === 'ready'
        ? { ...prev, entries: [...prev.entries.filter((other) => other.id !== record.id), entry] }
        : prev,
    );
    setEditor(null);
    syncNow();
  }

  async function deleteItem(id: string) {
    setActionError(null);
    try {
      await deleteEncryptedItem(id, Date.now());
    } catch (error) {
      setActionError(errorMessage(error, 'Could not delete the item.'));
      return;
    }
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, entries: prev.entries.filter((entry) => entry.id !== id) } : prev,
    );
    syncNow();
  }

  const visible = useMemo(
    () => (state.status === 'ready' ? state.entries.filter((entry) => matches(entry, query.trim())).sort(byTitle) : []),
    [state, query],
  );

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Your vault</h1>
          <SyncStatus sync={sync} onSync={syncNow} />
        </div>
        <div className="flex gap-2">
          <input
            type="search"
            aria-label="Search items"
            placeholder="Search…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={`${inputClass} sm:w-64`}
          />
          <Button onClick={() => setEditor({ mode: 'create' })} disabled={state.status !== 'ready'} className="shrink-0">
            New item
          </Button>
        </div>
      </header>

      <div className="space-y-4">
        {sync.status === 'conflict' && <Alert tone="warning" title="Backup paused">{sync.message}</Alert>}
        {passwordChangedElsewhere && (
          <Alert tone="info" title="Master password changed in another browser">
            The next time you unlock here, use the new password. Until then this browser still
            accepts the old one.
          </Alert>
        )}
        {actionError && <Alert tone="error">{actionError}</Alert>}
        {notice && <Alert tone="info">{notice}</Alert>}

        {state.status === 'loading' && <LoadingState done={state.done} total={state.total} />}
        {state.status === 'error' && (
          <Alert tone="error" title="Could not load your vault">
            <p>{state.message}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setReloadToken((token) => token + 1)}>
              Try again
            </Button>
          </Alert>
        )}
        {state.status === 'ready' && (
          <EntryGrid
            entries={visible}
            total={state.entries.length}
            query={query.trim()}
            onCreate={() => setEditor({ mode: 'create' })}
            onEdit={(entry) => setEditor({ mode: 'edit', entry })}
            onDelete={deleteItem}
          />
        )}
      </div>

      {keyReplacedElsewhere && <SwitchKeyDialog onSwitched={keySwitched} onLock={onLock} />}
      {editor && !keyReplacedElsewhere && (
        <ItemForm
          initial={editor.mode === 'edit' ? editor.entry.item : undefined}
          onSave={(item) => saveItem(item, editor.mode === 'edit' ? editor.entry : undefined)}
          onCancel={closeEditor}
        />
      )}
    </section>
  );
}

function SyncStatus({ sync, onSync }: { sync: SyncState; onSync: () => void }) {
  const base = 'mt-1 flex items-center gap-2 text-sm';
  switch (sync.status) {
    case 'syncing':
      return (
        <p className={`${base} text-zinc-500 dark:text-zinc-400`} role="status">
          <Spinner className="h-3 w-3" /> Syncing with backup…
        </p>
      );
    case 'synced':
      return (
        <p className={`${base} text-zinc-500 dark:text-zinc-400`} role="status">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
          Backed up at {new Date(sync.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          <Button variant="ghost" size="sm" onClick={onSync}>
            Sync now
          </Button>
        </p>
      );
    case 'offline':
      return (
        <p className={`${base} text-amber-700 dark:text-amber-400`} role="status">
          <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden />
          Saved on this device only: {sync.message}
          <Button variant="ghost" size="sm" onClick={onSync}>
            Retry
          </Button>
        </p>
      );
    case 'conflict':
      return (
        <p className={`${base} text-amber-700 dark:text-amber-400`} role="status">
          <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden />
          Backup paused
        </p>
      );
  }
}

function LoadingState({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div role="status" aria-live="polite">
      <div className="mb-4 flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-300">
        <Spinner className="h-4 w-4 text-indigo-600" />
        {total > 0 ? `Decrypting records… ${done} of ${total}` : 'Loading encrypted records…'}
      </div>
      {total > 0 && (
        <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-full bg-indigo-600 transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: Math.min(total || 3, 6) }, (_, i) => (
          <li
            key={i}
            className="h-40 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
          />
        ))}
      </ul>
    </div>
  );
}

function EntryGrid({
  entries,
  total,
  query,
  onCreate,
  onEdit,
  onDelete,
}: {
  entries: VaultEntry[];
  total: number;
  query: string;
  onCreate: () => void;
  onEdit: (entry: DecryptedEntry) => void;
  onDelete: (id: string) => void;
}) {
  if (total === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
        <p className="font-medium">Your vault is empty</p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Items are encrypted on this device before they are stored or backed up.
        </p>
        <Button className="mt-4" onClick={onCreate}>
          Add your first item
        </Button>
      </div>
    );
  }
  if (entries.length === 0) {
    return <p className="py-10 text-center text-sm text-zinc-500">No items match “{query}”.</p>;
  }

  const failedCount = entries.filter((entry) => entry.status === 'failed').length;
  return (
    <>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {query ? `${entries.length} of ${total}` : total} {total === 1 ? 'item' : 'items'}
        {failedCount > 0 && (
          <span className="text-red-600 dark:text-red-400"> · {failedCount} could not be decrypted</span>
        )}
      </p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <ItemCard
            key={entry.id}
            entry={entry}
            onEdit={() => entry.status === 'decrypted' && onEdit(entry)}
            onDelete={() => onDelete(entry.id)}
          />
        ))}
      </ul>
    </>
  );
}
