import type { CiphertextPayload, VaultKeyMaterial } from '@/crypto/crypto.types';

/** Wire format of the /api/vault backup endpoints. Timestamps are epoch milliseconds. */

export interface BackupItem {
  id: string;
  payload: CiphertextPayload;
  createdAt: number;
  updatedAt: number;
}

export interface BackupTombstone {
  id: string;
  deletedAt: number;
}

/** GET /api/vault (the response body is `null` when nothing is backed up yet). */
export interface BackupSnapshot {
  keyMaterial: VaultKeyMaterial;
  items: BackupItem[];
  deleted: BackupTombstone[];
}

/**
 * PUT /api/vault/key. Without `replaces` it only creates the first key. With
 * it, it replaces the stored key of the same vault (a password change) if the
 * stored wrappedVek still equals `replaces` and the new one is newer.
 */
export type PutKeyBody = VaultKeyMaterial & { replaces?: string };

/** PUT /api/vault/items/[id]. `keyId`: the vault key the payload is encrypted under. */
export type PutItemBody = Omit<BackupItem, 'id'> & { keyId: string };

/**
 * POST /api/vault/rotate: swaps the vault key and every item in one
 * transaction. `expected` is the server's item set the client re-encrypted;
 * if anything changed since, nothing is written (409 'changed').
 */
export interface RotateBody {
  keyMaterial: VaultKeyMaterial;
  replaces: string;
  expected: { id: string; updatedAt: number }[];
  items: BackupItem[];
}

/** DELETE /api/vault/items/[id] */
export type DeleteItemBody = Omit<BackupTombstone, 'id'>;

/**
 * 409 reasons. `stale`: the server copy is newer. `deleted`: deleted after
 * this edit. `rekeyed`: written under a vault key that has been replaced.
 * `changed`: items changed while a key replacement was being prepared.
 */
export type BackupConflictReason = 'stale' | 'deleted' | 'no-vault' | 'different-vault' | 'rekeyed' | 'changed';

export interface BackupErrorBody {
  error: string;
  reason?: BackupConflictReason;
}

export const ITEM_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
