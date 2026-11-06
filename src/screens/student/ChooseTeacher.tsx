/** «اختر معلمك» on the student's home (live mode, students without a teacher). The student searches the approved
 *  teachers (name, title, specialization, confirmed Riwayat), requests one, or suggests a teacher by name. A request
 *  never assigns anyone: the admin reviews it. While a request is pending the card shows «طلبك قيد المراجعة» instead
 *  of asking again. Dismissible for 48 hours on this device; gone once a teacher is assigned. Home screen only, so it
 *  never interrupts recording, reading or a session. */
import { useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { Avatar, card, inputStyle, muted, outlineBtn, primaryBtn } from '@/components/ui';
import { RiwayatChips } from '@/components/RiwayatPicker';
import { api, type ApiError } from '@/api/client';
import { toast, useApp } from '@/store/store';

interface Req {
  id: number; status: 'pending' | 'approved' | 'unavailable' | 'assigned'; status_label: string; created_at: string;
  teacher: { id: number; name: string } | null; suggested_name: string; alternative: { id: number; name: string } | null;
}
const HIDE_KEY = 'halqa.chooseTeacher.hiddenUntil';
const hiddenNow = () => { try { return Date.now() < Number(localStorage.getItem(HIDE_KEY) || 0); } catch { return false; } };

export function ChooseTeacherCard() {
  const teachers = useApp((s) => s.teachers);
  const [st, setSt] = useState<{ has_teacher: boolean; request: Req | null } | null>(null);
  const [hidden, setHidden] = useState(hiddenNow);
  const [q, setQ] = useState(''); const [pick, setPick] = useState<string | null>(null);
  const [suggest, setSuggest] = useState(''); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const load = () => api<{ has_teacher: boolean; request: Req | null }>('GET', 'student/teacher-request').then(setSt).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!st || st.has_teacher || hidden) return null;
  const r = st.request;
  const hide = () => { try { localStorage.setItem(HIDE_KEY, String(Date.now() + 48 * 3600_000)); } catch { /* private mode */ } setHidden(true); };
  const send = async (body: Record<string, unknown>) => {
    setBusy(true); setErr('');
    try { await api('POST', 'student/teacher-request', body); toast('أُرسل طلبك إلى الإدارة للمراجعة'); setPick(null); setSuggest(''); setNote(''); await load(); }
    catch (e) { const x = e as ApiError; setErr(x.field?.('teacher') ?? x.field?.('suggested_name') ?? x.message); } finally { setBusy(false); }
  };
  const close = (
    <button onClick={hide} aria-label="إخفاء «اختر معلمك» لمدة يومين" style={{ width: 44, height: 44, margin: '-8px -8px 0 0', border: 'none', background: 'transparent', color: color.muted, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}>
      <Icon name="x" size={20} />
    </button>
  );

  if (r && (r.status === 'pending' || r.status === 'approved')) return (
    <section aria-labelledby="ct-h" data-testid="choose-teacher" style={{ ...card, padding: 14, display: 'flex', gap: 10, alignItems: 'flex-start', borderColor: color.gold, background: color.goldTint }}>
      <span style={{ color: color.goldInk, paddingTop: 2 }}><Icon name="clock" /></span>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 id="ct-h" style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>طلبك قيد المراجعة</h2>
        <p style={muted(14, { lineHeight: 1.7 })}>طلبت: <strong>{r.teacher?.name ?? r.suggested_name}</strong> · {r.status_label}. سيصلك إشعار عند تعيين معلمك.</p>
      </div>
      {close}
    </section>
  );

  const term = q.trim();
  const list = teachers.filter((t) => !term || t.name.includes(term));
  const chosen = teachers.find((t) => t.id === pick);
  return (
    <section aria-labelledby="ct-h" data-testid="choose-teacher" style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, borderColor: color.primary }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <h2 id="ct-h" style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>اختر معلمك</h2>
          <p style={muted(13, { lineHeight: 1.7, margin: '4px 0 0' })}>اختر المعلم الذي تفضّله، وتراجع الإدارة إتاحته ثم تعيّنه لك.</p>
        </div>
        {close}
      </div>
      {r?.status === 'unavailable' && (
        <p role="status" style={{ margin: 0, padding: '8px 12px', borderRadius: 12, background: color.dangerBg, color: color.dangerInk, fontSize: 14, lineHeight: 1.7 }}>
          {r.status_label}: {r.teacher?.name ?? r.suggested_name}.{r.alternative ? ` تقترح الإدارة: ${r.alternative.name}.` : ' اختر معلمًا آخر.'}
        </p>
      )}
      <input type="search" aria-label="ابحث باسم المعلم" placeholder="ابحث باسم المعلم" value={q} onChange={(e) => setQ(e.target.value)} style={inputStyle(false, false, { minHeight: 48 })} />
      <div role="list" aria-label="المعلمون المتاحون" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
        {!teachers.length && <p style={muted(14)}>لا يوجد معلمون متاحون حاليًا. اقترح معلمًا بالاسم أدناه.</p>}
        {teachers.length > 0 && !list.length && <p style={muted(14)}>لا يوجد معلم بهذا الاسم. يمكنك اقتراحه أدناه.</p>}
        {list.map((t) => {
          const on = pick === t.id;
          return (
            <button key={t.id} role="listitem" aria-pressed={on} onClick={() => setPick(on ? null : t.id)}
              style={{ minHeight: 60, padding: '8px 10px', borderRadius: 12, border: `1.5px solid ${on ? color.primary : color.border}`, background: on ? color.sageTint : color.card, display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
              <Avatar ini={t.ini} size={40} fs={17} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 15, fontWeight: 800 }}>{t.name}</span>
                {t.spec && t.spec !== '—' && <span style={{ fontSize: 13, color: color.body }}>{t.spec}{t.levels && t.levels !== '—' ? ` · ${t.levels}` : ''}</span>}
                {!!t.riwayat?.length && <RiwayatChips items={t.riwayat} />}
              </span>
              {on && <span style={{ color: color.primary }}><Icon name="check" /></span>}
            </button>
          );
        })}
      </div>
      {chosen && <>
        <input aria-label="ملاحظة للإدارة (اختياري)" placeholder="ملاحظة للإدارة (اختياري)، مثل الأوقات المناسبة" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} style={inputStyle(false, false, { minHeight: 44 })} />
        <button disabled={busy} onClick={() => void send({ teacher: Number(chosen.id), note })} style={primaryBtn(48, 15, { borderRadius: 12 })}>اطلب {chosen.name}</button>
      </>}
      <details style={{ fontSize: 14 }}>
        <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', fontWeight: 700, color: color.primary }}>لم تجد معلمك؟ اقترحه بالاسم</summary>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 6 }}>
          <input aria-label="اسم المعلم المقترح" placeholder="اسم المعلم" value={suggest} maxLength={120} onChange={(e) => setSuggest(e.target.value)} style={inputStyle(false, false, { minHeight: 44, flex: '1 1 180px' })} />
          <button disabled={busy || suggest.trim().length < 3} onClick={() => void send({ suggested_name: suggest.trim(), note })} style={outlineBtn(44, 14, { padding: '0 14px', borderRadius: 12 })}>إرسال الاقتراح</button>
        </div>
      </details>
      {err && <p role="alert" style={{ margin: 0, color: color.dangerInk, fontSize: 14 }}>{err}</p>}
    </section>
  );
}
