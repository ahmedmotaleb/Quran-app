/** «استيراد طلاب من CSV» (PROMPT 50): template → upload → server preview (valid / duplicate / error per row) →
 *  confirm → per-row result. Rows not created are never dropped silently: they are listed and offered as an error CSV. */
import { useState } from 'react';
import { color } from '@/theme/tokens';
import { api } from '@/api/client';
import { toast } from '../adminStore';
import { Modal, errMsg, smallBtn } from './ui';

type Row = { line: number; data: Record<string, string>; status: 'valid' | 'duplicate' | 'error'; errors: string[];
  result?: 'created' | 'skipped' | 'failed'; email?: 'sent' | 'failed' | 'pending' };
type Report = { dry_run: boolean; rows: Row[]; summary: { valid: number; duplicate: number; error: number; total: number };
  result?: { created: number; skipped: number; failed: number; emails: { sent: number; failed: number; pending: number } } };

// «gender»: male / female (or ذكر / أنثى); optional.
const COLUMNS = ['full_name', 'email', 'gender', 'phone', 'timezone', 'level', 'teacher_email', 'circle'];
const STATUS: Record<Row['status'], [string, string]> = { valid: ['صالح', color.primary], duplicate: ['مكرر', '#9A6B00'], error: ['خطأ', color.danger] };

function send(file: File, dry: boolean) {
  const f = new FormData(); f.append('file', file, file.name); f.append('dry_run', String(dry));
  return api<Report>('POST', 'admin/import/students', f);
}
function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Spreadsheet formula injection: a cell starting with = + - @ is written as text.
const cell = (v: string) => { const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const errorCsv = (rows: Row[]) => [[...COLUMNS, 'line', 'status', 'errors'].join(','),
  ...rows.map((r) => [...COLUMNS.map((c) => r.data[c] ?? ''), String(r.line), STATUS[r.status][0], r.errors.join(' | ')].map(cell).join(','))].join('\r\n');

export default function StudentImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null); const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (dry: boolean) => {
    if (!file) return setErr('اختر ملف CSV.');
    setBusy(true); setErr(null);
    try { const r = await send(file, dry); setRep(r); if (!dry) { onDone(); toast(`أُنشئ ${r.result?.created ?? 0} حساب طالب`); } }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const bad = rep ? rep.rows.filter((r) => (rep.dry_run ? r.status !== 'valid' : r.result !== 'created')) : [];
  return (
    <Modal title="استيراد طلاب من ملف CSV" onClose={onClose} wide>
      {!rep?.result && <>
        <ol style={{ margin: 0, paddingInlineStart: 20, fontSize: 14, lineHeight: 1.9, color: color.body }}>
          <li>نزّل القالب واملأه (صف لكل طالب). الإلزامي: الاسم والبريد. المنطقة الزمنية الافتراضية للمنصة إن تُركت فارغة.</li>
          <li>احفظه بصيغة «CSV UTF-8» ثم ارفعه هنا للمعاينة. لا يُنشأ شيء قبل التأكيد.</li>
          <li>بعد التأكيد يُنشأ الصالح فقط ويصل كل طالب بريدٌ لتعيين كلمة المرور.</li>
        </ol>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" onClick={() => save('halqa-students-template.csv', COLUMNS.join(',') + '\r\n')} style={smallBtn()}>تنزيل القالب</button>
          <label style={{ ...smallBtn(), display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' }}>
            {file ? `الملف: ${file.name}` : 'اختيار ملف CSV'}
            <input type="file" accept=".csv,text/csv" aria-label="ملف CSV" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRep(null); setErr(null); }}
              style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} />
          </label>
          <button type="button" onClick={() => run(true)} disabled={!file || busy} aria-busy={busy && !rep} style={smallBtn('primary')}>{busy && !rep ? 'جارٍ الفحص…' : 'معاينة'}</button>
        </div>
      </>}
      {err && <p role="alert" style={{ margin: 0, color: color.danger }}>{err}</p>}
      {rep && <>
        <p role="status" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
          {rep.result
            ? `أُنشئ ${rep.result.created} · لم يُنشأ ${rep.result.skipped + rep.result.failed} · البريد: أُرسل ${rep.result.emails.sent}، تعذّر ${rep.result.emails.failed}، في قائمة الإرسال ${rep.result.emails.pending}`
            : `${rep.summary.total} صف: صالح ${rep.summary.valid} · مكرر ${rep.summary.duplicate} · أخطاء ${rep.summary.error}`}
        </p>
        {rep.result && rep.result.emails.pending > 0 && <p style={{ margin: 0, fontSize: 13, color: color.muted }}>
          البريد المتبقي يُرسل تلقائيًا خلال ساعة (المهمة الدورية).</p>}
        {rep.result && rep.result.emails.failed > 0 && <p style={{ margin: 0, fontSize: 13, color: color.muted }}>
          من تعذّر إرسال بريده: حدّده في قائمة الطلاب واختر «إعادة إرسال رابط الإعداد».</p>}
        <div style={{ maxHeight: 320, overflow: 'auto', border: `1px solid ${color.border}`, borderRadius: 12 }} tabIndex={0} role="region" aria-label="صفوف الملف">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: color.sand, textAlign: 'right' }}>{['السطر', 'الاسم', 'البريد', 'الحالة', 'الملاحظات'].map((h) => <th key={h} scope="col" style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
            <tbody>{rep.rows.map((r) => {
              const [label, tone] = r.result === 'created' ? ['أُنشئ', color.primary] : r.result === 'failed' ? ['تعذّر', color.danger] : STATUS[r.status];
              return (
                <tr key={r.line} style={{ borderTop: `1px solid ${color.divider}` }}>
                  <td style={{ padding: '6px 10px' }}>{r.line}</td><td style={{ padding: '6px 10px' }}>{r.data.full_name}</td>
                  <td style={{ padding: '6px 10px' }}><bdi dir="ltr">{r.data.email}</bdi></td>
                  <td style={{ padding: '6px 10px', fontWeight: 700, color: tone, whiteSpace: 'nowrap' }}>{label}</td>
                  <td style={{ padding: '6px 10px' }}>{r.errors.join('، ')}{r.email === 'failed' ? 'تعذّر إرسال البريد' : r.email === 'pending' ? 'البريد في قائمة الإرسال (خلال ساعة)' : ''}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {bad.length > 0 && <button type="button" onClick={() => save('halqa-import-errors.csv', errorCsv(bad))} style={smallBtn()}>تنزيل ملف الصفوف غير المُنشأة ({bad.length})</button>}
          {!rep.result && <button type="button" onClick={() => run(false)} disabled={busy || rep.summary.valid === 0} aria-busy={busy} style={smallBtn('primary')}>
            {busy ? 'جارٍ الإنشاء…' : `إنشاء ${rep.summary.valid} حساب وإرسال روابط الإعداد`}</button>}
          {rep.result && <button type="button" onClick={onClose} style={smallBtn('primary')}>تم</button>}
        </div>
        {!rep.result && bad.length > 0 && <p style={{ margin: 0, fontSize: 13, color: color.muted }}>الصفوف المكررة والخاطئة لن تُنشأ. صحّحها في ملف الأخطاء ثم استوردها لاحقًا.</p>}
      </>}
    </Modal>
  );
}
