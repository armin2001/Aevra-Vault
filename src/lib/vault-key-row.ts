import type { VaultKeyMaterial } from '@/crypto/crypto.types';
import type { VaultKey } from '@/generated/prisma/client';

/** VaultKey row -> wire format; absent optional fields stay absent. */
export function toKeyMaterial(key: VaultKey): VaultKeyMaterial {
  return {
    salt: key.salt,
    iterations: key.iterations,
    wrappedVek: key.wrappedVek,
    ...(key.vaultId !== null && { vaultId: key.vaultId }),
    ...(key.changedAt !== null && { changedAt: key.changedAt.getTime() }),
    ...(key.keyId !== null && { keyId: key.keyId }),
  };
}

/** Wire format -> VaultKey columns. */
export function toKeyColumns(material: VaultKeyMaterial) {
  return {
    salt: material.salt,
    iterations: material.iterations,
    wrappedVek: material.wrappedVek,
    vaultId: material.vaultId ?? null,
    changedAt: material.changedAt === undefined ? null : new Date(material.changedAt),
    keyId: material.keyId ?? null,
  };
}
