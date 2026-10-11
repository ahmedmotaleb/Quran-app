import type { ComponentType } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import { Skeleton, primaryBtn } from '@/components/ui';
import Sheet from '@/components/Sheet';
import type { Screen } from '@/data/demo';
import { setState, tab, useApp, type DataState } from '@/store/store';

import { Forgot, Intro, Login, Onboard, Signup, Splash } from '@/screens/auth/Auth';
import Home from '@/screens/student/Home';
import Plan, { TaskDetail } from '@/screens/student/Plan';
import Record from '@/screens/student/Record';
import Feedback from '@/screens/student/Feedback';
import Mushaf from '@/screens/student/Mushaf';
import Circles, { BookingDone, BookingReview, SessionDetails, TeacherPage } from '@/screens/student/Circles';
import Live from '@/screens/student/Live';
import { LessonPage, QuizPage } from '@/screens/student/Learn';
import Progress from '@/screens/student/Progress';
import Account from '@/screens/student/Account';
import {
  TeacherAssign, TeacherContent, TeacherDash, TeacherReview, TeacherReviews, TeacherSchedule, TeacherStudent, TeacherStudents,
} from '@/screens/teacher/Teacher';
import ParentHome from '@/screens/parent/ParentHome';

const SCREENS: Record<Screen, ComponentType> = {
  splash: Splash, intro: Intro, login: Login, signup: Signup, forgot: Forgot, onboard: Onboard,
  home: Home, plan: Plan, task: TaskDetail, record: Record, feedback: Feedback, mushaf: Mushaf,
  circles: Circles, teacher: TeacherPage, bkreview: BookingReview, bkdone: BookingDone, session: SessionDetails,
  live: Live, lesson: LessonPage, quiz: QuizPage, progress: Progress, account: Account,
  tdash: TeacherDash, tstudents: TeacherStudents, tstudent: TeacherStudent, tassign: TeacherAssign,
  treviews: TeacherReviews, treview: TeacherReview, tschedule: TeacherSchedule, tcontent: TeacherContent, phome: ParentHome,
};

const TABS_STUDENT: [Screen, string, IconName][] = [['home', 'الرئيسية', 'home'], ['plan', 'تعلمي', 'plan'], ['circles', 'الجلسات', 'users'], ['progress', 'تقدمي', 'chart'], ['account', 'حسابي', 'user']];
const TABS_TEACHER: [Screen, string, IconName][] = [['tdash', 'اليوم', 'home'], ['tstudents', 'الطلاب', 'users'], ['treviews', 'المراجعات', 'inbox'], ['tschedule', 'المواعيد', 'cal'], ['account', 'حسابي', 'user']];

/** Main screens that can be switched into loading / empty / error / offline from the demo panel. */
const MAIN: Screen[] = ['home', 'plan', 'circles', 'progress', 'tdash', 'tstudents', 'treviews', 'phome'];
const TITLES: Partial<Record<Screen, string>> = { home: 'الرئيسية', plan: 'تعلمي', circles: 'الجلسات', progress: 'تقدمي', tdash: 'لوحة اليوم', tstudents: 'الطلاب', treviews: 'المراجعات', phome: 'متابعة الأبناء' };
const EMPTY: Partial<Record<Screen, [string, string]>> = {
  home: ['لا توجد مهام لليوم', 'استرح أو راجع ما حفظته سابقًا. سيضيف معلمك مهامك القادمة هنا.'],
  plan: ['لا توجد مهام لليوم', 'سيضيف معلمك المهام القادمة هنا، وستصلك إشعارات بها.'],
  circles: ['لا توجد حلقات متاحة حاليًا', 'نضيف معلمين جددًا باستمرار. جرّب لاحقًا.'],
  progress: ['لا توجد بيانات تقدّم بعد', 'سيظهر تقدّمك بعد أول تقييم من معلمك.'],
  tdash: ['لا توجد جلسات أو تسجيلات اليوم', 'يمكنك إضافة مواعيد متاحة من صفحة المواعيد.'],
  tstudents: ['لم يُربط بك أي طالب بعد', 'تربط الإدارة الطلاب بالمعلمين بعد اعتماد الاشتراك.'],
  treviews: ['لا توجد تسجيلات تنتظر المراجعة', 'ستظهر هنا تسليمات طلابك فور وصولها.'],
  phome: ['لا يوجد أبناء مرتبطون بحسابك', 'اطلب من إدارة الحلقة ربط حساب ابنك أو ابنتك.'],
};

function retry() { setState({ ds: 'loading' }); setTimeout(() => setState({ ds: 'normal' }), 900); }

function DataStateView({ screen, ds }: { screen: Screen; ds: Exclude<DataState, 'normal'> }) {
  const empt = EMPTY[screen] || ['', ''];
  const center = { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 12, padding: '40px 16px' } as const;
  const retryBtn = <button onClick={retry} style={primaryBtn(52, 16, { padding: '0 24px' })}><Icon name="refresh" /> إعادة المحاولة</button>;
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', padding: '8px 16px 24px', gap: 16 }}>
      <h1 style={{ margin: '8px 0 0', fontSize: 24, fontWeight: 800, color: color.ink }}>{TITLES[screen]}</h1>
      {ds === 'loading' && <div role="status" aria-label="جارٍ التحميل"><Skeleton /></div>}
      {ds === 'empty' && (
        <div style={center}>
          <img src="/assets/halqa-mark.png" alt="" style={{ width: 72, height: 72, objectFit: 'contain', opacity: 0.55 }} />
          <p style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>{empt[0]}</p>
          <p style={{ margin: 0, fontSize: 15, color: color.muted, lineHeight: 1.7, maxWidth: 280, textWrap: 'pretty' }}>{empt[1]}</p>
        </div>
      )}
      {ds === 'error' && (
        <div role="alert" style={center}>
          <span style={{ width: 64, height: 64, borderRadius: '50%', background: color.dangerBg, color: color.dangerInk, display: 'grid', placeItems: 'center' }}><Icon name="alert" size={30} /></span>
          <p style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>تعذّر تحميل البيانات</p>
          <p style={{ margin: 0, fontSize: 15, color: color.muted, lineHeight: 1.7, maxWidth: 280 }}>حدث خطأ غير متوقع من جهتنا. بياناتك محفوظة، حاول مرة أخرى.</p>
          {retryBtn}
        </div>
      )}
      {ds === 'offline' && (
        <div role="alert" style={center}>
          <span style={{ width: 64, height: 64, borderRadius: '50%', background: color.neutralBg, color: color.subtle, display: 'grid', placeItems: 'center' }}><Icon name="wifiOff" size={30} /></span>
          <p style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>لا يوجد اتصال بالإنترنت</p>
          <p style={{ margin: 0, fontSize: 15, color: color.muted, lineHeight: 1.7, maxWidth: 290 }}>تحقق من الاتصال ثم أعد المحاولة. تبقى تسجيلاتك محفوظة على الجهاز حتى يعود الاتصال.</p>
          {retryBtn}
        </div>
      )}
    </div>
  );
}

// Teacher: students, assignments and reviews are live; today's sessions, schedule and content are not yet.
const SAMPLE_SCREENS: Screen[] = ['live', 'lesson', 'quiz', 'progress', 'tschedule', 'tcontent'];

/**
 * The phone UI. `framed` renders the fake status bar + home indicator used inside the
 * desktop demo frame; full-screen (real phones) relies on safe-area insets instead.
 */
export default function AppShell({ framed }: { framed: boolean }) {
  const screen = useApp((s) => s.screen); const role = useApp((s) => s.role); const ds = useApp((s) => s.ds);
  const uiScale = useApp((s) => s.uiScale); const toast = useApp((s) => s.toast);

  const dark = screen === 'live';
  const tabs = role === 'student' ? TABS_STUDENT : role === 'teacher' ? TABS_TEACHER : [];
  const showNav = tabs.some((t) => t[0] === screen);
  const showState = ds !== 'normal' && MAIN.includes(screen);
  const offlineBanner = ds === 'offline' && !showState && !['splash', 'intro'].includes(screen);
  const navBg = dark ? color.liveBg : showNav ? color.card : color.ivory;
  const Cur = SCREENS[screen];
  const liveMode = useApp((s) => s.liveMode);
  // Live mode: screens whose data is not served by the API yet keep the design's sample content, labelled as such.
  const sample = liveMode && (role === 'parent' || SAMPLE_SCREENS.includes(screen));

  return (
    <div style={{ height: '100%', overflow: 'hidden', background: dark ? color.liveBg : color.ivory, display: 'flex', flexDirection: 'column', position: 'relative', paddingTop: framed ? 0 : 'env(safe-area-inset-top)' }}>
      {framed && (
        <div aria-hidden="true" style={{ height: 34, padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: font.latin, fontSize: 13, fontWeight: 600, flexShrink: 0, color: dark ? color.ivory : color.ink, background: dark ? color.liveBg : color.ivory }}>
          <span dir="ltr">9:41</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="wifi" size={18} /><Icon name="battery" size={18} /></span>
        </div>
      )}
      {offlineBanner && (
        <div role="status" style={{ flexShrink: 0, background: color.offlineBar, color: color.ivory, fontSize: 13, fontWeight: 500, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="wifiOff" size={18} /> أنت غير متصل بالإنترنت. ستظهر آخر بيانات محفوظة.
        </div>
      )}
      {sample && (
        <div role="note" style={{ flexShrink: 0, background: color.warnBg, color: color.warnInk, fontSize: 13, fontWeight: 700, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="alert" size={18} /> محتوى تجريبي — هذا القسم لم يُربط بالخادم بعد.
        </div>
      )}
      <main id="scr" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative', zoom: { s: 0.92, m: 1, l: 1.1 }[uiScale] }}>
        {showState ? <DataStateView screen={screen} ds={ds as Exclude<DataState, 'normal'>} /> : <Cur key={screen} />}
      </main>
      {showNav && (
        <nav aria-label="التنقل الرئيسي" style={{ flexShrink: 0, display: 'flex', background: color.card, borderTop: `1px solid ${color.border}`, padding: '6px 4px 2px' }}>
          {tabs.map(([k, l, i]) => {
            const cur = k === screen;
            return (
              <button key={k} onClick={() => tab(k)} aria-current={cur ? 'page' : undefined}
                style={{ flex: 1, minWidth: 0, minHeight: 56, border: 'none', background: 'transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, cursor: 'pointer', color: cur ? color.primary : color.muted, fontSize: 12, fontWeight: cur ? 800 : 500 }}>
                <span style={{ width: 56, height: 30, borderRadius: 999, display: 'grid', placeItems: 'center', background: cur ? color.sage : 'transparent' }}><Icon name={i} /></span>
                <span>{l}</span>
              </button>
            );
          })}
        </nav>
      )}
      {framed ? (
        <div aria-hidden="true" style={{ height: 20, display: 'grid', placeItems: 'center', flexShrink: 0, background: navBg }}>
          <span style={{ width: 108, height: 4, borderRadius: 4, background: dark ? color.ivory : color.ink }} />
        </div>
      ) : (
        <div aria-hidden="true" style={{ height: 'env(safe-area-inset-bottom)', flexShrink: 0, background: navBg }} />
      )}
      {toast && (
        <div role="status" aria-live="polite" style={{ position: 'absolute', top: framed ? 44 : 'calc(10px + env(safe-area-inset-top))', left: 16, right: 16, zIndex: 40, background: color.ink, color: color.ivory, borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 500, boxShadow: '0 12px 28px -12px rgba(0,0,0,.4)' }}>
          <Icon name={toast.icon} /><span style={{ flex: 1 }}>{toast.text}</span>
        </div>
      )}
      <Sheet />
    </div>
  );
}
