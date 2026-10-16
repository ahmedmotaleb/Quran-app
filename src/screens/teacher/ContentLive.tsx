/**
 * Teacher content authoring on the real API (pack prompt 07, teacher side). The teacher writes drafts — lessons in
 * their own courses (or a new draft course) and quizzes — and the academy's admins review and publish them.
 * Published items are shown read-only here: what students study does not change under them.
 */
import { useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackHeader, FieldError, Segmented, card, inputStyle, labelStyle, muted, outlineBtn, primaryBtn } from '@/components/ui';
import { ApiError, api } from '@/api/client';
import { toast } from '@/store/store';

type State = 'draft' | 'published' | 'archived' | 'pending' | 'closed';
interface Lesson { id: number; title: string; kind: string; state: State }
interface Course { id: number; title: string; state: State; lesson_list: Lesson[] }
interface Quiz { id: number; title: string; state: State; questions: number }
interface Mine { courses: Course[]; tests: Quiz[]; rule: string }
type QKind = 'mcq' | 'true_false' | 'recitation';
interface Q { kind: QKind; prompt: string; options: string[]; key: number; tf: boolean; surah: string; from: string; to: string }

const STATE_L: Record<State, string> = { draft: 'مسودة · بانتظار النشر', pending: 'بانتظار المراجعة', published: 'منشور', archived: 'مؤرشف', closed: 'مغلق' };
const TOPICS = [['tajweed', 'التجويد'], ['hifz', 'الحفظ والمراجعة'], ['adab', 'آداب التلاوة'], ['ulum', 'علوم القرآن']] as const;
const LEVELS = ['مبتدئ', 'متوسط', 'متقدم', 'جميع المستويات'];
const newQ = (kind: QKind): Q => ({ kind, prompt: '', options: ['', ''], key: 0, tf: true, surah: '', from: '', to: '' });
const sel = { minHeight: 52, padding: '0 10px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 } as const;
const area = { ...inputStyle(), minHeight: 120, padding: 12, lineHeight: 1.7, resize: 'vertical' } as const;

function Pill({ s }: { s: State }) {
  const on = s === 'published';
  return <span style={{ fontSize: 12, padding: '3px 9px', borderRadius: 999, background: on ? color.sand : color.sunken, color: on ? color.primary : color.muted, whiteSpace: 'nowrap' }}>{STATE_L[s]}</span>;
}

export default function TeacherContentLive() {
  const [mine, setMine] = useState<Mine | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [kind, setKind] = useState<'lecture' | 'quiz'>('lecture');
  const load = () => api<Mine>('GET', 'teacher/content').then((m) => { setMine(m); setLoadErr(''); }).catch((e: ApiError) => setLoadErr(e.message));
  useEffect(() => { load(); }, []);
  return (
    <div>
      <BackHeader title="إنشاء محتوى" />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p role="note" style={{ ...muted(13), margin: 0 }}>{mine?.rule ?? 'يحفظ المعلم المحتوى كمسودة، وتنشره إدارة الحلقة بعد المراجعة.'}</p>
        <Segmented role="group" label="نوع المحتوى" h={48} options={[['lecture', 'درس'], ['quiz', 'اختبار']] as const} value={kind} onChange={setKind} />
        {kind === 'lecture' ? <LessonForm courses={mine?.courses ?? []} onSaved={load} /> : <QuizForm courses={mine?.courses ?? []} onSaved={load} />}
        <section aria-labelledby="mine-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 id="mine-h" style={{ margin: '8px 0 0', fontSize: 17, fontWeight: 700 }}>محتواي</h2>
          {loadErr && <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{loadErr}</p>}
          {mine && !mine.courses.length && !mine.tests.length && <p style={muted(14)}>لم تكتب محتوى بعد.</p>}
          {mine?.courses.map((c) => (
            <div key={c.id} style={{ ...card, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="layers" size={18} /><strong style={{ flex: 1 }}>{c.title}</strong><Pill s={c.state} /></div>
              {c.lesson_list.map((l) => (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingInlineStart: 26 }}>
                  <span style={{ flex: 1, fontSize: 14 }}>{l.title}</span><Pill s={l.state} />
                  {l.state === 'draft' && <DeleteBtn label={`حذف مسودة ${l.title}`} path={`teacher/lessons/${l.id}`} onDone={load} />}
                </div>
              ))}
              {!c.lesson_list.length && <p style={{ ...muted(13), margin: 0, paddingInlineStart: 26 }}>لا دروس بعد.</p>}
            </div>
          ))}
          {mine?.tests.map((t) => (
            <div key={t.id} style={{ ...card, borderRadius: 14, padding: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="target" size={18} /><span style={{ flex: 1 }}>{t.title} <span style={muted(12)}>· {t.questions} أسئلة</span></span><Pill s={t.state} />
              {t.state === 'draft' && <DeleteBtn label={`حذف مسودة ${t.title}`} path={`teacher/tests/${t.id}`} onDone={load} />}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function DeleteBtn({ label, path, onDone }: { label: string; path: string; onDone: () => void }) {
  return (
    <button aria-label={label} onClick={() => api('DELETE', path).then(() => { toast('حُذفت المسودة'); onDone(); }).catch((e: ApiError) => toast(e.message, 'alert'))}
      style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: color.dangerInk, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
      <Icon name="trash" size={18} />
    </button>
  );
}

function Field({ id, label, err, children }: { id: string; label: string; err?: string | null; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>{children}<FieldError msg={err} fs={12} />
    </div>
  );
}

function LessonForm({ courses, onSaved }: { courses: Course[]; onSaved: () => void }) {
  const open = courses.filter((c) => c.state !== 'archived');
  const [course, setCourse] = useState<string>('new');
  const [courseTitle, setCourseTitle] = useState('');
  const [topic, setTopic] = useState('tajweed');
  const [title, setTitle] = useState('');
  const [lk, setLk] = useState<'text' | 'video'>('text');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [mins, setMins] = useState('');
  const [err, setErr] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  // Once the teacher's courses load, pre-select the latest one — never overriding a choice they already made.
  useEffect(() => { if (!touched && course === 'new' && open.length && !courseTitle) { setCourse(String(open[0].id)); setErr((e) => ({ ...e, course: null })); } }, [open.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const e: Record<string, string> = {};
    if (course === 'new' && courseTitle.trim().length < 2) e.course = 'اكتب اسم الدورة الجديدة';
    if (title.trim().length < 2) e.title = 'أدخل عنوان الدرس';
    if (lk === 'text' && !body.trim()) e.body = 'اكتب نص الدرس';
    if (lk === 'video' && !url.trim()) e.external_url = 'أضف رابط الفيديو';
    setErr(e); if (Object.keys(e).length) return;
    setBusy(true);
    try {
      let cid = course;
      if (course === 'new') cid = String((await api<{ id: number }>('POST', 'teacher/courses', { title: courseTitle.trim(), topic })).id);
      await api('POST', `teacher/courses/${cid}/lessons`, { title: title.trim(), kind: lk, body: lk === 'text' ? body : '', external_url: lk === 'video' ? url.trim() : '', duration_minutes: mins ? Number(mins) : null });
      setTitle(''); setBody(''); setUrl(''); setMins(''); setCourseTitle(''); setCourse(cid);
      toast('حُفظ الدرس كمسودة بانتظار النشر'); onSaved();
    } catch (x) {
      const a = x as ApiError;
      setErr({ title: a.field?.('title'), body: a.field?.('body'), external_url: a.field?.('external_url'), duration: a.field?.('duration_minutes'), form: a.fields && Object.keys(a.fields).length ? null : a.message });
    } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field id="tl-course" label="الدورة" err={err.course}>
        <select id="tl-course" value={course} onChange={(e) => { setTouched(true); setCourse(e.target.value); setErr({ ...err, course: null }); }} style={sel}>
          {open.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          <option value="new">+ دورة جديدة (مسودة)</option>
        </select>
      </Field>
      {course === 'new' && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
          <Field id="tl-ctitle" label="اسم الدورة الجديدة"><input id="tl-ctitle" value={courseTitle} onChange={(e) => setCourseTitle(e.target.value)} style={inputStyle(err.course)} /></Field>
          <Field id="tl-topic" label="الموضوع"><select id="tl-topic" value={topic} onChange={(e) => setTopic(e.target.value)} style={sel}>{TOPICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
      )}
      <Field id="tl-title" label="عنوان الدرس" err={err.title}><input id="tl-title" value={title} aria-invalid={!!err.title} onChange={(e) => setTitle(e.target.value)} style={inputStyle(err.title)} /></Field>
      <Segmented role="group" label="شكل الدرس" h={44} options={[['text', 'نص'], ['video', 'رابط فيديو']] as const} value={lk} onChange={setLk} />
      {lk === 'text'
        ? <Field id="tl-body" label="نص الدرس" err={err.body}><textarea id="tl-body" value={body} onChange={(e) => setBody(e.target.value)} style={area} /></Field>
        : <Field id="tl-url" label="رابط YouTube أو Vimeo" err={err.external_url}><input id="tl-url" dir="ltr" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} style={inputStyle(err.external_url, true)} /></Field>}
      <Field id="tl-mins" label="المدة بالدقائق (اختياري)" err={err.duration}><input id="tl-mins" inputMode="numeric" dir="ltr" value={mins} onChange={(e) => setMins(e.target.value.replace(/\D/g, '').slice(0, 3))} style={inputStyle(err.duration, true)} /></Field>
      {err.form && <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err.form}</p>}
      <button onClick={save} disabled={busy} style={primaryBtn()}>{busy ? 'جارٍ الحفظ…' : 'حفظ الدرس كمسودة'}</button>
    </div>
  );
}

function QuizForm({ courses, onSaved }: { courses: Course[]; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('tajweed');
  const [level, setLevel] = useState(LEVELS[0]);
  const [course, setCourse] = useState('');
  const [mins, setMins] = useState('10');
  const [qs, setQs] = useState<Q[]>([]);
  const [err, setErr] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const setQ = (i: number, p: Partial<Q>) => setQs(qs.map((q, j) => (j === i ? { ...q, ...p } : q)));
  const payload = (q: Q) => q.kind === 'mcq' ? { kind: 'mcq', prompt: q.prompt, options: q.options.map((o) => o.trim()), answer_key: q.key }
    : q.kind === 'true_false' ? { kind: 'true_false', prompt: q.prompt, answer_key: q.tf }
      : { kind: 'recitation', prompt: q.prompt, points: 2, options: q.surah ? { surah: Number(q.surah), ayah_from: Number(q.from), ayah_to: Number(q.to) } : {} };
  const save = async () => {
    const e: Record<string, string> = {};
    if (title.trim().length < 2) e.title = 'أدخل عنوان الاختبار';
    if (!qs.length) e.qs = 'أضف سؤالًا واحدًا على الأقل';
    qs.forEach((q, i) => { if (q.prompt.trim().length < 3) e[`q${i}`] = 'اكتب نص السؤال'; else if (q.kind === 'mcq' && q.options.some((o) => !o.trim())) e[`q${i}`] = 'أكمل الخيارات'; });
    setErr(e); if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api('POST', 'teacher/tests', { title: title.trim(), topic, level, course: course ? Number(course) : null, duration_minutes: mins ? Number(mins) : null, questions: qs.map(payload) });
      setTitle(''); setQs([]); toast('حُفظ الاختبار كمسودة بانتظار النشر'); onSaved();
    } catch (x) {
      const a = x as ApiError; const per = (a.fields?.questions ?? {}) as unknown as Record<string, Record<string, string[]>>;
      const out: Record<string, string | null> = { title: a.field?.('title'), form: null };
      if (per && typeof per === 'object' && !Array.isArray(per)) Object.entries(per).forEach(([i, f]) => { out[`q${i}`] = Object.values(f).flat()[0] ?? 'تحقق من السؤال'; });
      else if (Array.isArray(per)) out.qs = String(per[0]);
      if (!Object.values(out).some(Boolean)) out.form = a.message;
      setErr(out);
    } finally { setBusy(false); }
  };
  const dashed = { flex: 1, minHeight: 48, borderRadius: 12, border: `1.5px dashed ${color.borderStrong}`, background: 'transparent', color: color.primary, fontWeight: 700, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center' } as const;
  const small = { minHeight: 44, padding: '0 10px', borderRadius: 10, border: `1.5px solid ${color.borderInput}`, background: color.ivory, fontSize: 15 } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field id="tq-title" label="عنوان الاختبار" err={err.title}><input id="tq-title" value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle(err.title)} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field id="tq-topic" label="الموضوع"><select id="tq-topic" value={topic} onChange={(e) => setTopic(e.target.value)} style={sel}>{TOPICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field id="tq-level" label="المستوى"><select id="tq-level" value={level} onChange={(e) => setLevel(e.target.value)} style={sel}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select></Field>
        <Field id="tq-course" label="الدورة (اختياري)"><select id="tq-course" value={course} onChange={(e) => setCourse(e.target.value)} style={sel}><option value="">بدون دورة</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></Field>
        <Field id="tq-mins" label="المدة بالدقائق"><input id="tq-mins" dir="ltr" inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value.replace(/\D/g, '').slice(0, 3))} style={inputStyle(null, true)} /></Field>
      </div>
      <span style={labelStyle}>الأسئلة</span>
      {qs.map((q, i) => (
        <div key={i} style={{ ...card, borderRadius: 14, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>السؤال {i + 1} · {q.kind === 'mcq' ? 'اختيار من متعدد' : q.kind === 'true_false' ? 'صح أو خطأ' : 'سؤال تلاوة · يقيّمه المعلم'}</span>
            <button onClick={() => setQs(qs.filter((_, j) => j !== i))} aria-label={`حذف السؤال ${i + 1}`} style={{ width: 40, height: 40, border: 'none', background: 'transparent', color: color.dangerInk, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="trash" size={18} /></button>
          </div>
          <input value={q.prompt} onChange={(e) => setQ(i, { prompt: e.target.value })} aria-label={`نص السؤال ${i + 1}`} placeholder="اكتب نص السؤال" style={small} />
          {q.kind === 'mcq' && (
            <div role="radiogroup" aria-label={`خيارات السؤال ${i + 1}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {q.options.map((o, k) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="radio" name={`key-${i}`} checked={q.key === k} onChange={() => setQ(i, { key: k })} aria-label={`الإجابة الصحيحة: الخيار ${k + 1}`} style={{ width: 22, height: 22 }} />
                  <input value={o} onChange={(e) => setQ(i, { options: q.options.map((x, m) => (m === k ? e.target.value : x)) })} aria-label={`الخيار ${k + 1}`} placeholder={`الخيار ${k + 1}`} style={{ ...small, flex: 1 }} />
                </div>
              ))}
              {q.options.length < 6 && <button onClick={() => setQ(i, { options: [...q.options, ''] })} style={outlineBtn(40, 14)}>+ خيار</button>}
            </div>
          )}
          {q.kind === 'true_false' && (
            <Segmented role="group" label={`الإجابة الصحيحة للسؤال ${i + 1}`} h={40} fs={14} options={[['t', 'صح'], ['f', 'خطأ']] as const} value={q.tf ? 't' : 'f'} onChange={(v) => setQ(i, { tf: v === 't' })} />
          )}
          {q.kind === 'recitation' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
              {(['surah', 'from', 'to'] as const).map((k) => (
                <input key={k} dir="ltr" inputMode="numeric" value={q[k]} onChange={(e) => setQ(i, { [k]: e.target.value.replace(/\D/g, '').slice(0, 3) })}
                  aria-label={k === 'surah' ? 'رقم السورة (اختياري)' : k === 'from' ? 'من الآية' : 'إلى الآية'} placeholder={k === 'surah' ? 'السورة' : k === 'from' ? 'من آية' : 'إلى آية'} style={small} />
              ))}
            </div>
          )}
          <FieldError msg={err[`q${i}`]} fs={12} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setQs([...qs, newQ('mcq')])} style={dashed}><Icon name="plus" size={18} /> اختيار من متعدد</button>
        <button onClick={() => setQs([...qs, newQ('true_false')])} style={dashed}><Icon name="plus" size={18} /> صح أو خطأ</button>
        <button onClick={() => setQs([...qs, newQ('recitation')])} style={dashed}><Icon name="mic" size={18} /> سؤال تلاوة</button>
      </div>
      <FieldError msg={err.qs} fs={12} />
      {err.form && <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err.form}</p>}
      <button onClick={save} disabled={busy} style={primaryBtn()}>{busy ? 'جارٍ الحفظ…' : 'حفظ الاختبار كمسودة'}</button>
    </div>
  );
}
