/** «الإتاحة»: a teacher's availability as time ranges anywhere in the day (00:00–23:59), not fixed times.
 *  Weekly ranges per weekday, copy to other days, changes for one date only (close the day, add a range, «حظر وقت»),
 *  the day's state (متاح / محجوز / غير متاح / تعارض تقويم) and the day's real sessions, kept apart from the ranges.
 *  The server computes the bookable times and enforces every rule (scheduling/availability.py); this screen only
 *  edits ranges. Used by the teacher app and, with an admin API prefix, by the admin portal. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { api, type ApiError } from '@/api/client';

export type Rule = { id: number; weekday: number; start: string; end: string; session_minutes: number; overnight: boolean };
export type Info = { timezone: string; tz_offset: string; increment: number; durations: number[]; default_minutes: number; gap_minutes: number; rules: Rule[] };
export type Override = { id: number; date: string; kind: 'off' | 'extra' | 'blocked'; start: string | null; end: string | null; session_minutes: number | null; reason?: string; overnight: boolean };
export type Segment = { start: string; end: string; state: 'available' | 'booked' | 'unavailable' | 'calendar' };
export type DaySession = { id: number; starts_at: string; ends_at: string; kind: string; circle_name: string | null; students: string[]; topic: string; title: string };
export type Day = { date: string; weekday: number; closed: boolean; weekly: Rule[]; overrides: Override[]; timeline: Segment[]; bookable_starts: number; sessions: DaySession[] };
type RangeIn = { start: string; end: string; session_minutes?: number };

export interface AvailApi {
  info(): Promise<Info>;
  addRule(b: RangeIn & { weekday: number }): Promise<Rule>;
  patchRule(id: number, b: RangeIn): Promise<Rule>;
  delRule(id: number): Promise<unknown>;
  copy(from: number, to: number[]): Promise<Info>;
  day(date: string): Promise<Day>;
  addOverride(b: Partial<RangeIn> & { date: string; kind: Override['kind']; reason?: string }): Promise<Override>;
  delOverride(id: number): Promise<unknown>;
}

/** The server API: `teacher/availability` (the teacher) or `admin/teachers/<id>/availability` (an admin). */
export function httpAvail(base: string): AvailApi {
  return {
    info: () => api<Info>('GET', base),
    addRule: (b) => api<Rule>('POST', `${base}/rules`, b),
    patchRule: (id, b) => api<Rule>('PATCH', `${base}/rules/${id}`, b),
    delRule: (id) => api('DELETE', `${base}/rules/${id}`),
    copy: (from, to) => api<Info>('POST', `${base}/copy`, { from_weekday: from, to_weekdays: to }),
    day: (date) => api<Day>('GET', `${base}/day?date=${date}`),
    addOverride: (b) => api<Override>('POST', `${base}/overrides`, b),
    delOverride: (id) => api('DELETE', `${base}/overrides/${id}`),
  };
}

/* ---------------- labels ---------------- */
// Python weekday order (0 = Monday) as the server uses; shown starting from Saturday.
export const WD = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];
const WEEK_ORDER = [5, 6, 0, 1, 2, 3, 4];
export const tLabel = (v: string | null) => {
  if (!v) return '';
  const [h, m] = v.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'ص' : 'م'}`;
};
const rangeLabel = (s: string | null, e: string | null) => `${tLabel(s)} — ${tLabel(e)}`;
const STATE: Record<Segment['state'], [string, string, string]> = {
  available: ['متاح', '#E3EFE9', color.primary],
  booked: ['محجوز', '#F6E7C8', color.warnInk],
  unavailable: ['غير متاح', '#ECE7DD', color.muted],
  calendar: ['تعارض تقويم', '#F7DEDA', color.dangerInk],
};
const gmt = (off: string) => { const h = Number(off.slice(0, 3)); const m = off.slice(3); return `GMT${h >= 0 ? '+' : ''}${h}${m !== '00' ? ':' + m : ''}`; };
const TZ_AR: Record<string, string> = { 'Africa/Cairo': 'القاهرة', 'Asia/Riyadh': 'الرياض', 'Asia/Dubai': 'دبي', 'Europe/London': 'لندن' };

/** Local dates (YYYY-MM-DD) in the academy timezone, from today. */
function nextDates(tz: string, n: number): string[] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}
const pyWeekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const dayNum = (date: string) => String(Number(date.slice(8)));
const dateLabel = (date: string) => new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const timeOf = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const errOf = (e: unknown) => {
  const x = e as ApiError;
  const f = x?.fields ? Object.values(x.fields).flat()[0] : null;
  return x?.code === 'invalid' && f ? String(f) : x?.message || 'تعذّر الحفظ. حاول مرة أخرى.';
};

/* ---------------- small UI ---------------- */
const btn = (tone: 'primary' | 'plain' | 'danger' = 'plain') => ({
  minHeight: 44, padding: '0 14px', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
  border: `1px solid ${tone === 'danger' ? color.dangerInk : tone === 'primary' ? color.primary : color.borderStrong}`,
  background: tone === 'primary' ? color.primary : color.card, color: tone === 'primary' ? color.ivory : tone === 'danger' ? color.dangerInk : color.primary,
}) as const;
const sec = { background: color.card, border: `1px solid ${color.border}`, borderRadius: 16, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 } as const;
const h2 = { margin: 0, fontSize: 16, fontWeight: 800 } as const;
const mutedS = (fs = 13) => ({ margin: 0, fontSize: fs, color: color.muted }) as const;

/** A bottom sheet on phones (a centred dialog on wide screens). */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, background: 'rgba(20,33,31,.45)', zIndex: 70, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label={title} style={{ background: color.ivory, width: '100%', maxWidth: 480, borderRadius: '20px 20px 0 0', padding: '18px 16px calc(18px + env(safe-area-inset-bottom))', maxHeight: '90dvh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** «04:00 م»: hour, minutes on the increment, and ص/م — three touch-sized selects instead of 96 rows. */
export function TimePicker({ id, label, value, onChange, step }: { id: string; label: string; value: string; onChange: (v: string) => void; step: number }) {
  const [h, m] = value.split(':').map(Number);
  const pm = h >= 12; const h12 = ((h + 11) % 12) + 1;
  const set = (nh12: number, nm: number, npm: boolean) => onChange(`${String((nh12 % 12) + (npm ? 12 : 0)).padStart(2, '0')}:${String(nm).padStart(2, '0')}`);
  const sel = { minHeight: 48, fontSize: 17, borderRadius: 12, border: `1.5px solid ${color.borderStrong}`, background: color.card, padding: '0 8px', fontFamily: font.latin } as const;
  return (
    <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <legend style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{label}</legend>
      <div dir="ltr" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select id={id} aria-label={`${label}: الساعة`} value={h12} onChange={(e) => set(Number(e.target.value), m, pm)} style={{ ...sel, flex: 1 }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((x) => <option key={x} value={x}>{String(x).padStart(2, '0')}</option>)}
        </select>
        <span aria-hidden="true" style={{ fontSize: 18, fontWeight: 800 }}>:</span>
        <select id={`${id}-m`} aria-label={`${label}: الدقائق`} value={m - (m % step)} onChange={(e) => set(h12, Number(e.target.value), pm)} style={{ ...sel, flex: 1 }}>
          {Array.from({ length: 60 / step }, (_, i) => i * step).map((x) => <option key={x} value={x}>{String(x).padStart(2, '0')}</option>)}
        </select>
        <div role="radiogroup" aria-label={`${label}: صباحًا أو مساءً`} dir="rtl" style={{ display: 'flex', gap: 4 }}>
          {([[false, 'ص'], [true, 'م']] as const).map(([v, l]) => (
            <button key={l} type="button" role="radio" aria-checked={pm === v} onClick={() => set(h12, m, v)}
              style={{ minWidth: 48, minHeight: 48, borderRadius: 12, border: `1.5px solid ${pm === v ? color.primary : color.borderStrong}`, background: pm === v ? color.primary : color.card, color: pm === v ? color.ivory : color.primary, fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>{l}</button>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

type SheetState =
  | { kind: 'range'; mode: 'weekly' | 'date'; rule?: Rule }
  | { kind: 'block' }
  | { kind: 'copy' }
  | { kind: 'confirm'; title: string; body: string; ok: string; run: () => Promise<unknown> };

/** `readOnly`: view only (an admin without sessions.manage); the server refuses changes anyway. */
export default function AvailabilityEditor({ io, toast, days = 14, readOnly = false }: { io: AvailApi; toast: (m: string) => void; days?: number; readOnly?: boolean }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [day, setDay] = useState<Day | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const tz = info?.timezone ?? 'Africa/Cairo';
  const dates = useMemo(() => nextDates(tz, days), [tz, days]);
  // The chosen date lives in a ref too: an answer that arrives late (the first load, a slow day) never replaces a day
  // the teacher picked in the meantime.
  const cur = useRef<string | null>(null);
  const showDay = useCallback(async (d: string) => {
    cur.current = d; setDate(d);
    try { const x = await io.day(d); if (cur.current === d) { setDay(x); setErr(null); } } catch (e) { if (cur.current === d) setErr(errOf(e)); }
  }, [io]);
  const load = useCallback(async () => {
    try {
      const i = await io.info(); setInfo(i);
      await showDay(cur.current ?? nextDates(i.timezone, 1)[0]);
    } catch (e) { setErr(errOf(e)); }
  }, [io, showDay]);
  useEffect(() => { void load(); }, [load]);
  const pick = async (d: string) => { setDay(null); await showDay(d); };

  if (err && !info) return <p role="alert" style={{ color: color.dangerInk, margin: 0 }}>{err} <button onClick={() => void load()} style={btn()}>إعادة المحاولة</button></p>;
  if (!info || !date) return <p role="status" style={mutedS(14)}>جارٍ التحميل…</p>;
  const wd = pyWeekday(date);
  const weekly = info.rules.filter((r) => r.weekday === wd).sort((a, b) => a.start.localeCompare(b.start));
  const done = async (msg: string) => { setSheet(null); toast(msg); await load(); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={mutedS(13)}>الأوقات بتوقيت {TZ_AR[tz] ?? tz} ({gmt(info.tz_offset)}). تُحسب مواعيد الحجز تلقائيًا كل {info.increment} دقيقة داخل فتراتك، دون تعارض مع الجلسات المحجوزة{info.gap_minutes ? ` (مع فاصل ${info.gap_minutes} دقيقة بين الجلسات)` : ''}.</p>
      <div role="tablist" aria-label="اختر اليوم" style={{ display: 'flex', gap: 8, overflowX: 'auto', margin: '0 -16px', padding: '2px 16px' }}>
        {dates.map((d, i) => {
          const on = d === date; const has = info.rules.some((r) => r.weekday === pyWeekday(d));
          return (
            <button key={d} role="tab" aria-selected={on} aria-label={dateLabel(d)} onClick={() => void pick(d)} style={{ flexShrink: 0, width: 64, minHeight: 68, borderRadius: 14, border: `1.5px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.ink, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, cursor: 'pointer' }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{i === 0 ? 'اليوم' : WD[pyWeekday(d)].replace('ال', '')}</span>
              <span style={{ fontFamily: font.latin, fontSize: 18, fontWeight: 700 }}>{dayNum(d)}</span>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 3, background: has ? (on ? color.ivory : color.primary) : 'transparent' }} />
            </button>
          );
        })}
      </div>

      <section aria-label="الإتاحة" style={sec}>
        <h2 style={h2}>الإتاحة · كل {WD[wd]}</h2>
        {weekly.length === 0 && <p style={mutedS(14)}>غير متاح</p>}
        {weekly.map((r) => (
          <div key={r.id} data-range={`${r.start}-${r.end}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 52, borderTop: `1px solid ${color.divider}`, paddingTop: 8 }}>
            <span style={{ flex: '1 1 180px' }}>
              <strong style={{ fontSize: 16 }}>{rangeLabel(r.start, r.end)}</strong>
              <span style={{ display: 'block', fontSize: 12, color: color.muted }}>جلسات {r.session_minutes} دقيقة{r.overnight ? ' · تمتد إلى اليوم التالي' : ''}</span>
            </span>
            {!readOnly && <><button onClick={() => setSheet({ kind: 'range', mode: 'weekly', rule: r })} aria-label={`تعديل ${rangeLabel(r.start, r.end)}`} style={btn()}>تعديل</button>
            <button onClick={() => setSheet({ kind: 'confirm', title: 'حذف الفترة؟', body: `ستُحذف الفترة ${rangeLabel(r.start, r.end)} من كل ${WD[wd]}. الجلسات المحجوزة تبقى كما هي.`, ok: 'حذف', run: async () => { await io.delRule(r.id); await done('حُذفت الفترة'); } })}
              aria-label={`حذف ${rangeLabel(r.start, r.end)}`} style={btn('danger')}>حذف</button></>}
          </div>
        ))}
        {!readOnly && <button onClick={() => setSheet({ kind: 'range', mode: 'weekly' })} style={{ ...btn('primary'), minHeight: 48 }}>+ إضافة فترة إتاحة</button>}
        {!readOnly && weekly.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setSheet({ kind: 'confirm', title: 'نسخ لهذا الأسبوع', body: `ستصبح إتاحة كل أيام الأسبوع مثل ${WD[wd]} تمامًا (تُستبدل فترات الأيام الأخرى).`, ok: 'نسخ',
            run: async () => { await io.copy(wd, [0, 1, 2, 3, 4, 5, 6].filter((x) => x !== wd)); await done('نُسخت الإتاحة لكل أيام الأسبوع'); } })} style={btn()}>نسخ لهذا الأسبوع</button>
          <button onClick={() => setSheet({ kind: 'copy' })} style={btn()}>نسخ لأيام أخرى</button>
        </div>}
      </section>

      <section aria-label="تعديل هذا اليوم فقط" style={sec}>
        <h2 style={h2}>تعديل هذا اليوم فقط · {dateLabel(date)}</h2>
        <p style={mutedS(12)}>لا يغيّر الإتاحة الأسبوعية؛ ينطبق على هذا التاريخ وحده.</p>
        {!day ? <p role="status" style={mutedS()}>جارٍ التحميل…</p> : <>
          {day.overrides.map((o) => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 48, borderTop: `1px solid ${color.divider}`, paddingTop: 8 }}>
              <span style={{ flex: '1 1 180px', fontSize: 15 }}>
                {o.kind === 'off' ? <strong>مغلق طوال اليوم</strong> : <><strong>{o.kind === 'extra' ? 'إتاحة إضافية' : 'وقت محظور'}</strong> {rangeLabel(o.start, o.end)}</>}
                {o.reason ? <span style={{ display: 'block', fontSize: 12, color: color.muted }}>{o.reason} (لا يظهر للطلاب)</span> : null}
              </span>
              {!readOnly && <button onClick={() => void io.delOverride(o.id).then(() => done('أُزيل التعديل')).catch((e) => toast(errOf(e)))} style={btn('danger')}>إزالة</button>}
            </div>
          ))}
          {readOnly ? (day.overrides.length === 0 && <p style={mutedS(14)}>لا تعديلات على هذا اليوم.</p>) : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!day.closed && <button onClick={() => setSheet({ kind: 'confirm', title: 'إغلاق هذا اليوم؟', body: `لن تُعرض أي مواعيد جديدة يوم ${dateLabel(date)}. الجلسات المحجوزة تبقى كما هي، وباقي أيام ${WD[wd]} لا تتغير.`, ok: 'إغلاق اليوم',
              run: async () => { await io.addOverride({ date, kind: 'off' }); await done('أُغلق هذا اليوم'); } })} style={btn()}>غير متاح هذا اليوم</button>}
            <button onClick={() => setSheet({ kind: 'range', mode: 'date' })} style={btn()}>إضافة فترة لهذا اليوم</button>
            <button onClick={() => setSheet({ kind: 'block' })} style={btn()}>حظر وقت</button>
          </div>}
        </>}
      </section>

      {day && <section aria-label="حالة اليوم" style={sec}>
        <h2 style={h2}>حالة اليوم</h2>
        <div aria-hidden="true" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(Object.keys(STATE) as Segment['state'][]).map((k) => <span key={k} style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: STATE[k][1], color: STATE[k][2] }}>{STATE[k][0]}</span>)}
        </div>
        {day.closed && <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.warnInk }}>هذا اليوم مغلق (تعديل لهذا اليوم فقط).</p>}
        {day.timeline.length === 0 ? <p style={mutedS(14)}>غير متاح في هذا اليوم.</p> : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {day.timeline.map((s) => (
              <li key={s.start + s.state} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40 }}>
                <span style={{ flex: 1, fontSize: 15 }}>{rangeLabel(timeOf(s.start, tz), timeOf(s.end, tz))}</span>
                <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: STATE[s.state][1], color: STATE[s.state][2] }}>{STATE[s.state][0]}</span>
              </li>
            ))}
          </ul>
        )}
        <p style={mutedS(13)}>{day.bookable_starts ? `${day.bookable_starts} موعد بداية متاح للحجز في هذا اليوم.` : 'لا توجد مواعيد متاحة للحجز في هذا اليوم.'}</p>
      </section>}

      {day && <section aria-label="جلسات اليوم" style={sec}>
        <h2 style={h2}>جلسات اليوم</h2>
        {day.sessions.length === 0 && <p style={mutedS(14)}>لا توجد جلسات في هذا اليوم.</p>}
        {day.sessions.map((s) => (
          <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 48, borderTop: `1px solid ${color.divider}`, paddingTop: 8 }}>
            <strong style={{ minWidth: 120, fontSize: 15 }}>{rangeLabel(timeOf(s.starts_at, tz), timeOf(s.ends_at, tz))}</strong>
            <span style={{ fontSize: 14 }}>{s.circle_name ?? (s.students.join('، ') || (s.title || 'جلسة'))}<span style={{ color: color.muted }}> · {s.kind === 'group' ? 'جماعية' : 'فردية'}</span></span>
          </div>
        ))}
      </section>}

      {sheet?.kind === 'range' && <RangeSheet info={info} rule={sheet.rule} title={sheet.rule ? 'تعديل الفترة' : sheet.mode === 'weekly' ? `إضافة فترة · كل ${WD[wd]}` : `إضافة فترة · ${dateLabel(date)} فقط`}
        onClose={() => setSheet(null)} save={async (b) => {
          if (sheet.rule) await io.patchRule(sheet.rule.id, b);
          else if (sheet.mode === 'weekly') await io.addRule({ ...b, weekday: wd });
          else await io.addOverride({ ...b, date, kind: 'extra' });
          await done(sheet.rule ? 'حُفظت الفترة' : 'أُضيفت الفترة');
        }} />}
      {sheet?.kind === 'block' && <RangeSheet info={info} block title={`حظر وقت · ${dateLabel(date)}`} onClose={() => setSheet(null)}
        save={async (b) => { await io.addOverride({ ...b, date, kind: 'blocked' }); await done('حُظر الوقت'); }} />}
      {sheet?.kind === 'copy' && <CopySheet from={wd} onClose={() => setSheet(null)} save={async (to) => { await io.copy(wd, to); await done('نُسخت الإتاحة'); }} />}
      {sheet?.kind === 'confirm' && <ConfirmSheet {...sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}

function RangeSheet({ info, rule, block, title, onClose, save }: {
  info: Info; rule?: Rule; block?: boolean; title: string; onClose: () => void; save: (b: RangeIn & { reason?: string }) => Promise<void>;
}) {
  const [start, setStart] = useState(rule?.start ?? (block ? '18:30' : '16:00'));
  const [end, setEnd] = useState(rule?.end ?? (block ? '20:00' : '22:00'));
  const [minutes, setMinutes] = useState(rule?.session_minutes ?? info.default_minutes);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const overnight = end <= start && end !== start;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return;
    if (start === end) return setErr('وقت النهاية يساوي وقت البداية. اختر فترة لها مدة.');
    setBusy(true); setErr(null);
    try { await save(block ? { start, end, reason: reason.trim() } : { start, end, session_minutes: minutes }); } catch (x) { setErr(errOf(x)); setBusy(false); }
  };
  return (
    <Sheet title={title} onClose={onClose}>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TimePicker id="av-from" label="من" value={start} onChange={setStart} step={info.increment} />
        <TimePicker id="av-to" label="إلى" value={end} onChange={setEnd} step={info.increment} />
        {overnight && <p style={{ margin: 0, fontSize: 13, color: color.warnInk }}>تمتد هذه الفترة بعد منتصف الليل إلى اليوم التالي.</p>}
        {block ? <>
          <label htmlFor="av-reason" style={{ fontSize: 14, fontWeight: 700 }}>السبب (اختياري، لا يظهر للطلاب)</label>
          <input id="av-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="موعد شخصي" style={{ minHeight: 48, borderRadius: 12, border: `1.5px solid ${color.borderStrong}`, padding: '0 12px', fontSize: 16 }} />
        </> : <>
          <label htmlFor="av-min" style={{ fontSize: 14, fontWeight: 700 }}>مدة الجلسة</label>
          <select id="av-min" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={{ minHeight: 48, borderRadius: 12, border: `1.5px solid ${color.borderStrong}`, padding: '0 10px', fontSize: 16, background: color.card }}>
            {info.durations.map((d) => <option key={d} value={d}>{d} دقيقة</option>)}
          </select>
        </>}
        {err && <p role="alert" style={{ margin: 0, fontSize: 14, color: color.dangerInk }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy} style={{ ...btn('primary'), flex: 1, minHeight: 52, fontSize: 16 }}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
          <button type="button" onClick={onClose} style={{ ...btn(), minHeight: 52 }}>إلغاء</button>
        </div>
      </form>
    </Sheet>
  );
}

function CopySheet({ from, onClose, save }: { from: number; onClose: () => void; save: (to: number[]) => Promise<void> }) {
  const [to, setTo] = useState<Set<number>>(new Set()); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!to.size) return setErr('اختر يومًا واحدًا على الأقل.');
    setBusy(true); setErr(null);
    try { await save([...to]); } catch (x) { setErr(errOf(x)); setBusy(false); }
  };
  return (
    <Sheet title={`نسخ إتاحة ${WD[from]} إلى…`} onClose={onClose}>
      <p style={mutedS(13)}>تُستبدل فترات الأيام المختارة بفترات {WD[from]}.</p>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {WEEK_ORDER.filter((x) => x !== from).map((x) => (
          <label key={x} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 48, fontSize: 16, borderBottom: `1px solid ${color.divider}` }}>
            <input type="checkbox" checked={to.has(x)} onChange={() => { const n = new Set(to); n.has(x) ? n.delete(x) : n.add(x); setTo(n); }} style={{ width: 22, height: 22 }} />{WD[x]}
          </label>
        ))}
      </div>
      {err && <p role="alert" style={{ margin: 0, fontSize: 14, color: color.dangerInk }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => void run()} disabled={busy} style={{ ...btn('primary'), flex: 1, minHeight: 52 }}>{busy ? 'جارٍ النسخ…' : 'نسخ'}</button>
        <button onClick={onClose} style={{ ...btn(), minHeight: 52 }}>إلغاء</button>
      </div>
    </Sheet>
  );
}

function ConfirmSheet({ title, body, ok, run, onClose }: { title: string; body: string; ok: string; run: () => Promise<unknown>; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  return (
    <Sheet title={title} onClose={onClose}>
      <p style={{ margin: 0, fontSize: 15 }}>{body}</p>
      {err && <p role="alert" style={{ margin: 0, fontSize: 14, color: color.dangerInk }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={() => { setBusy(true); run().catch((x) => { setErr(errOf(x)); setBusy(false); }); }} style={{ ...btn('primary'), flex: 1, minHeight: 52 }}>{busy ? 'جارٍ التنفيذ…' : ok}</button>
        <button onClick={onClose} style={{ ...btn(), minHeight: 52 }}>إلغاء</button>
      </div>
    </Sheet>
  );
}

/* ---------------- demo (no server): the same screen on in-memory data ---------------- */
export function demoAvail(): AvailApi {
  let seq = 100;
  const rules: Rule[] = [6, 1, 3].map((weekday) => ({ id: ++seq, weekday, start: '16:00', end: '21:00', session_minutes: 45, overnight: false }));
  const ov: Override[] = [];
  const info = (): Info => ({ timezone: 'Africa/Cairo', tz_offset: '+0300', increment: 15, durations: [30, 45, 60], default_minutes: 45, gap_minutes: 0, rules: rules.map((r) => ({ ...r })) });
  const len = (s: string, e: string) => { const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3)); return (m(e) - m(s) + 1440) % 1440; };
  const span = (wd: number, s: string, e: string) => [wd * 1440 + Number(s.slice(0, 2)) * 60 + Number(s.slice(3)), len(s, e)];
  const hit = (a: number[], b: number[]) => (b[0] - a[0] + 10080) % 10080 < a[1] || (a[0] - b[0] + 10080) % 10080 < b[1];
  const clash = (wd: number, s: string, e: string, skip?: number) => rules.some((r) => r.id !== skip && hit(span(wd, s, e), span(r.weekday, r.start, r.end)));
  const fail = (m: string) => Promise.reject(Object.assign(new Error(m), { code: 'overlap', message: m }));
  return {
    info: async () => info(),
    addRule: async (b) => { if (clash(b.weekday, b.start, b.end)) return fail('تتداخل هذه الفترة مع فترة أخرى.'); const r = { id: ++seq, weekday: b.weekday, start: b.start, end: b.end, session_minutes: b.session_minutes ?? 45, overnight: b.end <= b.start }; rules.push(r); return r; },
    patchRule: async (id, b) => { const r = rules.find((x) => x.id === id)!; if (clash(r.weekday, b.start, b.end, id)) return fail('تتداخل هذه الفترة مع فترة أخرى.'); Object.assign(r, b, { overnight: b.end <= b.start }); return r; },
    delRule: async (id) => { rules.splice(rules.findIndex((x) => x.id === id), 1); },
    copy: async (from, to) => { for (let i = rules.length - 1; i >= 0; i--) if (to.includes(rules[i].weekday)) rules.splice(i, 1); for (const r of rules.filter((x) => x.weekday === from)) for (const w of to) rules.push({ ...r, id: ++seq, weekday: w }); return info(); },
    day: async (date) => {
      const wd = pyWeekday(date); const mine = ov.filter((o) => o.date === date); const closed = mine.some((o) => o.kind === 'off');
      const iso = (t: string) => new Date(`${date}T${t}:00+03:00`).toISOString();
      const wins = [...(closed ? [] : rules.filter((r) => r.weekday === wd)), ...mine.filter((o) => o.kind === 'extra')];
      return { date, weekday: wd, closed, weekly: rules.filter((r) => r.weekday === wd), overrides: mine, sessions: [], bookable_starts: wins.length * 12,
        timeline: wins.map((w) => ({ start: iso(w.start!), end: iso(w.end!), state: 'available' as const })) };
    },
    addOverride: async (b) => { const o: Override = { id: ++seq, date: b.date, kind: b.kind, start: b.start ?? null, end: b.end ?? null, session_minutes: b.session_minutes ?? null, reason: b.reason ?? '', overnight: false }; ov.push(o); return o; },
    delOverride: async (id) => { ov.splice(ov.findIndex((x) => x.id === id), 1); },
  };
}
