/** «جلسات الأسبوع» (owner request 22 Nov 2026): every session of a Saturday–Friday week in academy time (Cairo):
 *  teacher, students and their attendance, and what happened (انعقدت / غياب الجميع / لم يُسجَّل الحضور / ملغاة…),
 *  totals for the week and per teacher, week by week, with a CSV (Excel) export. The server decides every result. */
import { useEffect, useState } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { inputStyle } from '@/components/ui';
import { card } from '../AdminTables';
import * as A from './api';
import { chip, errMsg, smallBtn } from './ui';
import { teacherOptions } from './list';
import { fmtTime } from '@/lib/time';

const TZ = 'Africa/Cairo';
const TONE: Record<A.WeekResult, [string, string]> = {
  held: [color.sageTint, color.primary], absent: [color.dangerBg, color.dangerInk], unmarked: [color.warnBg, color.warnInk],
  empty: [color.sand, color.muted], in_progress: [color.goldTint, color.goldInk], upcoming: [color.sand, color.body], cancelled: [color.dangerBg, color.dangerInk],
};
const ATT: Record<string, string> = { present: 'حاضر', late: 'متأخر', absent: 'غائب', excused: 'غائب بعذر', '': 'لم يُسجَّل' };
const FILTERS: [string, string][] = [['', 'الكل'], ['held', 'انعقدت'], ['unmarked', 'لم يُسجَّل الحضور'], ['absent', 'غياب الجميع'], ['cancelled', 'ملغاة'], ['upcoming', 'قادمة']];
const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const dayTitle = (iso: string) => new Intl.DateTimeFormat('ar-EG', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
const dateL = (d: string) => new Intl.DateTimeFormat('ar-EG', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(new Date(d + 'T00:00:00Z'));
const pill = (r: A.WeekResult, l: string) => <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: TONE[r][0], color: TONE[r][1], whiteSpace: 'nowrap' }}>{l}</span>;

function exportCsv(d: A.WeekReport) {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['اليوم', 'الوقت (القاهرة)', 'المدة', 'المعلم', 'النوع', 'العنوان', 'النتيجة', 'الطلاب', 'حضور', 'غياب', 'بعذر', 'لم يُسجَّل'];
  const lines = d.results.map((s) => [dayTitle(s.starts_at), fmtTime(s.starts_at, TZ), s.minutes, s.teacher.name,
    `${s.kind_label}${s.weekly ? ' · أسبوعية' : ''}${s.circle ? ` · ${s.circle}` : ''}`, s.title || s.topic, s.result_label,
    s.students.map((x) => `${x.name} (${ATT[x.attendance] ?? x.attendance})`).join('، '),
    s.attendance.present + s.attendance.late, s.attendance.absent, s.attendance.excused, s.attendance.unmarked].map(q).join(','));
  const blob = new Blob(['﻿' + [head.map(q).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });   // BOM: Arabic in Excel
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `halqa-sessions-${d.week_start}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function WeekSessions() {
  const [start, setStart] = useState(''); const [teacher, setTeacher] = useState(''); const [result, setResult] = useState('');
  const [d, setD] = useState<A.WeekReport | null>(null); const [err, setErr] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const [tOpts, setTOpts] = useState<[string, string][]>([]); const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { teacherOptions().then(setTOpts).catch(() => setTOpts([])); }, []);
  useEffect(() => {
    let live = true; setLoading(true); setErr(null);
    A.weekSessions({ start, teacher, result }).then((x) => { if (live) setD(x); }).catch((e) => { if (live) setErr(errMsg(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [start, teacher, result]);
  const s = d?.summary;
  const tiles: [string, number | string, string][] = s ? [
    ['كل الجلسات', s.sessions, color.ink], ['انعقدت', s.held, color.primary], ['لم يُسجَّل الحضور', s.unmarked, color.warnInk],
    ['غياب الجميع', s.absent, color.dangerInk], ['ملغاة', s.cancelled, color.dangerInk], ['قادمة / جارية', s.upcoming + s.in_progress, color.body],
    ['حضور الطلاب', s.students_present, color.primary], ['غياب الطلاب', s.students_absent, color.dangerInk], ['ساعات منعقدة', Math.round((s.held_minutes / 60) * 10) / 10, color.ink],
  ] : [];
  const days: [string, A.WeekSession[]][] = [];
  for (const x of d?.results ?? []) { const k = dayKey(x.starts_at); const last = days.at(-1); if (last && last[0] === k) last[1].push(x); else days.push([k, [x]]); }
  return (
    <section aria-label="جلسات الأسبوع" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => d && setStart(d.prev)} disabled={!d} aria-label="الأسبوع السابق" style={smallBtn()}><Icon name="chevR" size={16} /> السابق</button>
        <h2 data-testid="week-title" style={{ margin: 0, fontSize: 18, fontWeight: 800, flex: '1 1 200px', textAlign: 'center' }}>
          {d ? `الأسبوع من السبت ${dateL(d.week_start)} إلى الجمعة ${dateL(d.week_end)}` : 'جلسات الأسبوع'}{d?.is_current ? ' · هذا الأسبوع' : ''}
        </h2>
        <button onClick={() => d && setStart(d.next)} disabled={!d} aria-label="الأسبوع التالي" style={smallBtn()}>التالي <Icon name="chevL" size={16} /></button>
        {d && !d.is_current && <button onClick={() => setStart('')} style={smallBtn('primary')}>هذا الأسبوع</button>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="wk-t" style={{ fontSize: 14, fontWeight: 700 }}>المعلم</label>
        <select id="wk-t" value={teacher} onChange={(e) => setTeacher(e.target.value)} style={{ ...inputStyle(null), width: 'auto', minWidth: 200 }}>
          <option value="">كل المعلمين</option>{tOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label htmlFor="wk-d" style={{ fontSize: 14, fontWeight: 700 }}>أسبوع يوم</label>
        <input id="wk-d" type="date" dir="ltr" value={start} onChange={(e) => setStart(e.target.value)} style={{ ...inputStyle(null, true), width: 'auto' }} />
        {d && d.results.length > 0 && <button onClick={() => exportCsv(d)} style={smallBtn()}><Icon name="download" size={16} /> تصدير (Excel)</button>}
      </div>
      <div role="group" aria-label="النتيجة" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map(([k, l]) => <button key={k} aria-pressed={result === k} onClick={() => setResult(k)} style={chip(result === k)}>{l}</button>)}
      </div>
      {err && <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err}</p>}
      {s && (
        <div data-testid="week-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 8 }}>
          {tiles.map(([l, v, c]) => (
            <div key={l} style={{ ...card, padding: '10px 12px' }}>
              <div style={{ fontFamily: font.latin, fontSize: 22, fontWeight: 800, color: c }}>{v}</div>
              <div style={{ fontSize: 13, color: color.muted }}>{l}</div>
            </div>
          ))}
        </div>
      )}
      {d && d.teachers.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <caption style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 800 }}>حسب المعلم</caption>
            <thead><tr>{['المعلم', 'الجلسات', 'انعقدت', 'الساعات', 'حضور الطلاب', 'غياب', 'بلا تسجيل حضور', 'ملغاة'].map((h) =>
              <th key={h} scope="col" style={{ textAlign: 'right', padding: '8px 12px', borderTop: `1px solid ${color.divider}`, color: color.muted, fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
            <tbody>{d.teachers.map((t) => (
              <tr key={t.id}>{[t.name, t.sessions, t.held, Math.round((t.minutes / 60) * 10) / 10, t.present, t.absent, t.unmarked, t.cancelled].map((v, i) =>
                <td key={i} style={{ padding: '8px 12px', borderTop: `1px solid ${color.divider}`, whiteSpace: 'nowrap', fontFamily: i ? font.latin : undefined, fontWeight: i ? 700 : 500, color: i === 6 && v ? color.warnInk : undefined }}>{v}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {loading && !d && <p role="status" style={{ margin: 0, color: color.muted }}>جارٍ التحميل…</p>}
      {d && d.results.length === 0 && <p style={{ margin: 0, padding: 20, textAlign: 'center', color: color.muted }}>لا توجد جلسات {result ? 'بهذه النتيجة ' : ''}في هذا الأسبوع.</p>}
      {days.map(([k, list]) => (
        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ margin: '6px 0 0', fontSize: 15, fontWeight: 800 }}>{dayTitle(list[0].starts_at)} <span style={{ color: color.muted, fontWeight: 500 }}>({list.length})</span></h3>
          {list.map((x) => (
            <article key={x.id} data-testid="week-session" style={{ ...card, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button onClick={() => setOpen(open === x.id ? null : x.id)} aria-expanded={open === x.id}
                style={{ border: 'none', background: 'transparent', padding: 0, display: 'flex', gap: 10, alignItems: 'center', textAlign: 'right', cursor: 'pointer', color: color.ink, minHeight: 44, flexWrap: 'wrap' }}>
                <span style={{ minWidth: 72, fontWeight: 800 }}>{fmtTime(x.starts_at, TZ)}</span>
                <span style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 700 }}>{x.teacher.name}{x.title ? ` · ${x.title}` : ''}</span>
                  <span style={{ display: 'block', fontSize: 13, color: color.muted }}>{x.kind_label}{x.weekly ? ' · أسبوعية' : ''}{x.circle ? ` · ${x.circle}` : ''}{x.topic ? ` · ${x.topic}` : ''} · {x.minutes} دقيقة · {x.students.length} {x.students.length === 1 ? 'طالب' : 'طلاب'}</span>
                </span>
                {pill(x.result, x.result_label)}
              </button>
              {open === x.id && (x.students.length ? (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {x.students.map((st) => <li key={st.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderTop: `1px solid ${color.divider}`, paddingTop: 4, fontSize: 14 }}>
                    <span>{st.name}</span><span style={{ color: st.attendance === 'absent' ? color.dangerInk : st.attendance ? color.primary : color.warnInk, fontWeight: 700 }}>{ATT[st.attendance] ?? st.attendance}</span></li>)}
                </ul>
              ) : <span style={{ fontSize: 13, color: color.muted }}>لا يوجد طلاب في هذه الجلسة.</span>)}
            </article>
          ))}
        </div>
      ))}
    </section>
  );
}
