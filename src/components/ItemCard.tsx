'use client';

import { useEffect, useState } from 'react';
import { toSafeHref, type VaultItemData } from '../lib/vault-item';
import { Button } from './ui';

export type VaultEntry =
  | { id: string; createdAt?: number; updatedAt?: number; status: 'decrypted'; item: VaultItemData }
  | { id: string; createdAt?: number; updatedAt?: number; status: 'failed'; error: string };

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  return confirming ? (
    <Button variant="danger" size="sm" onClick={onDelete}>
      Confirm delete
    </Button>
  ) : (
    <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
      Delete
    </Button>
  );
}

const ROW_LABEL = 'w-20 shrink-0 text-xs uppercase tracking-wide text-zinc-400 dark:text-zinc-500';

export function ItemCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: VaultEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const edited = entry.updatedAt ?? entry.createdAt;

  if (entry.status === 'failed') {
    return (
      <li className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50/60 p-4 dark:border-red-900/60 dark:bg-red-950/30">
        <p className="text-sm font-medium text-red-800 dark:text-red-200">Unreadable item</p>
        <p className="text-sm text-red-700 dark:text-red-300">{entry.error}</p>
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs text-red-500/80" title={entry.id}>
            {entry.id}
          </span>
          <DeleteButton onDelete={onDelete} />
        </div>
      </li>
    );
  }

  const { item } = entry;
  const href = item.url ? toSafeHref(item.url) : null;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0">
        <h3 className="truncate font-semibold" title={item.title}>
          {item.title}
        </h3>
        {item.url &&
          (href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-sm text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {item.url}
            </a>
          ) : (
            <p className="truncate text-sm text-zinc-500">{item.url}</p>
          ))}
      </div>

      <dl className="space-y-1.5 text-sm">
        {item.username && (
          <div className="flex items-center gap-2">
            <dt className={ROW_LABEL}>User</dt>
            <dd className="min-w-0 flex-1 truncate">{item.username}</dd>
            <CopyButton value={item.username} label="username" />
          </div>
        )}
        {item.password && (
          <div className="flex items-center gap-2">
            <dt className={ROW_LABEL}>Password</dt>
            <dd className={`min-w-0 flex-1 font-mono ${revealed ? 'break-all' : 'truncate'}`}>
              {revealed ? item.password : '••••••••'}
            </dd>
            <Button variant="ghost" size="sm" onClick={() => setRevealed((value) => !value)} aria-pressed={revealed}>
              {revealed ? 'Hide' : 'Show'}
            </Button>
            <CopyButton value={item.password} label="password" />
          </div>
        )}
      </dl>

      {item.notes && (
        <p className="line-clamp-3 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">{item.notes}</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <span className="text-xs text-zinc-400">
          {edited !== undefined && `Edited ${new Date(edited).toLocaleDateString()}`}
        </span>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <DeleteButton onDelete={onDelete} />
        </div>
      </div>
    </li>
  );
}
