/** Progress cards shared by the student, teacher and parent views (pack prompts 12–14). Values come only from
 * the server Progress API; every number states what it counts. Charts carry numbers, not colour alone. */
import type { ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { ProgressBar, card, muted } from '@/components/ui';
import type { ApiProgress } from '@/api/endpoints';

const Box = ({ title, value, sub, children }: { title: string; value: ReactNode; sub?: string; children?: ReactNode }) => (
  <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={{ fontSize: 13, color: color.muted, fontWeight: 700 }}>{title}</span>
    <span style={{ fontSize: 20, fontWeight: 800 }}>{value}</span>
    {sub && <span style={{ fontSize: 12, color: color.muted, lineHeight: 1.6 }}>{sub}</span>}
    {children}
  </div>
);
const n = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '—' : Number.isInteger(x) ? String(x) : x.toFixed(d));

export function ProgressCards({ p, who = 'student' }: { p: ApiProgress; who?: 'student' | 'teacher' | 'parent' }) {
  const m = p.memorization; const r = p.review; const a = p.attendance; const pr = p.practice; const l = p.learning;
  const empty = !m.assigned_ayahs && !pr.submissions && !a.sessions && !l.lessons_completed && !l.quiz_attempts;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {empty && <p style={muted(14, { lineHeight: 1.7 })}>{who === 'student' ? 'يبدأ تقدّمك بعد أول مهمة يكلّفك بها معلمك وتسجيل تلاوتك لها، أو بعد حضور أول جلسة.' : 'لا توجد سجلات تعلّم في هذه الفترة بعد.'}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,150px),1fr))', gap: 10 }}>
        <Box title="الحفظ" value={m.assigned_ayahs ? `${m.accepted_ayahs} من ${m.assigned_ayahs} آية` : '—'} sub="آيات اعتمدها المعلم (كل الفترات)">
          {m.pct !== null && <ProgressBar pct={m.pct} h={6} />}
        </Box>
        <Box title="المراجعة" value={`${r.due_today} اليوم`} sub={`${r.overdue} متأخرة · ${r.completed} مكتملة في الفترة`} />
        <Box title="التجويد · الطلاقة" value={`${n(p.scores.avg.tajweed)} · ${n(p.scores.avg.fluency)}`} sub={p.scores.points.length ? `متوسط ${p.scores.points.length} تقييم من 5` : 'لا تقييمات في الفترة'} />
        <Box title="الحضور" value={a.rate === null ? '—' : `${Math.round(a.rate * 100)}%`} sub={`${a.present + a.late} حضور · ${a.absent} غياب${a.excused ? ` · ${a.excused} بعذر` : ''}`} />
        <Box title="التدرّب" value={`${n(pr.minutes)} دقيقة`} sub={`${pr.submissions} تسجيل · ${pr.reviewed} قيّمه المعلم`} />
        <Box title="الدروس والاختبارات" value={`${l.lessons_completed} درس`} sub={l.quiz_attempts ? `${l.quiz_attempts} محاولة · متوسط ${n(l.quiz_avg_pct, 0)}%` : 'لا اختبارات في الفترة'} />
      </div>
      {p.scores.points.length > 0 && <ScoreTrend p={p} />}
      {p.latest_feedback && (
        <section style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>آخر ملاحظة من المعلم</h3>
          <p style={muted(12)}>{p.latest_feedback.assignment} · {p.latest_feedback.teacher} · {p.latest_feedback.decision === 'accept' ? 'اعتُمد' : 'يحتاج إعادة'}</p>
          {p.latest_feedback.needs_review && <p style={{ margin: 0, fontSize: 14 }}>يحتاج مراجعة: {p.latest_feedback.needs_review}</p>}
          {p.latest_feedback.next_step && <p style={{ margin: 0, fontSize: 14 }}>الخطوة التالية: {p.latest_feedback.next_step}</p>}
          {p.latest_feedback.general && <p style={{ margin: 0, fontSize: 14, color: color.body }}>{p.latest_feedback.general}</p>}
        </section>
      )}
      <details style={{ fontSize: 13, color: color.body }}>
        <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>كيف تُحسب هذه الأرقام؟</summary>
        <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.8 }}>{Object.values(p.rules).map((t) => <li key={t}>{t}</li>)}</ul>
      </details>
    </div>
  );
}

/** Teacher scores over the range (latest 8), each bar labelled with its value. */
function ScoreTrend({ p }: { p: ApiProgress }) {
  const pts = p.scores.points.slice(-8);
  const rows: [keyof ApiProgress['scores']['points'][number], string][] = [['hifz', 'الحفظ'], ['tajweed', 'التجويد'], ['fluency', 'الطلاقة']];
  return (
    <section style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }} aria-label="تقييمات المعلم عبر الوقت">
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>تقييمات المعلم عبر الوقت</h3>
      {rows.map(([k, label]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 56, fontSize: 12, color: color.muted }}>{label}</span>
          <div role="img" aria-label={`${label}: ${pts.map((x) => x[k]).join('، ')}`} style={{ flex: 1, display: 'flex', gap: 4, alignItems: 'flex-end', height: 44 }}>
            {pts.map((x, i) => (
              <span key={i} title={`${x.date}: ${x[k]}`} style={{ flex: 1, maxWidth: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <span style={{ fontFamily: font.latin, fontSize: 10 }}>{x[k] as number}</span>
                <span style={{ width: '100%', height: ((x[k] as number) / 5) * 30, background: x.decision === 'repeat' ? color.gold : color.primary, borderRadius: 3 }} />
              </span>
            ))}
          </div>
        </div>
      ))}
      <p style={muted(11)}>الأعمدة الذهبية: تسليمات طلب فيها المعلم الإعادة.</p>
    </section>
  );
}
