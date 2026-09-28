/**
 * Message protocol between the UI thread (crypto.client.ts) and the isolated
 * crypto worker (crypto.worker.ts). Only ciphertext envelopes and plaintext
 * values cross this boundary; CryptoKey objects never leave the worker.
 */

/** Versioned envelope produced by ENCRYPT_ITEM and consumed by DECRYPT_ITEM. */
export interface CiphertextPayload {
  v: 1;
  alg: 'AES-256-GCM';
  /** Base64-encoded 96-bit AES-GCM nonce. */
  nonce: string;
  /** Base64-encoded ciphertext with the 128-bit GCM auth tag appended. */
  ciphertext: string;
}

// --- DERIVE_KEYS -------------------------------------------------------------

/**
 * Everything needed to recover the VEK from the master password. None of it is
 * secret on its own, so it is persisted in plain form next to the vault.
 */
export interface VaultKeyMaterial {
  /** Base64 PBKDF2 salt. */
  salt: string;
  /** PBKDF2-SHA-256 iteration count the KEK was derived with. */
  iterations: number;
  /** Base64 AES-KW (RFC 3394) wrapping of the raw 256-bit VEK. */
  wrappedVek: string;
  /**
   * Identifies the vault across master password changes. Absent on vaults
   * created before password changes existed; see vaultIdOf().
   */
  vaultId?: string;
  /** Epoch ms when this wrapping was made; the newest wins across devices. */
  changedAt?: number;
  /**
   * Identifies the VEK itself. Unchanged by a password change; new when the
   * vault key is replaced. Absent until the first replacement; see keyIdOf().
   */
  keyId?: string;
}

/** An item as the worker sees it: an id and its ciphertext. */
export interface ItemCiphertext {
  id: string;
  payload: CiphertextPayload;
}

export interface DeriveKeysParams {
  password: string;
  /**
   * Material from vault setup. When present the worker unwraps the existing
   * VEK; when omitted it creates a new vault key (first-time setup only).
   */
  keyMaterial?: VaultKeyMaterial;
}

/** The material to persist: newly created on setup, echoed back on unlock. */
export type DeriveKeysResult = VaultKeyMaterial;

// --- CHANGE_PASSWORD ---------------------------------------------------------

export interface ChangePasswordParams {
  currentPassword: string;
  newPassword: string;
  /** The material `currentPassword` unlocks. */
  keyMaterial: VaultKeyMaterial;
}

// --- ROTATE_KEY --------------------------------------------------------------

export interface RotateKeyParams extends ChangePasswordParams {
  /** Every item of the vault, encrypted under the current VEK. */
  items: ItemCiphertext[];
}

export interface RotateKeyResult {
  /** New VEK wrapped under the new password, with a new keyId. */
  keyMaterial: VaultKeyMaterial;
  /** The same items re-encrypted under the new VEK. */
  items: ItemCiphertext[];
}

// --- SWITCH_KEY --------------------------------------------------------------

export interface SwitchKeyParams {
  password: string;
  /** Key material of a vault key replaced in another browser. */
  keyMaterial: VaultKeyMaterial;
  /** Local items under the session VEK to carry over to the new key. */
  items: ItemCiphertext[];
}

export interface SwitchKeyResult {
  items: ItemCiphertext[];
  /** Ids that could not be carried over (no old key in memory, or unreadable). */
  failed: string[];
}

// --- ENCRYPT_ITEM ------------------------------------------------------------

export interface EncryptItemParams {
  plaintext: string;
}

// --- DECRYPT_ITEM ------------------------------------------------------------

export interface DecryptItemParams {
  itemId: string;
  payload: CiphertextPayload;
}

export interface DecryptItemResult {
  itemId: string;
  plaintext: string;
}

// --- Errors ------------------------------------------------------------------

export type CryptoErrorCode =
  /** No sessionVEK in worker memory: the vault has not been unlocked. */
  | 'VAULT_LOCKED'
  /** The master password did not unwrap the stored VEK. */
  | 'WRONG_PASSWORD'
  /** A stored envelope or key record is malformed or uses an unsupported format. */
  | 'INVALID_PAYLOAD'
  /** AES-GCM authentication failed: wrong key or tampered/corrupted data. */
  | 'DECRYPTION_FAILED'
  | 'INTERNAL_ERROR';

export interface CryptoError {
  code: CryptoErrorCode;
  message: string;
  /** Set when the error belongs to a single vault item (DECRYPT_ITEM). */
  itemId?: string;
}

// --- Request / response envelopes -------------------------------------------

export interface CryptoActionMap {
  DERIVE_KEYS: { params: DeriveKeysParams; result: DeriveKeysResult };
  ENCRYPT_ITEM: { params: EncryptItemParams; result: CiphertextPayload };
  DECRYPT_ITEM: { params: DecryptItemParams; result: DecryptItemResult };
  /** Drops the session VEK from worker memory. */
  LOCK: { params: Record<string, never>; result: null };
  /** Re-wraps the same VEK under a new master password; items stay as they are. */
  CHANGE_PASSWORD: { params: ChangePasswordParams; result: VaultKeyMaterial };
  /** New password and a brand-new VEK; re-encrypts every item. Does not switch the session. */
  ROTATE_KEY: { params: RotateKeyParams; result: RotateKeyResult };
  /** Moves this session to a VEK replaced elsewhere, re-encrypting the given items. */
  SWITCH_KEY: { params: SwitchKeyParams; result: SwitchKeyResult };
}

export type CryptoAction = keyof CryptoActionMap;

export type CryptoParams<A extends CryptoAction> = CryptoActionMap[A]['params'];
export type CryptoResult<A extends CryptoAction> = CryptoActionMap[A]['result'];

/** Message posted to the worker. Discriminated on `action`. */
export type WorkerRequest = {
  [A in CryptoAction]: { requestId: number; action: A; params: CryptoParams<A> };
}[CryptoAction];

export type DecryptItemRequest = Extract<WorkerRequest, { action: 'DECRYPT_ITEM' }>;

/** Message posted back by the worker. Discriminated on `ok`. */
export type WorkerResponse<R = CryptoResult<CryptoAction>> =
  | { requestId: number; ok: true; result: R }
  | { requestId: number; ok: false; error: CryptoError };

/** DECRYPT_ITEM reply: the decrypted plaintext, or an error tied to the item. */
export type DecryptItemResponse = WorkerResponse<DecryptItemResult>;
