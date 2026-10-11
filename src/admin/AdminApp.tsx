import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { FieldError, inputStyle, labelStyle, outlineBtn, primaryBtn } from '@/components/ui';
import { STATUS, TEACHER_NAMES, type AdminUser, type Status, type UserRole } from './adminData';
import {
  PAGE_SIZE, adminLogin, adminLogout, goSection, saveLink, saveUser, setAdmin, setStatus, toast, useAdmin, type Section,
} from './adminStore';

const card: CSSProperties = { background: color.card, border: `1px solid ${color.border}`, borderRadius: 16 };
const toApp = () => { window.location.hash = '#/'; };

/* ------------------------------------------------------------------ */
export default function AdminApp() {
  const authed = useAdmin((s) => s.authed);
  useEffect(() => { document.title = 'حَلْقة | لوحة الإدارة'; return () => { document.title = 'حَلْقة | HALQA'; }; }, []);
  return <div dir="rtl" lang="ar" style={{ minHeight: '100vh', background: color.ivory }}>{authed ? <Portal /> : <AdminLogin />}</div>;
}

/* ---------------- Separate admin sign-in ---------------- */
function AdminLogin() {
  const L = useAdmin((s) => s.login);
  const up = (o: Partial<typeof L>) => setAdmin({ login: { ...L, ...o } });
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); adminLogin(); }}
        style={{ ...card, width: '100%', maxWidth: 420, padding: 28, display: 'flex', flexDirection: 'column', gap: 16, borderRadius: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <img src="/assets/halqa-logo.png" alt="حَلْقة HALQA" style={{ width: 120, height: 120, objectFit: 'contain' }} />
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>دخول الإدارة</h1>
          <p style={{ margin: 0, fontSize: 14, color: color.muted }}>بوابة منفصلة لحسابات الإدارة فقط</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="ad-email" style={labelStyle}>البريد الإلكتروني</label>
          <input id="ad-email" type="email" dir="ltr" autoComplete="username" value={L.email} placeholder="admin@halqa.app" aria-invalid={!!L.errors.email}
            onChange={(e) => up({ email: e.target.value, errors: { ...L.errors, email: null } })} style={inputStyle(L.errors.email, true)} />
          <FieldError msg={L.errors.email} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="ad-pw" style={labelStyle}>كلمة المرور</label>
          <input id="ad-pw" type="password" dir="ltr" autoComplete="current-password" value={L.pw} aria-invalid={!!L.errors.pw}
            onChange={(e) => up({ pw: e.target.value, errors: { ...L.errors, pw: null } })} style={inputStyle(L.errors.pw, true)} />
          <FieldError msg={L.errors.pw} />
        </div>
        <button type="submit" disabled={L.loading} style={primaryBtn(52, 16)}>{L.loading ? 'جارٍ الدخول…' : 'دخول'}</button>
        <div style={{ background: color.sand, borderRadius: 12, padding: 12, fontSize: 13, color: color.subtle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span>حساب تجريبي: <bdi dir="ltr" style={{ fontFamily: font.latin }}>admin@halqa.app</bdi> / <bdi dir="ltr" style={{ fontFamily: font.latin }}>halqa123</bdi></span>
          <button type="button" onClick={() => up({ email: 'admin@halqa.app', pw: 'halqa123', errors: {} })}
            style={{ minHeight: 40, padding: '0 12px', borderRadius: 999, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>تعبئة</button>
        </div>
        <button type="button" onClick={toApp} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.muted, fontSize: 13, textDecoration: 'underline', cursor: 'pointer' }}>العودة إلى تطبيق الجوال</button>
      </form>
    </div>
  );
}

/* ---------------- Portal shell ---------------- */
const TITLES: Record<Section, [string, string]> = {
  overview: ['نظرة عامة', 'الأحد 11 أكتوبر 2026'],
  users: ['المستخدمون والربط', 'اعتماد الحسابات وربط الطلاب بالمعلمين وأولياء الأمور'],
  teachers: ['المعلمون', 'اعتماد المعلمين ومتابعة أعداد طلابهم'],
  content: ['المحتوى', 'مراجعة المحاضرات والاختبارات قبل نشرها للطلاب'],
  subs: ['الاشتراكات', 'حالة الباقات ومواعيد التجديد'],
};

function Portal() {
  const s = useAdmin();
  const pc = (k: 'users' | 'teachers' | 'content' | 'subs') => (s[k] as { st: Status }[]).filter((x) => x.st === 'pending').length;
  const secs: [Section, string, number][] = [['overview', 'نظرة عامة', 0], ['users', 'المستخدمون والربط', pc('users')], ['teachers', 'المعلمون', pc('teachers')], ['content', 'المحتوى', pc('content')], ['subs', 'الاشتراكات', pc('subs')]];
  const [title, sub] = TITLES[s.sec];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexWrap: 'wrap' }}>
      <aside style={{ flex: '1 0 240px', maxWidth: '100%', background: color.primary, color: color.ivory, padding: '20px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px 18px' }}>
          <img src="/assets/halqa-mark-ivory.png" alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />
          <div><p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>حَلْقة</p><p style={{ margin: 0, fontSize: 12, color: color.liveSub }}>لوحة الإدارة</p></div>
        </div>
        <nav aria-label="أقسام الإدارة" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {secs.map(([k, l, c]) => {
            const cur = s.sec === k;
            return (
              <button key={k} onClick={() => goSection(k)} aria-current={cur ? 'page' : undefined}
                style={{ minHeight: 48, padding: '0 14px', border: 'none', borderRadius: 12, background: cur ? color.ivory : 'transparent', color: cur ? color.primary : color.ivory, fontSize: 15, fontWeight: 700, textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                {l}
                {c > 0 && <span aria-label={`${c} بانتظار المراجعة`} style={{ minWidth: 24, height: 24, borderRadius: 999, background: color.gold, color: color.ink, fontFamily: font.latin, fontSize: 12, display: 'grid', placeItems: 'center', padding: '0 6px' }}>{c}</span>}
              </button>
            );
          })}
        </nav>
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 16 }}>
          <button onClick={toApp} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.sage, fontSize: 14, textAlign: 'right', padding: '0 14px', cursor: 'pointer', textDecoration: 'underline' }}>← العودة إلى نموذج الجوال</button>
          <button onClick={adminLogout} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.sage, fontSize: 14, textAlign: 'right', padding: '0 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="leave" size={18} /> تسجيل الخروج</button>
        </div>
      </aside>
      <main style={{ flex: '999 1 600px', minWidth: 0, padding: '28px clamp(16px,3vw,40px)', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div><h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{title}</h1><p style={{ margin: '4px 0 0', fontSize: 14, color: color.muted }}>{sub}</p></div>
          <span style={{ fontSize: 13, color: color.muted, background: color.sand, padding: '6px 12px', borderRadius: 999 }}>بيانات عرض تجريبية</span>
        </header>
        {s.sec === 'overview' ? <Overview pc={pc} /> : <TableSection />}
      </main>
      {s.dialog?.kind === 'link' && <LinkDialog id={s.dialog.id} approve={s.dialog.approve} />}
      {s.dialog?.kind === 'user' && <UserDialog id={s.dialog.id} />}
      {s.toast && <div role="status" aria-live="polite" style={{ position: 'fixed', bottom: 24, left: 24, maxWidth: 'calc(100vw - 48px)', background: color.ink, color: color.ivory, padding: '14px 18px', borderRadius: 14, fontSize: 14, boxShadow: '0 12px 28px -12px rgba(0,0,0,.4)', zIndex: 60 }}>{s.toast}</div>}
    </div>
  );
}

function Overview({ pc }: { pc: (k: 'users' | 'teachers' | 'content' | 'subs') => number }) {
  const s = useAdmin();
  const activeStudents = s.users.filter((u) => u.role !== 'ولي أمر' && u.st === 'active').length;
  const kpis = [
    { l: 'طلاب نشطون', v: String(activeStudents), s: '+9 هذا الشهر' },
    { l: 'معلمون نشطون', v: String(s.teachers.filter((x) => x.st === 'active').length), s: `${pc('teachers')} بانتظار الاعتماد` },
    { l: 'جلسات هذا الأسبوع', v: '318', s: 'نسبة الحضور 91%' },
    { l: 'تسجيلات بانتظار التقييم', v: '27', s: 'متوسط الرد 18 ساعة' },
  ];
  const todo: [string, string, Section, number][] = [
    [`${pc('users')} حسابات بانتظار الاعتماد والربط`, 'المستخدمون', 'users', pc('users')],
    [`${pc('content')} محتوى بانتظار النشر`, 'المحتوى', 'content', pc('content')],
    [`${pc('teachers')} طلب انضمام معلم`, 'المعلمون', 'teachers', pc('teachers')],
    [`${pc('subs')} اشتراكات بانتظار التفعيل`, 'الاشتراكات', 'subs', pc('subs')],
  ];
  const open = todo.filter((t) => t[3] > 0);
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
        {kpis.map((k) => (
          <div key={k.l} style={{ ...card, padding: 18 }}>
            <p style={{ margin: 0, fontSize: 14, color: color.muted }}>{k.l}</p>
            <p style={{ margin: '6px 0 0', fontSize: 30, fontWeight: 800, fontFamily: font.latin }}>{k.v}</p>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: color.primary }}>{k.s}</p>
          </div>
        ))}
      </div>
      <section style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>يحتاج إجراء</h2>
        {open.length === 0 && <p style={{ margin: 0, fontSize: 15, color: color.muted, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="check" size={18} /> لا توجد إجراءات معلقة.</p>}
        {open.map(([l, a, k]) => (
          <button key={k} onClick={() => goSection(k)} style={{ minHeight: 52, padding: '0 14px', borderRadius: 12, border: `1px solid ${color.divider}`, background: color.ivory, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink, fontSize: 15 }}>
            <span style={{ flex: 1 }}>{l}</span><span style={{ fontWeight: 700, color: color.primary }}>{a} ←</span>
          </button>
        ))}
      </section>
    </>
  );
}

/* ---------------- Tables ---------------- */
interface Act { label: string; click: () => void; primary?: boolean }
interface Row { id: number; name: string; c2: ReactNode; c3: ReactNode; st: Status; role?: UserRole; acts: Act[] }

function useRows(): { cols: string[]; rows: Row[] } {
  const s = useAdmin();
  switch (s.sec) {
    case 'users': return {
      cols: ['الاسم', 'الدور', 'المعلم / الأبناء المرتبطون', 'الحالة', 'إجراء'],
      rows: s.users.map((x) => {
        const links = x.role === 'ولي أمر' ? (x.children.length ? x.children.join('، ') : 'غير مرتبط') : [x.teacher, x.parent && `ولي الأمر: ${x.parent}`].filter(Boolean).join(' · ') || (x.role === 'طالبة' ? 'غير مرتبطة' : 'غير مرتبط');
        return {
          id: x.id, name: x.name, c2: x.role, c3: links, st: x.st, role: x.role,
          acts: x.st === 'pending'
            ? [{ label: 'اعتماد وربط', click: () => setAdmin({ dialog: { kind: 'link', id: x.id, approve: true } }), primary: true }]
            : [{ label: 'تعديل الربط', click: () => setAdmin({ dialog: { kind: 'link', id: x.id, approve: false } }) },
              { label: 'تعديل', click: () => setAdmin({ dialog: { kind: 'user', id: x.id } }) },
              x.st === 'off' ? { label: 'إعادة تفعيل', click: () => setStatus('users', x.id, 'active', `أُعيد تفعيل ${x.name}`) } : { label: 'إيقاف', click: () => setStatus('users', x.id, 'off', `أُوقف حساب ${x.name}`) }],
        };
      }),
    };
    case 'teachers': return {
      cols: ['المعلم', 'التخصص', 'الطلاب', 'الحالة', 'إجراء'],
      rows: s.teachers.map((x) => ({
        id: x.id, name: x.name, c2: x.spec, c3: x.n, st: x.st,
        acts: x.st === 'pending'
          ? [{ label: 'اعتماد', click: () => setStatus('teachers', x.id, 'active', 'تم اعتماد ' + x.name), primary: true }, { label: 'رفض', click: () => setStatus('teachers', x.id, 'off', 'رُفض الطلب') }]
          : [{ label: x.st === 'off' ? 'إعادة تفعيل' : 'إيقاف', click: () => setStatus('teachers', x.id, x.st === 'off' ? 'active' : 'off', 'تم التحديث') }],
      })),
    };
    case 'content': return {
      cols: ['العنوان', 'المعلم', 'النوع', 'الحالة', 'إجراء'],
      rows: s.content.map((x) => ({
        id: x.id, name: x.name, c2: x.by, c3: x.k, st: x.st,
        acts: x.st === 'pending'
          ? [{ label: 'نشر', click: () => setStatus('content', x.id, 'active', 'نُشر المحتوى للطلاب'), primary: true }, { label: 'إعادة للمعلم', click: () => setStatus('content', x.id, 'off', 'أُعيد للمعلم مع ملاحظة') }]
          : x.st === 'off' ? [{ label: 'نشر', click: () => setStatus('content', x.id, 'active', 'نُشر المحتوى للطلاب'), primary: true }]
            : [{ label: 'إلغاء النشر', click: () => setStatus('content', x.id, 'off', 'أُلغي النشر') }],
      })),
    };
    case 'subs': return {
      cols: ['المشترك', 'الباقة', 'التجديد', 'الحالة', 'إجراء'],
      rows: s.subs.map((x) => ({
        id: x.id, name: x.name, c2: x.plan, c3: x.due, st: x.st,
        acts: x.st === 'active' ? [{ label: 'تفاصيل', click: () => toast('سجل المدفوعات (تجريبي) — يحتاج ربطًا بمزود الدفع') }]
          : [{ label: 'تفعيل', click: () => setStatus('subs', x.id, 'active', 'تم تفعيل الاشتراك'), primary: true }],
      })),
    };
    default: return { cols: [], rows: [] };
  }
}

const chip = (on: boolean): CSSProperties => ({ minHeight: 48, padding: '0 16px', borderRadius: 12, border: `1.5px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontWeight: 700, cursor: 'pointer' });

function TableSection() {
  const s = useAdmin();
  const { cols, rows: all } = useRows();
  const q = s.q.trim();
  const present = new Set(all.map((r) => r.st));
  const filters: ['all' | Status, string][] = [['all', 'الكل'], ['pending', 'بانتظار المراجعة'], ['active', 'نشط'], ...(['expired', 'off'] as Status[]).filter((k) => present.has(k)).map((k) => [k, STATUS[k].label] as [Status, string])];
  const rows = all.filter((r) => (!q || r.name.includes(q)) && (s.f === 'all' || r.st === s.f) && (s.sec !== 'users' || s.role === 'all' || (s.role === 'student' ? r.role !== 'ولي أمر' : r.role === 'ولي أمر')));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(s.page, pages);
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input type="search" aria-label="بحث" placeholder="ابحث بالاسم" value={s.q} onChange={(e) => setAdmin({ q: e.target.value, page: 1 })}
          style={{ flex: '1 1 260px', minHeight: 48, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 }} />
        {s.sec === 'users' && (
          <select aria-label="نوع الحساب" value={s.role} onChange={(e) => setAdmin({ role: e.target.value, page: 1 })}
            style={{ minHeight: 48, padding: '0 12px', borderRadius: 12, border: `1.5px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontWeight: 700, fontSize: 15 }}>
            <option value="all">كل الأدوار</option><option value="student">الطلاب</option><option value="parent">أولياء الأمور</option>
          </select>
        )}
        {filters.map(([k, l]) => <button key={k} aria-pressed={s.f === k} onClick={() => setAdmin({ f: k, page: 1 })} style={chip(s.f === k)}>{l}</button>)}
        {s.sec === 'users' && <button onClick={() => setAdmin({ dialog: { kind: 'user', id: null } })} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6 })}><Icon name="plus" size={18} /> إضافة مستخدم</button>}
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 680 }}>
          <thead><tr style={{ background: color.sand, textAlign: 'right' }}>{cols.map((c) => <th key={c} scope="col" style={{ padding: '12px 16px', fontWeight: 700, color: color.body }}>{c}</th>)}</tr></thead>
          <tbody>
            {shown.map((r) => {
              const t = STATUS[r.st];
              return (
                <tr key={r.id} style={{ borderTop: `1px solid ${color.divider}` }}>
                  <td style={{ padding: '12px 16px', fontWeight: 700 }}>{r.name}</td>
                  <td style={{ padding: '12px 16px', color: color.body }}>{r.c2}</td>
                  <td style={{ padding: '12px 16px', color: color.body }}>{r.c3}</td>
                  <td style={{ padding: '12px 16px' }}><span style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>{t.label}</span></td>
                  <td style={{ padding: '8px 16px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {r.acts.map((a) => (
                        <button key={a.label} onClick={a.click} aria-label={`${a.label}: ${r.name}`}
                          style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: `1px solid ${a.primary ? color.primary : color.borderStrong}`, background: a.primary ? color.primary : 'transparent', color: a.primary ? color.ivory : color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>{a.label}</button>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p style={{ margin: 0, padding: 28, textAlign: 'center', color: color.muted }}>لا توجد نتائج مطابقة.</p>}
      </div>
      {rows.length > PAGE_SIZE && <Pager page={page} pages={pages} total={rows.length} />}
    </>
  );
}

function Pager({ page, pages, total }: { page: number; pages: number; total: number }) {
  const go = (p: number) => setAdmin({ page: Math.max(1, Math.min(pages, p)) });
  // Window of up to 5 page numbers around the current page.
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const nums = Array.from({ length: Math.min(5, pages) }, (_, i) => start + i);
  const btn = (on: boolean, disabled = false): CSSProperties => ({ minWidth: 44, minHeight: 44, padding: '0 10px', borderRadius: 10, border: `1px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontFamily: font.latin, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1 });
  return (
    <nav aria-label="الصفحات" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <p style={{ margin: 0, fontSize: 14, color: color.muted }}>عرض {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} من {total}</p>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => go(page - 1)} disabled={page === 1} aria-label="الصفحة السابقة" style={btn(false, page === 1)}><Icon name="chevR" size={18} /></button>
        {nums.map((n) => <button key={n} onClick={() => go(n)} aria-label={`الصفحة ${n}`} aria-current={n === page ? 'page' : undefined} style={btn(n === page)}>{n}</button>)}
        <button onClick={() => go(page + 1)} disabled={page === pages} aria-label="الصفحة التالية" style={btn(false, page === pages)}><Icon name="chevL" size={18} /></button>
      </div>
    </nav>
  );
}

/* ---------------- Dialogs ---------------- */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector('input,select,button') as HTMLElement | null)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(12,36,33,.45)' }} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        style={{ position: 'relative', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', background: color.ivory, borderRadius: 20, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{title}</h2>
          <button onClick={onClose} aria-label="إغلاق" style={{ width: 44, height: 44, border: 'none', background: 'transparent', color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
const close = () => setAdmin({ dialog: null });
const selStyle: CSSProperties = { ...inputStyle(false), padding: '0 12px' };

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
    <Modal title={approve ? `اعتماد وربط: ${u.name}` : `تعديل الربط: ${u.name}`} onClose={close}>
      <p style={{ margin: 0, fontSize: 14, color: color.muted }}>{u.role} · <bdi dir="ltr" style={{ fontFamily: font.latin }}>{u.email}</bdi></p>
      {!isParent ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="ln-teacher" style={labelStyle}>المعلم</label>
            <select id="ln-teacher" value={teacher} onChange={(e) => { setTeacher(e.target.value); setErr(null); }} style={selStyle}>
              <option value="">— بدون معلم —</option>
              {TEACHER_NAMES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <FieldError msg={err} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="ln-parent" style={labelStyle}>ولي الأمر</label>
            <select id="ln-parent" value={parent} onChange={(e) => setParent(e.target.value)} style={selStyle}>
              <option value="">— غير مرتبط —</option>
              {parents.map((p) => <option key={p.id}>{p.name}</option>)}
            </select>
            <p style={{ margin: 0, fontSize: 12, color: color.muted }}>يرى ولي الأمر بيانات أبنائه المرتبطين فقط.</p>
          </div>
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
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button onClick={close} style={outlineBtn(48, 15, { flex: 1 })}>إلغاء</button>
        <button onClick={save} style={primaryBtn(48, 15, { flex: 1 })}>{approve ? 'اعتماد وحفظ الربط' : 'حفظ الربط'}</button>
      </div>
    </Modal>
  );
}

const ROLES: UserRole[] = ['طالب', 'طالبة', 'ولي أمر'];

function UserDialog({ id }: { id: number | null }) {
  const users = useAdmin((s) => s.users);
  const u: AdminUser | undefined = id === null ? undefined : users.find((x) => x.id === id);
  const [name, setName] = useState(u?.name ?? '');
  const [email, setEmail] = useState(u?.email ?? '');
  const [role, setRole] = useState<UserRole>(u?.role ?? 'طالب');
  const [errs, setErrs] = useState<Record<string, string | null>>({});
  const save = () => {
    const e: Record<string, string> = {}; const em = email.trim().toLowerCase();
    if (name.trim().length < 2) e.name = 'أدخل الاسم الكامل';
    if (!em) e.email = 'أدخل البريد الإلكتروني'; else if (!/^\S+@\S+\.\S+$/.test(em)) e.email = 'صيغة البريد الإلكتروني غير صحيحة';
    else if (users.some((x) => x.email === em && x.id !== id)) e.email = 'هذا البريد مستخدم لحساب آخر';
    if (Object.keys(e).length) { setErrs(e); return; }
    saveUser(id, { name: name.trim(), email: em, role });
  };
  return (
    <Modal title={id === null ? 'إضافة مستخدم' : `تعديل: ${u?.name}`} onClose={close}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="us-name" style={labelStyle}>الاسم الكامل</label>
        <input id="us-name" value={name} aria-invalid={!!errs.name} onChange={(e) => { setName(e.target.value); setErrs({ ...errs, name: null }); }} style={inputStyle(errs.name)} />
        <FieldError msg={errs.name} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="us-email" style={labelStyle}>البريد الإلكتروني</label>
        <input id="us-email" type="email" dir="ltr" value={email} aria-invalid={!!errs.email} placeholder="name@example.com" onChange={(e) => { setEmail(e.target.value); setErrs({ ...errs, email: null }); }} style={inputStyle(errs.email, true)} />
        <FieldError msg={errs.email} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor="us-role" style={labelStyle}>نوع الحساب</label>
        <select id="us-role" value={role} onChange={(e) => setRole(e.target.value as UserRole)} disabled={id !== null && u?.role === 'ولي أمر' && u.children.length > 0} style={selStyle}>
          {ROLES.map((r) => <option key={r}>{r}</option>)}
        </select>
        <p style={{ margin: 0, fontSize: 12, color: color.muted }}>حسابات المعلمين تُعتمد من قسم «المعلمون». تُرسل دعوة الدخول بالبريد بعد الحفظ (تجريبي).</p>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button onClick={close} style={outlineBtn(48, 15, { flex: 1 })}>إلغاء</button>
        <button onClick={save} style={primaryBtn(48, 15, { flex: 1 })}>{id === null ? 'إضافة' : 'حفظ'}</button>
      </div>
    </Modal>
  );
}
