/** «طلبات اختيار المعلم»: a student's preferred-teacher request never assigns anyone. The admin checks availability,
 *  then approves, marks the teacher unavailable (optionally suggesting another), or assigns (the normal teacher link).
 *  The student is notified on every change; the notification history is shown per request. */
import { useCallback, useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { can, refreshCounts, toast } from '../adminStore';
import { card } from '../AdminTables';
import * as A from './api';
import { chip, dateTime, errMsg, Modal, smallBtn } from './ui';

const TABS: [string, string][] = [['open', 'المفتوحة'], ['pending', 'بانتظار المراجعة'], ['approved', 'تمت الموافقة'], ['unavailable', 'المعلم غير متاح'], ['assigned', 'تم تعيين المعلم']];
const TONE: Record<A.TeacherRequestStatus, [string, string]> = {
  pending: ['#F3E6CC', '#6B470C'], approved: [color.sage, color.primary], unavailable: [color.dangerBg, color.dangerInk], assigned: [color.primary, color.ivory],
};
type Act = { row: A.TeacherRequestRow; action: 'approve' | 'unavailable' | 'assign' };

export default function TeacherRequestsLive() {
  const [tab, setTab] = useState('open');
  const [rows, setRows] = useState<A.TeacherRequestRow[] | null>(null); const [err, setErr] = useState<string | null>(null);
  const [act, setAct] = useState<Act | null>(null); const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(() => { setErr(null); A.teacherRequests(tab).then((r) => setRows(r.results)).catch((e) => setErr(errMsg(e))); }, [tab]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const may = can('teachers.assign');
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div role="tablist" aria-label="حالة الطلب" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ ...chip(tab === k), minHeight: 44 }}>{l}</button>)}
      </div>
      {err ? <p role="alert" style={{ color: color.danger, margin: 0 }}>{err}</p>
        : !rows ? <p role="status" style={{ color: color.muted, margin: 0 }}>جارٍ التحميل…</p>
        : !rows.length ? <p style={{ ...card, padding: 18, margin: 0, color: color.muted }}>لا توجد طلبات هنا.</p>
        : <div style={{ ...card, padding: '4px 14px', display: 'flex', flexDirection: 'column' }}>
          <div aria-hidden style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.4fr 1fr 1fr', gap: 10, padding: '10px 0', fontSize: 13, color: color.muted, fontWeight: 700 }}>
            <span>الطالب</span><span>المعلم المطلوب</span><span>تاريخ الطلب</span><span>الحالة</span>
          </div>
          {rows.map((r) => (
            <div key={r.id} data-request={r.id} style={{ borderTop: `1px solid ${color.divider}`, padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, alignItems: 'center', fontSize: 14 }}>
                <strong>{r.student.name}</strong>
                <span>{r.teacher ? r.teacher.name : <>اقتراح: <strong>{r.suggested_name}</strong> <span style={{ color: color.muted }}>(ليس في القائمة)</span></>}</span>
                <span style={{ color: color.muted }}>{dateTime(r.created_at)}</span>
                <span><span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: TONE[r.status][0], color: TONE[r.status][1] }}>{r.status_label}</span></span>
              </div>
              {r.note && <span style={{ fontSize: 13, color: color.body }}>ملاحظة الطالب: {r.note}</span>}
              {r.alternative && <span style={{ fontSize: 13 }}>البديل المقترح: {r.alternative.name}</span>}
              {r.assigned_teacher && <span style={{ fontSize: 13, color: color.primary, fontWeight: 700 }}>عُيّن: {r.assigned_teacher.name}</span>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {may && r.status === 'pending' && <button onClick={() => setAct({ row: r, action: 'approve' })} style={{ ...smallBtn('primary'), minHeight: 44 }}>موافقة</button>}
                {may && r.status !== 'assigned' && <button onClick={() => setAct({ row: r, action: 'assign' })} style={{ ...smallBtn('primary'), minHeight: 44 }}>تعيين المعلم</button>}
                {may && r.status !== 'assigned' && <button onClick={() => setAct({ row: r, action: 'unavailable' })} style={{ ...smallBtn('danger'), minHeight: 44 }}>غير متاح / اقتراح بديل</button>}
                <button aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} style={{ ...smallBtn(), minHeight: 44 }}>سجل الإشعارات ({r.history.length})</button>
              </div>
              {open === r.id && (r.history.length
                ? <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13, lineHeight: 1.9 }}>
                  {r.history.map((h, i) => <li key={i}>{dateTime(h.at)} · <strong>{h.title}</strong> — {h.body} {h.read ? '· قُرئ' : '· لم يُقرأ'}</li>)}
                </ul>
                : <p style={{ margin: 0, fontSize: 13, color: color.muted }}>لم يُرسل إشعار بعد.</p>)}
            </div>
          ))}
        </div>}
      {act && <Decide act={act} onClose={() => setAct(null)} onDone={(m) => { toast(m); setAct(null); load(); refreshCounts(); }} />}
    </section>
  );
}

function Decide({ act, onClose, onDone }: { act: Act; onClose: () => void; onDone: (msg: string) => void }) {
  const { row, action } = act;
  const [teachers, setTeachers] = useState<{ id: number; name: string }[] | null>(null);
  const [teacher, setTeacher] = useState<string>(action === 'assign' && row.teacher ? String(row.teacher.id) : '');
  const [note, setNote] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (action === 'approve') return;
    A.approvedTeachers().then((r) => setTeachers(r.results.map((t) => ({ id: t.id, name: t.display_name || t.full_name })))).catch((e) => setErr(errMsg(e)));
  }, [action]);
  const title = { approve: 'الموافقة على الطلب', unavailable: 'المعلم غير متاح', assign: 'تعيين المعلم' }[action];
  const submit = async () => {
    if (action === 'assign' && !teacher) return setErr('اختر المعلم الذي سيُعيَّن للطالب.');
    setBusy(true); setErr(null);
    try {
      await A.decideTeacherRequest(row.id, action, teacher ? Number(teacher) : null, note.trim());
      onDone({ approve: 'تمت الموافقة وأُبلغ الطالب', unavailable: 'أُبلغ الطالب أن المعلم غير متاح', assign: 'عُيّن المعلم وأُبلغ الطالب' }[action]);
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  };
  return (
    <Modal title={`${title}: ${row.student.name}`} onClose={() => { if (!busy) onClose(); }}>
      <p style={{ margin: 0, fontSize: 14 }}>المطلوب: <strong>{row.teacher?.name ?? `${row.suggested_name} (اقتراح)`}</strong></p>
      {action === 'approve' && <p style={{ margin: 0, fontSize: 14, color: color.muted }}>الموافقة لا تعيّن المعلم بعد؛ عيّنه بعد التأكد من إتاحته.</p>}
      {action !== 'approve' && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, fontWeight: 700 }}>
          {action === 'assign' ? 'المعلم الذي سيُعيَّن' : 'معلم بديل تقترحه (اختياري)'}
          <select value={teacher} onChange={(e) => setTeacher(e.target.value)} style={{ minHeight: 48, borderRadius: 12, padding: '0 10px', fontSize: 15 }}>
            <option value="">{teachers ? 'اختر…' : 'جارٍ التحميل…'}</option>
            {teachers?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, fontWeight: 700 }}>ملاحظة داخلية (اختياري)
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 44, borderRadius: 12, padding: '0 10px', fontSize: 15 }} />
      </label>
      {err && <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={() => void submit()} style={{ ...smallBtn(action === 'unavailable' ? 'danger' : 'primary'), minHeight: 44 }}>{title}</button>
        <button onClick={onClose} style={{ ...smallBtn(), minHeight: 44 }}>إلغاء</button>
      </div>
    </Modal>
  );
}
