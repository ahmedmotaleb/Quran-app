/**
 * Central API client (Prompt 03/06).
 * - Base URL from VITE_API_BASE_URL. Unset → the app runs in labelled demo mode (no server).
 * - Web / installed PWA: HttpOnly session cookie + CSRF token header. No token is stored in the browser.
 * - 15 s timeout. Only GETs (and requests carrying an Idempotency-Key) are retried automatically.
 * - Errors carry the server's stable `code`, Arabic `message`, per-field errors and request id.
 */

const RAW_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
/** True when a backend is configured; false means demo mode. */
export const LIVE = !!RAW_BASE;
const BASE = (RAW_BASE ?? '').replace(/\/$/, '');
const TIMEOUT_MS = 15_000;
/** Uploads get longer: a 10-minute recitation on a slow connection. */
const UPLOAD_TIMEOUT_MS = 120_000;

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

/** Safe facts about failed requests that did not answer JSON (proxy pages, crashes): kept in memory for support and
 *  printed to the console. Never bodies, cookies, tokens, URLs with ids or personal data. */
export interface ApiDiag { at: string; status: number; contentType: string; requestId: string; endpoint: string; upload: boolean; size: number }
export const diagnostics: ApiDiag[] = [];
/** `assignments/123/submissions` → `assignments/:id/submissions` (no ids in diagnostics). */
export const endpointCategory = (path: string) => path.replace(/^\/?api\/v1\//, '').replace(/\?.*$/, '').replace(/\/[^/]*\d[^/]*(?=\/|$)/g, '/:id');

/** Arabic message for an HTTP failure that carried no JSON body (with the request id when there is one). */
export function nonJsonMessage(status: number, requestId: string, upload: boolean): string {
  const ref = requestId ? ` رقم الخطأ: ${requestId.slice(0, 12)}` : '';
  if (status === 413) return upload ? 'حجم التسجيل أكبر من الحد المسموح.' : 'حجم الطلب أكبر من الحد المسموح.';
  if (status === 404) return `تعذّر إتمام الطلب: العنوان غير موجود.${ref}`;
  if (status === 401 || status === 403) return 'انتهت الجلسة أو لا تملك صلاحية. سجّل الدخول مرة أخرى.';
  if (status === 429) return 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.';
  if (status >= 500) return upload ? `حدث خطأ أثناء رفع التسجيل. أعد المحاولة.${ref}` : `حدث خطأ في الخادم. أعد المحاولة.${ref}`;
  return `حدث خطأ غير متوقع. أعد المحاولة.${ref}`;
}

const OFFLINE = () => new ApiError(0, 'network', 'تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم حاول مرة أخرى.');
const TIMEOUT = () => new ApiError(0, 'timeout', 'استغرق الطلب وقتًا أطول من المتوقع. حاول مرة أخرى.');

let csrf: string | null = null;

async function ensureCsrf() {
  if (csrf) return;
  const r = await raw('GET', '/api/v1/auth/csrf');
  csrf = (r as { csrfToken?: string })?.csrfToken ?? null;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The admin portal (/admin/) has its own session on the server, separate from the learners' app, so an admin and a
 *  student can both stay signed in on one phone. Its requests say so with this header. */
const portalHeaders = (): Record<string, string> =>
  typeof window !== 'undefined' && window.location.pathname.startsWith('/admin') ? { 'X-Halqa-Portal': 'admin' } : {};

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs?: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? (body instanceof FormData ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS));
  const h: Record<string, string> = { Accept: 'application/json', ...portalHeaders(), ...headers };
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !form) h['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') h['X-CSRFToken'] = csrf;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method, headers: h, body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body), signal: ctrl.signal,
      credentials: 'include',
    });
  } catch (e) {
    throw (e as Error).name === 'AbortError' ? TIMEOUT() : OFFLINE();
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  let data: Record<string, unknown> | null = null;
  const text = await res.text().catch(() => '');
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; /* non-JSON (e.g. proxy error page) */ }
  const requestId = String(data?.request_id ?? res.headers.get('X-Request-ID') ?? '');
  if (!res.ok) {
    if (!data || data.code === undefined) {
      const d: ApiDiag = { at: new Date().toISOString(), status: res.status, contentType: res.headers.get('Content-Type') ?? '',
        requestId, endpoint: endpointCategory(path), upload: form, size: text.length };
      diagnostics.push(d); if (diagnostics.length > 20) diagnostics.shift();
      console.warn('api_non_json_error', d);
      throw new ApiError(res.status, `http_${res.status}`, nonJsonMessage(res.status, requestId, form), {}, requestId);
    }
    throw new ApiError(res.status, String(data.code), String(data.message ?? nonJsonMessage(res.status, requestId, form)),
      (data.fields as Record<string, string[]>) ?? {}, requestId);
  }
  return data ?? {};
}

/** Retries network failures/timeouts/5xx for safe requests: GET, or writes that carry an Idempotency-Key. */
export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown,
  opts: { idempotencyKey?: string; uploadId?: string; timeoutMs?: number } = {}): Promise<T> {
  if (!LIVE) throw new ApiError(0, 'demo', 'وضع العرض التجريبي: لا يوجد خادم متصل.');
  if (method !== 'GET') await ensureCsrf();
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.uploadId) headers['X-Upload-ID'] = opts.uploadId; // the server returns the same stored file on a retry
  const retriable = method === 'GET' || !!opts.idempotencyKey || !!opts.uploadId;
  for (let attempt = 0; ; attempt++) {
    try {
      return (await raw(method, `/api/v1/${path.replace(/^\//, '')}`, body, headers, opts.timeoutMs)) as T;
    } catch (e) {
      const err = e as ApiError;
      // A CSRF failure after the session rotated (login/logout): refresh the token once.
      if (err.status === 403 && err.code === 'permission_denied' && attempt === 0 && method !== 'GET') {
        csrf = null; await ensureCsrf(); continue;
      }
      const transient = err.status === 0 || err.status >= 500;
      if (!retriable || !transient || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}

/** A POST that answers with a file (CSV export): returns the blob and the server's file name. */
export async function apiDownload(path: string, body: unknown): Promise<{ blob: Blob; name: string }> {
  if (!LIVE) throw new ApiError(0, 'demo', 'وضع العرض التجريبي: لا يوجد خادم متصل.');
  await ensureCsrf();
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/csv, application/json', ...portalHeaders() };
  if (csrf) h['X-CSRFToken'] = csrf;
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1/${path}`, { method: 'POST', headers: h, body: JSON.stringify(body), credentials: 'include' });
  } catch { throw OFFLINE(); }
  if (!res.ok) {
    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    throw new ApiError(res.status, String(data.code ?? 'error'), String(data.message ?? 'تعذّر التصدير.'), (data.fields as Record<string, string[]>) ?? {}, String(data.request_id ?? ''));
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'halqa.csv';
  return { blob: await res.blob(), name };
}

/** Called after login/logout: Django rotates the CSRF token with the session. */
export function resetCsrf() { csrf = null; }

export interface Page<T> { count: number; next: string | null; previous: string | null; results: T[] }
