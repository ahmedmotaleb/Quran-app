/** «طلبات الدعم» (PROMPT 49): staff read tickets with support.view; replying, internal notes, assigning and changing
 *  the state need support.manage (the server checks every request; buttons the server would refuse are hidden). */
import { useEffect, useState, type FormEvent } from 'react';
import { color } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle } from '@/components/ui';
import { ImagePicker, Thread } from '@/components/SupportThread';
import * as SP from '@/api/support';
import { can, toast } from '../adminStore';
import { Modal, Pager, SearchBar, Table, chip, dateTime, errMsg, smallBtn, useDebounced, usePaged } from './ui';

const FILTERS: [string, string][] = [['active', 'المفتوحة'], ['open', 'جديدة'], ['in_progress', 'قيد المعالجة'], ['waiting_user', 'بانتظار المستخدم'], ['resolved', 'تم الحل'], ['closed', 'مغلقة'], ['all', 'الكل']];
const ROLE: Record<string, string> = { student: 'طالب', teacher: 'معلم', parent: 'ولي أمر' };
const STAFF_STATUS: Record<SP.TicketStatus, string> = { ...SP.STATUS_LABEL, waiting_user: 'بانتظار المستخدم' };

export default function SupportLive() {
  const [status, setStatus] = useState('active'); const [mine, setMine] = useState(''); const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [open, setOpen] = useState<number | null>(null);
  const list = usePaged((page) => SP.adminTickets({ status, ...(mine ? { assignee: mine } : {}), ...(dq ? { q: dq } : {}), page: String(page) }), [status, mine, dq]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div role="group" aria-label="حالة الطلب" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map(([k, l]) => <button key={k} aria-pressed={status === k} onClick={() => setStatus(k)} style={chip(status === k)}>{l}</button>)}
      </div>
      <SearchBar q={q} setQ={setQ} label="بحث بالعنوان أو اسم صاحب الطلب أو رقمه" action={
        <select aria-label="المسؤول" value={mine} onChange={(e) => setMine(e.target.value)} style={{ ...inputStyle(), flex: '0 1 200px' }}>
          <option value="">كل المسؤولين</option><option value="me">المسندة إليّ</option><option value="none">غير مسندة</option>
        </select>} />
      <Table cols={['#', 'العنوان', 'صاحب الطلب', 'النوع', 'الحالة', 'المسؤول', 'آخر تحديث']} loading={list.loading} err={list.err} empty={!list.data?.results.length} retry={list.reload}>
        {list.data?.results.map((t) => (
          <tr key={t.id} style={{ borderTop: `1px solid ${color.divider}` }}>
            <td style={{ padding: '10px 16px' }}>{t.id}</td>
            <td style={{ padding: '10px 16px' }}><button onClick={() => setOpen(t.id)} style={{ border: 'none', background: 'transparent', color: color.primary, fontWeight: 700, cursor: 'pointer', textAlign: 'right', padding: 0, minHeight: 36 }}>{t.subject}</button></td>
            <td style={{ padding: '10px 16px' }}>{t.requester?.name} <span style={{ color: color.muted }}>({ROLE[t.requester?.role ?? ''] ?? ''})</span></td>
            <td style={{ padding: '10px 16px' }}>{t.category_label}</td>
            <td style={{ padding: '10px 16px', fontWeight: 700 }}>{STAFF_STATUS[t.status]}</td>
            <td style={{ padding: '10px 16px' }}>{t.assignee?.name ?? <span style={{ color: color.muted }}>غير مسند</span>}</td>
            <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>{dateTime(t.last_activity_at)}</td>
          </tr>
        ))}
      </Table>
      <Pager page={list.page} total={list.data?.count ?? 0} setPage={list.setPage} />
      {open !== null && <TicketDialog id={open} onClose={() => { setOpen(null); void list.reload(); }} />}
    </div>
  );
}

function TicketDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [t, setT] = useState<SP.Ticket | null>(null); const [err, setErr] = useState<string | null>(null);
  const [staff, setStaff] = useState<{ id: number; name: string }[]>([]);
  const manage = can('support.manage');
  useEffect(() => { SP.adminTicket(id).then(setT).catch((e) => setErr(errMsg(e))); if (manage) SP.supportStaff().then((r) => setStaff(r.results)).catch(() => {}); }, [id, manage]);
  const update = async (d: { status?: SP.TicketStatus; assignee?: number | null }) => {
    try { setT(await SP.adminUpdateTicket(id, d)); toast('حُفظ التغيير'); } catch (x) { toast(errMsg(x)); }
  };
  return (
    <Modal title={t ? `طلب دعم #${t.id}` : 'طلب دعم'} onClose={onClose} wide>
      {err && <p role="alert" style={{ color: color.danger, margin: 0 }}>{err}</p>}
      {!t && !err && <p role="status" style={{ color: color.muted, margin: 0 }}>جارٍ التحميل…</p>}
      {t && <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <strong style={{ fontSize: 17 }}>{t.subject}</strong>
          <span style={{ fontSize: 13, color: color.muted }}>
            {t.category_label} · من {t.requester?.name} ({ROLE[t.requester?.role ?? ''] ?? ''}){t.requester?.email ? <> · <bdi dir="ltr">{t.requester.email}</bdi></> : null} · فُتح {dateTime(t.created_at)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 180px' }}>الحالة
            <select value={t.status} disabled={!manage} onChange={(e) => update({ status: e.target.value as SP.TicketStatus })} style={inputStyle()}>
              {(Object.keys(STAFF_STATUS) as SP.TicketStatus[]).map((s) => <option key={s} value={s}>{STAFF_STATUS[s]}</option>)}
            </select>
          </label>
          <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 180px' }}>المسؤول
            <select value={t.assignee?.id ?? ''} disabled={!manage} onChange={(e) => update({ assignee: e.target.value ? Number(e.target.value) : null })} style={inputStyle()}>
              <option value="">غير مسند</option>
              {(staff.length ? staff : t.assignee ? [t.assignee] : []).map((s) => <option key={s!.id} value={s!.id}>{s!.name}</option>)}
            </select>
          </label>
        </div>
        <Thread messages={t.messages ?? []} staff />
        {manage ? <ReplyForm id={id} onDone={setT} /> : <p style={{ margin: 0, fontSize: 13, color: color.muted }}>لديك صلاحية العرض فقط.</p>}
      </>}
    </Modal>
  );
}

function ReplyForm({ id, onDone }: { id: number; onDone: (t: SP.Ticket) => void }) {
  const [msg, setMsg] = useState(''); const [internal, setInternal] = useState(false); const [after, setAfter] = useState<SP.TicketStatus | ''>('');
  const [image, setImage] = useState<File | null>(null); const [e, setE] = useState<string | undefined>(); const [busy, setBusy] = useState(false);
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!msg.trim()) return setE('اكتب الرد.');
    setBusy(true);
    try {
      onDone(await SP.adminReply(id, { message: msg, internal, status: after || undefined }, image));
      setMsg(''); setImage(null); setE(undefined); toast(internal ? 'أُضيفت الملاحظة الداخلية' : 'أُرسل الرد إلى صاحب الطلب');
    } catch (x) { setE(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={send} aria-label="الرد على طلب الدعم" noValidate style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: `1px solid ${color.divider}`, paddingTop: 12 }}>
      <div role="radiogroup" aria-label="نوع الرد" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" role="radio" aria-checked={!internal} onClick={() => setInternal(false)} style={chip(!internal)}>رد على صاحب الطلب</button>
        <button type="button" role="radio" aria-checked={internal} onClick={() => setInternal(true)} style={chip(internal)}>ملاحظة داخلية</button>
      </div>
      <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>{internal ? 'الملاحظة (لا يراها صاحب الطلب)' : 'الرد'}
        <textarea value={msg} maxLength={4000} rows={4} onChange={(x) => setMsg(x.target.value)} style={{ ...inputStyle(e), minHeight: 100, padding: 12, resize: 'vertical' }} />
      </label>
      {!internal && <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>الحالة بعد الرد
        <select value={after} onChange={(x) => setAfter(x.target.value as SP.TicketStatus | '')} style={inputStyle()}>
          <option value="">بانتظار المستخدم (افتراضي)</option><option value="in_progress">قيد المعالجة</option><option value="resolved">تم الحل</option>
        </select>
      </label>}
      <ImagePicker id="adm-sup-image" file={image} onChange={(f, x) => { setImage(f); setE(x); }} />
      <FieldError msg={e} />
      <button type="submit" disabled={busy} aria-busy={busy} style={{ ...smallBtn('primary'), minHeight: 46 }}>{busy ? 'جارٍ الإرسال…' : internal ? 'حفظ الملاحظة' : 'إرسال الرد'}</button>
    </form>
  );
}
