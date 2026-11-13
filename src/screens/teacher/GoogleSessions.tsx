/** «+ إنشاء جلسة» for teachers. The session is created in HALQA on its own (owner P0, 13 Nov 2026): it is saved,
 *  the student booked and told, and it appears in «المواعيد» at once. Google Calendar + Meet is optional: when the
 *  teacher connected Google, the event and Meet link are added; if Google fails, the session stays and the teacher can
 *  retry or paste a meeting link.
 *  Tokens never reach the app: the server keeps them; the app only sees the connection state and a masked email. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { FieldError, card, inputStyle, labelStyle, muted, primaryBtn } from '@/components/ui';
import { ApiError } from '@/api/client';
import * as E from '@/api/endpoints';
import { openSheet, setState, toast, useApp } from '@/store/store';
import { refreshSchedule } from '@/store/live';
import { tzOf } from '@/lib/format';
import { clockOf } from '@/lib/time';
import type { ReactNode } from 'react';

const TOPICS: [E.SessionTopic, string][] = [['hifz', 'حفظ'], ['review', 'مراجعة'], ['tajweed', 'تجويد'], ['test', 'اختبار'], ['other', 'أخرى']];
const RESULT: Record<string, string> = {
  connected: 'Google Calendar متصل',
  denied: 'لم يُمنح الإذن. اضغط «ربط Google Calendar» ووافق على إدارة أحداث التقويم.',
  scope_missing: 'لم يُمنح إذن إدارة أحداث التقويم. أعد الربط ووافق عليه.',
  wrong_account: 'انتهت الجلسة أو تغيّر الحساب. سجّل الدخول بحساب المعلم ثم أعد الربط.',
  invalid_state: 'انتهت صلاحية طلب الربط. أعد المحاولة.',
  failed: 'تعذّر إكمال الربط مع Google. أعد المحاولة.',
};
const errText = (e: unknown) => (e as ApiError)?.message || 'تعذّر تنفيذ الطلب.';
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const smallBtn = (tone: 'primary' | 'plain' | 'danger' = 'plain') => ({
  minHeight: 40, padding: '0 12px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
  border: `1px solid ${tone === 'danger' ? color.dangerInk : tone === 'primary' ? color.primary : color.borderStrong}`,
  background: tone === 'primary' ? color.primary : color.card, color: tone === 'primary' ? color.ivory : tone === 'danger' ? color.dangerInk : color.primary, textDecoration: 'none',
} as const);

/** Back from Google (`#/google?result=…`): show the outcome once, then continue in the app. */
export function googleReturnResult(): string | null {
  const m = /^#\/google\?result=([a-z_]+)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(history.state, '', location.pathname + location.search);
  return m[1];
}

/* ---------------- connection card («حسابي») ---------------- */
export function GoogleCalendarCard() {
  const [st, setSt] = useState<E.ApiGoogleStatus | null>(null); const [busy, setBusy] = useState(false);
  const result = useApp((s) => s.googleResult);
  const load = () => E.googleStatus().then(setSt).catch(() => setSt(null));
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (result) { toast(RESULT[result] ?? RESULT.failed, result === 'connected' ? undefined : 'alert'); setState({ googleResult: '' }); void load(); } }, [result]);
  if (!st || !st.configured) return null;
  const connect = async () => {
    setBusy(true);
    try { window.location.href = (await E.googleConnect()).auth_url; } catch (e) { toast(errText(e), 'alert'); setBusy(false); }
  };
  const disconnect = () => openSheet({ kind: 'confirm', title: 'قطع الاتصال بـ Google Calendar؟', ok: 'قطع الاتصال', danger: true,
    body: 'لن تُنشأ جلسات Google جديدة حتى تعيد الربط. الجلسات الحالية وروابطها تبقى كما هي.',
    onOk: () => { setState({ sheet: null }); E.googleDisconnect().then((x) => { setSt(x); toast('قُطع الاتصال بـ Google Calendar'); }).catch((e) => toast(errText(e), 'alert')); } });
  const on = st.status === 'active'; const lost = st.status === 'reconnect_required';
  return (
    <section aria-labelledby="gcal-h" style={{ ...card, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 id="gcal-h" style={{ margin: 0, fontSize: 15, fontWeight: 700, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="cal" size={18} /> Google Calendar</h2>
      {on && <p role="status" style={{ margin: 0, fontSize: 14, color: color.primary, fontWeight: 700 }}>Google Calendar متصل{st.email ? <> · <bdi dir="ltr" style={{ fontWeight: 500 }}>{st.email}</bdi></> : null}</p>}
      {lost && <p role="alert" style={{ margin: 0, fontSize: 14, color: color.dangerInk, fontWeight: 700 }}>انقطع اتصال Google Calendar</p>}
      {!on && !lost && <p style={muted(13)}>اربط تقويمك مرة واحدة: كل جلسة تنشئها في الحلقة تُضاف إلى تقويمك مع رابط Google Meet تلقائيًا، ويصل الطالب دعوة.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {on ? <>
          <button onClick={connect} disabled={busy} style={smallBtn()}>إعادة الربط</button>
          <button onClick={disconnect} disabled={busy} style={smallBtn('danger')}>قطع الاتصال</button>
        </> : <button onClick={connect} disabled={busy} aria-busy={busy} style={smallBtn('primary')}>{lost ? 'إعادة ربط Google' : 'ربط Google Calendar'}</button>}
      </div>
    </section>
  );
}

/* ---------------- «+ إنشاء جلسة» ---------------- */
export function CreateSessionButton() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)} style={primaryBtn(48, 15, { borderRadius: 12 })}><Icon name="plus" size={18} /> إنشاء جلسة</button>
    {open && <CreateSessionForm onClose={() => setOpen(false)} />}
  </>;
}

function CreateSessionForm({ onClose }: { onClose: () => void }) {
  const tz = tzOf(useApp((s) => s.tz)).iana;
  const [gs, setGs] = useState<E.ApiGoogleStatus | null>(null);
  const [students, setStudents] = useState<{ id: number; name: string }[]>([]); const [circles, setCircles] = useState<{ id: number; name: string }[]>([]);
  const [v, setV] = useState({ who: '', topic: 'hifz' as E.SessionTopic, date: '', time: '19:00', minutes: 45, title: '', prep_note: '' });
  const [errs, setErrs] = useState<Record<string, string | undefined>>({}); const [busy, setBusy] = useState(false);
  const key = useRef(newKey()); // one request id per form: a double tap or a retry never makes a second session
  const sending = useRef(false); // a second tap while the first request is still on its way does nothing
  useEffect(() => {
    E.googleStatus().then(setGs).catch(() => setGs(null));
    E.teacherStudents().then((p) => setStudents(p.results.map((x) => ({ id: x.id, name: x.full_name })))).catch(() => {});
    E.teacherCircles().then((r) => setCircles(r.results.filter((c) => c.state === 'published').map((c) => ({ id: c.id, name: c.name })))).catch(() => {});
    const d = new Date(Date.now() + 86_400_000);
    setV((x) => ({ ...x, date: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d) }));
  }, [tz]);
  /** The session exists from here on; the Google part only adds to the message. */
  const created = (s: E.ApiTeacherSession) => {
    const who = s.with?.kind === 'circle' ? 'أُبلغ أعضاء الحلقة' : 'أُبلغ الطالب';
    const g = s.google;
    if (!g) toast(`تم إنشاء الجلسة و${who}.`);
    else if (g.sync_status === 'ready') toast(`تم إنشاء الجلسة و${who}، ورابط Google Meet جاهز.`);
    else if (g.sync_status === 'pending') toast(`تم إنشاء الجلسة و${who}. جارٍ تجهيز رابط Google Meet.`);
    else toast(`تم إنشاء الجلسة و${who}. تعذّر إنشاء رابط Google Meet: ${g.error_message || 'أعد المحاولة من الجلسة أو أضف رابطًا يدويًا.'}`, 'alert');
    void refreshSchedule();
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending.current) return;
    const local: Record<string, string | undefined> = { who: v.who ? undefined : 'اختر طالبًا أو حلقة.', date: v.date ? undefined : 'اختر التاريخ.', time: v.time ? undefined : 'اختر الوقت.' };
    if (Object.values(local).some(Boolean)) return setErrs(local);
    const [kind, id] = v.who.split(':');
    sending.current = true; setBusy(true); setErrs({});
    try {
      created(await E.createTeacherSession({ ...(kind === 'c' ? { circle: +id } : { student: +id }), topic: v.topic, date: v.date, time: v.time, minutes: v.minutes, title: v.title, prep_note: v.prep_note }, key.current));
    } catch (x) {
      const a = x as ApiError;
      setErrs({ form: a.message || 'تعذّر إنشاء الجلسة. تحقق من الاتصال وحاول مرة أخرى.', time: a.field?.('time') ?? undefined,
        who: a.field?.('student') ?? a.field?.('circle') ?? undefined, minutes: a.field?.('minutes') ?? undefined });
    } finally { sending.current = false; setBusy(false); }
  };
  const lbl = { ...labelStyle, display: 'flex', flexDirection: 'column' as const, gap: 6 };
  const googleOn = !!gs && gs.configured && gs.status === 'active';
  return (
    <div role="dialog" aria-modal="true" aria-label="إنشاء جلسة" style={{ position: 'fixed', inset: 0, background: 'rgba(20,33,31,.45)', zIndex: 60, display: 'grid', placeItems: 'end center' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form onSubmit={submit} noValidate style={{ background: color.ivory, width: '100%', maxWidth: 520, maxHeight: '92dvh', overflowY: 'auto', borderRadius: '20px 20px 0 0', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800 }}>إنشاء جلسة</h2>
        <label style={lbl}>الطالب أو الحلقة
          <select value={v.who} onChange={(e) => setV({ ...v, who: e.target.value })} style={inputStyle(errs.who)} aria-invalid={!!errs.who}>
            <option value="">اختر…</option>
            {students.length > 0 && <optgroup label="الطلاب">{students.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}</optgroup>}
            {circles.length > 0 && <optgroup label="الحلقات">{circles.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}</optgroup>}
          </select>
          <FieldError msg={errs.who} />
        </label>
        <div role="radiogroup" aria-label="نوع الجلسة" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TOPICS.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={v.topic === k} onClick={() => setV({ ...v, topic: k })}
            style={{ minHeight: 40, padding: '0 14px', borderRadius: 999, border: `1.5px solid ${v.topic === k ? color.primary : color.borderStrong}`, background: v.topic === k ? color.primary : color.card, color: v.topic === k ? color.ivory : color.primary, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>{l}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <label style={{ ...lbl, flex: 1 }}>التاريخ<input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} style={inputStyle(errs.date, true)} /></label>
          <label style={{ ...lbl, flex: 1 }}>الوقت<input type="time" value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} style={inputStyle(errs.time, true)} /></label>
        </div>
        {v.time && <p style={muted(13, { margin: 0 })}>الموعد: <strong>{clockOf(v.time)}</strong> بتوقيت جهازك ({tz})</p>}
        <FieldError msg={errs.date ?? errs.time} />
        <label style={lbl}>المدة
          <select value={v.minutes} onChange={(e) => setV({ ...v, minutes: +e.target.value })} style={inputStyle(errs.minutes)}>
            {[30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} دقيقة</option>)}
          </select>
        </label>
        <label style={lbl}>العنوان (اختياري)<input value={v.title} maxLength={120} onChange={(e) => setV({ ...v, title: e.target.value })} style={inputStyle()} /></label>
        <label style={lbl}>ملاحظة تحضير للطالب (اختياري)
          <textarea value={v.prep_note} maxLength={500} rows={2} onChange={(e) => setV({ ...v, prep_note: e.target.value })} style={{ ...inputStyle(), minHeight: 64, padding: 10 }} />
          <span style={muted(12)}>تظهر للطالب في الحلقة فقط، ولا تُرسل إلى Google.</span>
        </label>
        <p style={muted(12)}>{googleOn
          ? 'يصل الطالب إشعار في الحلقة، ويُضاف رابط Google Meet ودعوة على بريده تلقائيًا.'
          : 'يصل الطالب إشعار في الحلقة. يمكنك إضافة رابط الاجتماع من الجلسة بعد إنشائها، أو ربط Google Calendar من «حسابي» لإنشاء رابط Google Meet تلقائيًا (اختياري).'}</p>
        {errs.form && <p role="alert" style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.dangerInk }}>{errs.form}</p>}
        <button type="submit" disabled={busy} aria-busy={busy} style={primaryBtn(52, 16)}>{busy ? 'جارٍ إنشاء الجلسة…' : 'إنشاء الجلسة'}</button>
        <button type="button" onClick={onClose} disabled={busy} style={{ ...smallBtn(), justifyContent: 'center' }}>إغلاق</button>
      </form>
    </div>
  );
}

/* ---------------- one teacher-created session in «الجلسات» (with or without Google) ---------------- */
export function GoogleSessionActions({ o, link }: { o: E.ApiTeacherOcc; link?: ReactNode }) {
  const g = o.google ?? null; const tz = tzOf(useApp((s) => s.tz)).iana;
  const [edit, setEdit] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const local = new Date(o.starts_at);
  const [v, setV] = useState({ date: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(local),
    time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(local),
    minutes: Math.round((new Date(o.ends_at).getTime() - local.getTime()) / 60000) });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await fn(); toast(ok); setEdit(false); await refreshSchedule(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const cancel = () => openSheet({ kind: 'confirm', title: 'إلغاء الجلسة؟', ok: 'إلغاء الجلسة', danger: true,
    body: g ? 'يُلغى الحجز ويصل الطالب إشعار، ويُحذف الحدث من Google Calendar مع إبلاغ المدعوين. يبقى سجل الجلسة في الحلقة.'
      : 'يُلغى الحجز ويصل الطالب إشعار. يبقى سجل الجلسة في الحلقة.',
    onOk: () => { setState({ sheet: null }); void run(() => E.cancelTeacherSession(o.id, 'ألغى المعلم الجلسة'), 'أُلغيت الجلسة'); } });
  const ended = new Date(o.ends_at).getTime() < Date.now();
  const meetOk = g?.sync_status === 'ready' && o.meeting_provider === 'google_meet';
  const badge = !g ? null : g.sync_status === 'ready' ? ['Google Meet جاهز ✓', color.primary] : g.sync_status === 'pending' ? ['جارٍ تجهيز Google Meet…', color.warnInk]
    : g.sync_status === 'reconnect_required' ? ['يجب إعادة ربط Google Calendar', color.dangerInk] : g.sync_status === 'cancelled' ? ['أُلغي في Google Calendar', color.muted] : ['تعذّر إنشاء Google Meet', color.dangerInk];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {badge && <span role="status" style={{ fontSize: 13, fontWeight: 700, color: badge[1], display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="video" size={18} /> {badge[0]}</span>}
      {g?.error_message && g.sync_status !== 'ready' && <span style={muted(12)}>{g.error_message}</span>}
      {/* Without a working Google Meet the teacher sets the meeting link by hand. */}
      {!ended && o.status !== 'cancelled' && !meetOk && link}
      {!ended && o.status !== 'cancelled' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {meetOk && o.meeting_url && <a href={o.meeting_url} target="_blank" rel="noopener noreferrer" style={smallBtn('primary')}>فتح Google Meet</a>}
        {g?.calendar_url && <a href={g.calendar_url} target="_blank" rel="noopener noreferrer" style={smallBtn()}>فتح في Google Calendar</a>}
        {g && (g.sync_status === 'failed' || g.sync_status === 'pending' || g.sync_status === 'reconnect_required') && <button disabled={busy} onClick={() => run(() => E.retryTeacherSession(o.id), 'أُعيدت محاولة إنشاء رابط Google Meet')} style={smallBtn('primary')}>إنشاء رابط Google Meet</button>}
        <button disabled={busy} onClick={() => setEdit(!edit)} style={smallBtn()}>تعديل الموعد</button>
        <button disabled={busy} onClick={cancel} style={smallBtn('danger')}>إلغاء الجلسة</button>
      </div>}
      {edit && <form onSubmit={(e) => { e.preventDefault(); void run(() => E.rescheduleTeacherSession(o.id, v), 'عُدّل الموعد وأُبلغ الطالب'); }}
        aria-label="تعديل الموعد" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 4 }}>التاريخ<input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} style={inputStyle(null, true)} /></label>
        <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 4 }}>الوقت<input type="time" value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} style={inputStyle(null, true)} /></label>
        <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 4 }}>المدة
          <select value={v.minutes} onChange={(e) => setV({ ...v, minutes: +e.target.value })} style={inputStyle()}>{[30, 45, 60, 90].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        <button type="submit" disabled={busy} style={smallBtn('primary')}>حفظ الموعد</button>
      </form>}
      {err && <span role="alert" style={{ fontSize: 13, color: color.dangerInk }}>{err}</span>}
    </div>
  );
}
