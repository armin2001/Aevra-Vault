import { CryptoWorkerError, cryptoClient } from '../crypto/crypto.client';
import type { CiphertextPayload, CryptoErrorCode, VaultKeyMaterial } from '../crypto/crypto.types';
import { changedAtOf, keyIdOf } from '../crypto/crypto.validation';

/** Shape of a row in the local items store. Only ciphertext is persisted. */
export interface EncryptedVaultRecord {
  id: string;
  payload: CiphertextPayload;
  createdAt?: number;
  updatedAt?: number;
}

/** A local deletion the backup server has not acknowledged yet. */
export interface LocalTombstone {
  id: string;
  deletedAt: number;
}

export const VAULT_DB_NAME = 'aevra-vault';
const ITEMS = 'items';
const META = 'meta';
const TOMBSTONES = 'tombstones';
const KEY_MATERIAL_ID = 'vault';
const PENDING_KEY_MATERIAL_ID = 'pending';

const STORES: Record<string, IDBObjectStoreParameters | undefined> = {
  [ITEMS]: { keyPath: 'id' },
  [META]: undefined,
  [TOMBSTONES]: { keyPath: 'id' },
};

function missingStores(db: IDBDatabase): string[] {
  return Object.keys(STORES).filter((name) => !db.objectStoreNames.contains(name));
}

function openAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(VAULT_DB_NAME) : indexedDB.open(VAULT_DB_NAME, version);
    request.onupgradeneeded = () => {
      for (const name of missingStores(request.result)) {
        request.result.createObjectStore(name, STORES[name]);
      }
    };
    request.onsuccess = () => {
      // Let a newer tab upgrade the schema instead of being blocked by us.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open the local vault database.'));
    request.onblocked = () =>
      reject(new Error('Close other Aevra Vault tabs so local storage can be upgraded, then retry.'));
  });
}

/**
 * Opens whatever version exists and only bumps it when a store is missing, so
 * a database created by an older build is upgraded in place, never replaced.
 */
async function openVaultDb(): Promise<IDBDatabase> {
  const db = await openAt();
  if (missingStores(db).length === 0) return db;
  const nextVersion = db.version + 1;
  db.close();
  return openAt(nextVersion);
}

/**
 * Runs `work` in a single transaction over `stores` and resolves with the
 * result of the request it returns once the transaction has committed. Any
 * failed request aborts the whole transaction.
 */
async function transact<T = undefined>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openVaultDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(stores, mode);
      const request = work(transaction);
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      // A failed request always aborts the transaction; by the abort event
      // transaction.error holds the original DOMException (e.g. ConstraintError).
      transaction.onabort = () =>
        reject(transaction.error ?? request?.error ?? new Error('Local vault database request failed.'));
    });
  } finally {
    db.close();
  }
}

// --- Items -------------------------------------------------------------------

export async function getAllEncryptedItems(): Promise<EncryptedVaultRecord[]> {
  const records = await transact<EncryptedVaultRecord[]>([ITEMS], 'readonly', (tx) =>
    tx.objectStore(ITEMS).getAll(),
  );
  return records ?? [];
}

export async function putEncryptedItem(record: EncryptedVaultRecord): Promise<void> {
  await transact([ITEMS, TOMBSTONES], 'readwrite', (tx) => {
    tx.objectStore(TOMBSTONES).delete(record.id);
    tx.objectStore(ITEMS).put(record);
  });
}

/** Deletes an item and remembers the deletion until the server acknowledges it. */
export async function deleteEncryptedItem(id: string, deletedAt: number): Promise<void> {
  await transact([ITEMS, TOMBSTONES], 'readwrite', (tx) => {
    tx.objectStore(ITEMS).delete(id);
    tx.objectStore(TOMBSTONES).put({ id, deletedAt } satisfies LocalTombstone);
  });
}

export function updatedAtOf(record: EncryptedVaultRecord): number {
  return record.updatedAt ?? record.createdAt ?? 0;
}

/**
 * Stores an item received from the server unless this browser holds a newer
 * edit or a newer deletion of it. Checked and written in one transaction so a
 * concurrent local edit can never be overwritten. Resolves true if applied.
 */
export async function mergeRemoteItem(record: EncryptedVaultRecord): Promise<boolean> {
  let applied = false;
  await transact([ITEMS, TOMBSTONES], 'readwrite', (tx) => {
    const items = tx.objectStore(ITEMS);
    const tombstones = tx.objectStore(TOMBSTONES);
    const existingRequest = items.get(record.id);
    const tombstoneRequest = tombstones.get(record.id);
    // Requests in a transaction complete in order, so both results are ready here.
    tombstoneRequest.onsuccess = () => {
      const existing = existingRequest.result as EncryptedVaultRecord | undefined;
      const tombstone = tombstoneRequest.result as LocalTombstone | undefined;
      const incoming = updatedAtOf(record);
      if (existing && updatedAtOf(existing) >= incoming) return;
      if (tombstone && tombstone.deletedAt >= incoming) return;
      tombstones.delete(record.id);
      items.put(record);
      applied = true;
    };
  });
  return applied;
}

/** Applies a deletion from the server unless the local copy was edited after it. */
export async function mergeRemoteDeletion(id: string, deletedAt: number): Promise<boolean> {
  let applied = false;
  await transact([ITEMS], 'readwrite', (tx) => {
    const items = tx.objectStore(ITEMS);
    const existingRequest = items.get(id);
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as EncryptedVaultRecord | undefined;
      if (!existing || updatedAtOf(existing) > deletedAt) return;
      items.delete(id);
      applied = true;
    };
  });
  return applied;
}

export async function getLocalTombstones(): Promise<LocalTombstone[]> {
  const tombstones = await transact<LocalTombstone[]>([TOMBSTONES], 'readonly', (tx) =>
    tx.objectStore(TOMBSTONES).getAll(),
  );
  return tombstones ?? [];
}

export async function clearLocalTombstone(id: string): Promise<void> {
  await transact([TOMBSTONES], 'readwrite', (tx) => {
    tx.objectStore(TOMBSTONES).delete(id);
  });
}

// --- Key material ------------------------------------------------------------

export async function getVaultKeyMaterial(): Promise<VaultKeyMaterial | null> {
  const material = await transact<VaultKeyMaterial | undefined>([META], 'readonly', (tx) =>
    tx.objectStore(META).get(KEY_MATERIAL_ID),
  );
  return material ?? null;
}

/** False until a master password has been set (or a backup restored) in this browser. */
export async function isVaultInitialized(): Promise<boolean> {
  return (await getVaultKeyMaterial()) !== null;
}

/**
 * Key material from a master password change made in another browser, held
 * until the new password is proven here. Until then the current material
 * keeps working, so a bad or tampered copy from the server can never lock
 * this browser out of its vault.
 */
export async function getPendingKeyMaterial(): Promise<VaultKeyMaterial | null> {
  const material = await transact<VaultKeyMaterial | undefined>([META], 'readonly', (tx) =>
    tx.objectStore(META).get(PENDING_KEY_MATERIAL_ID),
  );
  return material ?? null;
}

export async function setPendingKeyMaterial(material: VaultKeyMaterial): Promise<void> {
  await transact([META], 'readwrite', (tx) => {
    tx.objectStore(META).put(material, PENDING_KEY_MATERIAL_ID);
  });
}

/** Makes `material` this browser's key material and drops any pending one. */
async function replaceKeyMaterial(material: VaultKeyMaterial): Promise<void> {
  await transact([META], 'readwrite', (tx) => {
    const meta = tx.objectStore(META);
    meta.put(material, KEY_MATERIAL_ID);
    meta.delete(PENDING_KEY_MATERIAL_ID);
  });
}

function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'ConstraintError';
}

export function isCryptoError(error: unknown, ...codes: CryptoErrorCode[]): boolean {
  return error instanceof CryptoWorkerError && codes.includes(error.code);
}

/** What another browser changed that this one has not applied yet. */
export async function getPendingChange(): Promise<'password' | 'key' | null> {
  const [existing, pending] = await Promise.all([getVaultKeyMaterial(), getPendingKeyMaterial()]);
  if (!existing || !pending) return null;
  return keyIdOf(pending) === keyIdOf(existing) ? 'password' : 'key';
}

/**
 * Replaces the whole local vault, key material and every item, in one
 * transaction. Used when the vault key changes: items under the old key
 * must never sit next to the new key.
 */
export async function replaceVaultContents(
  material: VaultKeyMaterial,
  records: EncryptedVaultRecord[],
): Promise<void> {
  await transact([ITEMS, META], 'readwrite', (tx) => {
    const items = tx.objectStore(ITEMS);
    items.clear();
    for (const record of records) items.put(record);
    const meta = tx.objectStore(META);
    meta.put(material, KEY_MATERIAL_ID);
    meta.delete(PENDING_KEY_MATERIAL_ID);
  });
}

/**
 * Unlocks the vault with the master password, creating and persisting the
 * vault key on first use. Rejects with a CryptoWorkerError whose code is
 * WRONG_PASSWORD when the password does not match the stored key.
 *
 * `needsKeySwitch`: the vault key was replaced in another browser and the
 * password opened only the new key; finish with switchToRotatedKey() before
 * reading items. (The old password opens this browser's copy instead, so its
 * unsynced changes can still be carried over once the dashboard asks.)
 */
export async function unlockVault(password: string): Promise<{ created: boolean; needsKeySwitch?: boolean }> {
  const existing = await getVaultKeyMaterial();
  if (existing) {
    const pending = await getPendingKeyMaterial();
    if (pending && keyIdOf(pending) !== keyIdOf(existing)) {
      try {
        await cryptoClient.deriveKeys(password, existing);
        return { created: false };
      } catch (error) {
        if (!isCryptoError(error, 'WRONG_PASSWORD', 'INVALID_PAYLOAD')) throw error;
      }
      await cryptoClient.deriveKeys(password, pending);
      return { created: false, needsKeySwitch: true };
    }
    if (pending) {
      try {
        await cryptoClient.deriveKeys(password, pending);
        await replaceKeyMaterial(pending);
        return { created: false };
      } catch (error) {
        // Not the password set elsewhere: fall back to the one this browser knows.
        if (!isCryptoError(error, 'WRONG_PASSWORD', 'INVALID_PAYLOAD')) throw error;
      }
    }
    await cryptoClient.deriveKeys(password, existing);
    return { created: false };
  }

  const material = await cryptoClient.deriveKeys(password);
  try {
    // add(), not put(): if another tab finished setup first, its key must win
    // or anything that tab already encrypted would become unreadable.
    await transact([META], 'readwrite', (tx) => tx.objectStore(META).add(material, KEY_MATERIAL_ID));
    return { created: true };
  } catch (error) {
    if (!isConstraintError(error)) throw error;

    const winner = await getVaultKeyMaterial();
    if (!winner) throw error;
    await cryptoClient.deriveKeys(password, winner);
    return { created: false };
  }
}

/**
 * Changes the master password in this browser; the vault must be unlocked.
 * The next sync pushes the new key material to the server, and other browsers
 * switch to it once the new password is used there. Rejects with
 * WRONG_PASSWORD if `currentPassword` is wrong.
 */
export async function changeMasterPassword(currentPassword: string, newPassword: string): Promise<void> {
  const existing = await getVaultKeyMaterial();
  if (!existing) throw new Error('This browser has no vault.');
  const pending = await getPendingKeyMaterial();

  // "Current" may be the password set in another browser (pending) or the one known here.
  const rewrap = (base: VaultKeyMaterial) => cryptoClient.changePassword(currentPassword, newPassword, base);
  const updated = pending
    ? await rewrap(pending).catch((error: unknown) => {
        if (isCryptoError(error, 'WRONG_PASSWORD')) return rewrap(existing);
        throw error;
      })
    : await rewrap(existing);

  // Must sort after every wrapping this browser has seen, even with clock skew
  // between devices, or sync would treat the change as stale.
  const floor = Math.max(changedAtOf(existing), pending ? changedAtOf(pending) : 0) + 1;
  await replaceKeyMaterial({ ...updated, changedAt: Math.max(changedAtOf(updated), floor) });
}

/**
 * Installs a backed-up vault into an empty browser in one transaction: either
 * the key and every item land, or nothing does. Rejects with a ConstraintError
 * DOMException if this browser already has a vault.
 */
export async function restoreVault(
  keyMaterial: VaultKeyMaterial,
  records: EncryptedVaultRecord[],
): Promise<void> {
  await transact([ITEMS, META], 'readwrite', (tx) => {
    const items = tx.objectStore(ITEMS);
    for (const record of records) items.put(record);
    tx.objectStore(META).add(keyMaterial, KEY_MATERIAL_ID);
  });
}
