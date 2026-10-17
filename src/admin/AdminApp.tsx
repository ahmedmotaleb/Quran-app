import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import { FieldError, inputStyle, labelStyle, primaryBtn } from '@/components/ui';
import type { Status } from './adminData';
import { adminLogin, adminLogout, adminRestore, goSection, sectionFromHash, mfaFinish, mfaStart, setAdmin, useAdmin, type AdminState, type Section } from './adminStore';
import { LIVE, type ApiError } from '@/api/client';
import * as LA from './live/api';
const PeopleLive = lazy(() => import('./live/People'));
const CirclesLive = lazy(() => import('./live/Scheduling').then((m) => ({ default: m.CirclesLive })));
const BookingsLive = lazy(() => import('./live/Scheduling').then((m) => ({ default: m.BookingsLive })));
/** Non-people sections that run on the API in live mode. */
const CoursesLive = lazy(() => import('./live/Content').then((m) => ({ default: m.CoursesLive })));
const QuizzesLive = lazy(() => import('./live/Content').then((m) => ({ default: m.QuizzesLive })));
const SettingsLive = lazy(() => import('./live/Settings'));
const LIVE_OTHER: Partial<Record<Section, () => JSX.Element>> = {
  settings: () => <SettingsLive />, circles: () => <CirclesLive />, bookings: () => <BookingsLive />, lectures: () => <CoursesLive />, quizzes: () => <QuizzesLive />,
};

/** Sections that run on the real API in live mode; the rest still show demo data (labelled). */
const LIVE_SECTIONS: Partial<Record<Section, LA.Role>> = { students: 'student', teachers: 'teacher', parents: 'parent' };
type LiveCounts = Partial<Record<LA.Role, LA.Counts>> & { drafts?: LA.Drafts };
function useLiveCounts(sec: Section) {
  const [c, setC] = useState<LiveCounts>({});
  useEffect(() => {
    if (!LIVE) return;
    let on = true;
    Promise.all((['student', 'teacher', 'parent'] as const).map((r) => LA.peopleCounts(r).then((x) => [r, x] as const)))
      .then((xs) => { if (on) setC((p) => ({ ...p, ...Object.fromEntries(xs) })); }).catch(() => { /* badges are optional */ });
    LA.contentDrafts().then((d) => { if (on) setC((p) => ({ ...p, drafts: d })); }).catch(() => {});
    return () => { on = false; };
  }, [sec]);
  return c;
}
import { StatusPill, TableSection, card } from './AdminTables';
import AdminDialogs from './AdminDialogs';
import AdminSettings from './AdminSettings';
import { BRAND, pageTitle } from '@/theme/brand';
import { Logo } from '@/components/Logo';

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
  const restoring = useAdmin((s) => s.restoring);
  useEffect(() => { document.title = pageTitle('لوحة الإدارة'); void adminRestore(); return () => { document.title = pageTitle(); }; }, []);
  return (
    <div dir="rtl" lang="ar" style={{ minHeight: '100vh', background: color.ivory }}>
      {restoring ? <p role="status" style={{ margin: 0, padding: 40, textAlign: 'center', color: color.muted }}>جارٍ التحقق من الجلسة…</p>
        : authed ? <Portal /> : <AdminLogin />}
    </div>
  );
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
          <Logo size={72} />
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
        {L.needOtp && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="ad-otp" style={labelStyle}>رمز التحقق</label>
            <p style={{ margin: 0, fontSize: 13, color: color.muted }}>افتح تطبيق المصادقة وأدخل الرمز المكوّن من 6 أرقام.</p>
            <input id="ad-otp" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} autoFocus value={L.otp} aria-invalid={!!L.errors.otp}
              onChange={(e) => up({ otp: e.target.value.replace(/\D/g, ''), errors: { ...L.errors, otp: null } })} style={inputStyle(L.errors.otp, true)} />
            <FieldError msg={L.errors.otp} />
          </div>
        )}
        {L.errors.form && <p role="alert" style={{ margin: 0, fontSize: 14, color: color.danger }}>{L.errors.form}</p>}
        <button type="submit" disabled={L.loading} style={primaryBtn(52, 16)}>{L.loading ? 'جارٍ الدخول…' : L.needOtp ? 'تحقق ودخول' : 'دخول'}</button>
        {!LIVE && <div style={{ background: color.sand, borderRadius: 12, padding: 12, fontSize: 13, color: color.subtle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span>حساب تجريبي: <bdi dir="ltr" style={{ fontFamily: font.latin }}>admin@halqa.app</bdi> / <bdi dir="ltr" style={{ fontFamily: font.latin }}>halqa123</bdi></span>
          <button type="button" onClick={() => up({ email: 'admin@halqa.app', pw: 'halqa123', errors: {} })}
            style={{ minHeight: 40, padding: '0 12px', borderRadius: 999, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>تعبئة</button>
        </div>}
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
// No payments yet (owner decision): the live portal has no Subscriptions section; the demo keeps its sample.
const NAV_SHOWN = LIVE ? NAV.filter(([k]) => k !== 'subs') : NAV;
const todayCairo = () => new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
const TITLES: Record<Section, string> = {
  overview: LIVE ? '' : 'الأحد 11 أكتوبر 2026',
  students: 'اعتماد حسابات الطلاب وربطهم بالمعلمين وأولياء الأمور',
  teachers: 'اعتماد المعلمين ومتابعة طلابهم وحلقاتهم',
  parents: 'ربط أولياء الأمور بأبنائهم؛ يرى كلٌّ منهم بيانات أبنائه فقط',
  circles: 'الحلقات الجماعية ومواعيدها وسعتها',
  bookings: 'كل الحجوزات على المنصة بتوقيت القاهرة',
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
  const lc = useLiveCounts(s.sec);
  const counts: Partial<Record<Section, number>> = LIVE
    ? { students: (lc.student?.pending ?? 0) + (lc.student?.unlinked ?? 0), teachers: (lc.teacher?.pending ?? 0) + (lc.teacher?.unapproved ?? 0), parents: lc.parent?.pending ?? 0 }
    : pendingCounts(s);
  const liveRole = LIVE ? LIVE_SECTIONS[s.sec] : undefined;
  const liveOther = LIVE ? LIVE_OTHER[s.sec] : undefined;
  const demoBadge = LIVE && !liveRole && !liveOther && s.sec !== 'overview';
  useEffect(() => { if (LIVE && s.sec === 'subs') goSection('overview'); }, [s.sec]);
  useEffect(() => { // browser back/forward between sections
    const on = () => { const x = sectionFromHash() ?? 'overview'; if (x !== useAdmin.getState().sec) goSection(x, true); };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const label = NAV.find((n) => n[0] === s.sec)![1];

  const nav = (
    <nav aria-label="أقسام الإدارة" style={narrow
      ? { display: 'flex', gap: 4, overflowX: 'auto', padding: '0 12px 10px', margin: '0 -0px' }
      : { display: 'flex', flexDirection: 'column', gap: 4 }}>
      {NAV_SHOWN.map(([k, l, ic]) => {
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
      <div style={{ flex: 1 }}><p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{BRAND.ar}</p><p style={{ margin: 0, fontSize: 12, color: color.liveSub }}>لوحة الإدارة</p></div>
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
            <button onClick={toApp} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.sage, fontSize: 14, textAlign: 'right', padding: '0 14px', cursor: 'pointer', textDecoration: 'underline' }}>{LIVE ? '← تطبيق الحلقة' : '← العودة إلى نموذج الجوال'}</button>
            <button onClick={adminLogout} style={{ minHeight: 44, border: 'none', background: 'transparent', color: color.sage, fontSize: 14, textAlign: 'right', padding: '0 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="leave" size={18} /> تسجيل الخروج</button>
          </div>
        </aside>
      )}
      <main style={{ flex: 1, minWidth: 0, padding: '28px clamp(16px,3vw,40px)', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div><h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{label}</h1><p style={{ margin: '4px 0 0', fontSize: 14, color: color.muted }}>{s.sec === 'overview' && LIVE ? todayCairo() : TITLES[s.sec]}</p></div>
          <span style={{ fontSize: 13, color: demoBadge ? color.dangerInk : color.muted, background: color.sand, padding: '6px 12px', borderRadius: 999 }}>
            {!LIVE ? 'بيانات عرض تجريبية' : !demoBadge ? `${s.me?.full_name ?? ''} · بيانات حقيقية` : 'هذا القسم ما زال ببيانات عرض تجريبية — لا تُحفظ التغييرات'}
          </span>
        </header>
        {LIVE && s.me && !s.me.mfa_enabled && <MfaSetup />}
        {LIVE && s.me && !s.me.mfa_enabled && s.me.mfa_required ? <p style={{ margin: 0, fontSize: 15, color: color.muted }}>تُفتح أقسام الإدارة بعد تفعيل التحقق بخطوتين.</p>
          : liveRole ? <Suspense fallback={null}><PeopleLive key={liveRole} role={liveRole} /></Suspense>
          : liveOther ? <Suspense fallback={null}>{liveOther()}</Suspense>
          : s.sec === 'overview' ? (LIVE ? <OverviewLive c={lc} /> : <Overview counts={counts} />)
            : s.sec === 'settings' ? <AdminSettings /> : <TableSection key={s.sec} sec={s.sec} />}
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

/* ---------------- Live overview (real counts only) ---------------- */
function OverviewLive({ c }: { c: LiveCounts }) {
  const n = (x?: number) => (x === undefined ? '…' : x);
  const kpis: { l: string; v: number | string; s: string; go: Section }[] = [
    { l: 'طلاب نشطون', v: n(c.student?.active), s: c.student?.unlinked ? `${c.student.unlinked} دون معلم مرتبط` : 'كلهم مرتبطون بمعلمين', go: 'students' },
    { l: 'معلمون نشطون', v: n(c.teacher?.active), s: `${c.teacher?.unapproved ?? 0} غير معتمدين`, go: 'teachers' },
    { l: 'أولياء أمور', v: n(c.parent?.active), s: `${c.parent?.pending ?? 0} بانتظار الاعتماد`, go: 'parents' },
  ];
  const todo: [Section, number, string][] = [
    ['students', c.student?.pending ?? 0, 'طلاب بانتظار الاعتماد'], ['students', c.student?.unlinked ?? 0, 'طلاب دون معلم'],
    ['teachers', c.teacher?.unapproved ?? 0, 'معلمون غير معتمدين'], ['parents', c.parent?.pending ?? 0, 'أولياء أمور بانتظار الاعتماد'],
    ['lectures', c.drafts?.lessons ?? 0, `دروس مسودة بانتظار المراجعة والنشر${c.drafts?.lessons_by_teachers ? ` (${c.drafts.lessons_by_teachers} من المعلمين)` : ''}`],
    ['quizzes', c.drafts?.tests ?? 0, `اختبارات مسودة بانتظار المراجعة والنشر${c.drafts?.tests_by_teachers ? ` (${c.drafts.tests_by_teachers} من المعلمين)` : ''}`],
  ];
  const open = todo.filter(([, k]) => k > 0);
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
      <section style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>يحتاج إجراء</h2>
        {open.length === 0 && <p style={{ margin: 0, fontSize: 15, color: color.muted }}>لا توجد إجراءات معلقة.</p>}
        {open.map(([k, v, t]) => (
          <button key={t} onClick={() => goSection(k)} style={{ minHeight: 52, padding: '0 14px', borderRadius: 12, border: `1px solid ${color.divider}`, background: color.ivory, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink, fontSize: 15 }}>
            <span style={{ flex: 1 }}><span style={{ fontFamily: font.latin }}>{v}</span> {t}</span><span style={{ fontWeight: 700, color: color.primary }}>{NAV.find((x) => x[0] === k)![1]} ←</span>
          </button>
        ))}
      </section>
    </>
  );
}

/* ---------------- Two-step verification (live mode) ---------------- */
function MfaSetup() {
  const [st, setSt] = useState<{ step: 'idle' | 'code'; secret?: string; uri?: string; otp: string; err?: string; busy?: boolean }>({ step: 'idle', otp: '' });
  const start = async () => {
    setSt({ ...st, busy: true, err: undefined });
    try { const r = await mfaStart(); setSt({ step: 'code', secret: r.secret, uri: r.otpauth_uri, otp: '' }); }
    catch (e) { setSt({ ...st, busy: false, err: (e as ApiError).message }); }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(st.otp)) { setSt({ ...st, err: 'أدخل الرمز المكوّن من 6 أرقام' }); return; }
    setSt({ ...st, busy: true, err: undefined });
    try { await mfaFinish(st.otp); } catch (x) { setSt({ ...st, busy: false, otp: '', err: (x as ApiError).message }); }
  };
  return (
    <section aria-labelledby="mfa-h" style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10, borderColor: color.gold }}>
      <h2 id="mfa-h" style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>فعّل التحقق بخطوتين</h2>
      {st.step === 'idle' ? (
        <>
          <p style={{ margin: 0, fontSize: 14, color: color.muted }}>يحمي حساب الإدارة إذا تسرّبت كلمة المرور. ستحتاج تطبيق مصادقة مثل Google Authenticator أو Microsoft Authenticator.</p>
          <button onClick={start} disabled={st.busy} style={{ ...primaryBtn(48, 15), alignSelf: 'flex-start', padding: '0 20px' }}>{st.busy ? 'جارٍ التحضير…' : 'ابدأ التفعيل'}</button>
        </>
      ) : (
        <form noValidate onSubmit={confirm} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ margin: 0, fontSize: 14 }}>١. في تطبيق المصادقة اختر «إدخال مفتاح الإعداد» واكتب هذا المفتاح (نوع المفتاح: مبني على الوقت):</p>
          <code dir="ltr" style={{ fontFamily: 'monospace', fontSize: 16, letterSpacing: 2, background: color.sand, padding: '10px 12px', borderRadius: 10, wordBreak: 'break-all', userSelect: 'all' }}>{st.secret}</code>
          {st.uri && <a href={st.uri} style={{ fontSize: 13, color: color.primary }}>أو افتح الرابط مباشرة إن كان تطبيق المصادقة على هذا الجهاز</a>}
          <label htmlFor="mfa-otp" style={labelStyle}>٢. أدخل الرمز الذي يظهر في التطبيق</label>
          <input id="mfa-otp" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} value={st.otp} aria-invalid={!!st.err}
            onChange={(e) => setSt({ ...st, otp: e.target.value.replace(/\D/g, ''), err: undefined })} style={{ ...inputStyle(st.err, true), maxWidth: 220 }} />
          <FieldError msg={st.err ?? null} />
          <button type="submit" disabled={st.busy} style={{ ...primaryBtn(48, 15), alignSelf: 'flex-start', padding: '0 20px' }}>{st.busy ? 'جارٍ التحقق…' : 'تأكيد التفعيل'}</button>
        </form>
      )}
      {st.step === 'idle' && st.err && <p role="alert" style={{ margin: 0, color: color.danger, fontSize: 14 }}>{st.err}</p>}
    </section>
  );
}
