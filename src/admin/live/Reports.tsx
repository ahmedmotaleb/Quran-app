/** «التقارير» (PROMPT 46): academy KPIs and teacher workload. Every number is aggregated on the server and shown with
 *  what it counts («2 من 5») and its definition; a ratio with no data reads «لا بيانات كافية», never 0%. */
import { useEffect, useState, type CSSProperties } from 'react';
import { color } from '@/theme/tokens';
import { inputStyle, labelStyle } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { card } from '../AdminTables';
import { can, toast } from '../adminStore';
import * as A from './api';
import { errMsg, smallBtn } from './ui';

const NO_DATA = 'لا بيانات كافية';
const pct = (r: A.Ratio) => (r.value === null ? NO_DATA : `${Math.round(r.value * 100)}٪`);
const ofN = (r: A.Ratio) => `${r.num} من ${r.den}`;
const hours = (h: number | null) => (h === null ? NO_DATA : h < 48 ? `${h} ساعة` : `${Math.round(h / 24)} يوم`);

type Tile = { key: string; label: string; value: string; sub?: string; warn?: boolean };
function tiles(k: A.Kpis): [string, Tile[]][] {
  const a = k.attendance;
  return [
    ['الحضور والانضباط', [
      { key: 'attendance_rate', label: 'نسبة الحضور', value: pct(a.attendance_rate), sub: `${ofN(a.attendance_rate)} · لم يُسجَّل ${a.unmarked}` },
      { key: 'unexcused_absence_rate', label: 'غياب بدون عذر', value: pct(a.unexcused_absence_rate), sub: ofN(a.unexcused_absence_rate) },
      { key: 'suspended_by_absence', label: 'إيقاف بسبب الغياب', value: String(k.suspended_by_absence), warn: k.suspended_by_absence > 0 },
      { key: 'pending_excuses', label: 'اعتذارات معلقة', value: String(k.pending_excuses), warn: k.pending_excuses > 0 },
    ]],
    ['الجلسات والحلقات', [
      { key: 'booking_fill_rate', label: 'امتلاء الجلسات', value: pct(k.booking_fill_rate), sub: `${ofN(k.booking_fill_rate)} مقعد` },
      { key: 'circle_capacity_utilization', label: 'إشغال الحلقات', value: pct(k.circle_capacity_utilization), sub: `${ofN(k.circle_capacity_utilization)} مقعد` },
    ]],
    ['التعلّم والمراجعة', [
      { key: 'assignment_completion', label: 'إنجاز المهام', value: pct(k.assignment_completion), sub: `${ofN(k.assignment_completion)} · مُسلَّمة تنتظر ${k.assignment_completion.submitted_waiting}` },
      { key: 'review_turnaround_hours', label: 'زمن التقييم (الوسيط)', value: hours(k.review_turnaround_hours.median), sub: `${k.review_turnaround_hours.reviews} تقييم` },
      { key: 'recording_review_backlog', label: 'تسجيلات بانتظار التقييم', value: String(k.recording_review_backlog.count),
        sub: k.recording_review_backlog.oldest_hours === null ? undefined : `أقدمها منذ ${hours(k.recording_review_backlog.oldest_hours)}`, warn: k.recording_review_backlog.count > 0 },
    ]],
    ['المستخدمون', [
      { key: 'active_students', label: 'طلاب نشطون', value: String(k.active_students) },
      { key: 'active_teachers', label: 'معلمون نشطون', value: String(k.active_teachers) },
      { key: 'new_registrations', label: 'تسجيلات جديدة', value: String(k.new_registrations) },
      { key: 'pending_teacher_approvals', label: 'معلمون بانتظار الاعتماد', value: String(k.pending_teacher_approvals), warn: k.pending_teacher_approvals > 0 },
    ]],
  ];
}

const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 210px), 1fr))', gap: 10 };
const th: CSSProperties = { padding: '8px 10px', textAlign: 'right', fontSize: 13, color: color.muted, fontWeight: 700, whiteSpace: 'nowrap', borderBottom: `1px solid ${color.divider}` };
const td: CSSProperties = { padding: '8px 10px', fontSize: 14, whiteSpace: 'nowrap', borderBottom: `1px solid ${color.divider}` };

export default function ReportsLive() {
  const [f, setF] = useState<A.KpiFilter>({});
  const [k, setK] = useState<Awaited<ReturnType<typeof A.getKpis>> | null>(null);
  const [w, setW] = useState<A.Workload[] | null>(null);
  const [teachers, setTeachers] = useState<{ id: number; name: string }[]>([]);
  const [circles, setCircles] = useState<{ id: number; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    setErr(null); setK(null); setW(null);
    Promise.all([A.getKpis(f), A.getWorkload(f)]).then(([kp, wl]) => {
      if (!on) return;
      setK(kp); setW(wl.results);
      if (!f.teacher && !f.circle) setTeachers(wl.results.map((r) => r.teacher));
    }).catch((e) => on && setErr(errMsg(e)));
    return () => { on = false; };
  }, [f]);
  useEffect(() => {
    if (can('circles.view')) A.listCircles({ page_size: 100, state: 'published' }).then((p) => setCircles(p.results.map((c) => ({ id: c.id, name: c.name })))).catch(() => {});
  }, []);

  const exportCsv = async () => {
    setBusy(true);
    try {
      const { blob, name } = await A.exportWorkload(f);
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('صُدّر جدول عبء العمل');
    } catch (x) { toast(errMsg(x)); } finally { setBusy(false); }
  };

  const nf = new Set(Object.values(k?.not_filtered ?? {}).flat());
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section aria-label="مرشحات التقارير" style={{ ...card, padding: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 140px' }}>من
          <input type="date" value={f.from ?? k?.range.from ?? ''} max={f.to ?? k?.range.to} onChange={(e) => setF({ ...f, from: e.target.value || undefined })} style={inputStyle()} />
        </label>
        <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 140px' }}>إلى
          <input type="date" value={f.to ?? k?.range.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value || undefined })} style={inputStyle()} />
        </label>
        <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 180px' }}>المعلم
          <select value={f.teacher ?? ''} onChange={(e) => setF({ ...f, teacher: e.target.value ? Number(e.target.value) : '' })} style={inputStyle()}>
            <option value="">كل المعلمين</option>
            {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {circles.length > 0 && <label style={{ ...labelStyle, display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 180px' }}>الحلقة
          <select value={f.circle ?? ''} onChange={(e) => setF({ ...f, circle: e.target.value ? Number(e.target.value) : '' })} style={inputStyle()}>
            <option value="">كل الحلقات</option>
            {circles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>}
        {(f.from || f.to || f.teacher || f.circle) && <button onClick={() => setF({})} style={smallBtn()}>آخر 30 يومًا</button>}
      </section>
      {k && <p style={{ margin: 0, fontSize: 13, color: color.muted }}>
        الفترة {k.range.from} – {k.range.to} بتوقيت {k.range.timezone === 'Africa/Cairo' ? 'القاهرة' : k.range.timezone}. أرقام فعلية فقط؛ كل نسبة معها ما تُحسب منه.
      </p>}
      {err && <p role="alert" style={{ color: color.danger, margin: 0 }}>{err}</p>}
      {!k && !err && <p role="status" style={{ color: color.muted, margin: 0 }}>جارٍ التحميل…</p>}

      {k && tiles(k.kpis).map(([group, ts]) => (
        <section key={group} aria-label={group} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{group}</h2>
          <div style={grid}>
            {ts.map((t) => (
              <article key={t.key} aria-label={t.label} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 4, borderInlineStart: t.warn ? `4px solid ${color.gold}` : undefined }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: color.body }}>{t.label}</span>
                <strong style={{ fontSize: t.value === NO_DATA ? 16 : 26, fontWeight: 800, color: t.value === NO_DATA ? color.muted : color.primary, fontVariantNumeric: 'tabular-nums' }}>{t.value}</strong>
                {t.sub && <span style={{ fontSize: 13, color: color.body }}>{t.sub}</span>}
                <span style={{ fontSize: 12, color: color.muted, lineHeight: 1.6 }}>{k.definitions[t.key]}{nf.has(t.key) ? ' (لا يتأثر بالمرشح المختار)' : ''}</span>
              </article>
            ))}
          </div>
        </section>
      ))}

      {w && <section aria-label="عبء عمل المعلمين" style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, flex: 1 }}>عبء عمل المعلمين</h2>
          {can('exports.create') && <button onClick={exportCsv} disabled={busy || !w.length} aria-busy={busy} style={{ ...smallBtn(), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="download" size={18} />تصدير CSV</button>}
        </div>
        {!w.length ? <p style={{ margin: 0, color: color.muted }}>لا يوجد معلمون نشطون ضمن هذا المرشح.</p> : (
          <div style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="جدول عبء العمل (مرّر أفقيًا)">
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>
                {['المعلم', 'طلاب مرتبطون', 'طلاب الحلقات', 'جلسات الأسبوع', 'مواعيد متاحة', 'الإشغال', 'بانتظار التقييم', 'متأخرة +48 س', 'اعتذارات معلقة', 'أخطاء مفتوحة', 'الحضور', 'الغياب'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {w.map((r) => (
                  <tr key={r.teacher.id}>
                    <th scope="row" style={{ ...td, fontWeight: 700 }}>{r.teacher.name}{!r.teacher.approved && <span style={{ color: color.muted, fontWeight: 400 }}> (غير معتمد)</span>}</th>
                    <td style={td}>{r.active_students}</td><td style={td}>{r.circle_students}</td>
                    <td style={td}>{r.upcoming_sessions}</td><td style={td}>{r.available_slots}</td>
                    <td style={td} title={ofN(r.utilization)}>{pct(r.utilization)}</td>
                    <td style={td}>{r.awaiting_review}</td>
                    <td style={{ ...td, color: r.overdue_feedback ? color.danger : undefined, fontWeight: r.overdue_feedback ? 800 : undefined }}>{r.overdue_feedback}</td>
                    <td style={td}>{r.pending_excuses}</td><td style={td}>{r.unresolved_mistakes}</td>
                    <td style={td} title={ofN(r.attendance_rate)}>{pct(r.attendance_rate)}</td>
                    <td style={td} title={ofN(r.no_show_rate)}>{pct(r.no_show_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ margin: 0, fontSize: 12, color: color.muted, lineHeight: 1.7 }}>
          الإشغال: {k?.definitions.utilization} · متأخرة: {k?.definitions.overdue_feedback} · جلسات الأسبوع: {k?.definitions.upcoming_sessions} · الغياب: {k?.definitions.no_show_rate}
        </p>
      </section>}
    </div>
  );
}
