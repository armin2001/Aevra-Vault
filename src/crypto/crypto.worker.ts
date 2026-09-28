import { CryptoEngine, PBKDF2_ITERATIONS } from './crypto.engine';
import type {
  ChangePasswordParams,
  CryptoError,
  CryptoErrorCode,
  CryptoResult,
  DecryptItemParams,
  DecryptItemResult,
  DeriveKeysParams,
  DeriveKeysResult,
  ItemCiphertext,
  RotateKeyParams,
  RotateKeyResult,
  SwitchKeyParams,
  SwitchKeyResult,
  VaultKeyMaterial,
  WorkerRequest,
  WorkerResponse,
} from './crypto.types';
import { isCiphertextPayload, isVaultKeyMaterial, vaultIdOf } from './crypto.validation';

/**
 * The only reference to the vault key. It lives in worker memory for the
 * lifetime of the worker and is never posted to the UI thread.
 */
let sessionVEK: CryptoKey | null = null;

const workerScope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse): void;
};

class CryptoRequestError extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
    readonly itemId?: string,
  ) {
    super(message);
  }
}

function requireSessionVek(itemId?: string): CryptoKey {
  if (!sessionVEK) {
    throw new CryptoRequestError(
      'VAULT_LOCKED',
      'The vault is locked. Unlock it with your master password to continue.',
      itemId,
    );
  }
  return sessionVEK;
}

async function deriveKeys({ password, keyMaterial }: DeriveKeysParams): Promise<DeriveKeysResult> {
  // Any unlock attempt locks first, so a wrong password never leaves an old key usable.
  sessionVEK = null;

  if (keyMaterial === undefined) {
    const salt = CryptoEngine.generateSalt();
    const kek = await CryptoEngine.deriveKek(password, salt, PBKDF2_ITERATIONS);
    const { vek, wrappedVek } = await CryptoEngine.createVek(kek);
    sessionVEK = vek;
    return {
      salt: CryptoEngine.toBase64(salt),
      iterations: PBKDF2_ITERATIONS,
      wrappedVek,
      vaultId: crypto.randomUUID(),
      changedAt: Date.now(),
    };
  }

  if (!isVaultKeyMaterial(keyMaterial)) {
    throw new CryptoRequestError('INVALID_PAYLOAD', 'The stored vault key data is corrupted.');
  }

  const kek = await CryptoEngine.deriveKek(
    password,
    CryptoEngine.fromBase64(keyMaterial.salt),
    keyMaterial.iterations,
  );
  try {
    sessionVEK = await CryptoEngine.unwrapVek(kek, keyMaterial.wrappedVek);
  } catch {
    throw new CryptoRequestError('WRONG_PASSWORD', 'Incorrect master password.');
  }
  return keyMaterial;
}

/**
 * Proves the current password by unwrapping the stored VEK, then wraps that
 * same VEK under a KEK from the new password and a fresh salt. Items are not
 * touched because the VEK does not change. The vault stays unlocked.
 */
async function changePassword({
  currentPassword,
  newPassword,
  keyMaterial,
}: ChangePasswordParams): Promise<VaultKeyMaterial> {
  requireSessionVek();
  if (!isVaultKeyMaterial(keyMaterial)) {
    throw new CryptoRequestError('INVALID_PAYLOAD', 'The stored vault key data is corrupted.');
  }

  const currentKek = await CryptoEngine.deriveKek(
    currentPassword,
    CryptoEngine.fromBase64(keyMaterial.salt),
    keyMaterial.iterations,
  );
  let exportable: CryptoKey;
  try {
    // Extractable only for the duration of this function, to be re-wrapped.
    exportable = await CryptoEngine.unwrapVek(currentKek, keyMaterial.wrappedVek, true);
  } catch {
    throw new CryptoRequestError('WRONG_PASSWORD', 'The current master password is incorrect.');
  }

  const salt = CryptoEngine.generateSalt();
  const newKek = await CryptoEngine.deriveKek(newPassword, salt, PBKDF2_ITERATIONS);
  const wrappedVek = await CryptoEngine.wrapVek(newKek, exportable);
  // Switch the session to the new wrapping so an immediate lock/unlock uses it.
  sessionVEK = await CryptoEngine.unwrapVek(newKek, wrappedVek);

  return {
    salt: CryptoEngine.toBase64(salt),
    iterations: PBKDF2_ITERATIONS,
    wrappedVek,
    vaultId: vaultIdOf(keyMaterial),
    changedAt: Date.now(),
    // Same VEK, so the same key identity.
    ...(keyMaterial.keyId !== undefined && { keyId: keyMaterial.keyId }),
  };
}

/**
 * Proves the current password, decrypts every item, and re-encrypts it under
 * a brand-new VEK wrapped with the new password. The session keeps the old
 * VEK: the caller switches only after the server and local storage both hold
 * the result, so a failure halfway never strands this browser on a key its
 * stored items don't match.
 */
async function rotateKey({
  currentPassword,
  newPassword,
  keyMaterial,
  items,
}: RotateKeyParams): Promise<RotateKeyResult> {
  requireSessionVek();
  if (!isVaultKeyMaterial(keyMaterial)) {
    throw new CryptoRequestError('INVALID_PAYLOAD', 'The stored vault key data is corrupted.');
  }

  const currentKek = await CryptoEngine.deriveKek(
    currentPassword,
    CryptoEngine.fromBase64(keyMaterial.salt),
    keyMaterial.iterations,
  );
  let oldVek: CryptoKey;
  try {
    oldVek = await CryptoEngine.unwrapVek(currentKek, keyMaterial.wrappedVek);
  } catch {
    throw new CryptoRequestError('WRONG_PASSWORD', 'The current master password is incorrect.');
  }

  const plaintexts: { id: string; plaintext: string }[] = [];
  for (const { id, payload } of items) {
    try {
      if (!isCiphertextPayload(payload)) throw new Error('malformed');
      plaintexts.push({ id, plaintext: await CryptoEngine.decrypt(oldVek, payload) });
    } catch {
      throw new CryptoRequestError(
        'DECRYPTION_FAILED',
        'An item cannot be decrypted, so the vault key cannot be replaced. Delete unreadable items first.',
        id,
      );
    }
  }

  const salt = CryptoEngine.generateSalt();
  const newKek = await CryptoEngine.deriveKek(newPassword, salt, PBKDF2_ITERATIONS);
  const { vek, wrappedVek } = await CryptoEngine.createVek(newKek);
  const rotated = await Promise.all(
    plaintexts.map(async ({ id, plaintext }) => ({ id, payload: await CryptoEngine.encrypt(vek, plaintext) })),
  );

  return {
    keyMaterial: {
      salt: CryptoEngine.toBase64(salt),
      iterations: PBKDF2_ITERATIONS,
      wrappedVek,
      vaultId: vaultIdOf(keyMaterial),
      keyId: crypto.randomUUID(),
      changedAt: Date.now(),
    },
    items: rotated,
  };
}

/**
 * Unwraps a VEK that replaced the current one in another browser, moves the
 * given items (still under the session VEK) over to it, and switches the
 * session. Items that cannot be decrypted with the session VEK are reported.
 */
async function switchKey({ password, keyMaterial, items }: SwitchKeyParams): Promise<SwitchKeyResult> {
  if (!isVaultKeyMaterial(keyMaterial)) {
    throw new CryptoRequestError('INVALID_PAYLOAD', 'The new vault key data is corrupted.');
  }
  const kek = await CryptoEngine.deriveKek(
    password,
    CryptoEngine.fromBase64(keyMaterial.salt),
    keyMaterial.iterations,
  );
  let newVek: CryptoKey;
  try {
    newVek = await CryptoEngine.unwrapVek(kek, keyMaterial.wrappedVek);
  } catch {
    throw new CryptoRequestError('WRONG_PASSWORD', 'Incorrect master password.');
  }

  const oldVek = sessionVEK;
  const carried: ItemCiphertext[] = [];
  const failed: string[] = [];
  for (const { id, payload } of items) {
    if (!oldVek || !isCiphertextPayload(payload)) {
      failed.push(id);
      continue;
    }
    try {
      const plaintext = await CryptoEngine.decrypt(oldVek, payload);
      carried.push({ id, payload: await CryptoEngine.encrypt(newVek, plaintext) });
    } catch {
      failed.push(id);
    }
  }

  sessionVEK = newVek;
  return { items: carried, failed };
}

async function decryptItem({ itemId, payload }: DecryptItemParams): Promise<DecryptItemResult> {
  const vek = requireSessionVek(itemId);

  if (!isCiphertextPayload(payload)) {
    throw new CryptoRequestError(
      'INVALID_PAYLOAD',
      'This record is malformed or uses an unsupported encryption format.',
      itemId,
    );
  }

  try {
    const plaintext = await CryptoEngine.decrypt(vek, payload);
    return { itemId, plaintext };
  } catch {
    // AES-GCM only reports a bare OperationError; don't guess between a wrong
    // key and tampered data, and never echo ciphertext back in the message.
    throw new CryptoRequestError(
      'DECRYPTION_FAILED',
      'This record could not be decrypted with the current vault key.',
      itemId,
    );
  }
}

async function handleRequest(request: WorkerRequest): Promise<CryptoResult<WorkerRequest['action']>> {
  switch (request.action) {
    case 'DERIVE_KEYS':
      return deriveKeys(request.params);
    case 'ENCRYPT_ITEM':
      return CryptoEngine.encrypt(requireSessionVek(), request.params.plaintext);
    case 'DECRYPT_ITEM':
      return decryptItem(request.params);
    case 'LOCK':
      sessionVEK = null;
      return null;
    case 'CHANGE_PASSWORD':
      return changePassword(request.params);
    case 'ROTATE_KEY':
      return rotateKey(request.params);
    case 'SWITCH_KEY':
      return switchKey(request.params);
    default: {
      const unknownAction: never = request;
      throw new Error(`Unknown crypto action: ${JSON.stringify(unknownAction)}`);
    }
  }
}

function toCryptoError(error: unknown): CryptoError {
  if (error instanceof CryptoRequestError) {
    return { code: error.code, message: error.message, itemId: error.itemId };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unexpected crypto worker error.',
  };
}

workerScope.addEventListener('message', (event) => {
  const request = event.data;
  handleRequest(request).then(
    (result) => workerScope.postMessage({ requestId: request.requestId, ok: true, result }),
    (error: unknown) =>
      workerScope.postMessage({ requestId: request.requestId, ok: false, error: toCryptoError(error) }),
  );
});
