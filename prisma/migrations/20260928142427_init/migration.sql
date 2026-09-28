-- CreateTable
CREATE TABLE "VaultKey" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'vault',
    "salt" TEXT NOT NULL,
    "iterations" INTEGER NOT NULL,
    "wrappedVek" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "VaultItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "alg" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VaultTombstone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deletedAt" DATETIME NOT NULL
);
