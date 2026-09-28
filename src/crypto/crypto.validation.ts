import { PBKDF2_ITERATIONS } from './crypto.engine';
import type { CiphertextPayload, VaultKeyMaterial } from './crypto.types';

/**
 * Runtime shape checks for data that crosses a trust boundary: records read
 * back from IndexedDB, messages into the worker, and request bodies on the
 * backup API. Shared so every layer accepts exactly the same formats.
 */

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && BASE64.test(value);
}

export function isCiphertextPayload(value: unknown): value is CiphertextPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    candidate.alg === 'AES-256-GCM' &&
    isBase64(candidate.nonce) &&
    isBase64(candidate.ciphertext)
  );
}

function isOptionalId(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 128);
}

export function isVaultKeyMaterial(value: unknown): value is VaultKeyMaterial {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isBase64(candidate.salt) &&
    isBase64(candidate.wrappedVek) &&
    typeof candidate.iterations === 'number' &&
    Number.isInteger(candidate.iterations) &&
    // Refuse to derive with a weakened cost even if the stored record says so.
    candidate.iterations >= PBKDF2_ITERATIONS &&
    isOptionalId(candidate.vaultId) &&
    isOptionalId(candidate.keyId) &&
    (candidate.changedAt === undefined ||
      (typeof candidate.changedAt === 'number' && Number.isSafeInteger(candidate.changedAt) && candidate.changedAt >= 0))
  );
}

/** Same wrapping of the same key (vaultId and changedAt are bookkeeping). */
export function sameKeyMaterial(a: VaultKeyMaterial, b: VaultKeyMaterial): boolean {
  return a.salt === b.salt && a.iterations === b.iterations && a.wrappedVek === b.wrappedVek;
}

/**
 * Stable identity of a vault across password changes. Vaults created before
 * vaultId existed are identified by their original wrapping, which is exactly
 * what their first password change records as vaultId.
 */
export function vaultIdOf(material: VaultKeyMaterial): string {
  return material.vaultId ?? material.wrappedVek;
}

export function changedAtOf(material: VaultKeyMaterial): number {
  return material.changedAt ?? 0;
}

/**
 * Identity of the VEK. A vault's first key has no keyId and is identified by
 * the vault; every replacement gets a fresh one.
 */
export function keyIdOf(material: VaultKeyMaterial): string {
  return material.keyId ?? vaultIdOf(material);
}
