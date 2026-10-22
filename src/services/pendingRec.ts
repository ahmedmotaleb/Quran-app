/**
 * Unsent recordings kept on this device (IndexedDB, never localStorage) so a failed or postponed upload is not lost
 * when the student leaves the screen or closes the installed app.
 *
 * - One entry per (signed-in user, task): another account on the same phone never sees it.
 * - Holds only the audio, its real type and length, and the upload/submission keys that make a retry safe.
 *   No auth tokens, cookies or names.
 * - Removed after a successful submission, when the student deletes it, or after EXPIRY_DAYS.
 * Every call is best-effort: if storage is unavailable (private mode), the app keeps working with memory only.
 */
export interface PendingRec {
  id: string;                 // `${userId}:${taskId}`
  userId: string;
  taskId: string;
  blob: Blob;
  mime: string;
  secs: number;
  createdAt: number;
  state: 'ready' | 'failed';
  uploadId: string;           // X-Upload-ID: the same server copy on every retry
  idemKey: string;            // Idempotency-Key of the submission
  mediaId: string | null;     // set once the upload succeeded
}

const DB = 'halqa-recordings';
const STORE = 'pending';
export const EXPIRY_DAYS = 7;

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('user', 'userId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { resolve(req ? (req.result as T) : null); db.close(); };
      tx.onerror = tx.onabort = () => { resolve(null); db.close(); };
    } catch { resolve(null); db.close(); }
  });
}

export const pendingId = (userId: string, taskId: string) => `${userId}:${taskId}`;

export async function savePending(p: Omit<PendingRec, 'id'>): Promise<boolean> {
  const ok = await run('readwrite', (s) => s.put({ ...p, id: pendingId(p.userId, p.taskId) }));
  return ok !== null;
}

export async function updatePending(userId: string, taskId: string, patch: Partial<PendingRec>): Promise<void> {
  const cur = await getPending(userId, taskId);
  if (cur) await run('readwrite', (s) => s.put({ ...cur, ...patch, id: cur.id }));
}

export async function getPending(userId: string, taskId: string): Promise<PendingRec | null> {
  const p = await run<PendingRec>('readonly', (s) => s.get(pendingId(userId, taskId)));
  return p && p.userId === userId && !expired(p) ? p : null;
}

/** This user's unsent recordings, newest first (expired ones are removed on the way). */
export async function listPending(userId: string): Promise<PendingRec[]> {
  const all = (await run<PendingRec[]>('readonly', (s) => s.index('user').getAll(userId))) ?? [];
  const old = all.filter(expired);
  for (const p of old) await deletePending(p.userId, p.taskId);
  return all.filter((p) => !expired(p) && p.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deletePending(userId: string, taskId: string): Promise<void> {
  await run('readwrite', (s) => s.delete(pendingId(userId, taskId)));
}

function expired(p: PendingRec) { return Date.now() - p.createdAt > EXPIRY_DAYS * 86400_000; }
