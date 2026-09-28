# Aevra Vault

End-to-end encrypted password manager: Next.js 16 (App Router, Turbopack), Web Crypto in an isolated Web Worker, IndexedDB for the local vault, and Prisma + SQLite for an encrypted server-side backup.

## Run it

Requires Node.js 20.9+ and npm 12+.

```bash
npm install      # installs dependencies and generates the Prisma client
npm run dev      # http://127.0.0.1:3000
```

For a production build: `npm run build`, then `npm start`. Both `dev` and `start` apply pending database migrations first.

Other scripts: `npm run lint`, `npm run typecheck`.

## How it works

- **Keys.** The master password goes through PBKDF2-SHA-256 (600,000 iterations) to derive a key-encryption key (AES-KW). The vault key (AES-256-GCM) is created once at setup and stored only in wrapped form. Unlocking unwraps it inside `src/crypto/crypto.worker.ts`; key objects never reach the page or the server.
- **Items.** Each item (title, username, password, website, notes) is serialized and encrypted as one blob, so no metadata is stored in plaintext.
- **Local storage.** IndexedDB database `aevra-vault` with stores `items`, `meta` (the wrapped key) and `tombstones` (pending deletions).
- **Backup and sync.** `/api/vault` keeps ciphertext and the wrapped key in `prisma/vault.db`. Every change syncs automatically, and **Sync now** pulls changes from other browsers. Conflicts resolve per item by last write; deletions are tracked so they are not undone.
- **Locking.** The Lock button, a page reload, or 10 minutes without activity clears the key from memory.
- **Changing the master password.** Requires the current password. The same vault key is locked with a key derived from the new password (fresh salt), so items are not re-encrypted. Other browsers get the new key material on their next sync, but keep accepting the old password until the new one has unlocked them once. A bad copy from the server therefore can't lock a browser out.
- **Replacing the vault key** (the "Also replace the vault key" option). Every item is decrypted and re-encrypted under a brand-new key inside the worker. The server then swaps the key and all items in one transaction (`POST /api/vault/rotate`), and only if nothing changed meanwhile. From then on the server rejects writes made under the old key. Other browsers ask for the new password on their next sync and carry over any changes they had not backed up yet. A browser that was locked can keep those changes by unlocking once with the previous password; otherwise it can discard them.

## Security notes

- The server listens on `127.0.0.1` and only answers requests addressed to localhost. This blocks other websites and DNS-rebinding attacks. To serve another host name, set `ALLOWED_HOSTS` in `.env`.
- The backup API has **no user authentication**. Don't expose it on a network as-is: anyone who can reach it can download the wrapped key and try to guess the master password offline.
- The master password cannot be reset. If you forget it, the vault cannot be recovered.
- A password change alone doesn't replace the vault key, so any copy of the vault taken before it (another browser, an old backup) can still be opened with the old password. Replacing the key protects everything saved afterwards, but old copies still hold the items as they were.
