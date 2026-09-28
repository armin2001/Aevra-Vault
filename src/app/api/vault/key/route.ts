import { changedAtOf, isVaultKeyMaterial, keyIdOf, sameKeyMaterial, vaultIdOf } from '@/crypto/crypto.validation';
import type { VaultKeyMaterial } from '@/crypto/crypto.types';
import { errorResponse, guardRequest, readJsonBody } from '@/lib/api-guard';
import { prisma } from '@/lib/prisma';
import { toKeyColumns, toKeyMaterial } from '@/lib/vault-key-row';

async function readStoredKey(): Promise<VaultKeyMaterial | null> {
  const key = await prisma.vaultKey.findUnique({ where: { id: 'vault' } });
  return key ? toKeyMaterial(key) : null;
}

/**
 * Stores the wrapped vault key. The first PUT creates it; re-sending the same
 * key is a no-op. A master password change (same VEK, new wrapping) replaces
 * it only for the same vault and key, only if it is newer, and only if the
 * stored wrapping still equals `replaces` (compare-and-swap), so a stale
 * browser can never roll it back.
 */
export async function PUT(request: Request) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isVaultKeyMaterial(body)) return errorResponse(400, 'Invalid key material.');
  const replaces = (body as { replaces?: unknown }).replaces;
  if (replaces !== undefined && typeof replaces !== 'string') return errorResponse(400, 'Invalid key material.');
  const incoming: VaultKeyMaterial = {
    salt: body.salt,
    iterations: body.iterations,
    wrappedVek: body.wrappedVek,
    ...(body.vaultId !== undefined && { vaultId: body.vaultId }),
    ...(body.changedAt !== undefined && { changedAt: body.changedAt }),
    ...(body.keyId !== undefined && { keyId: body.keyId }),
  };

  let stored = await readStoredKey();
  if (!stored) {
    try {
      await prisma.vaultKey.create({ data: { id: 'vault', ...toKeyColumns(incoming) } });
      return Response.json({ ok: true }, { status: 201 });
    } catch (error) {
      // Lost a race with a concurrent PUT: fall through and compare with the winner.
      stored = await readStoredKey();
      if (!stored) throw error;
    }
  }

  if (sameKeyMaterial(stored, incoming)) return Response.json({ ok: true });
  if (vaultIdOf(stored) !== vaultIdOf(incoming)) {
    return errorResponse(409, 'This server already backs up a different vault.', 'different-vault');
  }
  if (keyIdOf(incoming) !== keyIdOf(stored)) {
    // A new vault key only makes sense together with its re-encrypted items.
    return errorResponse(409, 'Replace the vault key through /api/vault/rotate.', 'rekeyed');
  }
  if (replaces === undefined || changedAtOf(incoming) <= changedAtOf(stored)) {
    return errorResponse(409, 'The server has a newer vault key.', 'stale');
  }

  const { count } = await prisma.vaultKey.updateMany({
    where: { id: 'vault', wrappedVek: replaces },
    data: toKeyColumns(incoming),
  });
  if (count === 0) return errorResponse(409, 'The vault key changed meanwhile.', 'stale');
  return Response.json({ ok: true });
}
