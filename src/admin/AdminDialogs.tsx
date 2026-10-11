import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { FieldError, inputStyle, labelStyle, outlineBtn, primaryBtn } from '@/components/ui';
import { LEVELS, TEACHER_NAMES, TOPICS, type AdminUser, type UserRole } from './adminData';
import { closeDialog, saveCircle, saveContent, saveLink, saveUser, setAdmin, useAdmin } from './adminStore';
import { StatusPill } from './AdminTables';

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const selStyle: CSSProperties = { ...inputStyle(false), padding: '0 12px' };

/** Centered modal, or a side drawer (`drawer`) for detail views. Esc and backdrop close it; focus returns on close. */
function Modal({ title, children, drawer = false }: { title: string; children: ReactNode; drawer?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector('input,select,textarea,button:not([aria-label="إغلاق"])') as HTMLElement | null)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: drawer ? 'flex-start' : 'center', alignItems: drawer ? 'stretch' : 'center', padding: drawer ? 0 : 16 }}>
      <div onClick={closeDialog} style={{ position: 'absolute', inset: 0, background: 'rgba(12,36,33,.45)' }} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        style={{ position: 'relative', width: '100%', maxWidth: drawer ? 460 : 500, maxHeight: drawer ? '100vh' : '90vh', overflowY: 'auto', background: color.ivory, borderRadius: drawer ? 0 : 20, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{title}</h2>
          <button onClick={closeDialog} aria-label="إغلاق" style={{ width: 44, height: 44, border: 'none', background: 'transparent', color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Actions({ okL, onOk, danger = false }: { okL: string; onOk: () => void; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
      <button onClick={closeDialog} style={outlineBtn(48, 15, { flex: 1 })}>إلغاء</button>
      <button onClick={onOk} style={primaryBtn(48, 15, { flex: 1, ...(danger ? { background: color.dangerBtn, color: color.card } : {}) })}>{okL}</button>
    </div>
  );
}

function Field({ id, label, error, hint, children }: { id?: string; label: string; error?: string | null; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {id ? <label htmlFor={id} style={labelStyle}>{label}</label> : <span style={labelStyle}>{label}</span>}
      {children}
      {hint && <p style={{ margin: 0, fontSize: 12, color: color.muted }}>{hint}</p>}
      <FieldError msg={error} />
    </div>
  );
}

export default function AdminDialogs() {
  const d = useAdmin((s) => s.dialog);
  if (!d) return null;
  switch (d.kind) {
    case 'link': return <LinkDialog id={d.id} approve={d.approve} />;
    case 'user': return <UserDialog id={d.id} role={d.role} />;
    case 'circle': return <CircleDialog id={d.id} />;
    case 'content': return <ContentDialog id={d.id} ckind={d.ckind} />;
    case 'student': return <StudentDrawer id={d.id} />;
    case 'teacher': return <TeacherDrawer id={d.id} />;
    case 'confirm': return (
      <Modal title={d.title}>
        <p style={{ margin: 0, fontSize: 15, color: color.body, lineHeight: 1.7 }}>{d.body}</p>
        <Actions okL={d.ok} onOk={d.onOk} danger />
      </Modal>
    );
  }
}

/* ---------------- Linking ---------------- */
function LinkDialog({ id, approve }: { id: number; approve: boolean }) {
  const users = useAdmin((s) => s.users);
  const u = users.find((x) => x.id === id)!;
  const isParent = u.role === 'ولي أمر';
  const [teacher, setTeacher] = useState(u.teacher ?? '');
  const [parent, setParent] = useState(u.parent ?? '');
  const [children, setChildren] = useState<string[]>(u.children);
  const [kq, setKq] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const parents = users.filter((x) => x.role === 'ولي أمر' && x.st === 'active');
  const students = users.filter((x) => x.role !== 'ولي أمر' && (!kq.trim() || x.name.includes(kq.trim()))).slice(0, 8);

  const save = () => {
    if (approve && !isParent && !teacher) { setErr('اختر معلمًا لربط الطالب قبل الاعتماد'); return; }
    saveLink(id, isParent ? null : teacher || null, isParent ? null : parent || null, isParent ? children : [], approve);
  };
  return (
    <Modal title={approve ? `اعتماد وربط: ${u.name}` : `تعديل الربط: ${u.name}`}>
      <p style={{ margin: 0, fontSize: 14, color: color.muted }}>{u.role} · <bdi dir="ltr" style={{ fontFamily: font.latin }}>{u.email}</bdi></p>
      {!isParent ? (
        <>
          <Field id="ln-teacher" label="المعلم" error={err}>
            <select id="ln-teacher" value={teacher} onChange={(e) => { setTeacher(e.target.value); setErr(null); }} style={selStyle}>
              <option value="">— بدون معلم —</option>
              {TEACHER_NAMES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </Field>
          <Field id="ln-parent" label="ولي الأمر" hint="يرى ولي الأمر بيانات أبنائه المرتبطين فقط.">
            <select id="ln-parent" value={parent} onChange={(e) => setParent(e.target.value)} style={selStyle}>
              <option value="">— غير مرتبط —</option>
              {parents.map((p) => <option key={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={labelStyle}>الأبناء المرتبطون</span>
          {children.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {children.map((c) => (
                <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 4px 0 12px', minHeight: 36, borderRadius: 999, background: color.sage, color: color.primary, fontSize: 14, fontWeight: 700 }}>
                  {c}<button onClick={() => setChildren(children.filter((x) => x !== c))} aria-label={`إزالة ${c}`} style={{ width: 32, height: 32, border: 'none', background: 'transparent', color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="x" size={18} /></button>
                </span>
              ))}
            </div>
          ) : <p style={{ margin: 0, fontSize: 14, color: color.muted }}>لا يوجد أبناء مرتبطون بعد.</p>}
          <input type="search" aria-label="ابحث عن طالب لربطه" placeholder="ابحث عن طالب لربطه" value={kq} onChange={(e) => setKq(e.target.value)} style={inputStyle(false, false, { minHeight: 48, fontSize: 15 })} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {students.map((x) => {
              const on = children.includes(x.name);
              return (
                <button key={x.id} aria-pressed={on} onClick={() => setChildren(on ? children.filter((c) => c !== x.name) : [...children, x.name])}
                  style={{ minHeight: 44, padding: '0 12px', borderRadius: 10, border: `1px solid ${on ? color.primary : color.border}`, background: on ? color.sageTint : color.card, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: color.ink, fontSize: 14, textAlign: 'right' }}>
                  <span style={{ flex: 1 }}>{x.name}</span>
                  <span style={{ fontSize: 12, color: color.muted }}>{x.parent && x.parent !== u.name ? `مرتبط بـ ${x.parent}` : x.role}</span>
                  {on && <span style={{ color: color.primary }}><Icon name="check" size={18} /></span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <Actions okL={approve ? 'اعتماد وحفظ الربط' : 'حفظ الربط'} onOk={save} />
    </Modal>
  );
}

/* ---------------- Add / edit user ---------------- */
function UserDialog({ id, role: role0 }: { id: number | null; role: UserRole }) {
  const users = useAdmin((s) => s.users);
  const u: AdminUser | undefined = id === null ? undefined : users.find((x) => x.id === id);
  const isParent = (u?.role ?? role0) === 'ولي أمر';
  const [name, setName] = useState(u?.name ?? '');
  const [email, setEmail] = useState(u?.email ?? '');
  const [role, setRole] = useState<UserRole>(u?.role ?? role0);
  const [level, setLevel] = useState(u?.level ?? 'مبتدئ');
  const [errs, setErrs] = useState<Record<string, string | null>>({});
  const save = () => {
    const e: Record<string, string> = {}; const em = email.trim().toLowerCase();
    if (name.trim().length < 2) e.name = 'أدخل الاسم الكامل';
    if (!em) e.email = 'أدخل البريد الإلكتروني'; else if (!EMAIL_RE.test(em)) e.email = 'صيغة البريد الإلكتروني غير صحيحة';
    else if (users.some((x) => x.email === em && x.id !== id)) e.email = 'هذا البريد مستخدم لحساب آخر';
    if (Object.keys(e).length) { setErrs(e); return; }
    saveUser(id, { name: name.trim(), email: em, role, ...(isParent ? {} : { level }) });
  };
  const title = id === null ? (isParent ? 'إضافة ولي أمر' : 'إضافة طالب') : `تعديل: ${u?.name}`;
  return (
    <Modal title={title}>
      <Field id="us-name" label="الاسم الكامل" error={errs.name}>
        <input id="us-name" value={name} aria-invalid={!!errs.name} onChange={(e) => { setName(e.target.value); setErrs({ ...errs, name: null }); }} style={inputStyle(errs.name)} />
      </Field>
      <Field id="us-email" label="البريد الإلكتروني" error={errs.email} hint="تُرسل دعوة الدخول إلى هذا البريد بعد الحفظ (تجريبي).">
        <input id="us-email" type="email" dir="ltr" value={email} aria-invalid={!!errs.email} placeholder="name@example.com" onChange={(e) => { setEmail(e.target.value); setErrs({ ...errs, email: null }); }} style={inputStyle(errs.email, true)} />
      </Field>
      {!isParent && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field id="us-role" label="الجنس">
            <select id="us-role" value={role} onChange={(e) => setRole(e.target.value as UserRole)} style={selStyle}><option>طالب</option><option>طالبة</option></select>
          </Field>
          <Field id="us-level" label="المستوى">
            <select id="us-level" value={level} onChange={(e) => setLevel(e.target.value)} style={selStyle}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select>
          </Field>
        </div>
      )}
      <Actions okL={id === null ? 'إضافة' : 'حفظ'} onOk={save} />
    </Modal>
  );
}

/* ---------------- Circle ---------------- */
function CircleDialog({ id }: { id: number | null }) {
  const c = useAdmin((s) => (id === null ? undefined : s.circles.find((x) => x.id === id)));
  const [v, setV] = useState({ name: c?.name ?? '', teacher: c?.teacher ?? TEACHER_NAMES[0], schedule: c?.schedule ?? '', level: c?.level ?? 'مبتدئ', capacity: String(c?.capacity ?? 10), members: c?.members ?? 0 });
  const [errs, setErrs] = useState<Record<string, string | null>>({});
  const up = (o: Partial<typeof v>) => { setV({ ...v, ...o }); setErrs({}); };
  const save = () => {
    const e: Record<string, string> = {}; const cap = parseInt(v.capacity, 10);
    if (v.name.trim().length < 3) e.name = 'أدخل اسم الحلقة';
    if (!v.schedule.trim()) e.schedule = 'حدّد الأيام والوقت';
    if (!cap || cap < 2 || cap > 40) e.capacity = 'السعة بين 2 و 40 طالبًا';
    else if (cap < v.members) e.capacity = `في الحلقة ${v.members} طلاب حاليًا؛ لا يمكن أن تقل السعة عن ذلك`;
    if (Object.keys(e).length) { setErrs(e); return; }
    saveCircle(id, { name: v.name.trim(), teacher: v.teacher, schedule: v.schedule.trim(), level: v.level, capacity: cap, members: v.members });
  };
  return (
    <Modal title={id === null ? 'حلقة جديدة' : `تعديل: ${c?.name}`}>
      <Field id="ci-name" label="اسم الحلقة" error={errs.name}>
        <input id="ci-name" value={v.name} aria-invalid={!!errs.name} onChange={(e) => up({ name: e.target.value })} style={inputStyle(errs.name)} />
      </Field>
      <Field id="ci-teacher" label="المعلم">
        <select id="ci-teacher" value={v.teacher} onChange={(e) => up({ teacher: e.target.value })} style={selStyle}>{TEACHER_NAMES.map((t) => <option key={t}>{t}</option>)}</select>
      </Field>
      <Field id="ci-sched" label="الموعد" error={errs.schedule} hint="بتوقيت الرياض (GMT+3)؛ يُعرض لكل طالب بتوقيته.">
        <input id="ci-sched" value={v.schedule} aria-invalid={!!errs.schedule} placeholder="مثال: الأحد والثلاثاء · 8:00 م" onChange={(e) => up({ schedule: e.target.value })} style={inputStyle(errs.schedule)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field id="ci-level" label="المستوى">
          <select id="ci-level" value={v.level} onChange={(e) => up({ level: e.target.value })} style={selStyle}>{[...LEVELS, 'جميع المستويات'].map((l) => <option key={l}>{l}</option>)}</select>
        </Field>
        <Field id="ci-cap" label="السعة" error={errs.capacity}>
          <input id="ci-cap" type="number" inputMode="numeric" min={2} max={40} dir="ltr" value={v.capacity} aria-invalid={!!errs.capacity} onChange={(e) => up({ capacity: e.target.value })} style={inputStyle(errs.capacity, false, { fontFamily: font.latin, textAlign: 'center' })} />
        </Field>
      </div>
      <Actions okL={id === null ? 'إنشاء كمسودة' : 'حفظ'} onOk={save} />
    </Modal>
  );
}

/* ---------------- Lecture / quiz ---------------- */
function ContentDialog({ id, ckind }: { id: number | null; ckind: 'lecture' | 'quiz' }) {
  const c = useAdmin((s) => (id === null ? undefined : s.content.find((x) => x.id === id)));
  const isLec = ckind === 'lecture';
  const kinds = isLec ? ['محاضرة فيديو', 'محاضرة صوتية'] : ['اختبار · اختيار من متعدد', 'اختبار · سؤال تلاوة'];
  const [v, setV] = useState({ name: c?.name ?? '', by: c?.by ?? TEACHER_NAMES[0], k: c?.k ?? kinds[0], topic: c?.topic ?? TOPICS[0], level: c?.level ?? 'مبتدئ' });
  const [err, setErr] = useState<string | null>(null);
  const up = (o: Partial<typeof v>) => { setV({ ...v, ...o }); setErr(null); };
  const save = () => { if (v.name.trim().length < 3) { setErr('أدخل العنوان'); return; } saveContent(id, { ...v, name: v.name.trim(), kind: ckind }); };
  return (
    <Modal title={id === null ? (isLec ? 'محاضرة جديدة' : 'اختبار جديد') : `تعديل: ${c?.name}`}>
      <Field id="co-name" label="العنوان" error={err}>
        <input id="co-name" value={v.name} aria-invalid={!!err} onChange={(e) => up({ name: e.target.value })} style={inputStyle(err)} />
      </Field>
      <Field id="co-by" label="المعلم المسؤول">
        <select id="co-by" value={v.by} onChange={(e) => up({ by: e.target.value })} style={selStyle}>{TEACHER_NAMES.map((t) => <option key={t}>{t}</option>)}</select>
      </Field>
      <Field id="co-k" label="النوع">
        <select id="co-k" value={v.k} onChange={(e) => up({ k: e.target.value })} style={selStyle}>{[...new Set([v.k, ...kinds])].map((k) => <option key={k}>{k}</option>)}</select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field id="co-topic" label="الموضوع">
          <select id="co-topic" value={v.topic} onChange={(e) => up({ topic: e.target.value })} style={selStyle}>{TOPICS.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field id="co-level" label="المستوى">
          <select id="co-level" value={v.level} onChange={(e) => up({ level: e.target.value })} style={selStyle}>{[...LEVELS, 'جميع المستويات'].map((l) => <option key={l}>{l}</option>)}</select>
        </Field>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: color.muted }}>{isLec ? 'رفع ملف الفيديو أو الصوت يتم من حساب المعلم ويحتاج ربطًا بالتخزين.' : 'تُضاف الأسئلة من حساب المعلم. سؤال التلاوة يقيّمه المعلم ولا يُصحَّح آليًا.'}</p>
      <Actions okL={id === null ? 'حفظ كمسودة' : 'حفظ'} onOk={save} />
    </Modal>
  );
}

/* ---------------- Detail drawers ---------------- */
function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div style={{ background: color.card, border: `1px solid ${color.border}`, borderRadius: 16, padding: '4px 16px' }}>
      {rows.map(([k, v], i) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderBottom: i < rows.length - 1 ? `1px solid ${color.divider}` : 'none' }}>
          <span style={{ fontSize: 14, color: color.muted }}>{k}</span><span style={{ fontSize: 15, fontWeight: 700, textAlign: 'left' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function StudentDrawer({ id }: { id: number }) {
  const s = useAdmin();
  const u = s.users.find((x) => x.id === id)!;
  const bookings = s.bookings.filter((b) => b.student === u.name);
  const circles = s.circles.filter((c) => c.teacher === u.teacher && (c.level === u.level || c.level === 'جميع المستويات'));
  return (
    <Modal title={u.name} drawer>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><StatusPill st={u.st} /><span style={{ fontSize: 13, color: color.muted }}>انضم {u.joined ?? '—'}</span></div>
      <Rows rows={[
        ['البريد', <bdi dir="ltr" style={{ fontFamily: font.latin, fontWeight: 500 }}>{u.email}</bdi>],
        ['العمر', u.age ? `${u.age} سنة` : '—'],
        ['المستوى', u.level ?? '—'],
        ['المعلم', u.teacher ?? 'غير مرتبط'],
        ['ولي الأمر', u.parent ?? 'غير مرتبط'],
      ]} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setAdmin({ dialog: { kind: 'link', id, approve: u.st === 'pending' } })} style={primaryBtn(44, 14, { padding: '0 14px', borderRadius: 10 })}>{u.st === 'pending' ? 'اعتماد وربط' : 'تعديل الربط'}</button>
        <button onClick={() => setAdmin({ dialog: { kind: 'user', id, role: u.role } })} style={outlineBtn(44, 14, { padding: '0 14px', borderRadius: 10 })}>تعديل البيانات</button>
      </div>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الحجوزات</h3>
        {bookings.length === 0 && <p style={{ margin: 0, fontSize: 14, color: color.muted }}>لا توجد حجوزات.</p>}
        {bookings.map((b) => (
          <div key={b.id} style={{ background: color.card, border: `1px solid ${color.border}`, borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>{b.when}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{b.teacher} · {b.type}</span></span>
            <StatusPill st={b.st} />
          </div>
        ))}
      </section>
      {circles.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>حلقات مناسبة مع معلمه</h3>
          {circles.map((c) => <p key={c.id} style={{ margin: 0, fontSize: 14 }}>{c.name} · <span style={{ color: color.muted }}>{c.schedule}</span></p>)}
        </section>
      )}
      <p style={{ margin: 0, fontSize: 12, color: color.muted }}>التسجيلات والتقييمات يطّلع عليها المعلم المرتبط فقط، ولا تُعرض في لوحة الإدارة حفاظًا على الخصوصية.</p>
    </Modal>
  );
}

function TeacherDrawer({ id }: { id: number }) {
  const s = useAdmin();
  const t = s.teachers.find((x) => x.id === id)!;
  const students = s.users.filter((u) => u.teacher === t.name && u.st === 'active');
  const circles = s.circles.filter((c) => c.teacher === t.name);
  const upcoming = s.bookings.filter((b) => b.teacher === t.name && b.st === 'confirmed');
  const content = s.content.filter((c) => c.by === t.name);
  return (
    <Modal title={t.name} drawer>
      <StatusPill st={t.st} />
      <Rows rows={[
        ['البريد', <bdi dir="ltr" style={{ fontFamily: font.latin, fontWeight: 500 }}>{t.email}</bdi>],
        ['التخصص', t.spec],
        ['أنواع الجلسات', t.types],
        ['طلاب مرتبطون', <span style={{ fontFamily: font.latin }}>{students.length}</span>],
        ['جلسات قادمة', <span style={{ fontFamily: font.latin }}>{upcoming.length}</span>],
      ]} />
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الحلقات</h3>
        {circles.length === 0 && <p style={{ margin: 0, fontSize: 14, color: color.muted }}>لا توجد حلقات.</p>}
        {circles.map((c) => (
          <div key={c.id} style={{ background: color.card, border: `1px solid ${color.border}`, borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>{c.name}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{c.schedule} · <bdi dir="ltr" style={{ fontFamily: font.latin }}>{c.members}/{c.capacity}</bdi></span></span>
            <StatusPill st={c.st} />
          </div>
        ))}
      </section>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>المحتوى</h3>
        {content.length === 0 && <p style={{ margin: 0, fontSize: 14, color: color.muted }}>لا يوجد محتوى.</p>}
        {content.map((c) => <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}><span style={{ flex: 1 }}>{c.name}</span><StatusPill st={c.st} /></div>)}
      </section>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>الطلاب ({students.length})</h3>
        <p style={{ margin: 0, fontSize: 14, color: color.body, lineHeight: 1.8 }}>{students.slice(0, 12).map((x) => x.name).join('، ')}{students.length > 12 ? ` و${students.length - 12} آخرون` : ''}</p>
      </section>
    </Modal>
  );
}
