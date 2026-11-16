/** Individual and group sessions with weekly recurrence (owner request, 16 Nov 2026). The server holds every rule
 *  (apps/scheduling/series.py); this file is the teacher's side:
 *  - StudentPicker: a searchable list of the teacher's own students (one for «فردية», several for «جماعية»);
 *  - WeeklyDays: one or more weekdays, each with its own time;
 *  - SeriesSection: «الجلسات الأسبوعية» — participants (add / remove), pause / resume / cancel, end date, meeting link;
 *  - SessionPeople: add or remove a student in one session;
 *  - EvaluationForm: per-student memorization, tajweed and note after the session starts. */
import { useEffect, useMemo, useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { card, inputStyle, labelStyle, muted, primaryBtn } from '@/components/ui';
import { SurahPicker } from '@/components/QuranPickers';
import { ayahCount } from '@/lib/quranIndex';
import { MeetingLinkError, meetingProvider, normalizeMeetingUrl } from '@/lib/meeting';
import { dayLabel, fmtTime } from '@/lib/time';
import { tzOf } from '@/lib/format';
import type { ApiError } from '@/api/client';
import * as E from '@/api/endpoints';
import type { SessionEvaluation } from '@/data/types';
import { openSheet, setState, toast, useApp } from '@/store/store';
import { refreshSchedule } from '@/store/live';

const errText = (e: unknown) => (e as ApiError)?.message || 'تعذّر تنفيذ الطلب.';
/** Saturday first, as the week reads in Egypt. Values are the server's weekday numbers (0 = Monday … 6 = Sunday). */
export const WEEK: [number, string][] = [[5, 'السبت'], [6, 'الأحد'], [0, 'الاثنين'], [1, 'الثلاثاء'], [2, 'الأربعاء'], [3, 'الخميس'], [4, 'الجمعة']];
const dayName = (wd: number) => WEEK.find(([w]) => w === wd)?.[1] ?? '';
const SERIES_EVENT = 'halqa:series';
export const seriesChanged = () => window.dispatchEvent(new Event(SERIES_EVENT));
const small = (tone: 'primary' | 'plain' | 'danger' = 'plain') => ({
  minHeight: 40, padding: '0 12px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
  border: `1px solid ${tone === 'danger' ? color.dangerInk : tone === 'primary' ? color.primary : color.borderStrong}`,
  background: tone === 'primary' ? color.primary : color.card, color: tone === 'primary' ? color.ivory : tone === 'danger' ? color.dangerInk : color.primary,
} as const);

/* ---------------- choosing students ---------------- */
let pickerCache: Promise<{ id: number; name: string }[]> | null = null;
export function usePickerStudents() {
  const [list, setList] = useState<{ id: number; name: string }[] | null>(null);
  useEffect(() => {
    pickerCache ??= E.studentPicker().then((r) => r.results).catch((e) => { pickerCache = null; throw e; });
    pickerCache.then(setList).catch(() => setList([]));
  }, []);
  return list;
}
export const forgetPickerStudents = () => { pickerCache = null; };

export function StudentPicker({ multi, value, onChange, exclude = [], invalid, id = 'stu-pick' }: {
  multi: boolean; value: number[]; onChange: (ids: number[]) => void; exclude?: number[]; invalid?: string; id?: string;
}) {
  const all = usePickerStudents();
  const [q, setQ] = useState('');
  const shown = useMemo(() => (all ?? []).filter((s) => !exclude.includes(s.id) && (!q.trim() || s.name.includes(q.trim()))), [all, q, exclude]);
  const toggle = (sid: number) => {
    if (!multi) return onChange([sid]);
    onChange(value.includes(sid) ? value.filter((x) => x !== sid) : [...value, sid]);   // a student is never listed twice
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث باسم الطالب" aria-label="ابحث عن طالب"
        style={inputStyle(invalid)} aria-invalid={!!invalid} />
      <div role={multi ? 'group' : 'radiogroup'} aria-label="الطلاب" data-testid="student-picker"
        style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${invalid ? color.dangerInk : color.borderStrong}`, borderRadius: 12, background: color.card }}>
        {all === null && <p style={muted(13, { padding: 10 })}>جارٍ تحميل الطلاب…</p>}
        {all !== null && shown.length === 0 && <p style={muted(13, { padding: 10 })}>{all.length ? 'لا يوجد طالب بهذا الاسم.' : 'لا يوجد طلاب مرتبطون بك بعد.'}</p>}
        {shown.map((s) => {
          const on = value.includes(s.id);
          return (
            <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '0 12px', borderBottom: `1px solid ${color.divider}`, cursor: 'pointer', fontSize: 15 }}>
              <input type={multi ? 'checkbox' : 'radio'} name={id} checked={on} onChange={() => toggle(s.id)} style={{ width: 20, height: 20, accentColor: color.primary }} />
              <span style={{ flex: 1 }}>{s.name}</span>
            </label>
          );
        })}
      </div>
      <span role="status" data-testid="picked-count" style={muted(13)}>المحدَّدون: {value.length} {value.length === 1 ? 'طالب' : 'طلاب'}</span>
    </div>
  );
}

/* ---------------- weekly days, each with its own time ---------------- */
export function WeeklyDays({ value, onChange, defaultTime, invalid }: {
  value: { weekday: number; time: string }[]; onChange: (v: { weekday: number; time: string }[]) => void; defaultTime: string; invalid?: string;
}) {
  const has = (wd: number) => value.some((d) => d.weekday === wd);
  const flip = (wd: number) => onChange(has(wd) ? value.filter((d) => d.weekday !== wd)
    : [...value, { weekday: wd, time: defaultTime || '19:00' }].sort((a, b) => WEEK.findIndex(([w]) => w === a.weekday) - WEEK.findIndex(([w]) => w === b.weekday)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div role="group" aria-label="أيام الأسبوع" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {WEEK.map(([wd, l]) => {
          const on = has(wd);
          return <button key={wd} type="button" aria-pressed={on} onClick={() => flip(wd)}
            style={{ minHeight: 40, padding: '0 12px', borderRadius: 999, border: `1.5px solid ${on ? color.primary : invalid ? color.dangerInk : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>{l}</button>;
        })}
      </div>
      {value.map((d) => (
        <label key={d.weekday} style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ minWidth: 70 }}>{dayName(d.weekday)}</span>
          <input type="time" aria-label={`وقت ${dayName(d.weekday)}`} value={d.time} onChange={(e) => onChange(value.map((x) => (x.weekday === d.weekday ? { ...x, time: e.target.value } : x)))}
            style={{ ...inputStyle(null, true), flex: 1 }} />
        </label>
      ))}
    </div>
  );
}

/** A meeting link field: «meet.google.com/…» becomes https://… when leaving it; only Meet, Zoom, Teams and Jitsi. */
export function tidyLink(raw: string): { url: string; error: string | null } {
  if (!raw.trim()) return { url: '', error: null };
  try {
    const url = normalizeMeetingUrl(raw);
    return meetingProvider(url) ? { url, error: null } : { url, error: 'الروابط المقبولة: Google Meet أو Zoom أو Jitsi أو Microsoft Teams.' };
  } catch (e) { return { url: raw, error: e instanceof MeetingLinkError ? e.message : 'الرابط غير صالح.' }; }
}

/* ---------------- «الجلسات الأسبوعية» ---------------- */
export function SeriesSection() {
  const [rows, setRows] = useState<E.ApiSeries[] | null>(null);
  const load = () => E.teacherSeries().then((r) => setRows(r.results)).catch(() => setRows([]));
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(SERIES_EVENT, on);
    return () => window.removeEventListener(SERIES_EVENT, on);
  }, []);
  if (!rows || rows.length === 0) return null;
  return (
    <section aria-labelledby="series-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 id="series-h" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الجلسات الأسبوعية</h2>
      {rows.map((r) => <SeriesCard key={r.id} r={r} onChange={(x) => setRows((all) => (all ?? []).map((y) => (y.id === x.id ? x : y)))} />)}
    </section>
  );
}

const STATUS: Record<E.ApiSeries['status'], [string, string, string]> = {
  active: ['نشطة', color.sageTint, color.primary], paused: ['موقوفة مؤقتًا', color.warnBg, color.warnInk], cancelled: ['ملغاة', color.dangerBg, color.dangerInk],
};

function SeriesCard({ r, onChange }: { r: E.ApiSeries; onChange: (x: E.ApiSeries) => void }) {
  const tz = tzOf(useApp((s) => s.tz)).iana;
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<number[] | null>(null);
  const [edit, setEdit] = useState<null | 'end' | 'link' | 'days'>(null);
  const [end, setEnd] = useState(r.ends_on ?? ''); const [link, setLink] = useState(r.meeting_url);
  const [days, setDays] = useState(r.slots.map((s) => ({ weekday: s.weekday, time: s.time })));
  const minutes = r.slots[0]?.minutes ?? 45;
  const active = r.participants.filter((p) => p.active);
  const run = async (fn: () => Promise<E.ApiSeries>, ok: string) => {
    setBusy(true); setErr(null);
    try {
      const x = await fn(); onChange(x); toast(ok); setEdit(null); setAdding(null); await refreshSchedule();
      if (x.result?.conflicts?.length) toast(`لم تُنشأ ${x.result.conflicts.length} جلسة لتعارضها مع جلسات أخرى لديك.`, 'alert');
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const confirm = (title: string, body: string, ok: string, fn: () => void, danger = false) =>
    openSheet({ kind: 'confirm', title, body, ok, danger, onOk: () => { setState({ sheet: null }); fn(); } });
  const closed = r.status === 'cancelled';
  const [label, bg, fg] = STATUS[r.status];
  return (
    <article data-testid="series-card" aria-label={r.title || 'جلسات أسبوعية'} style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 800 }}>{r.title || (r.kind === 'group' ? 'جلسات جماعية' : 'جلسات فردية')}</span>
        <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: bg, color: fg }}>{label}</span>
      </div>
      <span style={{ fontSize: 14, color: color.body }}>{r.kind === 'group' ? 'جماعية' : 'فردية'} · {r.schedule_text} · {minutes} دقيقة{r.ends_on ? ` · حتى ${r.ends_on}` : ''}</span>
      <span style={muted(13)}>{r.meeting_url ? `رابط ${r.meeting_label || 'الجلسة'} واحد لكل الجلسات` : 'لا يوجد رابط اجتماع ثابت (يمكن إضافته لكل جلسة)'}</span>
      {r.next_sessions.length > 0 && <span style={muted(13)}>القادمة: {r.next_sessions.slice(0, 3).map((o) => `${dayLabel(o.starts_at, tz)} ${fmtTime(o.starts_at, tz)}`).join('، ')}</span>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>المشاركون ({active.length})</span>
        {active.map((p) => (
          <div key={p.student} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40 }}>
            <span style={{ flex: 1, fontSize: 14 }}>{p.name}</span>
            {!closed && active.length > 1 && <button disabled={busy} aria-label={`إزالة ${p.name}`}
              onClick={() => confirm(`إزالة ${p.name}؟`, 'تُلغى مشاركته في الجلسات القادمة ويصله إشعار. الجلسات السابقة والحضور والتقييمات تبقى.', 'إزالة', () => void run(() => E.removeSeriesParticipant(r.id, p.student), `أُزيل ${p.name}`), true)}
              style={small('danger')}>إزالة</button>}
          </div>
        ))}
      </div>
      {!closed && (adding ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <StudentPicker id={`add-${r.id}`} multi={false} value={adding} onChange={setAdding} exclude={active.map((p) => p.student)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={busy || !adding.length} onClick={() => void run(() => E.addSeriesParticipant(r.id, adding[0]), 'أُضيف الطالب إلى الجلسات القادمة')} style={small('primary')}>إضافة</button>
            <button onClick={() => setAdding(null)} style={small()}>إلغاء</button>
          </div>
        </div>
      ) : r.kind === 'group' && <button disabled={busy} onClick={() => setAdding([])} style={{ ...small(), alignSelf: 'flex-start' }}><Icon name="plus" size={16} /> إضافة طالب</button>)}
      {edit === 'end' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 4 }}>تنتهي في<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={inputStyle(null, true)} /></label>
          <button disabled={busy} onClick={() => void run(() => E.updateSeries(r.id, { ends_on: end || null }), end ? 'حُدّد تاريخ الانتهاء' : 'أُزيل تاريخ الانتهاء')} style={small('primary')}>حفظ</button>
        </div>
      )}
      {edit === 'link' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input dir="ltr" inputMode="url" aria-label="رابط الاجتماع" value={link} placeholder="meet.google.com/abc-defg-hij"
            onChange={(e) => { setLink(e.target.value); setErr(null); }} onBlur={() => { const t = tidyLink(link); setLink(t.url); setErr(t.error); }} style={inputStyle(err)} />
          <button disabled={busy} onClick={() => { const t = tidyLink(link); if (t.error) return setErr(t.error); void run(() => E.updateSeries(r.id, { meeting_url: t.url }), 'حُفظ رابط الجلسات القادمة'); }} style={{ ...small('primary'), alignSelf: 'flex-start' }}>حفظ الرابط</button>
        </div>
      )}
      {edit === 'days' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <WeeklyDays value={days} onChange={setDays} defaultTime={days[0]?.time ?? '19:00'} />
          <button disabled={busy || !days.length} onClick={() => void run(() => E.updateSeries(r.id, { slots: days.map((d) => ({ ...d, minutes })) }), 'عُدّلت المواعيد الأسبوعية')} style={{ ...small('primary'), alignSelf: 'flex-start' }}>حفظ المواعيد</button>
        </div>
      )}
      {!closed && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={() => setEdit(edit === 'days' ? null : 'days')} style={small()}>تعديل الأيام والأوقات</button>
          <button disabled={busy} onClick={() => setEdit(edit === 'link' ? null : 'link')} style={small()}>رابط الاجتماع</button>
          <button disabled={busy} onClick={() => setEdit(edit === 'end' ? null : 'end')} style={small()}>تاريخ الانتهاء</button>
          {r.status === 'active'
            ? <button disabled={busy} onClick={() => confirm('إيقاف الجلسات مؤقتًا؟', 'تُلغى الجلسات القادمة ويصل المشاركين إشعار واحد. يمكنك الاستئناف لاحقًا.', 'إيقاف مؤقت', () => void run(() => E.seriesAction(r.id, 'pause'), 'أُوقفت الجلسات مؤقتًا'))} style={small()}>إيقاف مؤقت</button>
            : <button disabled={busy} onClick={() => void run(() => E.seriesAction(r.id, 'resume'), 'استؤنفت الجلسات')} style={small('primary')}>استئناف</button>}
          <button disabled={busy} onClick={() => confirm('إلغاء الجلسات الأسبوعية؟', 'تُلغى كل الجلسات القادمة نهائيًا ويُبلَّغ المشاركون. السجل السابق يبقى.', 'إلغاء الجلسات', () => void run(() => E.seriesAction(r.id, 'cancel'), 'أُلغيت الجلسات الأسبوعية'), true)} style={small('danger')}>إلغاء</button>
        </div>
      )}
      {err && <span role="alert" style={{ fontSize: 13, color: color.dangerInk }}>{err}</span>}
    </article>
  );
}

/* ---------------- one session's participants ---------------- */
export function SessionPeople({ o }: { o: E.ApiTeacherOcc }) {
  const [adding, setAdding] = useState<number[] | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); setAdding(null); await refreshSchedule(); } catch (e) { toast(errText(e), 'alert'); } finally { setBusy(false); }
  };
  if (!o.private || o.status === 'cancelled' || new Date(o.starts_at).getTime() <= Date.now() || o.kind !== 'group') return null;
  return adding ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <StudentPicker id={`sp-${o.id}`} multi={false} value={adding} onChange={setAdding} exclude={o.bookings.map((b) => b.student)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy || !adding.length} onClick={() => void run(() => E.addSessionParticipant(o.id, adding[0]), 'أُضيف الطالب إلى الجلسة')} style={small('primary')}>إضافة</button>
        <button onClick={() => setAdding(null)} style={small()}>إلغاء</button>
      </div>
    </div>
  ) : <button onClick={() => setAdding([])} style={{ ...small(), alignSelf: 'flex-start' }}><Icon name="plus" size={16} /> إضافة طالب لهذه الجلسة</button>;
}

export function removeFromSession(o: E.ApiTeacherOcc, b: { student: number; student_name: string }) {
  openSheet({ kind: 'confirm', title: `إزالة ${b.student_name} من الجلسة؟`, body: 'يصله إشعار، ولا تُعدَّل جلساته الأخرى.', ok: 'إزالة', danger: true,
    onOk: () => { setState({ sheet: null }); E.removeSessionParticipant(o.id, b.student).then(() => { toast(`أُزيل ${b.student_name} من الجلسة`); void refreshSchedule(); }).catch((e) => toast(errText(e), 'alert')); } });
}

/* ---------------- per-student evaluation ---------------- */
const GRADES: [string, string][] = [['excellent', 'ممتاز'], ['very_good', 'جيد جدًا'], ['good', 'جيد'], ['needs_work', 'يحتاج إلى مراجعة']];

/** One grade (tap again to clear). Plain buttons: they must never submit the surrounding form. */
function Grades({ label, value, onChange }: { label: string; value: string; onChange: (k: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {GRADES.map(([k, l]) => {
          const on = value === k;
          return <button key={k} type="button" role="radio" aria-checked={on} onClick={() => onChange(on ? '' : k)}
            style={{ minHeight: 38, padding: '0 12px', borderRadius: 999, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.sage : color.card, color: on ? color.primary : color.body, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{l}</button>;
        })}
      </div>
    </div>
  );
}

export function EvaluationForm({ booking, name, ev }: { booking: number; name: string; ev?: SessionEvaluation | null }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [v, setV] = useState<E.EvaluationBody>({ memorization_grade: ev?.memorization_grade ?? '', surah: ev?.surah ?? null, ayah_from: ev?.ayah_from ?? null,
    ayah_to: ev?.ayah_to ?? null, tajweed_grade: ev?.tajweed_grade ?? '', tajweed_note: ev?.tajweed_note ?? '', note: ev?.note ?? '' });
  const max = v.surah ? ayahCount(v.surah) : 286;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await E.saveEvaluation(booking, v); toast(`حُفظ تقييم ${name}`); setOpen(false); await refreshSchedule(); }
    catch (e) { const a = e as ApiError; setErr(a.fields?.ayah_to?.[0] ?? a.fields?.surah?.[0] ?? a.fields?.note?.[0] ?? errText(e)); } finally { setBusy(false); }
  };
  if (!open) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {ev && <span data-testid="eval-summary" style={muted(13, { flex: 1 })}>التقييم: {[ev.memorization_label && `الحفظ ${ev.memorization_label}`, ev.tajweed_label && `التجويد ${ev.tajweed_label}`].filter(Boolean).join(' · ') || 'ملاحظة'}</span>}
      <button onClick={() => setOpen(true)} style={small()} aria-label={`تقييم ${name}`}><Icon name="award" size={16} /> {ev ? 'تعديل التقييم' : 'التقييم'}</button>
    </div>
  );
  const num = (k: 'ayah_from' | 'ayah_to', label: string) => (
    <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>{label}
      <input type="number" inputMode="numeric" min={1} max={max} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value ? Number(e.target.value) : null })} style={inputStyle(null, true)} />
    </label>
  );
  return (
    <form aria-label={`تقييم ${name}`} onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ display: 'flex', flexDirection: 'column', gap: 8, background: color.sand, borderRadius: 12, padding: 10 }}>
      <Grades label="تقدير الحفظ" value={v.memorization_grade} onChange={(k) => setV({ ...v, memorization_grade: k })} />
      <SurahPicker id={`ev-s-${booking}`} value={v.surah} onChange={(n) => setV({ ...v, surah: n })} label="السورة (اختياري)" />
      <div style={{ display: 'flex', gap: 8 }}>{num('ayah_from', 'من آية')}{num('ayah_to', 'إلى آية')}</div>
      <Grades label="تقدير التجويد" value={v.tajweed_grade} onChange={(k) => setV({ ...v, tajweed_grade: k })} />
      <input aria-label="ملاحظة التجويد" placeholder="ملاحظة التجويد (اختياري)" maxLength={300} value={v.tajweed_note} onChange={(e) => setV({ ...v, tajweed_note: e.target.value })} style={inputStyle()} />
      <textarea aria-label="ملاحظة المعلم" placeholder="ملاحظة للطالب (اختياري)" maxLength={1000} rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} style={{ ...inputStyle(), minHeight: 60, padding: 10 }} />
      {err && <span role="alert" style={{ fontSize: 13, color: color.dangerInk }}>{err}</span>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy} style={primaryBtn(42, 14, { flex: 'none', padding: '0 16px', borderRadius: 10 })}>حفظ التقييم</button>
        <button type="button" onClick={() => setOpen(false)} style={small()}>إغلاق</button>
      </div>
    </form>
  );
}
