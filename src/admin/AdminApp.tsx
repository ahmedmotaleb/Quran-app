import { useEffect, useState, type FormEvent } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import type { Status } from './adminData';
import { adminLogin, adminLogout, goSection, setAdmin, useAdmin, type AdminState, type Section } from './adminStore';
import { StatusPill, TableSection, card } from './AdminTables';
import AdminDialogs from './AdminDialogs';
import AdminSettings from './AdminSettings';

const toApp = () => { window.location.hash = '#/'; };

function useNarrow() {
  const q = '(max-width: 899px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, []);
  return m;
}

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
const NAV: [Section, string, IconName][] = [
  ['overview', 'نظرة عامة', 'home'], ['students', 'الطلاب', 'user'], ['teachers', 'المعلمون', 'award'], ['parents', 'أولياء الأمور', 'users'],
  ['circles', 'الحلقات', 'target'], ['bookings', 'الحجوزات', 'cal'], ['lectures', 'المحاضرات', 'video'], ['quizzes', 'الاختبارات', 'plan'],
  ['subs', 'الاشتراكات', 'file'], ['settings', 'الإعدادات', 'settings'],
];
const TITLES: Record<Section, string> = {
  overview: 'الأحد 11 أكتوبر 2026',
  students: 'اعتماد حسابات الطلاب وربطهم بالمعلمين وأولياء الأمور',
  teachers: 'اعتماد المعلمين ومتابعة طلابهم وحلقاتهم',
  parents: 'ربط أولياء الأمور بأبنائهم؛ يرى كلٌّ منهم بيانات أبنائه فقط',
  circles: 'الحلقات الجماعية ومواعيدها وسعتها',
  bookings: 'كل الحجوزات على المنصة بتوقيت الرياض',
  lectures: 'مراجعة المحاضرات قبل نشرها للطلاب',
  quizzes: 'مراجعة الاختبارات قبل نشرها للطلاب',
  subs: 'حالة الباقات ومواعيد التجديد',
  settings: 'إعدادات المنصة العامة',
};

/** Items awaiting admin action, per section (shown as sidebar badges and on the overview). */
function pendingCounts(s: AdminState): Partial<Record<Section, number>> {
  const p = (xs: { st: Status }[]) => xs.filter((x) => x.st === 'pending').length;
  return {
    students: p(s.users.filter((u) => u.role !== 'ولي أمر')), parents: p(s.users.filter((u) => u.role === 'ولي أمر')),
    teachers: p(s.teachers), lectures: p(s.content.filter((c) => c.kind === 'lecture')), quizzes: p(s.content.filter((c) => c.kind === 'quiz')),
    subs: p(s.subs), circles: s.circles.filter((c) => c.st === 'draft').length,
  };
}

function Portal() {
  const s = useAdmin();
  const narrow = useNarrow();
  const counts = pendingCounts(s);
  const label = NAV.find((n) => n[0] === s.sec)![1];

  const nav = (
    <nav aria-label="أقسام الإدارة" style={narrow
      ? { display: 'flex', gap: 4, overflowX: 'auto', padding: '0 12px 10px', margin: '0 -0px' }
      : { display: 'flex', flexDirection: 'column', gap: 4 }}>
      {NAV.map(([k, l, ic]) => {
        const cur = s.sec === k; const c = counts[k] ?? 0;
        return (
          <button key={k} onClick={() => goSection(k)} aria-current={cur ? 'page' : undefined}
            style={{ minHeight: 48, padding: '0 14px', border: 'none', borderRadius: 12, background: cur ? color.ivory : 'transparent', color: cur ? color.primary : color.ivory, fontSize: 15, fontWeight: 700, textAlign: 'right', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}>
            <Icon name={ic} size={18} /><span style={{ flex: 1 }}>{l}</span>
            {c > 0 && <span aria-label={`${c} بانتظار إجراء`} style={{ minWidth: 24, height: 24, borderRadius: 999, background: color.gold, color: color.ink, fontFamily: font.latin, fontSize: 12, display: 'grid', placeItems: 'center', padding: '0 6px' }}>{c}</span>}
          </button>
        );
      })}
    </nav>
  );
  const brand = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: narrow ? '12px 16px' : '0 6px 18px' }}>
      <img src="/assets/halqa-mark-ivory.png" alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />
      <div style={{ flex: 1 }}><p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>حَلْقة</p><p style={{ margin: 0, fontSize: 12, color: color.liveSub }}>لوحة الإدارة</p></div>
      {narrow && <button onClick={adminLogout} aria-label="تسجيل الخروج" style={{ width: 44, height: 44, border: 'none', background: 'transparent', color: color.sage, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="leave" /></button>}
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: narrow ? 'column' : 'row' }}>
      {narrow ? (
        <header style={{ background: color.primary, color: color.ivory, position: 'sticky', top: 0, zIndex: 20 }}>{brand}{nav}</header>
      ) : (
        <aside style={{ flex: '0 0 248px', background: color.primary, color: color.ivory, padding: '20px 14px', display: 'flex', flexDirection: 'column', gap: 6, position: 'sticky', top: 0, height: '100vh', overflowY: 'auto' }}>
          {brand}{nav}
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 16 }}>
            <button onClick={toApp} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.sage, fontSize: 14, textAlign: 'right', padding: '0 14px', cursor: 'pointer', textDecoration: 'underline' }}>← العودة إلى نموذج الجوال</button>
            <button onClick={adminLogout} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.sage, fontSize: 14, textAlign: 'right', padding: '0 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="leave" size={18} /> تسجيل الخروج</button>
          </div>
        </aside>
      )}
      <main style={{ flex: 1, minWidth: 0, padding: '28px clamp(16px,3vw,40px)', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div><h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{label}</h1><p style={{ margin: '4px 0 0', fontSize: 14, color: color.muted }}>{TITLES[s.sec]}</p></div>
          <span style={{ fontSize: 13, color: color.muted, background: color.sand, padding: '6px 12px', borderRadius: 999 }}>بيانات عرض تجريبية</span>
        </header>
        {s.sec === 'overview' ? <Overview counts={counts} /> : s.sec === 'settings' ? <AdminSettings /> : <TableSection key={s.sec} sec={s.sec} />}
      </main>
      <AdminDialogs />
      {s.toast && <div role="status" aria-live="polite" style={{ position: 'fixed', bottom: 24, left: 24, maxWidth: 'calc(100vw - 48px)', background: color.ink, color: color.ivory, padding: '14px 18px', borderRadius: 14, fontSize: 14, boxShadow: '0 12px 28px -12px rgba(0,0,0,.4)', zIndex: 60 }}>{s.toast}</div>}
    </div>
  );
}

/* ---------------- Overview ---------------- */
const TODO: [Section, (n: number) => string][] = [
  ['students', (n) => `${n} طلاب بانتظار الاعتماد والربط`],
  ['parents', (n) => `${n} أولياء أمور بانتظار الاعتماد والربط`],
  ['teachers', (n) => `${n} طلب انضمام معلم`],
  ['lectures', (n) => `${n} محاضرات بانتظار النشر`],
  ['quizzes', (n) => `${n} اختبارات بانتظار النشر`],
  ['circles', (n) => `${n} حلقات مسودة لم تُنشر`],
  ['subs', (n) => `${n} اشتراكات بانتظار التفعيل`],
];

function Overview({ counts }: { counts: Partial<Record<Section, number>> }) {
  const s = useAdmin();
  const students = s.users.filter((u) => u.role !== 'ولي أمر');
  const unlinked = students.filter((u) => u.st === 'active' && !u.teacher).length;
  const confirmed = s.bookings.filter((b) => b.st === 'confirmed');
  const cancelled = s.bookings.filter((b) => b.st === 'cancelled').length;
  const seats = s.circles.filter((c) => c.st === 'active' || c.st === 'full');
  const fill = seats.length ? Math.round((seats.reduce((a, c) => a + c.members, 0) / seats.reduce((a, c) => a + c.capacity, 0)) * 100) : 0;
  const kpis = [
    { l: 'طلاب نشطون', v: students.filter((u) => u.st === 'active').length, s: unlinked ? `${unlinked} دون معلم مرتبط` : 'كلهم مرتبطون بمعلمين', go: 'students' as Section },
    { l: 'معلمون نشطون', v: s.teachers.filter((x) => x.st === 'active').length, s: `${counts.teachers ?? 0} بانتظار الاعتماد`, go: 'teachers' as Section },
    { l: 'حجوزات قادمة', v: confirmed.length, s: `${cancelled} حجوزات ملغاة`, go: 'bookings' as Section },
    { l: 'إشغال الحلقات', v: `${fill}%`, s: `${seats.length} حلقات منشورة`, go: 'circles' as Section },
  ];
  const open = TODO.filter(([k]) => (counts[k] ?? 0) > 0);
  const today = confirmed.filter((b) => b.when.startsWith('الأحد 11 أكتوبر')).slice(0, 6);

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 14 }}>
        {kpis.map((k) => (
          <button key={k.l} onClick={() => goSection(k.go)} style={{ ...card, padding: 18, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
            <p style={{ margin: 0, fontSize: 14, color: color.muted }}>{k.l}</p>
            <p style={{ margin: '6px 0 0', fontSize: 30, fontWeight: 800, fontFamily: font.latin }}>{k.v}</p>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: color.primary }}>{k.s}</p>
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,360px),1fr))', gap: 14, alignItems: 'start' }}>
        <section style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>يحتاج إجراء</h2>
          {open.length === 0 && <p style={{ margin: 0, fontSize: 15, color: color.muted, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="check" size={18} /> لا توجد إجراءات معلقة.</p>}
          {open.map(([k, txt]) => (
            <button key={k} onClick={() => goSection(k)} style={{ minHeight: 52, padding: '0 14px', borderRadius: 12, border: `1px solid ${color.divider}`, background: color.ivory, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink, fontSize: 15 }}>
              <span style={{ flex: 1 }}>{txt(counts[k]!)}</span><span style={{ fontWeight: 700, color: color.primary, whiteSpace: 'nowrap' }}>{NAV.find((n) => n[0] === k)![1]} ←</span>
            </button>
          ))}
        </section>
        <section style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>جلسات اليوم</h2>
            <button onClick={() => goSection('bookings')} style={{ minHeight: 40, border: 'none', background: 'transparent', color: color.primary, fontWeight: 700, cursor: 'pointer' }}>كل الحجوزات ←</button>
          </div>
          {today.length === 0 && <p style={{ margin: 0, fontSize: 15, color: color.muted }}>لا توجد جلسات اليوم.</p>}
          {today.map((b) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 48, borderTop: `1px solid ${color.divider}`, paddingTop: 8 }}>
              <span style={{ minWidth: 64, fontWeight: 800, fontSize: 14 }}>{b.when.split(' · ')[1]}</span>
              <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>{b.student}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{b.teacher} · {b.type}</span></span>
              <StatusPill st={b.st} />
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
