/** The teacher's «القراءات والروايات» (part of the teacher's application; editable later from «حسابي»).
 *  At least one Riwayah is required. What they add waits for the admin; learners only see confirmed ones. */
import { useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { card, muted, outlineBtn, primaryBtn } from '@/components/ui';
import { RiwayatChips, RiwayatPicker } from '@/components/RiwayatPicker';
import { myRiwayat, saveMyRiwayat, type MyRiwayah } from '@/api/endpoints';
import type { ApiError } from '@/api/client';
import { toast } from '@/store/store';

/** `whenNeeded`: on the home screen, show only while nothing is chosen or something waits for the admin. */
export function MyRiwayatSection({ whenNeeded = false }: { whenNeeded?: boolean }) {
  const [rows, setRows] = useState<MyRiwayah[] | null>(null);
  const [edit, setEdit] = useState<string[] | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; myRiwayat().then((r) => on && setRows(r.riwayat)).catch(() => {}); return () => { on = false; }; }, []);
  if (!rows) return null;
  const pending = rows.filter((r) => !r.verified);
  if (whenNeeded && rows.length && !pending.length && !edit) return null;

  const save = async () => {
    if (!edit?.length) { setErr('اختر رواية واحدة على الأقل.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await saveMyRiwayat(edit);
      setRows(r.riwayat); setEdit(null);
      toast(r.riwayat.some((x) => !x.verified) ? 'حُفظت القراءات والروايات وأُرسلت للإدارة للاعتماد' : 'حُفظت القراءات والروايات');
    } catch (e) { const x = e as ApiError; setErr(x.field?.('riwayat') ?? x.message); } finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="my-riwayat" style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, borderColor: rows.length ? color.border : color.gold }}>
      <h2 id="my-riwayat" style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>القراءات والروايات</h2>
      <p style={muted(13, { lineHeight: 1.7 })}>اختر الروايات التي تجيدها ومؤهل لتدريسها</p>
      {edit ? (
        <>
          <RiwayatPicker value={edit} onChange={(v) => { setEdit(v); setErr(''); }} idPrefix="my-rw" invalid={!!err} />
          {err && <p role="alert" style={{ margin: 0, color: color.dangerInk, fontSize: 14, fontWeight: 700 }}>{err}</p>}
          <p style={muted(12, { lineHeight: 1.6 })}>تظهر الروايات للطلاب بعد اعتماد الإدارة لها.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void save()} disabled={busy} aria-busy={busy} style={primaryBtn(48, 15, { flex: 1, borderRadius: 12, opacity: busy ? 0.7 : 1 })}>حفظ وإرسال للإدارة</button>
            <button onClick={() => { setEdit(null); setErr(''); }} style={outlineBtn(48, 15, { padding: '0 16px', borderRadius: 12 })}>إلغاء</button>
          </div>
        </>
      ) : rows.length ? (
        <>
          <RiwayatChips items={rows} pending={new Set(pending.map((r) => r.code))} />
          {pending.length > 0 && <p style={muted(12)}>ما يحمل «بانتظار الاعتماد» يظهر للطلاب بعد أن تعتمده الإدارة.</p>}
          <button onClick={() => setEdit(rows.map((r) => r.code))} style={outlineBtn(44, 14, { alignSelf: 'flex-start', padding: '0 14px', borderRadius: 12 })}>تعديل القراءات والروايات</button>
        </>
      ) : (
        <button onClick={() => setEdit([])} style={primaryBtn(48, 15, { borderRadius: 12 })}>أضف القراءات والروايات</button>
      )}
    </section>
  );
}
