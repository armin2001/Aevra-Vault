import type { CiphertextPayload } from './crypto.types';

/** PBKDF2 cost for new vaults. Stored with the key material so it can be raised later. */
export const PBKDF2_ITERATIONS = 600_000;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * AES-KW (RFC 3394) has a built-in integrity check, so unwrapping with a KEK
 * derived from the wrong password rejects with an OperationError rather than
 * yielding a garbage key. Only a password change asks for an extractable copy.
 */
function unwrapVek(kek: CryptoKey, wrappedVek: string, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    fromBase64(wrappedVek),
    kek,
    'AES-KW',
    'AES-GCM',
    extractable,
    ['encrypt', 'decrypt'],
  );
}

/** Wraps an extractable VEK under a KEK; returns base64. */
async function wrapVek(kek: CryptoKey, vek: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.wrapKey('raw', vek, kek, 'AES-KW')));
}

/** Web Crypto primitives. Only ever called from inside crypto.worker.ts. */
export const CryptoEngine = {
  toBase64,
  fromBase64,

  generateSalt() {
    return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  },

  /**
   * PBKDF2-SHA-256 -> 256-bit AES-KW key-encryption key. The KEK algorithm must
   * be AES-KW to match wrapKey/unwrapKey below; a mismatch is what WebCrypto
   * reports as "key.algorithm does not match that of operation".
   */
  async deriveKek(
    password: string,
    salt: BufferSource,
    iterations: number = PBKDF2_ITERATIONS,
  ): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey'],
    );
  },

  /**
   * Creates the vault encryption key once, at vault setup. It is extractable
   * only long enough to be wrapped; the copy returned for the session is the
   * non-extractable result of unwrapping it again.
   */
  async createVek(kek: CryptoKey): Promise<{ vek: CryptoKey; wrappedVek: string }> {
    const exportable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const wrappedVek = await wrapVek(kek, exportable);
    return { vek: await unwrapVek(kek, wrappedVek), wrappedVek };
  },

  wrapVek,
  unwrapVek,

  async encrypt(vek: CryptoKey, plaintext: string): Promise<CiphertextPayload> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      vek,
      encoder.encode(plaintext),
    );
    return {
      v: 1,
      alg: 'AES-256-GCM',
      nonce: toBase64(nonce),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
    };
  },

  /**
   * Rejects with an OperationError if the key is wrong or the ciphertext/nonce
   * was altered (GCM tag mismatch), and with an InvalidCharacterError on bad base64.
   */
  async decrypt(vek: CryptoKey, payload: CiphertextPayload): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(payload.nonce) },
      vek,
      fromBase64(payload.ciphertext),
    );
    return decoder.decode(plaintext);
  },
};
