/**
 * Central API client (Prompt 03/06).
 * - Base URL from VITE_API_BASE_URL. Unset → the app runs in labelled demo mode (no server).
 * - Web: session cookie + CSRF token header. Android: bearer token kept in app-private storage.
 * - 15 s timeout. Only GETs (and requests carrying an Idempotency-Key) are retried automatically.
 * - Errors carry the server's stable `code`, Arabic `message`, per-field errors and request id.
 */
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

const RAW_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
/** True when a backend is configured; false means demo mode. */
export const LIVE = !!RAW_BASE;
const BASE = (RAW_BASE ?? '').replace(/\/$/, '');
export const IS_NATIVE = Capacitor.isNativePlatform();
const TIMEOUT_MS = 15_000;
/** Uploads get longer: a 10-minute recitation on a slow connection. */
const UPLOAD_TIMEOUT_MS = 120_000;
const TOKEN_KEY = 'halqa.auth.token';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string[]> = {},
    public requestId = '',
  ) {
    super(message);
  }
  /** First Arabic message for a field, if the server sent one. */
  field(name: string): string | null {
    const v = this.fields?.[name];
    return Array.isArray(v) && v.length ? String(v[0]) : null;
  }
}

const OFFLINE = () => new ApiError(0, 'network', 'تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم حاول مرة أخرى.');
const TIMEOUT = () => new ApiError(0, 'timeout', 'استغرق الطلب وقتًا أطول من المتوقع. حاول مرة أخرى.');

let token: string | null = null;
let csrf: string | null = null;

export async function loadToken() {
  if (!IS_NATIVE) return;
  token = (await Preferences.get({ key: TOKEN_KEY })).value;
}
export async function setToken(t: string | null) {
  token = t;
  if (!IS_NATIVE) return;
  if (t) await Preferences.set({ key: TOKEN_KEY, value: t });
  else await Preferences.remove({ key: TOKEN_KEY });
}

async function ensureCsrf() {
  if (IS_NATIVE || csrf) return;
  const r = await raw('GET', '/api/v1/auth/csrf');
  csrf = (r as { csrfToken?: string })?.csrfToken ?? null;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), body instanceof FormData ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
  const h: Record<string, string> = { Accept: 'application/json', ...headers };
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !form) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (csrf && method !== 'GET') h['X-CSRFToken'] = csrf;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method, headers: h, body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body), signal: ctrl.signal,
      credentials: IS_NATIVE ? 'omit' : 'include',
    });
  } catch (e) {
    throw (e as Error).name === 'AbortError' ? TIMEOUT() : OFFLINE();
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* non-JSON (e.g. proxy error) */ }
  if (!res.ok) {
    throw new ApiError(res.status, String(data.code ?? 'error'), String(data.message ?? 'حدث خطأ غير متوقع. حاول مرة أخرى.'),
      (data.fields as Record<string, string[]>) ?? {}, String(data.request_id ?? res.headers.get('X-Request-ID') ?? ''));
  }
  return data;
}

/** Retries network failures/timeouts/5xx for safe requests: GET, or writes that carry an Idempotency-Key. */
export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown,
  opts: { idempotencyKey?: string } = {}): Promise<T> {
  if (!LIVE) throw new ApiError(0, 'demo', 'وضع العرض التجريبي: لا يوجد خادم متصل.');
  if (method !== 'GET') await ensureCsrf();
  const headers = opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
  const retriable = method === 'GET' || !!opts.idempotencyKey;
  for (let attempt = 0; ; attempt++) {
    try {
      return (await raw(method, `/api/v1/${path.replace(/^\//, '')}`, body, headers)) as T;
    } catch (e) {
      const err = e as ApiError;
      // A CSRF failure after the session rotated (login/logout): refresh the token once.
      if (err.status === 403 && err.code === 'permission_denied' && !IS_NATIVE && attempt === 0 && method !== 'GET') {
        csrf = null; await ensureCsrf(); continue;
      }
      const transient = err.status === 0 || err.status >= 500;
      if (!retriable || !transient || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}

/** Called after login/logout: Django rotates the CSRF token with the session. */
export function resetCsrf() { csrf = null; }

export interface Page<T> { count: number; next: string | null; previous: string | null; results: T[] }
