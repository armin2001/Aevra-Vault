import { changedAtOf, isCiphertextPayload, isVaultKeyMaterial, keyIdOf, vaultIdOf } from '@/crypto/crypto.validation';
import type { VaultKeyMaterial } from '@/crypto/crypto.types';
import { errorResponse, guardRequest, isRecord, isTimestamp, readJsonBody } from '@/lib/api-guard';
import { ITEM_ID_PATTERN, type BackupConflictReason, type BackupItem } from '@/lib/backup.types';
import { prisma } from '@/lib/prisma';
import { toKeyColumns, toKeyMaterial } from '@/lib/vault-key-row';

// The body carries every item of the vault.
const MAX_ROTATE_BODY_CHARS = 50_000_000;

class RotationConflict extends Error {
  constructor(
    readonly reason: BackupConflictReason,
    message: string,
  ) {
    super(message);
  }
}

function isBackupItem(value: unknown): value is BackupItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    ITEM_ID_PATTERN.test(value.id) &&
    isCiphertextPayload(value.payload) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

function versionKey(id: string, updatedAt: number): string {
  return `${id}@${updatedAt}`;
}

/**
 * Replaces the vault key and every item in one transaction (a vault key
 * replacement). Written only if the stored key is still `replaces`, the new
 * key is newer and has a new keyId, and the server's items are exactly the
 * `expected` set the client re-encrypted; otherwise 409 and nothing changes.
 */
export async function POST(request: Request) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const parsed = await readJsonBody(request, MAX_ROTATE_BODY_CHARS);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (
    !isRecord(body) ||
    !isVaultKeyMaterial(body.keyMaterial) ||
    typeof body.keyMaterial.keyId !== 'string' ||
    typeof body.replaces !== 'string' ||
    !Array.isArray(body.expected) ||
    !Array.isArray(body.items) ||
    !body.items.every(isBackupItem) ||
    !body.expected.every((entry) => isRecord(entry) && typeof entry.id === 'string' && isTimestamp(entry.updatedAt))
  ) {
    return errorResponse(400, 'Invalid key replacement.');
  }
  const incoming: VaultKeyMaterial = body.keyMaterial;
  const replaces = body.replaces;
  const items = body.items as BackupItem[];
  const expected = new Set(
    (body.expected as { id: string; updatedAt: number }[]).map((entry) => versionKey(entry.id, entry.updatedAt)),
  );
  // Timestamps are kept, so the re-encrypted items must be exactly the expected versions.
  const incomingVersions = new Set(items.map((item) => versionKey(item.id, item.updatedAt)));
  if (
    incomingVersions.size !== items.length ||
    incomingVersions.size !== expected.size ||
    ![...incomingVersions].every((version) => expected.has(version))
  ) {
    return errorResponse(400, 'The re-encrypted items do not match the expected items.');
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        const key = await tx.vaultKey.findUnique({ where: { id: 'vault' } });
        if (!key) throw new RotationConflict('no-vault', 'There is no vault key to replace.');
        const stored = toKeyMaterial(key);
        if (vaultIdOf(stored) !== vaultIdOf(incoming)) {
          throw new RotationConflict('different-vault', 'This server backs up a different vault.');
        }
        if (
          stored.wrappedVek !== replaces ||
          changedAtOf(incoming) <= changedAtOf(stored) ||
          keyIdOf(incoming) === keyIdOf(stored)
        ) {
          throw new RotationConflict('stale', 'The vault key changed meanwhile.');
        }

        const current = await tx.vaultItem.findMany({ select: { id: true, updatedAt: true } });
        const unchanged =
          current.length === expected.size &&
          current.every((item) => expected.has(versionKey(item.id, item.updatedAt.getTime())));
        if (!unchanged) {
          throw new RotationConflict('changed', 'Items changed while the vault key was being replaced.');
        }

        await tx.vaultItem.deleteMany({});
        if (items.length > 0) {
          await tx.vaultItem.createMany({
            data: items.map((item) => ({
              id: item.id,
              version: item.payload.v,
              alg: item.payload.alg,
              nonce: item.payload.nonce,
              ciphertext: item.payload.ciphertext,
              createdAt: new Date(item.createdAt),
              updatedAt: new Date(item.updatedAt),
            })),
          });
        }
        await tx.vaultKey.update({ where: { id: 'vault' }, data: toKeyColumns(incoming) });
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    if (error instanceof RotationConflict) return errorResponse(409, error.message, error.reason);
    throw error;
  }
  return Response.json({ ok: true });
}
