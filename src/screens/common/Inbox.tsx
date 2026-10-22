/** In-app notifications (pack prompt 17): a bell with the unread count and a paginated inbox. Opening an item marks it
 * read and goes to the thing it is about, using only the ids the server stored (authorization is re-checked there). */
import { useCallback, useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import { BackHeader, card, muted } from '@/components/ui';
import { api, type Page } from '@/api/client';
import { fmtRelative } from '@/lib/time';
import { tzOf } from '@/lib/format';
import { go, tab, useApp } from '@/store/store';

interface Note { id: number; kind: string; title: string; body: string; data: Record<string, number>; read_at: string | null; created_at: string }
const ICON: Record<string, IconName> = {
  assignment_new: 'plan', review_due: 'repeat', submission_new: 'mic', feedback_new: 'award', booking_confirmed: 'cal', booking_new: 'cal',
  booking_cancelled: 'cal', booking_cancelled_by_student: 'cal', booking_rescheduled: 'cal', session_reminder: 'clock',
  attendance_absent: 'alert', child_absent: 'alert', lesson_published: 'layers', quiz_published: 'plan',
};

let listeners: ((n: number) => void)[] = [];
export async function refreshUnread() {
  try { const r = await api<{ unread: number }>('GET', 'notifications/unread'); listeners.forEach((f) => f(r.unread)); } catch { /* offline: keep last */ }
}

export function InboxBell() {
  const live = useApp((s) => s.liveMode);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!live) return;
    listeners.push(setN); void refreshUnread();
    const t = setInterval(() => void refreshUnread(), 60000);
    return () => { listeners = listeners.filter((f) => f !== setN); clearInterval(t); };
  }, [live]);
  return (
    <button onClick={() => go('inbox')} aria-label={n ? `الإشعارات، ${n} غير مقروءة` : 'الإشعارات'}
      style={{ width: 48, height: 48, borderRadius: 14, border: `1px solid ${color.border}`, background: color.card, color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer', position: 'relative' }}>
      <Icon name="bell" />
      {n > 0 && <span aria-hidden style={{ position: 'absolute', top: 4, insetInlineEnd: 4, minWidth: 20, height: 20, borderRadius: 999, background: color.danger, color: '#fff', fontSize: 11, fontWeight: 800, display: 'grid', placeItems: 'center', padding: '0 5px' }}>{n > 99 ? '99+' : n}</span>}
    </button>
  );
}

function open(n: Note, role: string | null) {
  const d = n.data || {};
  if (n.kind === 'submission_new') return tab('treviews');
  if (n.kind === 'correction_new') return go('mistakes');
  if (n.kind === 'feedback_new' && d.assignment) return go('feedback', { id: String(d.assignment) });
  if (d.assignment) return go('task', { id: String(d.assignment) });
  if (n.kind === 'lesson_published' && d.lesson) return go('lesson', { id: String(d.lesson) });
  if (n.kind === 'quiz_published') return tab('circles');
  if (role === 'teacher') return tab('tschedule');
  if (role === 'parent') return tab('phome');
  return tab('circles');
}

export default function Inbox() {
  const role = useApp((s) => s.role); const tz = tzOf(useApp((s) => s.tz)).iana;
  const [items, setItems] = useState<Note[]>([]); const [next, setNext] = useState<number | null>(1);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (page: number) => {
    setBusy(true);
    try {
      const p = await api<Page<Note>>('GET', `notifications?page=${page}`);
      setItems((x) => (page === 1 ? p.results : [...x, ...p.results])); setNext(p.next ? page + 1 : null); setErr(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(1); }, [load]);
  const markAll = async () => { await api('POST', 'notifications/read', {}); setItems((x) => x.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() }))); void refreshUnread(); };
  const tap = async (n: Note) => {
    if (!n.read_at) { void api('POST', 'notifications/read', { ids: [n.id] }).then(refreshUnread); }
    open(n, role);
  };
  const unread = items.filter((n) => !n.read_at).length;
  return (
    <div>
      <BackHeader title="الإشعارات" sticky />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {unread > 0 && <button onClick={markAll} style={{ alignSelf: 'flex-start', minHeight: 44, border: 'none', background: 'transparent', color: color.primary, fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}>تعليم الكل كمقروء</button>}
        {err && <p role="alert" style={muted(14)}>تعذّر تحميل الإشعارات: {err}</p>}
        {!err && !busy && items.length === 0 && <p style={muted(14, { textAlign: 'center', padding: 24 })}>لا توجد إشعارات بعد.</p>}
        {items.map((n) => (
          <button key={n.id} onClick={() => void tap(n)} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'right', cursor: 'pointer', color: color.ink, background: n.read_at ? color.card : color.sageTint }}>
            <span style={{ color: color.primary, marginTop: 2 }}><Icon name={ICON[n.kind] ?? 'bell'} size={20} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: n.read_at ? 500 : 800 }}>{n.title}{!n.read_at && <span className="sr-only"> (غير مقروء)</span>}</span>
              {n.body && <span style={{ display: 'block', fontSize: 13, color: color.body, marginTop: 2, whiteSpace: 'pre-line' }}>{n.body}</span>}
              <span style={{ display: 'block', fontSize: 12, color: color.muted, marginTop: 4 }}>{fmtRelative(n.created_at, tz)}</span>
            </span>
          </button>
        ))}
        {next && items.length > 0 && <button disabled={busy} onClick={() => void load(next)} style={{ minHeight: 48, borderRadius: 12, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontWeight: 700, cursor: 'pointer' }}>{busy ? 'جارٍ التحميل…' : 'عرض المزيد'}</button>}
      </div>
    </div>
  );
}
