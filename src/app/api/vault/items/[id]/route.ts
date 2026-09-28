import { isCiphertextPayload, keyIdOf } from '@/crypto/crypto.validation';
import { errorResponse, guardRequest, isRecord, isTimestamp, readJsonBody } from '@/lib/api-guard';
import { ITEM_ID_PATTERN } from '@/lib/backup.types';
import { prisma } from '@/lib/prisma';
import { toKeyMaterial } from '@/lib/vault-key-row';

type Context = { params: Promise<{ id: string }> };

/**
 * Upserts one encrypted item. Last write wins on `updatedAt`: an older copy
 * than the server's, or one deleted after this edit, is rejected with 409, as
 * is one encrypted under a vault key that has since been replaced.
 */
export async function PUT(request: Request, { params }: Context) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const { id } = await params;
  if (!ITEM_ID_PATTERN.test(id)) return errorResponse(400, 'Invalid item id.');

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (
    !isRecord(body) ||
    !isCiphertextPayload(body.payload) ||
    !isTimestamp(body.createdAt) ||
    !isTimestamp(body.updatedAt) ||
    typeof body.keyId !== 'string'
  ) {
    return errorResponse(400, 'Invalid item.');
  }
  const { payload, createdAt, updatedAt, keyId } = body;

  const outcome = await prisma.$transaction(async (tx) => {
    const key = await tx.vaultKey.findUnique({ where: { id: 'vault' } });
    if (!key) return 'no-vault' as const;
    if (keyIdOf(toKeyMaterial(key)) !== keyId) return 'rekeyed' as const;

    const tombstone = await tx.vaultTombstone.findUnique({ where: { id } });
    if (tombstone && tombstone.deletedAt.getTime() >= updatedAt) return 'deleted' as const;

    const existing = await tx.vaultItem.findUnique({ where: { id }, select: { updatedAt: true } });
    if (existing && existing.updatedAt.getTime() > updatedAt) return 'stale' as const;

    if (tombstone) await tx.vaultTombstone.delete({ where: { id } });
    const data = {
      version: payload.v,
      alg: payload.alg,
      nonce: payload.nonce,
      ciphertext: payload.ciphertext,
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
    };
    await tx.vaultItem.upsert({ where: { id }, create: { id, ...data }, update: data });
    return 'saved' as const;
  });

  if (outcome === 'no-vault') return errorResponse(409, 'Back up the vault key before its items.', 'no-vault');
  if (outcome === 'rekeyed') return errorResponse(409, 'The vault key has been replaced.', 'rekeyed');
  if (outcome === 'deleted') return errorResponse(409, 'Item was deleted after this edit.', 'deleted');
  if (outcome === 'stale') return errorResponse(409, 'The server has a newer version.', 'stale');
  return Response.json({ ok: true });
}

/** Deletes an item and records a tombstone, unless the server copy was edited after `deletedAt`. */
export async function DELETE(request: Request, { params }: Context) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const { id } = await params;
  if (!ITEM_ID_PATTERN.test(id)) return errorResponse(400, 'Invalid item id.');

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.body) || !isTimestamp(parsed.body.deletedAt)) {
    return errorResponse(400, 'Invalid deletion.');
  }
  const deletedAt = parsed.body.deletedAt;

  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.vaultItem.findUnique({ where: { id }, select: { updatedAt: true } });
    if (existing && existing.updatedAt.getTime() > deletedAt) return 'stale' as const;

    if (existing) await tx.vaultItem.delete({ where: { id } });
    const previous = await tx.vaultTombstone.findUnique({ where: { id } });
    const at = new Date(Math.max(deletedAt, previous?.deletedAt.getTime() ?? 0));
    await tx.vaultTombstone.upsert({ where: { id }, create: { id, deletedAt: at }, update: { deletedAt: at } });
    return 'deleted' as const;
  });

  if (outcome === 'stale') return errorResponse(409, 'The item was edited after this deletion.', 'stale');
  return Response.json({ ok: true });
}
