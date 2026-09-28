import type { BackupConflictReason, BackupErrorBody } from './backup.types';

const MAX_BODY_CHARS = 1_000_000;

/**
 * Hosts the backup API answers to. Checking Host defeats DNS-rebinding, where
 * a malicious site points its own name at 127.0.0.1 to read this API from the
 * victim's browser. Override with ALLOWED_HOSTS="vault.example.com,…".
 */
const allowedHosts = new Set(
  (process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

function hostname(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '');
}

export function errorResponse(status: number, error: string, reason?: BackupConflictReason): Response {
  const body: BackupErrorBody = reason ? { error, reason } : { error };
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Returns an error response for requests from a foreign host or origin, else null. */
export function guardRequest(request: Request): Response | null {
  const host = request.headers.get('host');
  if (!host || !allowedHosts.has(hostname(host))) {
    return errorResponse(403, 'Host not allowed.');
  }

  // Browsers send Origin on every cross-origin request and on same-origin
  // writes; it must match the host we are serving.
  const origin = request.headers.get('origin');
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // Opaque or malformed origin ("null"): treat as foreign.
    }
    if (originHost !== host.toLowerCase()) {
      return errorResponse(403, 'Cross-origin requests are not allowed.');
    }
  }
  return null;
}

export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Requires a JSON content type (which also forces a CORS preflight for any
 * cross-origin caller) and caps the body size before parsing.
 */
export async function readJsonBody(request: Request, maxChars = MAX_BODY_CHARS): Promise<JsonBodyResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return { ok: false, response: errorResponse(415, 'Expected application/json.') };
  }
  const text = await request.text();
  if (text.length > maxChars) {
    return { ok: false, response: errorResponse(413, 'Request body too large.') };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: errorResponse(400, 'Malformed JSON.') };
  }
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
