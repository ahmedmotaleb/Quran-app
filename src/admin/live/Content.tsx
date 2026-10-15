/** Live Lectures (courses, lessons, enrollments) and Quizzes (tests, versioned questions) sections — pack prompt 07. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ApiError } from '@/api/client';
import { toast } from '../adminStore';
import * as A from './api';
import { chip, date, errMsg, Modal, Pager, ReasonDialog, SearchBar, smallBtn, Table, useDebounced, usePaged } from './ui';

const ST: Record<string, { l: string; bg: string; fg: string }> = {
  draft: { l: 'مسودة', bg: '#ECE7DB', fg: '#45534E' }, pending: { l: 'بانتظار المراجعة', bg: '#F3E6CC', fg: '#6B470C' },
  published: { l: 'منشور', bg: '#D8E5D7', fg: '#124C46' }, archived: { l: 'مؤرشف', bg: '#F5E1DC', fg: '#8E2F20' }, closed: { l: 'مغلق', bg: '#F5E1DC', fg: '#8E2F20' },
  active: { l: 'نشط', bg: '#D8E5D7', fg: '#124C46' }, completed: { l: 'مكتمل', bg: '#ECE7DB', fg: '#45534E' }, withdrawn: { l: 'منسحب', bg: '#F5E1DC', fg: '#8E2F20' },
};
const TOPICS: [string, string][] = [['', '—'], ['tajweed', 'التجويد'], ['hifz', 'الحفظ والمراجعة'], ['adab', 'آداب التلاوة'], ['ulum', 'علوم القرآن']];
const KIND_L: Record<string, string> = { text: 'نص', video: 'فيديو', audio: 'صوت', pdf: 'PDF', mcq: 'اختيار من متعدد', true_false: 'صح أو خطأ', short: 'إجابة قصيرة', recitation: 'تلاوة' };
const pill = (k: string) => { const t = ST[k] ?? ST.draft; return <span style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>{t.l}</span>; };
const nameBtn = (label: string, onClick: () => void) => (
  <button onClick={onClick} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: color.primary, cursor: 'pointer', textDecoration: 'underline', minHeight: 32, textAlign: 'right' }}>{label}</button>
);
const td = (c: ReactNode, latin = false) => <td style={{ padding: '12px 16px', fontFamily: latin ? font.latin : undefined }}>{c}</td>;
function Field({ id, label, children, err }: { id: string; label: string; children: ReactNode; err?: string | null }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><label htmlFor={id} style={labelStyle}>{label}</label>{children}<FieldError msg={err} /></div>;
}
const fieldsOf = (e: unknown, names: string[]) => { const a = e as ApiError; const o: Record<string, string | null> = {}; let any = false; for (const n of names) { o[n] = a.field?.(n) ?? null; any ||= !!o[n]; } if (!any) o.form = a.message; return o; };

/* =============================== Courses =============================== */
export function CoursesLive() {
  const [q, setQ] = useState(''); const dq = useDebounced(q); const [f, setF] = useState('all');
  const L = usePaged((page) => A.listCourses({ q: dq, state: f === 'all' ? undefined : f, page }), [dq, f]);
  const [open, setOpen] = useState<number | null>(null); const [adding, setAdding] = useState(false);
  return (
    <>
      <SearchBar q={q} setQ={setQ} label="ابحث في الدورات" action={<button onClick={() => setAdding(true)} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6, marginInlineStart: 'auto' })}><Icon name="plus" size={18} /> دورة جديدة</button>} />
      <div role="group" aria-label="تصفية حسب الحالة" style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
        {[['all', 'الكل'], ['draft', 'مسودة'], ['published', 'منشورة'], ['archived', 'مؤرشفة']].map(([k, l]) => <button key={k} aria-pressed={f === k} onClick={() => setF(k)} style={chip(f === k)}>{l}</button>)}
      </div>
      <Table cols={['الدورة', 'المعلم', 'المستوى', 'الدروس المنشورة', 'المسجلون', 'الوصول', 'الحالة']} loading={L.loading} err={L.err} empty={!L.data?.results.length} retry={() => void L.reload()}>
        {L.data?.results.map((c) => (
          <tr key={c.id} style={{ borderTop: `1px solid ${color.divider}` }}>
            <th scope="row" style={{ padding: '12px 16px', textAlign: 'right' }}>{nameBtn(c.title, () => setOpen(c.id))}</th>
            {td(c.teacher.name)}{td(c.level || '—')}{td(`${c.published_lessons}/${c.lessons}`, true)}{td(c.enrolled, true)}
            {td(c.restricted ? 'للمسجلين فقط' : 'مفتوح')}{td(pill(c.state))}
          </tr>
        ))}
      </Table>
      <Pager page={L.page} total={L.data?.count ?? 0} setPage={L.setPage} />
      {adding && <CourseForm onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); void L.reload(); setOpen(c.id); }} />}
      {open !== null && <CoursePanel id={open} onClose={() => setOpen(null)} onChanged={() => void L.reload()} />}
    </>
  );
}

function CourseForm({ course, onClose, onSaved }: { course?: A.Course; onClose: () => void; onSaved: (c: A.Course) => void }) {
  const [f, setF] = useState({ title: course?.title ?? '', description: course?.description ?? '', topic: course?.topic ?? '', level: course?.level ?? '', teacher: course?.teacher.id ?? 0, restricted: course?.restricted ?? false });
  const [teachers, setTeachers] = useState<A.Person[]>([]); const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { A.listPeople({ role: 'teacher', status: 'active', page_size: 100 }).then((p) => setTeachers(p.results)).catch(() => setTeachers([])); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.title.trim().length < 2) return setErr({ title: 'اكتب عنوان الدورة.' });
    if (!f.teacher) return setErr({ teacher: 'اختر المعلم المسؤول.' });
    setBusy(true); setErr({});
    try { onSaved(await A.saveCourse(course?.id ?? null, { ...f, title: f.title.trim() })); toast('حُفظت الدورة'); }
    catch (x) { setErr(fieldsOf(x, ['title', 'teacher', 'topic', 'level'])); } finally { setBusy(false); }
  };
  return (
    <Modal title={course ? 'تعديل الدورة' : 'دورة جديدة'} onClose={onClose}>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field id="co-t" label="العنوان" err={err.title}><input id="co-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={inputStyle(err.title)} /></Field>
        <Field id="co-d" label="الوصف (يظهر للطلاب)"><textarea id="co-d" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ ...inputStyle(null), minHeight: 80, paddingTop: 10 }} /></Field>
        <Field id="co-tc" label="المعلم المسؤول" err={err.teacher}>
          <select id="co-tc" value={f.teacher} onChange={(e) => setF({ ...f, teacher: Number(e.target.value) })} style={inputStyle(err.teacher)}>
            <option value={0}>— اختر —</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><Field id="co-tp" label="المجال"><select id="co-tp" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} style={inputStyle(null)}>{TOPICS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field></div>
          <div style={{ flex: 1 }}><Field id="co-lv" label="المستوى"><input id="co-lv" value={f.level} placeholder="مبتدئ" onChange={(e) => setF({ ...f, level: e.target.value })} style={inputStyle(null)} /></Field></div>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
          <input type="checkbox" checked={f.restricted} onChange={(e) => setF({ ...f, restricted: e.target.checked })} style={{ width: 20, height: 20 }} />
          للطلاب المسجلين فقط (وإلا فهي متاحة لكل الطلاب)
        </label>
        {err.form && <FieldError msg={err.form} />}
        <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
      </form>
    </Modal>
  );
}

function CoursePanel({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [c, setC] = useState<(A.Course & { lesson_list: A.Lesson[] }) | null>(null); const [err, setErr] = useState<string | null>(null);
  const [sub, setSub] = useState<'edit' | 'archive' | 'enroll' | { lesson: A.Lesson | null } | null>(null); const [busy, setBusy] = useState(false);
  const [enr, setEnr] = useState<A.Enrollment[] | null>(null); const [end, setEnd] = useState<A.Enrollment | null>(null);
  const reload = useCallback(async () => {
    try { const [cc, ee] = await Promise.all([A.getCourse(id), A.listEnrollments(id)]); setC(cc); setEnr(ee.results); setErr(null); } catch (e) { setErr(errMsg(e)); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok); await reload(); onChanged(); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); } };
  return (
    <Modal title={c?.title ?? 'الدورة'} onClose={onClose} wide>
      {err && <p role="alert" style={{ margin: 0, color: color.danger }}>{err}</p>}
      {!c && !err && <p role="status" style={{ margin: 0, color: color.muted }}>جارٍ التحميل…</p>}
      {c && <>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>{pill(c.state)}<span>{c.teacher.name}</span><span style={{ color: color.muted }}>· {c.restricted ? 'للمسجلين فقط' : 'متاحة لكل الطلاب'}</span></div>
        {c.description && <p style={{ margin: 0, fontSize: 14 }}>{c.description}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setSub('edit')} style={smallBtn()}>تعديل</button>
          {c.state !== 'published' && <button disabled={busy} onClick={() => act(() => A.setCourseState(c.id, 'published'), 'نُشرت الدورة')} style={smallBtn('primary')}>نشر</button>}
          {c.state === 'published' && <button disabled={busy} onClick={() => act(() => A.setCourseState(c.id, 'draft'), 'أُعيدت إلى مسودة')} style={smallBtn()}>إلغاء النشر</button>}
          {c.state !== 'archived' && <button disabled={busy} onClick={() => setSub('archive')} style={smallBtn('danger')}>أرشفة</button>}
        </div>
        <section style={{ borderTop: `1px solid ${color.divider}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>الدروس</h3>
          {c.lesson_list.length === 0 && <p style={{ margin: 0, color: color.muted }}>لا توجد دروس بعد.</p>}
          {c.lesson_list.map((l) => (
            <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 48, borderTop: `1px solid ${color.divider}`, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: font.latin, color: color.muted, minWidth: 24 }}>{l.order}</span>
              <span style={{ flex: 1, minWidth: 160 }}>{l.title} <span style={{ fontSize: 12, color: color.muted }}>· {KIND_L[l.kind]}</span></span>
              {pill(l.state)}
              <button onClick={() => setSub({ lesson: l })} aria-label={`تعديل ${l.title}`} style={smallBtn()}>تعديل</button>
              {l.state === 'published'
                ? <button disabled={busy} onClick={() => act(() => A.setLessonState(l.id, 'draft'), 'أُلغي نشر الدرس')} aria-label={`إلغاء نشر ${l.title}`} style={smallBtn()}>إلغاء النشر</button>
                : <button disabled={busy} onClick={() => act(() => A.setLessonState(l.id, 'published'), 'نُشر الدرس')} aria-label={`نشر ${l.title}`} style={smallBtn('primary')}>نشر</button>}
            </div>
          ))}
          <button onClick={() => setSub({ lesson: null })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>إضافة درس</button>
        </section>
        <section style={{ borderTop: `1px solid ${color.divider}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>المسجلون {c.restricted ? '' : <span style={{ fontSize: 13, color: color.muted, fontWeight: 400 }}>(الدورة مفتوحة؛ التسجيل للمتابعة فقط)</span>}</h3>
          {enr?.length === 0 && <p style={{ margin: 0, color: color.muted }}>لا يوجد طلاب مسجلون.</p>}
          {enr?.map((e) => (
            <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
              <span style={{ flex: 1 }}>{e.student.name}</span>{pill(e.status)}<span style={{ fontSize: 12, color: color.muted }}>{e.starts_on ? date(e.starts_on) : ''}</span>
              {e.status === 'active' && <button onClick={() => setEnd(e)} aria-label={`إنهاء تسجيل ${e.student.name}`} style={smallBtn('danger')}>إنهاء</button>}
            </div>
          ))}
          {c.state !== 'archived' && <button onClick={() => setSub('enroll')} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>تسجيل طالب</button>}
        </section>
      </>}
      {sub === 'edit' && c && <CourseForm course={c} onClose={() => setSub(null)} onSaved={() => { setSub(null); void reload(); onChanged(); }} />}
      {sub === 'archive' && c && <ReasonDialog title="أرشفة الدورة" body="تختفي الدورة عن الطلاب. التسجيلات والإنجازات والدرجات تبقى محفوظة." ok="أرشفة" onClose={() => setSub(null)}
        run={async (r) => { await A.setCourseState(c.id, 'archived', r); toast('أُرشفت الدورة'); await reload(); onChanged(); }} />}
      {sub && typeof sub === 'object' && c && <LessonForm courseId={c.id} lesson={sub.lesson} onClose={() => setSub(null)} onSaved={() => { setSub(null); void reload(); onChanged(); }} />}
      {sub === 'enroll' && c && <StudentPicker exclude={(enr ?? []).filter((e) => e.status === 'active').map((e) => e.student.id)} onClose={() => setSub(null)}
        onPick={async (p) => { await A.enroll(c.id, p.id); toast('سُجّل الطالب'); await reload(); onChanged(); }} />}
      {end && <ReasonDialog title="إنهاء التسجيل" body={`سيُنهى تسجيل ${end.student.name}${c?.restricted ? ' ويفقد الوصول إلى دروس الدورة' : ''}. يبقى السجل محفوظًا.`} ok="إنهاء التسجيل" required={false}
        onClose={() => setEnd(null)} run={async (r) => { await A.endEnrollment(end.id, 'withdrawn', r); toast('أُنهي التسجيل'); await reload(); onChanged(); }} />}
    </Modal>
  );
}

function LessonForm({ courseId, lesson, onClose, onSaved }: { courseId: number; lesson: A.Lesson | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ title: lesson?.title ?? '', kind: lesson?.kind === 'video' ? 'video' : 'text', body: lesson?.body ?? '', url: lesson?.external_url ?? '', minutes: lesson?.duration_minutes ? String(lesson.duration_minutes) : '' });
  const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  const fileKind = lesson && (lesson.kind === 'audio' || lesson.kind === 'pdf');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const x: Record<string, string> = {};
    if (f.title.trim().length < 2) x.title = 'اكتب عنوان الدرس.';
    if (f.kind === 'text' && !f.body.trim()) x.body = 'اكتب نص الدرس.';
    if (f.kind === 'video' && !/^https:\/\//.test(f.url.trim())) x.external_url = 'أضف رابط YouTube أو Vimeo يبدأ بـ https://';
    if (Object.keys(x).length) return setErr(x);
    setBusy(true); setErr({});
    try {
      await A.saveLesson(courseId, lesson?.id ?? null, { title: f.title.trim(), kind: f.kind, body: f.body, external_url: f.kind === 'video' ? f.url.trim() : '', duration_minutes: f.minutes ? Number(f.minutes) : null });
      toast('حُفظ الدرس'); onSaved();
    } catch (y) { setErr(fieldsOf(y, ['title', 'body', 'external_url', 'duration_minutes'])); } finally { setBusy(false); }
  };
  return (
    <Modal title={lesson ? 'تعديل الدرس' : 'درس جديد'} onClose={onClose} wide>
      {fileKind ? <p style={{ margin: 0 }}>هذا الدرس مرتبط بملف ({KIND_L[lesson!.kind]}). تعديل الملفات من لوحة الإدارة غير متاح بعد.</p> : (
        <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field id="ls-t" label="عنوان الدرس" err={err.title}><input id="ls-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={inputStyle(err.title)} /></Field>
          <div role="radiogroup" aria-label="نوع الدرس" style={{ display: 'flex', gap: 8 }}>
            {(['text', 'video'] as const).map((k) => <button type="button" key={k} role="radio" aria-checked={f.kind === k} onClick={() => setF({ ...f, kind: k })} style={chip(f.kind === k)}>{KIND_L[k]}</button>)}
          </div>
          {f.kind === 'video' && <Field id="ls-u" label="رابط الفيديو (YouTube أو Vimeo)" err={err.external_url}><input id="ls-u" dir="ltr" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} style={inputStyle(err.external_url, true)} /></Field>}
          <Field id="ls-b" label={f.kind === 'video' ? 'ملاحظات (اختياري)' : 'نص الدرس'} err={err.body}>
            <textarea id="ls-b" rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} style={{ ...inputStyle(err.body), minHeight: 160, paddingTop: 10, lineHeight: 1.8 }} />
          </Field>
          <Field id="ls-m" label="المدة بالدقائق (اختياري)" err={err.duration_minutes}><input id="ls-m" inputMode="numeric" dir="ltr" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value.replace(/\D/g, '') })} style={{ ...inputStyle(err.duration_minutes, true), maxWidth: 160 }} /></Field>
          <p style={{ margin: 0, fontSize: 13, color: color.muted }}>لا تكتب آيات القرآن نصًا هنا؛ أشر إليها باسم السورة ورقم الآية، فالنص المعتمد يُعرض من المصحف.</p>
          {err.form && <FieldError msg={err.form} />}
          <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الحفظ…' : 'حفظ الدرس'}</button>
        </form>
      )}
    </Modal>
  );
}

function StudentPicker({ exclude, onClose, onPick }: { exclude: number[]; onClose: () => void; onPick: (p: A.Person) => Promise<void> }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q); const [rows, setRows] = useState<A.Person[] | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; A.listPeople({ role: 'student', status: 'active', q: dq, page_size: 20 }).then((p) => on && setRows(p.results)).catch((e) => on && setErr(errMsg(e))); return () => { on = false; }; }, [dq]);
  return (
    <Modal title="اختر الطالب" onClose={onClose}>
      <input type="search" aria-label="بحث" placeholder="ابحث بالاسم أو البريد" value={q} onChange={(e) => setQ(e.target.value)} style={inputStyle(null)} />
      {err && <FieldError msg={err} />}
      {rows?.filter((r) => !exclude.includes(r.id)).map((r) => (
        <button key={r.id} disabled={busy} onClick={async () => { setBusy(true); try { await onPick(r); onClose(); } catch (e) { setErr(errMsg(e)); setBusy(false); } }}
          style={{ minHeight: 52, padding: '0 12px', borderRadius: 12, border: `1px solid ${color.divider}`, background: color.card, textAlign: 'right', cursor: 'pointer' }}>
          <span style={{ display: 'block', fontWeight: 700 }}>{r.full_name}</span><bdi dir="ltr" style={{ fontSize: 12, color: color.muted }}>{r.email}</bdi>
        </button>
      ))}
    </Modal>
  );
}

/* =============================== Quizzes =============================== */
export function QuizzesLive() {
  const [q, setQ] = useState(''); const dq = useDebounced(q); const [f, setF] = useState('all');
  const L = usePaged((page) => A.listQuizzes({ q: dq, state: f === 'all' ? undefined : f, page }), [dq, f]);
  const [open, setOpen] = useState<number | null>(null); const [adding, setAdding] = useState(false);
  return (
    <>
      <SearchBar q={q} setQ={setQ} label="ابحث في الاختبارات" action={<button onClick={() => setAdding(true)} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6, marginInlineStart: 'auto' })}><Icon name="plus" size={18} /> اختبار جديد</button>} />
      <div role="group" aria-label="تصفية حسب الحالة" style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
        {[['all', 'الكل'], ['draft', 'مسودة'], ['published', 'منشور'], ['closed', 'مغلق']].map(([k, l]) => <button key={k} aria-pressed={f === k} onClick={() => setF(k)} style={chip(f === k)}>{l}</button>)}
      </div>
      <Table cols={['الاختبار', 'الدورة', 'المستوى', 'الأسئلة', 'المحاولات المسلّمة', 'الحالة']} loading={L.loading} err={L.err} empty={!L.data?.results.length} retry={() => void L.reload()}>
        {L.data?.results.map((t) => (
          <tr key={t.id} style={{ borderTop: `1px solid ${color.divider}` }}>
            <th scope="row" style={{ padding: '12px 16px', textAlign: 'right' }}>{nameBtn(t.title, () => setOpen(t.id))}</th>
            {td(t.course?.title ?? '—')}{td(t.level || '—')}{td(t.questions, true)}{td(t.attempts, true)}{td(pill(t.state))}
          </tr>
        ))}
      </Table>
      <Pager page={L.page} total={L.data?.count ?? 0} setPage={L.setPage} />
      {adding && <QuizForm onClose={() => setAdding(false)} onSaved={(t) => { setAdding(false); void L.reload(); setOpen(t.id); }} />}
      {open !== null && <QuizPanel id={open} onClose={() => setOpen(null)} onChanged={() => void L.reload()} />}
    </>
  );
}

function QuizForm({ quiz, onClose, onSaved }: { quiz?: A.Quiz; onClose: () => void; onSaved: (t: A.Quiz) => void }) {
  const [f, setF] = useState({ title: quiz?.title ?? '', level: quiz?.level ?? '', topic: quiz?.topic ?? '', duration: quiz?.duration_minutes ? String(quiz.duration_minutes) : '', attempts: String(quiz?.max_attempts ?? 1), course: quiz?.course?.id ?? 0 });
  const [courses, setCourses] = useState<A.Course[]>([]); const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { A.listCourses({}).then((p) => setCourses(p.results.filter((c) => c.state !== 'archived'))).catch(() => setCourses([])); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.title.trim().length < 2) return setErr({ title: 'اكتب عنوان الاختبار.' });
    const att = Number(f.attempts); if (!(att >= 1 && att <= 10)) return setErr({ max_attempts: 'من 1 إلى 10.' });
    setBusy(true); setErr({});
    try {
      onSaved(await A.saveQuiz(quiz?.id ?? null, { title: f.title.trim(), level: f.level.trim(), topic: f.topic, duration_minutes: f.duration ? Number(f.duration) : null, max_attempts: att, course: f.course || null }));
      toast('حُفظ الاختبار');
    } catch (x) { setErr(fieldsOf(x, ['title', 'duration_minutes', 'max_attempts', 'course'])); } finally { setBusy(false); }
  };
  return (
    <Modal title={quiz ? 'تعديل الاختبار' : 'اختبار جديد'} onClose={onClose}>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field id="qz-t" label="العنوان" err={err.title}><input id="qz-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={inputStyle(err.title)} /></Field>
        <Field id="qz-c" label="الدورة (اختياري)" err={err.course}>
          <select id="qz-c" value={f.course} onChange={(e) => setF({ ...f, course: Number(e.target.value) })} style={inputStyle(null)}>
            <option value={0}>— بدون دورة (متاح لكل الطلاب) —</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><Field id="qz-tp" label="المجال"><select id="qz-tp" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} style={inputStyle(null)}>{TOPICS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field></div>
          <div style={{ flex: 1 }}><Field id="qz-l" label="المستوى"><input id="qz-l" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} style={inputStyle(null)} /></Field></div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><Field id="qz-d" label="المدة بالدقائق (اختياري)" err={err.duration_minutes}><input id="qz-d" inputMode="numeric" dir="ltr" value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value.replace(/\D/g, '') })} style={inputStyle(err.duration_minutes, true)} /></Field></div>
          <div style={{ flex: 1 }}><Field id="qz-a" label="عدد المحاولات" err={err.max_attempts}><input id="qz-a" inputMode="numeric" dir="ltr" value={f.attempts} onChange={(e) => setF({ ...f, attempts: e.target.value.replace(/\D/g, '') })} style={inputStyle(err.max_attempts, true)} /></Field></div>
        </div>
        {err.form && <FieldError msg={err.form} />}
        <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
      </form>
    </Modal>
  );
}

function QuizPanel({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [t, setT] = useState<(A.Quiz & { question_list: A.Question[] }) | null>(null); const [err, setErr] = useState<string | null>(null);
  const [sub, setSub] = useState<'edit' | { q: A.Question | null } | null>(null); const [busy, setBusy] = useState(false); const [del, setDel] = useState<A.Question | null>(null);
  const reload = useCallback(async () => { try { setT(await A.getQuiz(id)); setErr(null); } catch (e) { setErr(errMsg(e)); } }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok); await reload(); onChanged(); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); } };
  const keyText = (q: A.Question) => q.kind === 'mcq' ? `الصحيح: ${(q.options as string[])[q.answer_key as number] ?? '—'}` : q.kind === 'true_false' ? `الصحيح: ${q.answer_key ? 'صح' : 'خطأ'}`
    : q.kind === 'recitation' ? (() => { const o = q.options as { surah?: number; ayah_from?: number; ayah_to?: number }; return o.surah ? `سورة ${o.surah}: ${o.ayah_from}–${o.ayah_to} · يصححها المعلم` : 'يصححها المعلم'; })() : 'يصححها المعلم';
  return (
    <Modal title={t?.title ?? 'الاختبار'} onClose={onClose} wide>
      {err && <p role="alert" style={{ margin: 0, color: color.danger }}>{err}</p>}
      {!t && !err && <p role="status" style={{ margin: 0, color: color.muted }}>جارٍ التحميل…</p>}
      {t && <>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>{pill(t.state)}<span style={{ color: color.muted }}>{t.course ? `دورة: ${t.course.title} · ` : ''}{t.max_attempts} محاولة{t.duration_minutes ? ` · ${t.duration_minutes} دقيقة` : ''} · {t.attempts} محاولة مسلّمة</span></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setSub('edit')} style={smallBtn()}>تعديل البيانات</button>
          {t.state !== 'published' && <button disabled={busy} onClick={() => act(() => A.setQuizState(t.id, 'published'), 'نُشر الاختبار')} style={smallBtn('primary')}>نشر</button>}
          {t.state === 'published' && <button disabled={busy} onClick={() => act(() => A.setQuizState(t.id, 'closed'), 'أُغلق الاختبار')} style={smallBtn('danger')}>إغلاق الاختبار</button>}
          {t.state === 'closed' && <button disabled={busy} onClick={() => act(() => A.setQuizState(t.id, 'draft'), 'أُعيد إلى مسودة')} style={smallBtn()}>إعادة إلى مسودة</button>}
        </div>
        {t.attempts > 0 && <p style={{ margin: 0, fontSize: 13, color: color.muted }}>تعديل سؤال أُجيب عنه ينشئ نسخة جديدة للمحاولات القادمة، وتبقى المحاولات السابقة بنصّها الأصلي.</p>}
        <section style={{ borderTop: `1px solid ${color.divider}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>الأسئلة</h3>
          {t.question_list.length === 0 && <p style={{ margin: 0, color: color.muted }}>لا توجد أسئلة بعد.</p>}
          {t.question_list.map((q, i) => (
            <div key={q.id} style={{ borderTop: `1px solid ${color.divider}`, paddingTop: 8, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: font.latin, color: color.muted, minWidth: 24 }}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 200 }}>
                <span style={{ display: 'block', fontWeight: 700 }}>{q.prompt}</span>
                <span style={{ display: 'block', fontSize: 12, color: color.muted }}>{KIND_L[q.kind]} · {q.points} درجة · {keyText(q)}{q.version > 1 ? ` · نسخة ${q.version}` : ''}{q.used ? ` · أُجيب ${q.used} مرة` : ''}</span>
              </span>
              {t.state !== 'closed' && <><button onClick={() => setSub({ q })} aria-label={`تعديل السؤال ${i + 1}`} style={smallBtn()}>تعديل</button>
                <button onClick={() => setDel(q)} aria-label={`حذف السؤال ${i + 1}`} style={smallBtn('danger')}>حذف</button></>}
            </div>
          ))}
          {t.state !== 'closed' && <button onClick={() => setSub({ q: null })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>إضافة سؤال</button>}
        </section>
      </>}
      {sub === 'edit' && t && <QuizForm quiz={t} onClose={() => setSub(null)} onSaved={() => { setSub(null); void reload(); onChanged(); }} />}
      {sub && typeof sub === 'object' && t && <QuestionForm testId={t.id} q={sub.q} onClose={() => setSub(null)} onSaved={() => { setSub(null); void reload(); onChanged(); }} />}
      {del && <ReasonDialog title="حذف السؤال" body="يُخفى السؤال عن المحاولات القادمة. الإجابات السابقة تبقى محفوظة." ok="حذف" required={false}
        onClose={() => setDel(null)} run={async () => { await A.removeQuestion(del.id); toast('حُذف السؤال'); await reload(); onChanged(); }} />}
    </Modal>
  );
}

function QuestionForm({ testId, q, onClose, onSaved }: { testId: number; q: A.Question | null; onClose: () => void; onSaved: () => void }) {
  const ref = (q?.kind === 'recitation' ? q.options : {}) as { surah?: number; ayah_from?: number; ayah_to?: number };
  const [f, setF] = useState({
    kind: (q?.kind ?? 'mcq') as A.QKind, prompt: q?.prompt ?? '', points: String(q?.points ?? 1),
    options: q?.kind === 'mcq' ? [...(q.options as string[])] : ['', ''], correct: q?.kind === 'mcq' ? Number(q.answer_key) : 0,
    tf: q?.kind === 'true_false' ? Boolean(q.answer_key) : true, model: q?.kind === 'short' ? String(q.answer_key ?? '') : '',
    surah: ref.surah ? String(ref.surah) : '', from: ref.ayah_from ? String(ref.ayah_from) : '', to: ref.ayah_to ? String(ref.ayah_to) : '',
  });
  const [err, setErr] = useState<Record<string, string | null>>({}); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.prompt.trim().length < 3) return setErr({ prompt: 'اكتب نص السؤال.' });
    const body: Partial<A.Question> = { kind: f.kind, prompt: f.prompt.trim(), points: Number(f.points) || 1 };
    if (f.kind === 'mcq') { body.options = f.options.map((o) => o.trim()); body.answer_key = f.correct; }
    if (f.kind === 'true_false') body.answer_key = f.tf;
    if (f.kind === 'short') body.answer_key = f.model.trim() || null;
    if (f.kind === 'recitation') body.options = f.surah ? { surah: Number(f.surah), ayah_from: Number(f.from), ayah_to: Number(f.to || f.from) } : {};
    setBusy(true); setErr({});
    try { await A.saveQuestion(testId, q?.id ?? null, body); toast('حُفظ السؤال'); onSaved(); }
    catch (x) { setErr(fieldsOf(x, ['prompt', 'options', 'answer_key', 'points'])); } finally { setBusy(false); }
  };
  return (
    <Modal title={q ? 'تعديل السؤال' : 'سؤال جديد'} onClose={onClose} wide>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div role="radiogroup" aria-label="نوع السؤال" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['mcq', 'true_false', 'short', 'recitation'] as const).map((k) => <button type="button" key={k} role="radio" aria-checked={f.kind === k} onClick={() => setF({ ...f, kind: k })} style={chip(f.kind === k)}>{KIND_L[k]}</button>)}
        </div>
        <Field id="qq-p" label="نص السؤال" err={err.prompt}><textarea id="qq-p" rows={3} value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} style={{ ...inputStyle(err.prompt), minHeight: 80, paddingTop: 10 }} /></Field>
        {f.kind === 'mcq' && <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <legend style={labelStyle}>الخيارات (اختر الصحيح)</legend>
          {f.options.map((o, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="radio" name="correct" aria-label={`الخيار ${i + 1} صحيح`} checked={f.correct === i} onChange={() => setF({ ...f, correct: i })} style={{ width: 20, height: 20 }} />
              <input aria-label={`الخيار ${i + 1}`} value={o} onChange={(e) => { const n = [...f.options]; n[i] = e.target.value; setF({ ...f, options: n }); }} style={{ ...inputStyle(null), flex: 1 }} />
              {f.options.length > 2 && <button type="button" aria-label={`إزالة الخيار ${i + 1}`} onClick={() => setF({ ...f, options: f.options.filter((_, j) => j !== i), correct: f.correct >= i && f.correct > 0 ? f.correct - 1 : f.correct })} style={smallBtn()}><Icon name="x" size={16} /></button>}
            </div>
          ))}
          {f.options.length < 6 && <button type="button" onClick={() => setF({ ...f, options: [...f.options, ''] })} style={{ ...smallBtn(), alignSelf: 'flex-start' }}>إضافة خيار</button>}
          <FieldError msg={err.options ?? err.answer_key} />
        </fieldset>}
        {f.kind === 'true_false' && <div role="radiogroup" aria-label="الإجابة الصحيحة" style={{ display: 'flex', gap: 8 }}>
          {[[true, 'صح'], [false, 'خطأ']].map(([v, l]) => <button type="button" key={String(v)} role="radio" aria-checked={f.tf === v} onClick={() => setF({ ...f, tf: v as boolean })} style={chip(f.tf === v)}>{l as string}</button>)}
        </div>}
        {f.kind === 'short' && <Field id="qq-m" label="إجابة نموذجية للمعلم (اختياري)"><input id="qq-m" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} style={inputStyle(null)} /></Field>}
        {f.kind === 'recitation' && <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <legend style={labelStyle}>النطاق المطلوب تلاوته (اختياري، يُتحقق منه من المصحف المعتمد)</legend>
          <div style={{ display: 'flex', gap: 8 }}>
            {([['surah', 'رقم السورة'], ['from', 'من آية'], ['to', 'إلى آية']] as const).map(([k, l]) => (
              <input key={k} aria-label={l} placeholder={l} inputMode="numeric" dir="ltr" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '') })} style={{ ...inputStyle(err.options, true), flex: 1 }} />
            ))}
          </div>
          <FieldError msg={err.options} />
        </fieldset>}
        <Field id="qq-pt" label="الدرجة" err={err.points}><input id="qq-pt" inputMode="numeric" dir="ltr" value={f.points} onChange={(e) => setF({ ...f, points: e.target.value.replace(/\D/g, '') })} style={{ ...inputStyle(err.points, true), maxWidth: 120 }} /></Field>
        {err.form && <FieldError msg={err.form} />}
        <button type="submit" disabled={busy} style={primaryBtn(48, 15)}>{busy ? 'جارٍ الحفظ…' : 'حفظ السؤال'}</button>
      </form>
    </Modal>
  );
}
