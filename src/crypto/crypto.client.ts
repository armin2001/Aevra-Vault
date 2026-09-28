import type {
  CiphertextPayload,
  CryptoAction,
  CryptoError,
  CryptoErrorCode,
  CryptoParams,
  CryptoResult,
  DecryptItemResult,
  DeriveKeysResult,
  ItemCiphertext,
  RotateKeyResult,
  SwitchKeyResult,
  VaultKeyMaterial,
  WorkerRequest,
  WorkerResponse,
} from './crypto.types';

/** Rejection type for every CryptoClient call; `code` is safe to branch on in the UI. */
export class CryptoWorkerError extends Error {
  readonly code: CryptoErrorCode;
  readonly itemId?: string;

  constructor({ code, message, itemId }: CryptoError) {
    super(message);
    this.name = 'CryptoWorkerError';
    this.code = code;
    this.itemId = itemId;
  }
}

interface PendingRequest {
  resolve: (result: never) => void;
  reject: (error: CryptoWorkerError) => void;
}

/**
 * UI-thread facade over crypto.worker.ts. Each call posts one message and
 * resolves when the worker replies with the matching requestId.
 */
class CryptoClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  /**
   * Unlocks the worker with the master password. Pass the persisted key
   * material to unwrap the existing VEK (rejects with WRONG_PASSWORD on a bad
   * password); omit it only at first-time setup, then persist the result.
   * Prefer unlockVault() in vault.service.ts, which does both.
   */
  deriveKeys(password: string, keyMaterial?: VaultKeyMaterial): Promise<DeriveKeysResult> {
    return this.request('DERIVE_KEYS', { password, keyMaterial });
  }

  encryptItem(plaintext: string): Promise<CiphertextPayload> {
    return this.request('ENCRYPT_ITEM', { plaintext });
  }

  /**
   * Decrypts one stored record inside the worker. Rejects with a
   * CryptoWorkerError whose code is VAULT_LOCKED, INVALID_PAYLOAD or
   * DECRYPTION_FAILED.
   */
  decryptItem(itemId: string, payload: CiphertextPayload): Promise<DecryptItemResult> {
    return this.request('DECRYPT_ITEM', { itemId, payload });
  }

  /**
   * Re-wraps the vault key under `newPassword`. Rejects with WRONG_PASSWORD if
   * `currentPassword` does not unlock `keyMaterial`. Persist the result;
   * prefer changeMasterPassword() in vault.service.ts, which does that.
   */
  changePassword(
    currentPassword: string,
    newPassword: string,
    keyMaterial: VaultKeyMaterial,
  ): Promise<VaultKeyMaterial> {
    return this.request('CHANGE_PASSWORD', { currentPassword, newPassword, keyMaterial });
  }

  /**
   * Re-encrypts every item under a new VEK wrapped with `newPassword`. The
   * session keeps the old key; unlock with the result once it is persisted.
   */
  rotateKey(
    currentPassword: string,
    newPassword: string,
    keyMaterial: VaultKeyMaterial,
    items: ItemCiphertext[],
  ): Promise<RotateKeyResult> {
    return this.request('ROTATE_KEY', { currentPassword, newPassword, keyMaterial, items });
  }

  /** Switches the session to a key replaced elsewhere, carrying `items` over. */
  switchKey(password: string, keyMaterial: VaultKeyMaterial, items: ItemCiphertext[]): Promise<SwitchKeyResult> {
    return this.request('SWITCH_KEY', { password, keyMaterial, items });
  }

  /** Forgets the session key; every later call fails with VAULT_LOCKED until unlocked again. */
  async lock(): Promise<void> {
    // Nothing to forget if the worker was never started (or has crashed).
    if (!this.worker) return;
    await this.request('LOCK', {});
  }

  private request<A extends CryptoAction>(action: A, params: CryptoParams<A>): Promise<CryptoResult<A>> {
    let worker: Worker;
    try {
      worker = this.getWorker();
    } catch (error) {
      return Promise.reject(
        new CryptoWorkerError({
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Crypto worker unavailable.',
        }),
      );
    }

    const requestId = this.nextRequestId++;
    return new Promise<CryptoResult<A>>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, action, params } as WorkerRequest);
    });
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof window === 'undefined') {
      throw new Error('The crypto worker is only available in the browser.');
    }

    const worker = new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.settle(event.data);
    });
    worker.addEventListener('error', (event) => {
      // Only reachable if the worker script fails to load or crashes; the
      // in-memory sessionVEK is gone either way, so start fresh next call.
      event.preventDefault();
      worker.terminate();
      this.worker = null;
      this.rejectAll({ code: 'INTERNAL_ERROR', message: event.message || 'The crypto worker crashed.' });
    });

    this.worker = worker;
    return worker;
  }

  private settle(response: WorkerResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);

    if (response.ok) {
      pending.resolve(response.result as never);
    } else {
      pending.reject(new CryptoWorkerError(response.error));
    }
  }

  private rejectAll(error: CryptoError): void {
    for (const { reject } of this.pending.values()) reject(new CryptoWorkerError(error));
    this.pending.clear();
  }
}

export const cryptoClient = new CryptoClient();
