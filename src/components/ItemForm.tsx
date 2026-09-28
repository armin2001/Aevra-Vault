'use client';

import { useId, useState, type FormEvent } from 'react';
import { EMPTY_ITEM, generatePassword, type VaultItemData } from '../lib/vault-item';
import { Alert, Button, Dialog, Field, Spinner, errorMessage, inputClass } from './ui';

export function ItemForm({
  initial,
  onSave,
  onCancel,
}: {
  /** Present when editing an existing item. */
  initial?: VaultItemData;
  onSave: (item: VaultItemData) => Promise<void>;
  onCancel: () => void;
}) {
  const [item, setItem] = useState<VaultItemData>(initial ?? EMPTY_ITEM);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const update = (field: keyof VaultItemData) => (value: string) => setItem((prev) => ({ ...prev, [field]: value }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!item.title.trim()) {
      setError('Give the item a title.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({ ...item, title: item.title.trim(), url: item.url.trim() });
    } catch (caught) {
      setBusy(false);
      setError(errorMessage(caught, 'Could not save the item.'));
    }
  }

  return (
    <Dialog title={initial ? 'Edit item' : 'New item'} busy={busy} onClose={onCancel}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Title" htmlFor={`${id}-t`}>
          <input
            id={`${id}-t`}
            autoFocus
            required
            maxLength={200}
            placeholder="e.g. GitHub"
            value={item.title}
            onChange={(event) => update('title')(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Username or email" htmlFor={`${id}-u`}>
          <input
            id={`${id}-u`}
            autoComplete="off"
            value={item.username}
            onChange={(event) => update('username')(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Password" htmlFor={`${id}-p`}>
          <div className="flex gap-2">
            <input
              id={`${id}-p`}
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={item.password}
              onChange={(event) => update('password')(event.target.value)}
              className={`${inputClass} font-mono`}
            />
            <Button variant="secondary" onClick={() => setShowPassword((value) => !value)} aria-pressed={showPassword}>
              {showPassword ? 'Hide' : 'Show'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                update('password')(generatePassword());
                setShowPassword(true);
              }}
            >
              Generate
            </Button>
          </div>
        </Field>
        <Field label="Website" htmlFor={`${id}-w`}>
          <input
            id={`${id}-w`}
            inputMode="url"
            placeholder="github.com"
            value={item.url}
            onChange={(event) => update('url')(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Notes" htmlFor={`${id}-n`}>
          <textarea
            id={`${id}-n`}
            rows={3}
            value={item.notes}
            onChange={(event) => update('notes')(event.target.value)}
            className={inputClass}
          />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Encrypting…
              </>
            ) : (
              'Save'
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
