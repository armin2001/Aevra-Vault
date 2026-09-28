import { cryptoClient } from '../crypto/crypto.client';
import { changedAtOf, keyIdOf, sameKeyMaterial, vaultIdOf } from '../crypto/crypto.validation';
import type { ItemCiphertext, VaultKeyMaterial } from '../crypto/crypto.types';
import type {
  BackupConflictReason,
  BackupErrorBody,
  BackupItem,
  BackupSnapshot,
  DeleteItemBody,
  PutItemBody,
  PutKeyBody,
  RotateBody,
} from '../lib/backup.types';
import {
  clearLocalTombstone,
  getAllEncryptedItems,
  getLocalTombstones,
  getPendingKeyMaterial,
  getVaultKeyMaterial,
  isCryptoError,
  mergeRemoteDeletion,
  mergeRemoteItem,
  replaceVaultContents,
  restoreVault,
  setPendingKeyMaterial,
  updatedAtOf,
  type EncryptedVaultRecord,
} from './vault.service';

/**
 * Keeps the local IndexedDB vault and the server backup (/api/vault) in step.
 * Only ciphertext and the password-wrapped key ever leave the browser.
 */

export class BackupError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: BackupConflictReason,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { cache: 'no-store', ...init });
  } catch {
    throw new BackupError('The backup server is unreachable.', 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as BackupErrorBody | null;
    throw new BackupError(
      body?.error ?? `Backup request failed (HTTP ${response.status}).`,
      response.status,
      body?.reason,
    );
  }
  return response;
}

function sendJson(method: 'PUT' | 'POST' | 'DELETE', path: string, body: unknown): Promise<Response> {
  return call(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function itemPath(id: string): string {
  return `/api/vault/items/${encodeURIComponent(id)}`;
}

/** The server's backup, or null if nothing has been backed up yet. */
export async function fetchSnapshot(): Promise<BackupSnapshot | null> {
  return (await (await call('/api/vault')).json()) as BackupSnapshot | null;
}

export async function hasServerBackup(): Promise<boolean> {
  return (await fetchSnapshot()) !== null;
}

/** `replaces`: the server's current wrappedVek, for a compare-and-swap after a password change. */
async function pushKeyMaterial(material: VaultKeyMaterial, replaces?: string): Promise<void> {
  const body: PutKeyBody = replaces ? { ...material, replaces } : material;
  await sendJson('PUT', '/api/vault/key', body);
}

type KeySync =
  | { status: 'in-sync' }
  | { status: 'changed-elsewhere' }
  | { status: 'rekeyed' }
  | { status: 'conflict'; message: string };

/**
 * Brings the key material in line with the server. A newer key from another
 * browser (a password change, or a replaced vault key) is parked as pending
 * (see setPendingKeyMaterial); a newer local wrapping is pushed.
 */
async function syncKeyMaterial(local: VaultKeyMaterial, snapshot: BackupSnapshot | null): Promise<KeySync> {
  try {
    if (!snapshot) {
      await pushKeyMaterial(local);
      return { status: 'in-sync' };
    }
    const remote = snapshot.keyMaterial;
    if (sameKeyMaterial(remote, local)) return { status: 'in-sync' };
    if (vaultIdOf(remote) !== vaultIdOf(local)) {
      return { status: 'conflict', message: 'The server holds a backup of a different vault, so sync is paused.' };
    }
    if (keyIdOf(remote) !== keyIdOf(local)) {
      if (changedAtOf(remote) > changedAtOf(local)) {
        await setPendingKeyMaterial(remote);
        return { status: 'rekeyed' };
      }
      return { status: 'conflict', message: 'This browser and the server hold different vault keys, so sync is paused.' };
    }
    if (changedAtOf(remote) > changedAtOf(local)) {
      await setPendingKeyMaterial(remote);
      return { status: 'changed-elsewhere' };
    }
    await pushKeyMaterial(local, remote.wrappedVek);
    return { status: 'in-sync' };
  } catch (error) {
    if (error instanceof BackupError && error.reason === 'different-vault') {
      return { status: 'conflict', message: error.message };
    }
    // 'stale': the server's key changed again meanwhile; the next sync reconciles it.
    if (error instanceof BackupError && error.reason === 'stale') return { status: 'in-sync' };
    throw error;
  }
}

/** Resolves false when the server rejected the copy as outdated; the next pull reconciles it. */
async function pushItem(record: EncryptedVaultRecord, keyId: string): Promise<boolean> {
  const body: PutItemBody = {
    payload: record.payload,
    createdAt: record.createdAt ?? updatedAtOf(record),
    updatedAt: updatedAtOf(record),
    keyId,
  };
  try {
    await sendJson('PUT', itemPath(record.id), body);
    return true;
  } catch (error) {
    // 'rekeyed': the key was replaced after this sync started; the next one picks that up.
    if (error instanceof BackupError && ['stale', 'deleted', 'rekeyed'].includes(error.reason ?? '')) return false;
    throw error;
  }
}

async function pushDeletion(id: string, deletedAt: number): Promise<void> {
  const body: DeleteItemBody = { deletedAt };
  try {
    await sendJson('DELETE', itemPath(id), body);
  } catch (error) {
    // 'stale': edited elsewhere after we deleted it; that edit wins and is pulled next time.
    if (!(error instanceof BackupError && error.reason === 'stale')) throw error;
  }
  await clearLocalTombstone(id);
}

export type SyncOutcome =
  | {
      status: 'synced';
      pulled: number;
      pushed: number;
      at: number;
      /** The master password was changed in another browser; the new one applies at next unlock. */
      passwordChangedElsewhere: boolean;
    }
  /** The vault key was replaced in another browser; call switchToRotatedKey() before going on. */
  | { status: 'rekeyed' }
  | { status: 'conflict'; message: string };

async function runSync(): Promise<SyncOutcome> {
  const localKey = await getVaultKeyMaterial();
  if (!localKey) throw new Error('This browser has no vault to sync.');

  const snapshot = await fetchSnapshot();
  const keySync = await syncKeyMaterial(localKey, snapshot);
  // After a key replacement the server's items are under a key this session
  // doesn't hold, and our pushes would be rejected: stop until switched.
  if (keySync.status === 'conflict' || keySync.status === 'rekeyed') return keySync;

  let pulled = 0;
  let pushed = 0;

  // Pull: newer items and deletions from other devices.
  for (const item of snapshot?.items ?? []) {
    if (await mergeRemoteItem(item)) pulled++;
  }
  for (const tombstone of snapshot?.deleted ?? []) {
    if (await mergeRemoteDeletion(tombstone.id, tombstone.deletedAt)) pulled++;
  }

  // Push: everything the server lacks or has older, then pending deletions.
  const keyId = keyIdOf(localKey);
  const remoteUpdatedAt = new Map((snapshot?.items ?? []).map((item) => [item.id, item.updatedAt]));
  for (const record of await getAllEncryptedItems()) {
    const theirs = remoteUpdatedAt.get(record.id);
    if (theirs !== undefined && theirs >= updatedAtOf(record)) continue;
    if (await pushItem(record, keyId)) pushed++;
  }
  for (const tombstone of await getLocalTombstones()) {
    await pushDeletion(tombstone.id, tombstone.deletedAt);
    pushed++;
  }

  return {
    status: 'synced',
    pulled,
    pushed,
    at: Date.now(),
    passwordChangedElsewhere: keySync.status === 'changed-elsewhere',
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `task` after every sync or key operation queued before it. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** Two-way sync with the server backup. Calls are serialized; each waits for the previous one. */
export function syncVault(): Promise<SyncOutcome> {
  return exclusive(runSync);
}

/** Installs the server backup into this (empty) browser. Unlock afterwards as usual. */
export async function restoreFromServer(): Promise<void> {
  const snapshot = await fetchSnapshot();
  if (!snapshot) throw new BackupError('There is no backup on this server.', 404);
  await restoreVault(snapshot.keyMaterial, snapshot.items);
}

// --- Vault key replacement -----------------------------------------------------

function toCiphertexts(items: { id: string; payload: ItemCiphertext['payload'] }[]): ItemCiphertext[] {
  return items.map(({ id, payload }) => ({ id, payload }));
}

/**
 * Changes the master password and replaces the vault key: every item is
 * re-encrypted under a brand-new key in the worker, the server swaps key and
 * items in one transaction, and only then does this browser switch. Needs the
 * backup server, so that every browser ends up on the same key.
 */
export function changePasswordAndReplaceKey(currentPassword: string, newPassword: string): Promise<void> {
  return exclusive(async () => {
    const synced = await runSync();
    if (synced.status === 'conflict') throw new BackupError(`The vault key can't be replaced: ${synced.message}`, 409);
    if (synced.status === 'rekeyed') {
      throw new BackupError('The vault key was already replaced in another browser. Switch to it first.', 409);
    }

    const snapshot = await fetchSnapshot();
    if (!snapshot) throw new BackupError('The backup server has no copy of this vault yet.', 409);
    const local = await getAllEncryptedItems();
    const serverVersions = new Map(snapshot.items.map((item) => [item.id, item.updatedAt]));
    const inStep =
      local.length === serverVersions.size &&
      local.every((record) => serverVersions.get(record.id) === updatedAtOf(record));
    if (!inStep) throw new BackupError('The vault changed while preparing. Try again.', 409, 'changed');

    const [existing, pending] = await Promise.all([getVaultKeyMaterial(), getPendingKeyMaterial()]);
    if (!existing) throw new Error('This browser has no vault.');
    // "Current" may be the password set in another browser (pending) or the one known here.
    const rotate = (base: VaultKeyMaterial) =>
      cryptoClient.rotateKey(currentPassword, newPassword, base, toCiphertexts(snapshot.items));
    const result = pending
      ? await rotate(pending).catch((error: unknown) => {
          if (isCryptoError(error, 'WRONG_PASSWORD')) return rotate(existing);
          throw error;
        })
      : await rotate(existing);

    const floor =
      Math.max(changedAtOf(snapshot.keyMaterial), changedAtOf(existing), pending ? changedAtOf(pending) : 0) + 1;
    const keyMaterial = { ...result.keyMaterial, changedAt: Math.max(changedAtOf(result.keyMaterial), floor) };
    const rotated = new Map(result.items.map((item) => [item.id, item.payload]));
    const items: BackupItem[] = snapshot.items.map((item) => ({ ...item, payload: rotated.get(item.id)! }));

    const body: RotateBody = {
      keyMaterial,
      replaces: snapshot.keyMaterial.wrappedVek,
      expected: snapshot.items.map(({ id, updatedAt }) => ({ id, updatedAt })),
      items,
    };
    await sendJson('POST', '/api/vault/rotate', body);
    // Server first: if this browser fails from here on, its next sync sees the
    // replaced key and switches to it like any other browser would.
    await replaceVaultContents(keyMaterial, items);
    await cryptoClient.deriveKeys(newPassword, keyMaterial);
  });
}

/** Local changes that never reached the server and cannot be moved to the new key. */
export class UnsyncedChangesError extends Error {
  constructor(readonly count: number) {
    super(
      `${count} ${count === 1 ? 'change' : 'changes'} made in this browser never reached the backup and cannot be moved to the new vault key.`,
    );
    this.name = 'UnsyncedChangesError';
  }
}

/** Local items newer than anything the server has for them (edits, or items it never got). */
function unsyncedItems(local: EncryptedVaultRecord[], snapshot: BackupSnapshot): EncryptedVaultRecord[] {
  const remote = new Map<string, number>();
  for (const item of snapshot.items) remote.set(item.id, item.updatedAt);
  for (const tombstone of snapshot.deleted) {
    remote.set(tombstone.id, Math.max(remote.get(tombstone.id) ?? 0, tombstone.deletedAt));
  }
  return local.filter((record) => updatedAtOf(record) > (remote.get(record.id) ?? -1));
}

/**
 * Switches this browser to a vault key that was replaced in another browser:
 * loads the re-encrypted items from the server and carries over local changes
 * that never reached it, re-encrypted under the new key. Changes that cannot
 * be carried over (the old key is not in memory, or they are unreadable) make
 * it reject with UnsyncedChangesError, unless `allowLoss`.
 */
export function switchToRotatedKey(
  password: string,
  { allowLoss = false }: { allowLoss?: boolean } = {},
): Promise<{ carriedOver: number; lost: number }> {
  return exclusive(async () => {
    const [localKey, snapshot] = await Promise.all([getVaultKeyMaterial(), fetchSnapshot()]);
    if (!localKey || !snapshot) throw new BackupError('The backup server has no copy of this vault.', 409);
    if (keyIdOf(snapshot.keyMaterial) === keyIdOf(localKey)) return { carriedOver: 0, lost: 0 };

    const [local, tombstones] = await Promise.all([getAllEncryptedItems(), getLocalTombstones()]);
    const unsynced = unsyncedItems(local, snapshot);
    const result = await cryptoClient.switchKey(password, snapshot.keyMaterial, toCiphertexts(unsynced));
    if (result.failed.length > 0 && !allowLoss) throw new UnsyncedChangesError(result.failed.length);

    const carried = new Map(result.items.map((item) => [item.id, item.payload]));
    const deletedHere = new Map(tombstones.map((tombstone) => [tombstone.id, tombstone.deletedAt]));
    const records: EncryptedVaultRecord[] = [
      ...snapshot.items.filter(
        (item) => !carried.has(item.id) && (deletedHere.get(item.id) ?? -1) < item.updatedAt,
      ),
      ...unsynced.filter((record) => carried.has(record.id)).map((record) => ({ ...record, payload: carried.get(record.id)! })),
    ];
    await replaceVaultContents(snapshot.keyMaterial, records);
    return { carriedOver: result.items.length, lost: result.failed.length };
  });
}
