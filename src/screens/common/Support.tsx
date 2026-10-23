/** «الدعم» (PROMPT 49): the signed-in student, teacher or parent opens support tickets and follows the replies.
 *  Only their own tickets are returned by the server; internal staff notes never are. */
import { useEffect, useState, type FormEvent } from 'react';
import { color } from '@/theme/tokens';
import { BackHeader, FieldError, card, inputStyle, labelStyle, muted, outlineBtn, pageCol, primaryBtn } from '@/components/ui';
import { ImagePicker, Thread } from '@/components/SupportThread';
import { go, openSheet, setState, toast, useApp } from '@/store/store';
import type { ApiError } from '@/api/client';
import * as SP from '@/api/support';

const errText = (e: unknown) => (e as ApiError)?.message || 'تعذّر تنفيذ الطلب.';
const fieldErr = (e: unknown, k: string) => (e as ApiError)?.fields?.[k]?.[0];
const day = (iso: string) => new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'short', timeZone: 'Africa/Cairo' }).format(new Date(iso));
const TONE: Record<SP.TicketStatus, string> = { open: color.primary, in_progress: color.primary, waiting_user: '#9A6B00', resolved: color.muted, closed: color.muted };

export default function Support() {
  const id = Number(useApp((s) => s.params.id) || 0);
  return id ? <TicketView id={id} /> : <TicketList />;
}

function TicketList() {
  const [data, setData] = useState<Awaited<ReturnType<typeof SP.myTickets>> | null>(null);
  const [err, setErr] = useState<string | null>(null); const [compose, setCompose] = useState(false);
  const load = () => SP.myTickets().then(setData).catch((e) => setErr(errText(e)));
  useEffect(() => { void load(); }, []);
  return (
    <div style={pageCol(14)}>
      <BackHeader title="الدعم" sticky />
      <p style={muted(14)}>اكتب لنا مشكلتك وسيرد فريق الدعم هنا، ويصلك إشعار عند الرد. لا ترفق تسجيلات التلاوة أو كلمات المرور.</p>
      {!compose && <button onClick={() => setCompose(true)} style={primaryBtn(52, 16)}>طلب دعم جديد</button>}
      {compose && data && <NewTicket categories={data.categories} onDone={(t) => { setCompose(false); void load(); go('support', { id: String(t.id) }); }} onCancel={() => setCompose(false)} />}
      {err && <p role="alert" style={{ color: color.danger, margin: 0 }}>{err}</p>}
      {!data && !err && <p role="status" style={muted(14)}>جارٍ التحميل…</p>}
      {data && (data.results.length === 0
        ? !compose && <p style={{ ...card, padding: 16, margin: 0, color: color.muted }}>لا توجد طلبات دعم بعد.</p>
        : <section aria-label="طلباتي" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 style={{ margin: '6px 0 0', fontSize: 16, fontWeight: 800 }}>طلباتي</h2>
            {data.results.map((t) => (
              <button key={t.id} onClick={() => go('support', { id: String(t.id) })}
                style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
                  <strong style={{ flex: 1, fontSize: 15 }}>{t.subject}</strong>
                  <span style={{ fontSize: 13, fontWeight: 700, color: TONE[t.status] }}>{t.status_label}</span>
                </span>
                <span style={muted(13)}>#{t.id} · {t.category_label} · آخر تحديث {day(t.last_activity_at)}</span>
              </button>
            ))}
          </section>)}
    </div>
  );
}

function NewTicket({ categories, onDone, onCancel }: { categories: { value: string; label: string }[]; onDone: (t: SP.Ticket) => void; onCancel: () => void }) {
  const [v, setV] = useState({ category: '', subject: '', message: '' }); const [image, setImage] = useState<File | null>(null);
  const [errs, setErrs] = useState<Record<string, string | undefined>>({}); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local = { category: v.category ? undefined : 'اختر نوع الطلب.', subject: v.subject.trim() ? undefined : 'اكتب عنوانًا مختصرًا.', message: v.message.trim() ? undefined : 'اكتب تفاصيل طلبك.' };
    if (Object.values(local).some(Boolean)) return setErrs(local);
    setBusy(true);
    try { const t = await SP.openTicket(v, image); toast('أُرسل طلبك إلى فريق الدعم'); onDone(t); }
    catch (x) { setErrs({ category: fieldErr(x, 'category'), subject: fieldErr(x, 'subject'), message: fieldErr(x, 'message'), image: fieldErr(x, 'image') ?? (fieldErr(x, 'category') || fieldErr(x, 'subject') || fieldErr(x, 'message') ? undefined : errText(x)) }); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} aria-label="طلب دعم جديد" noValidate style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>نوع الطلب
        <select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} style={inputStyle(errs.category)} aria-invalid={!!errs.category}>
          <option value="">اختر…</option>
          {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <FieldError msg={errs.category} />
      </label>
      <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>العنوان
        <input value={v.subject} maxLength={160} onChange={(e) => setV({ ...v, subject: e.target.value })} style={inputStyle(errs.subject)} aria-invalid={!!errs.subject} />
        <FieldError msg={errs.subject} />
      </label>
      <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>التفاصيل
        <textarea value={v.message} maxLength={4000} rows={5} onChange={(e) => setV({ ...v, message: e.target.value })}
          placeholder="ماذا حدث؟ وما الخطوات التي سبقت المشكلة؟" style={{ ...inputStyle(errs.message), minHeight: 120, padding: 12, resize: 'vertical' }} aria-invalid={!!errs.message} />
        <FieldError msg={errs.message} />
      </label>
      <ImagePicker id="sup-image" file={image} onChange={(f, e) => { setImage(f); setErrs({ ...errs, image: e }); }} />
      <FieldError msg={errs.image} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy} aria-busy={busy} style={{ ...primaryBtn(50, 16), flex: 1 }}>{busy ? 'جارٍ الإرسال…' : 'إرسال'}</button>
        <button type="button" onClick={onCancel} style={{ ...outlineBtn(50, 15), flex: '0 0 auto', padding: '0 18px' }}>إلغاء</button>
      </div>
    </form>
  );
}

function TicketView({ id }: { id: number }) {
  const [t, setT] = useState<SP.Ticket | null>(null); const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState(''); const [image, setImage] = useState<File | null>(null);
  const [mErr, setMErr] = useState<string | undefined>(); const [busy, setBusy] = useState(false);
  useEffect(() => { SP.myTicket(id).then(setT).catch((e) => setErr(errText(e))); }, [id]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!msg.trim()) return setMErr('اكتب ردّك.');
    setBusy(true);
    try { setT(await SP.replyTicket(id, msg, image)); setMsg(''); setImage(null); setMErr(undefined); toast('أُرسل ردّك'); }
    catch (x) { setMErr(fieldErr(x, 'message') ?? fieldErr(x, 'image') ?? errText(x)); } finally { setBusy(false); }
  };
  const close = () => openSheet({ kind: 'confirm', title: 'إغلاق الطلب؟', body: 'أغلقه إذا حُلّت المشكلة. لن يمكن الرد عليه بعد ذلك، ويمكنك فتح طلب جديد في أي وقت.', ok: 'إغلاق الطلب',
    onOk: () => { setState({ sheet: null }); SP.closeTicket(id).then((x) => { setT(x); toast('أُغلق الطلب'); }).catch((x) => toast(errText(x))); } });
  return (
    <div style={pageCol(14)}>
      <BackHeader title={t ? `طلب #${t.id}` : 'طلب دعم'} sticky />
      {err && <p role="alert" style={{ color: color.danger, margin: 0 }}>{err}</p>}
      {!t && !err && <p role="status" style={muted(14)}>جارٍ التحميل…</p>}
      {t && <>
        <section aria-label="بيانات الطلب" style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 800 }}>{t.subject}</h1>
          <p style={muted(13)}>{t.category_label} · فُتح {day(t.created_at)}</p>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: TONE[t.status] }}>الحالة: {t.status_label}</p>
        </section>
        <Thread messages={t.messages ?? []} />
        {t.status === 'closed'
          ? <p style={{ ...card, padding: 14, margin: 0, color: color.muted }}>هذا الطلب مغلق. إن احتجت مساعدة أخرى افتح طلبًا جديدًا.</p>
          : <form onSubmit={send} aria-label="الرد على الطلب" noValidate style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>ردّك
                <textarea value={msg} maxLength={4000} rows={3} onChange={(e) => setMsg(e.target.value)} style={{ ...inputStyle(mErr), minHeight: 90, padding: 12, resize: 'vertical' }} aria-invalid={!!mErr} />
              </label>
              <ImagePicker id="sup-reply-image" file={image} onChange={(f, e2) => { setImage(f); setMErr(e2); }} />
              <FieldError msg={mErr} />
              <button type="submit" disabled={busy} aria-busy={busy} style={primaryBtn(50, 16)}>{busy ? 'جارٍ الإرسال…' : 'إرسال الرد'}</button>
              <button type="button" onClick={close} style={outlineBtn(46, 14)}>تم حل مشكلتي، أغلق الطلب</button>
            </form>}
      </>}
    </div>
  );
}
