/** «تذكيرات القرآن الكريم» in «حسابي» (students): which daily reminders, at what hour (the student's own time zone,
 *  «المنطقة الزمنية»), and quiet hours. Sent by the server's hourly job to this account's devices, even when the
 *  app is closed; each only when something is left to do that day. Saved immediately. */
import { useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { card, muted } from '@/components/ui';
import { api, type ApiError } from '@/api/client';
import { toast } from '@/store/store';
import { hourLabel } from '@/lib/time';

interface R {
  reading_on: boolean; reading_hour: number; hifz_on: boolean; hifz_hour: number; review_on: boolean; review_hour: number;
  evening_on: boolean; evening_hour: number; quiet_start: number; quiet_end: number; timezone: string; enabled: boolean;
}
type Kind = 'reading' | 'hifz' | 'review' | 'evening';
const KINDS: [Kind, string, string][] = [
  ['reading', 'ورد القراءة', 'لا يصل إن فتحت المصحف اليوم'],
  ['hifz', 'الحفظ', 'عند وجود مقطع حفظ لم يكتمل'],
  ['review', 'المراجعة', 'عند وجود مراجعة مستحقة اليوم'],
  ['evening', 'تذكير آخر اليوم', 'فقط إن بقيت مهام اليوم دون إنجاز'],
];
const hh = hourLabel; // 20 → «٨:٠٠ مساءً»
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function ReminderSettingsCard() {
  const [r, setR] = useState<R | null>(null); const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => { api<R>('GET', 'me/reminders').then(setR).catch(() => {}); }, []);
  if (!r) return null;
  const save = async (patch: Partial<R>) => {
    const prev = r; setR({ ...r, ...patch }); setErr({});
    try { setR(await api<R>('PUT', 'me/reminders', patch)); toast('حُفظت التذكيرات'); }
    catch (e) {
      setR(prev);
      const x = e as ApiError; const f: Record<string, string> = {};
      for (const k of Object.keys(patch)) { const m = x.field?.(k); if (m) f[k] = m; }
      for (const [k] of KINDS) { const m = x.field?.(`${k}_hour`); if (m) f[`${k}_hour`] = m; }
      setErr(Object.keys(f).length ? f : { _: x.message });
    }
  };
  const sel = { minHeight: 44, borderRadius: 10, border: `1.5px solid ${color.borderInput}`, background: color.card, padding: '0 8px', fontSize: 15, fontFamily: 'inherit' } as const;
  return (
    <section aria-labelledby="rem-h" style={{ ...card, padding: '4px 16px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h2 id="rem-h" style={{ margin: '12px 0 0', fontSize: 14, color: color.muted, fontWeight: 700 }}>تذكيرات القرآن الكريم</h2>
      <p style={muted(12, { lineHeight: 1.7 })}>بتوقيت منطقتك الزمنية (<bdi dir="ltr">{r.timezone}</bdi>). تصل إلى هذا الجهاز حتى لو كان التطبيق مغلقًا، بعد تفعيل الإشعارات أعلاه.</p>
      {KINDS.map(([k, label, hint]) => {
        const on = r[`${k}_on` as const]; const hour = r[`${k}_hour` as const];
        return (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4, borderBottom: `1px solid ${color.divider}`, padding: '8px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}>
              <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, cursor: 'pointer' }}>
                <input type="checkbox" checked={on} onChange={(e) => void save({ [`${k}_on`]: e.target.checked } as Partial<R>)} style={{ width: 22, height: 22, accentColor: color.primary }} />
                <span><span style={{ display: 'block' }}>{label}</span><span style={muted(12)}>{hint}</span></span>
              </label>
              <select aria-label={`وقت تذكير ${label}`} value={hour} disabled={!on} onChange={(e) => void save({ [`${k}_hour`]: Number(e.target.value) } as Partial<R>)} style={{ ...sel, opacity: on ? 1 : 0.5 }}>
                {HOURS.map((h) => <option key={h} value={h}>{hh(h)}</option>)}
              </select>
            </div>
            {err[`${k}_hour`] && <p role="alert" style={{ margin: 0, fontSize: 13, color: color.dangerInk }}>{err[`${k}_hour`]}</p>}
          </div>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 52, fontSize: 15 }}>
        <span style={{ flex: '1 1 120px' }}>ساعات الهدوء</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>من
          <select aria-label="بداية ساعات الهدوء" value={r.quiet_start} onChange={(e) => void save({ quiet_start: Number(e.target.value) })} style={sel}>
            {HOURS.map((h) => <option key={h} value={h}>{hh(h)}</option>)}</select></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>إلى
          <select aria-label="نهاية ساعات الهدوء" value={r.quiet_end} onChange={(e) => void save({ quiet_end: Number(e.target.value) })} style={sel}>
            {HOURS.map((h) => <option key={h} value={h}>{hh(h)}</option>)}</select></label>
      </div>
      <p style={muted(12)}>لا يصل أي تذكير في ساعات الهدوء، وتذكير واحد على الأكثر كل ساعة، وكل نوع مرة واحدة في اليوم.</p>
      {err._ && <p role="alert" style={{ margin: 0, fontSize: 13, color: color.dangerInk }}>{err._}</p>}
    </section>
  );
}
