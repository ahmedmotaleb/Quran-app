/**
 * Live-mode lessons, quizzes and progress (real records from the API).
 * Quiz grading happens on the server; recitation answers are graded by the teacher.
 */
import { CorrectionsSummaryCard } from '@/screens/common/Corrections';
import { useEffect, useRef, useState } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackHeader, Chips, Ltr, ProgressBar, RecDot, Segmented, card, iconTile, listBtn, muted, outlineBtn, primaryBtn } from '@/components/ui';
import { fmt, rangeL, surahName, tzOf } from '@/lib/format';
import { dateKey, fmtDay } from '@/lib/time';
import { back, go, openSheet, setState, useApp } from '@/store/store';
import { answerQuiz, completeLesson, openLesson, openResult, startQuiz, submitQuiz } from '@/store/live';
import * as media from '@/services/media';
import { AttendancePill, useEvals } from './Progress';
import { ProgressCards } from '@/components/ProgressCards';
import { myProgress, type ApiProgress } from '@/api/endpoints';

const TOPICS = [['all', 'الكل'], ['tajweed', 'التجويد'], ['hifz', 'الحفظ والمراجعة'], ['adab', 'آداب التلاوة'], ['ulum', 'علوم القرآن']] as const;
const KIND_ICON = { video: 'video', audio: 'headphones', text: 'book', pdf: 'file' } as const;
const KIND_L = { video: 'فيديو', audio: 'صوتي', text: 'نص', pdf: 'ملف' } as const;

/* ---------------- Lessons ---------------- */
export function LessonsTabLive() {
  const s = useApp(); const lt = s.lessonTopic;
  const list = (s.lessons ?? []).filter((l) => lt === 'all' || l.topic === lt);
  return (
    <>
      <Chips scroll options={TOPICS} value={lt} onChange={(k) => setState({ lessonTopic: k })} wrapStyle={{ paddingBottom: 0 }} />
      {s.lessons === null && <p role="status" style={muted(14)}>جارٍ التحميل…</p>}
      {s.lessons && list.length === 0 && <p style={muted(14, { textAlign: 'center', padding: 20 })}>لا توجد دروس منشورة في هذا القسم بعد.</p>}
      {list.map((l) => (
        <button key={l.id} onClick={() => { openLesson(l.id); go('lesson', { id: String(l.id) }); }} style={listBtn}>
          <span style={iconTile(48, color.sand)}><Icon name={KIND_ICON[l.kind]} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{l.title}</span>
            <span style={{ display: 'block', fontSize: 13, color: color.muted, marginTop: 3 }}>{l.topic_label} · {l.level} · {KIND_L[l.kind]}{l.duration_minutes ? ` · ${l.duration_minutes} دقيقة` : ''}</span>
          </span>
          {l.completed && <span style={{ color: color.primary, display: 'flex', gap: 2, alignItems: 'center', fontSize: 12, fontWeight: 700 }}><Icon name="check" size={18} /> مكتمل</span>}
        </button>
      ))}
    </>
  );
}

export function LessonPageLive() {
  const l = useApp((s) => s.lessonCur);
  if (!l) return <div><BackHeader title="الدرس" /><p role="status" style={muted(14, { padding: 16 })}>جارٍ التحميل…</p></div>;
  const url = l.media?.url;
  return (
    <div>
      <BackHeader title="الدرس" />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 13, color: color.muted, fontWeight: 700 }}>{l.topic_label} · {l.level}{l.duration_minutes ? ` · ${l.duration_minutes} دقيقة` : ''}</p>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{l.title}</h2>
          <p style={muted(13)}>من دورة: {l.course_title}</p>
        </div>
        {url && l.kind === 'video' && <video controls preload="metadata" src={url} style={{ width: '100%', borderRadius: 18, background: '#000' }} />}
        {url && l.kind === 'audio' && <audio controls preload="metadata" src={url} style={{ width: '100%' }} />}
        {url && l.kind === 'pdf' && <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...outlineBtn(52, 15), textDecoration: 'none' }}><Icon name="file" /> افتح ملف الدرس</a>}
        {l.external_url && (
          <a href={l.external_url} target="_blank" rel="noopener noreferrer" style={{ ...outlineBtn(52, 15), textDecoration: 'none' }}><Icon name="video" /> شاهد الدرس على المنصة الخارجية</a>
        )}
        {l.body && <div style={{ ...card, padding: 16, fontSize: 16, lineHeight: 2, whiteSpace: 'pre-wrap' }}>{l.body}</div>}
        <button onClick={() => completeLesson(l.id)} disabled={l.completed} style={primaryBtn(52, 16, { opacity: l.completed ? 0.85 : 1 })}>
          <Icon name="check" /> {l.completed ? 'أكملت هذا الدرس' : 'علّم الدرس كمكتمل'}
        </button>
        {l.next && (
          <button onClick={() => { openLesson(l.next!.id); setState({ params: { id: String(l.next!.id) } }); }} style={{ minHeight: 56, padding: '8px 14px', borderRadius: 14, border: `1px dashed ${color.borderStrong}`, background: 'transparent', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
            <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 12, color: color.muted }}>التالي في الدورة</span><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{l.next.title}</span></span>
            <span style={{ color: color.primary }}><Icon name="chevL" /></span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- Quizzes ---------------- */
export function QuizzesTabLive() {
  const tests = useApp((s) => s.tests);
  if (tests === null) return <p role="status" style={muted(14)}>جارٍ التحميل…</p>;
  if (!tests.length) return <p style={muted(14, { textAlign: 'center', padding: 20 })}>لا توجد اختبارات مفتوحة الآن.</p>;
  return (
    <>
      {tests.map((t) => {
        const last = t.attempts[t.attempts.length - 1];
        const left = t.max_attempts - t.attempts.length;
        const label = !last ? 'متاح' : last.status === 'in_progress' ? 'محاولة جارية' : last.status === 'submitted' ? 'بانتظار تقييم المعلم' : `مكتمل · ${last.score} من ${last.max}`;
        const tone = !last || last.status === 'in_progress' ? [color.sage, color.primary] : last.status === 'submitted' ? [color.warnBg, color.warnInk] : [color.primary, color.ivory];
        const go1 = async () => {
          if (!last || last.status === 'in_progress') { if (await startQuiz(t.id)) go('quiz'); }
          else if (await openResult(t.id, last.id)) go('quiz');
        };
        return (
          <button key={t.id} onClick={go1} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
            <span style={{ fontSize: 16, fontWeight: 700 }}>{t.title}</span>
            <span style={{ fontSize: 13, color: color.muted }}>{t.question_count} أسئلة{t.duration_minutes ? ` · ${t.duration_minutes} دقائق` : ''}{t.has_recitation ? ' · يتضمن سؤال تلاوة' : ''}</span>
            <span style={{ alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 999, background: tone[0], color: tone[1], fontSize: 12, fontWeight: 700 }}>{label}</span>
            {last && last.status !== 'in_progress' && left > 0 && <span style={muted(12)}>يمكنك إعادة المحاولة ({left} متبقية) من صفحة النتيجة.</span>}
          </button>
        );
      })}
    </>
  );
}

function useRecorder() {
  const [st, setSt] = useState<{ on: boolean; secs: number }>({ on: false, secs: 0 });
  const t0 = useRef(0);
  useEffect(() => {
    if (!st.on) return;
    const i = setInterval(() => setSt((x) => ({ ...x, secs: (Date.now() - t0.current) / 1000 })), 250);
    return () => clearInterval(i);
  }, [st.on]);
  return {
    ...st,
    start: async (onDone: (b: Blob, secs: number) => void) => {
      try {
        await media.startRecorder(() => { const b = media.recording.blob; const secs = (Date.now() - t0.current) / 1000; setSt({ on: false, secs }); if (b) onDone(b, secs); });
        t0.current = Date.now(); setSt({ on: true, secs: 0 });
      } catch { openSheet({ kind: 'info', title: 'لا يمكن الوصول إلى الميكروفون', body: 'اسمح للتطبيق باستخدام الميكروفون من إعدادات الجهاز ثم حاول مرة أخرى.' }); }
    },
    stop: () => media.stopRecorder(),
  };
}

export function QuizPageLive() {
  const s = useApp(); const Q = s.lq;
  const [idx, setIdx] = useState(0);
  const [recs, setRecs] = useState<Record<number, { blob: Blob; secs: number }>>({});
  const rec = useRecorder();
  if (!Q) return <BackHeader title="الاختبار" />;
  const title = Q.test.title;
  if (Q.result) return <QuizResult />;
  const qs = Q.questions; const q = qs[idx];
  const answered = (x: typeof q) => (x.kind === 'recitation' ? !!recs[x.id] : Q.answers[x.id] !== undefined && Q.answers[x.id] !== '');
  const isLast = idx === qs.length - 1;
  const submit = () => {
    const un = qs.filter((x) => !answered(x)).length;
    openSheet({
      kind: 'confirm', title: 'تسليم الاختبار؟', body: un ? `لم تُجب عن ${un} من الأسئلة. هل تريد التسليم على أي حال؟` : 'لن تتمكن من تعديل إجاباتك بعد التسليم.', ok: 'سلّم الاختبار',
      onOk: () => { setState({ sheet: null }); submitQuiz(recs); },
    });
  };
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <BackHeader title={title} />
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        <div style={{ display: 'flex', gap: 6 }} role="navigation" aria-label="الأسئلة">
          {qs.map((x, i) => {
            const cur = i === idx;
            return <button key={x.id} onClick={() => setIdx(i)} aria-label={`السؤال ${i + 1}`} aria-current={cur ? 'step' : undefined}
              style={{ flex: 1, minHeight: 44, borderRadius: 10, border: `1.5px solid ${color.borderStrong}`, background: cur ? color.primary : answered(x) ? color.sage : color.card, color: cur ? color.ivory : color.primary, fontFamily: font.latin, fontWeight: 700, cursor: 'pointer' }}>{i + 1}</button>;
          })}
        </div>
        <p style={{ margin: 0, fontSize: 13, color: color.muted, fontWeight: 700 }}>السؤال {idx + 1} من {qs.length}{Q.test.duration_minutes ? ` · المدة ${Q.test.duration_minutes} دقائق` : ''}</p>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, lineHeight: 1.6 }}>{q.prompt}</h2>
        {(q.kind === 'mcq' || q.kind === 'true_false') && (
          <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {q.options.map((o, i) => {
              const on = Q.answers[q.id] === i;
              return (
                <button key={i} role="radio" aria-checked={on} onClick={() => answerQuiz(q.id, i)}
                  style={{ minHeight: 56, padding: '0 16px', borderRadius: 14, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.sageTint : color.card, display: 'flex', alignItems: 'center', gap: 12, fontSize: 16, fontWeight: 700, color: color.ink, cursor: 'pointer', textAlign: 'right' }}>
                  <span style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${color.primary}`, display: 'grid', placeItems: 'center', flexShrink: 0 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: on ? color.primary : 'transparent' }} /></span>{o}
                </button>
              );
            })}
          </div>
        )}
        {q.kind === 'short' && (
          <textarea aria-label="إجابتك" rows={3} value={String(Q.answers[q.id] ?? '')} onChange={(e) => answerQuiz(q.id, e.target.value)}
            style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 16 }} />
        )}
        {q.kind === 'recitation' && (
          <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center' }}>
            {rec.on ? (
              <>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 700, display: 'flex', gap: 8, alignItems: 'center' }}><RecDot /> جارٍ التسجيل <Ltr>{fmt(rec.secs)}</Ltr></p>
                <button onClick={rec.stop} style={primaryBtn(52, 16, { padding: '0 22px' })}><Icon name="stop" /> إنهاء التسجيل</button>
              </>
            ) : (
              <>
                {recs[q.id] && <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: color.primary, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="check" /> سُجّلت إجابتك (<Ltr>{fmt(recs[q.id].secs)}</Ltr>)</p>}
                <button onClick={() => rec.start((blob, secs) => (secs >= 1 ? setRecs((r) => ({ ...r, [q.id]: { blob, secs } })) : undefined))} style={primaryBtn(52, 16, { padding: '0 22px' })}>
                  <Icon name="mic" /> {recs[q.id] ? 'أعد التسجيل' : 'سجّل إجابتك'}
                </button>
              </>
            )}
            <p style={{ margin: 0, fontSize: 13, color: color.muted }}>يقيّم المعلم هذا السؤال بعد التسليم. التسجيل يراه معلمك فقط.</p>
          </div>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', gap: 10 }}>
          {idx > 0 && <button onClick={() => setIdx(idx - 1)} style={outlineBtn(54, 16, { padding: '0 20px' })}>السابق</button>}
          {!isLast && <button onClick={() => setIdx(idx + 1)} style={primaryBtn(54, 17, { flex: 1 })}>التالي</button>}
          {isLast && <button onClick={submit} disabled={Q.busy || rec.on} style={primaryBtn(54, 17, { flex: 1 })}>{Q.busy ? 'جارٍ التسليم…' : 'تسليم الاختبار'}</button>}
        </div>
      </div>
    </div>
  );
}

function QuizResult() {
  const Q = useApp((s) => s.lq)!; const r = Q.result!;
  const auto = r.answers.filter((x) => x.kind === 'mcq' || x.kind === 'true_false');
  const manual = r.answers.filter((x) => x.kind === 'recitation' || x.kind === 'short');
  const left = Q.test.max_attempts - Q.test.attempts.length - (Q.test.attempts.some((a) => a.id === r.id) ? 0 : 1);
  return (
    <div>
      <BackHeader title={r.test_title} />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div role="status" style={{ background: color.primary, color: color.ivory, borderRadius: 20, padding: 20, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 14, color: color.sage }}>{r.status === 'graded' ? 'النتيجة النهائية' : 'أسئلة الاختيار'}</p>
          <p style={{ margin: 0, fontSize: 34, fontWeight: 800 }}>{r.status === 'graded' ? `${r.score} من ${r.max}` : `${r.objective_score ?? 0} من ${r.objective_max ?? 0}`}</p>
          {r.status === 'submitted' && <p style={{ margin: 0, fontSize: 14, color: color.sage, display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}><Icon name="clock" size={18} /> سؤال التلاوة بانتظار تقييم المعلم</p>}
          <p style={{ margin: 0, fontSize: 12, color: color.liveSub }}>صحّح الخادم الإجابات؛ لا يُصحَّح شيء على الجهاز.</p>
        </div>
        {auto.map((x, i) => {
          const ok = !!x.is_correct; const c = ok ? color.primary : color.dangerInk;
          return (
            <div key={x.answer} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', gap: 10 }}>
              <span style={{ color: c, flexShrink: 0, marginTop: 2 }}><Icon name={ok ? 'check' : 'x'} size={18} /></span>
              <div>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{i + 1}. {x.prompt}</p>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: c, fontWeight: 700 }}>{x.response === null || x.response === undefined ? 'لم تُجب' : ok ? 'إجابة صحيحة' : 'إجابة غير صحيحة'}</p>
                {typeof x.correct === 'number' && <p style={{ margin: '2px 0 0', fontSize: 13, color: color.muted }}>الإجابة الصحيحة: {x.options[x.correct]}</p>}
              </div>
            </div>
          );
        })}
        {manual.map((x) => (
          <div key={x.answer} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{x.prompt}</p>
            <p style={muted(13)}>{x.points_awarded === null ? 'بانتظار تقييم المعلم' : `الدرجة: ${x.points_awarded} من ${x.points}${x.grade_reason ? ` · ${x.grade_reason}` : ''}`}</p>
          </div>
        ))}
        {left > 0 && r.status !== 'in_progress' && (
          <button onClick={() => startQuiz(Q.test.id)} style={outlineBtn(52, 15)}>إعادة المحاولة ({left} متبقية)</button>
        )}
        <button onClick={back} style={primaryBtn()}>العودة إلى الاختبارات</button>
      </div>
    </div>
  );
}

/* ---------------- Progress ---------------- */
const RANGE_DAYS = { week: 7, month: 28, q: 90 } as const;

export function ProgressLive() {
  const s = useApp(); const pr = s.progRange; const tz = tzOf(s.tz).iana; const evals = useEvals();
  const [srv, setSrv] = useState<ApiProgress | null>(null); const [srvErr, setSrvErr] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    const from = dateKey(new Date(Date.now() - (RANGE_DAYS[pr] - 1) * 86_400_000).toISOString(), tz);
    myProgress(from).then((x) => { if (on) { setSrv(x); setSrvErr(null); } }).catch((e) => { if (on) setSrvErr((e as Error).message); });
    return () => { on = false; };
  }, [pr, tz, s.subs.length, s.tasks.length]);
  const since = Date.now() - RANGE_DAYS[pr] * 86_400_000;
  const inRange = (iso: string) => new Date(iso).getTime() >= since;
  // Activity = minutes of recitation actually recorded and submitted.
  const buckets: { l: string; n: number }[] = [];
  const subs = s.subs.filter((x) => inRange(x.created_at));
  if (pr === 'week') {
    for (let i = 6; i >= 0; i--) {
      const iso = new Date(Date.now() - i * 86_400_000).toISOString();
      const k = dateKey(iso, tz);
      buckets.push({ l: new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: tz, weekday: 'short' }).format(new Date(iso)), n: Math.round(subs.filter((x) => dateKey(x.created_at, tz) === k).reduce((a, x) => a + x.duration_seconds, 0) / 6) / 10 });
    }
  } else {
    const n = pr === 'month' ? 4 : 3; const span = pr === 'month' ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const end = Date.now() - i * span * 86_400_000; const start = end - span * 86_400_000;
      const sec = subs.filter((x) => { const t = new Date(x.created_at).getTime(); return t > start && t <= end; }).reduce((a, x) => a + x.duration_seconds, 0);
      buckets.push({ l: pr === 'month' ? `الأسبوع ${n - i}` : `الشهر ${n - i}`, n: Math.round(sec / 6) / 10 });
    }
  }
  const mx = Math.max(1, ...buckets.map((b) => b.n));
  const approved = s.tasks.filter((t) => t.type === 'hifz' && t.status === 'reviewed');
  const pending = s.tasks.filter((t) => t.status === 'submitted');
  const att = s.sessions.filter((x) => x.attendance && x.startsAt && inRange(x.startsAt)).sort((a, b) => b.startsAt!.localeCompare(a.startsAt!));
  const attended = att.filter((x) => x.attendance === 'present' || x.attendance === 'late').length;
  const ATT: Record<string, string> = { present: 'حضر', late: 'حضر متأخرًا', absent: 'غاب', excused: 'غاب بعذر' };

  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>تقدمي</h1>
      <Segmented role="group" label="الفترة الزمنية" options={[['week', 'أسبوع'], ['month', 'شهر'], ['q', '3 أشهر']] as const} value={pr} onChange={(k) => setState({ progRange: k })} />
      <CorrectionsSummaryCard who="student" />
      {srv ? <>
        {srv.streak_days > 1 && <p style={{ margin: 0, fontSize: 14, color: color.primary, fontWeight: 700 }}>{srv.streak_days} أيام متتالية من التدرّب</p>}
        <ProgressCards p={srv} />
      </> : srvErr ? <p role="alert" style={muted(14)}>تعذّر تحميل التقدّم: {srvErr}</p> : <p role="status" style={muted(14)}>جارٍ تحميل التقدّم…</p>}
      <section style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>النشاط</h2>
        <p style={muted(12)}>دقائق التلاوة التي سجّلتها وسلّمتها</p>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 150 }} role="img" aria-label={`رسم بياني للنشاط: ${buckets.map((b) => `${b.l} ${b.n}`).join('، ')}`}>
          {buckets.map((b) => (
            <div key={b.l} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, justifyContent: 'flex-end', height: '100%' }}>
              <span style={{ fontFamily: font.latin, fontSize: 11, color: color.body }}>{b.n >= 10 ? Math.round(b.n) : b.n}</span>
              <span style={{ width: '100%', maxWidth: 36, borderRadius: '6px 6px 2px 2px', height: Math.max(4, Math.round((b.n / mx) * 120)), background: b.n ? color.primary : color.track }} />
              <span style={{ fontSize: 11, color: color.muted, whiteSpace: 'nowrap' }}>{b.l}</span>
            </div>
          ))}
        </div>
      </section>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', gap: 10 }}>
        <div style={{ background: color.sageTint, borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: color.primary, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="award" size={18} /> حفظ اعتمده المعلم</h2>
          {approved.length === 0 && <p style={muted(14)}>لم يُعتمد حفظ بعد. سلّم تلاوتك ليقيّمها معلمك.</p>}
          {approved.map((t) => (
            <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: color.primary, marginTop: 2 }}><Icon name="check" size={18} /></span>
              <div><p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>سورة {surahName(t.s)}</p><p style={{ margin: 0, fontSize: 12, color: color.body }}>الآيات {t.from}–{t.to} · اعتمدها {t.teacherName ?? 'المعلم'}</p></div>
            </div>
          ))}
        </div>
        <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="upload" size={18} /> مهام منجزة بانتظار الاعتماد</h2>
          {pending.length ? pending.map((t) => (
            <button key={t.id} onClick={() => go('task', { id: t.id })} style={{ display: 'flex', gap: 8, alignItems: 'center', border: 'none', background: 'transparent', padding: 0, textAlign: 'right', cursor: 'pointer', minHeight: 44, color: color.ink }}>
              <div style={{ flex: 1 }}><p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{t.title}</p><p style={muted(12)}>{rangeL(t)}</p></div>
              <span style={{ color: color.primary }}><Icon name="chevL" size={18} /></span>
            </button>
          )) : <p style={muted(14)}>لا توجد تسليمات بانتظار التقييم.</p>}
        </div>
      </section>
      <section style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الحضور</h2>
          <span style={{ fontSize: 15, fontWeight: 800 }}>{att.length ? `${attended} من ${att.length} جلسة` : '—'}</span>
        </div>
        {att.length ? <ProgressBar pct={(attended / att.length) * 100} /> : <p style={muted(13)}>لا جلسات بحضور مسجّل في هذه الفترة.</p>}
        {att.slice(0, 6).map((x) => (
          <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 36, borderTop: `1px solid ${color.divider}`, paddingTop: 6 }}>
            <span style={{ fontSize: 14 }}>{fmtDay(x.startsAt!, tz)}</span><AttendancePill a={ATT[x.attendance!] ?? x.attendance!} />
          </div>
        ))}
      </section>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>آخر التقييمات</h2>
        {evals.length === 0 && <p style={muted(14)}>لا تقييمات بعد.</p>}
        {evals.map((e) => (
          <button key={e.id} onClick={() => go('feedback', { id: e.id })} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
            <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{e.t}</span><span style={{ display: 'block', fontSize: 12, color: color.muted, marginTop: 2 }}>{e.d} · {e.sc}</span></span>
            <span style={{ color: color.primary }}><Icon name="chevL" /></span>
          </button>
        ))}
      </section>
      <p style={{ margin: 0, fontSize: 14, color: color.body, textAlign: 'center', padding: '8px 16px', lineHeight: 1.7 }}>تقدّمك يخصّك وحدك؛ لا نقارنك بغيرك. خطوات صغيرة منتظمة تصنع حفظًا ثابتًا.</p>
    </div>
  );
}
