/**
 * The plaintext of a vault item. The whole object, including the title, is
 * serialized and encrypted, so no metadata is ever stored in the clear.
 */
export interface VaultItemData {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
}

export const EMPTY_ITEM: VaultItemData = { title: '', username: '', password: '', url: '', notes: '' };

export function serializeItem(item: VaultItemData): string {
  return JSON.stringify(item);
}

/**
 * Parses decrypted plaintext. Anything that is not a serialized item (e.g. a
 * bare secret string saved by an earlier build) is shown as an untitled
 * password so it is never silently lost.
 */
export function parseItem(plaintext: string): VaultItemData {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as VaultItemData).title === 'string') {
      const value = parsed as Partial<Record<keyof VaultItemData, unknown>>;
      const text = (field: unknown) => (typeof field === 'string' ? field : '');
      return {
        title: text(value.title),
        username: text(value.username),
        password: text(value.password),
        url: text(value.url),
        notes: text(value.notes),
      };
    }
  } catch {
    // Not JSON: fall through to the legacy shape.
  }
  return { ...EMPTY_ITEM, title: 'Untitled secret', password: plaintext };
}

/** Only http(s) links are rendered as clickable, so a stored `javascript:` URL can't run. */
export function toSafeHref(url: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?';

/** Uniformly random password from the CSPRNG (rejection sampling avoids modulo bias). */
export function generatePassword(length = 20): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let result = '';
  while (result.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && result.length < length) {
        result += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      }
    }
  }
  return result;
}
