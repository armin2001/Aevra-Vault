import type { CiphertextPayload } from '@/crypto/crypto.types';
import { guardRequest } from '@/lib/api-guard';
import type { BackupSnapshot } from '@/lib/backup.types';
import { prisma } from '@/lib/prisma';
import { toKeyMaterial } from '@/lib/vault-key-row';

/**
 * Full backup snapshot: key material, live items and deletion markers, or
 * `null` when nothing has been backed up yet. "No backup" is a normal answer
 * during setup, so it is a 200 rather than a 404.
 */
export async function GET(request: Request) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;

  const key = await prisma.vaultKey.findUnique({ where: { id: 'vault' } });
  if (!key) return Response.json(null, { headers: { 'Cache-Control': 'no-store' } });

  const [items, tombstones] = await Promise.all([
    prisma.vaultItem.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.vaultTombstone.findMany(),
  ]);

  const snapshot: BackupSnapshot = {
    keyMaterial: toKeyMaterial(key),
    items: items.map((item) => ({
      id: item.id,
      payload: {
        v: item.version,
        alg: item.alg,
        nonce: item.nonce,
        ciphertext: item.ciphertext,
      } as CiphertextPayload,
      createdAt: item.createdAt.getTime(),
      updatedAt: item.updatedAt.getTime(),
    })),
    deleted: tombstones.map((tombstone) => ({
      id: tombstone.id,
      deletedAt: tombstone.deletedAt.getTime(),
    })),
  };
  return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
}
