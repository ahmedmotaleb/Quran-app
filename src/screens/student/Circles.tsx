import { TOPIC, addToCalendar } from './LiveJoin';
import { useEffect, useState, type FormEvent } from 'react';
import { color, font } from '@/theme/tokens';
import type { Session, Slot } from '@/data/types';
import { Icon } from '@/components/Icon';
import {
  Avatar, BackHeader, Badge, Chips, FieldError, KVCard, SearchInput, card, iconTile, inputStyle, labelStyle, listBtn, muted, outlineBtn, primaryBtn,
} from '@/components/ui';
import { LESSONS } from '@/data/demo';
import { dayL, timeIn, tzLabel, tzOf, type BadgeSpec } from '@/lib/format';
import {
  back, confirmBooking, requestExcuse, go, openSheet, openTeacher, replace, rescheduleSession, reset, setState, startQuiz, toast, up, useApp,
} from '@/store/store';
import { decoSession, pastSessions, slotTime, teacherById, upcomingSessions, weekDays } from '@/store/selectors';
import { loadStudentData } from '@/store/live';
import * as E from '@/api/endpoints';
import type { ApiError } from '@/api/client';
import { fmtDay, fmtTime } from '@/lib/time';

import { LessonsTabLive, QuizzesTabLive } from './LearnLive';

type CircTab = 'teachers' | 'bookings' | 'lessons' | 'quizzes';
const TABS: [CircTab, string][] = [['teachers', 'المعلمون'], ['bookings', 'حجوزاتي'], ['lessons', 'الدروس'], ['quizzes', 'الاختبارات']];

export default function Circles() {
  const s = useApp();
  const ct = s.circTab;
  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h1 style={{ margin: '12px 0 0', fontSize: 24, fontWeight: 800 }}>الجلسات</h1>
      <div role="tablist" style={{ display: 'flex', background: color.sunken, borderRadius: 14, padding: 4, gap: 2, overflowX: 'auto' }}>
        {TABS.map(([k, l]) => {
          const on = ct === k;
          return <button key={k} role="tab" aria-selected={on} onClick={() => setState({ circTab: k })} style={{ flex: 1, minHeight: 44, padding: '0 8px', border: 'none', borderRadius: 11, background: on ? color.primary : 'transparent', color: on ? color.ivory : color.body, fontSize: 14, fontWeight: on ? 700 : 500, whiteSpace: 'nowrap', cursor: 'pointer' }}>{l}</button>;
        })}
      </div>
      {ct === 'teachers' && <TeachersTab />}
      {ct === 'bookings' && <BookingsTab />}
      {ct === 'lessons' && (s.liveMode ? <LessonsTabLive /> : <LessonsTab />)}
      {ct === 'quizzes' && (s.liveMode ? <QuizzesTabLive /> : <QuizzesTab />)}
    </div>
  );
}

function TeachersTab() {
  const s = useApp();
  const q = s.q.trim();
  const list = s.teachers.filter((t) => (s.filt === 'all' || t.tags.includes(s.filt)) && (!q || t.name.includes(q) || t.spec.includes(q)));
  return (
    <>
      <SearchInput value={s.q} onChange={(v) => setState({ q: v })} placeholder="ابحث عن معلم أو تخصص" />
      <Chips scroll options={[['all', 'الكل'], ['hifz', 'حفظ'], ['tajweed', 'تجويد'], ['kids', 'أطفال'], ['group', 'حلقات جماعية']] as const} value={s.filt} onChange={(k) => setState({ filt: k })} />
      {s.net.error && <NetError msg={s.net.error} />}
      {s.net.loading && !s.teachers.length && <p role="status" style={muted(14)}>جارٍ التحميل…</p>}
      <p style={muted(13)}>{list.length} معلم</p>
      {list.length === 0 && (
        <div style={{ textAlign: 'center', padding: 24, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>لا توجد نتائج مطابقة</p>
          <p style={muted(14)}>جرّب كلمة أخرى أو أزل عوامل التصفية.</p>
          <button onClick={() => setState({ q: '', filt: 'all' })} style={outlineBtn(48, 15, { padding: '0 18px', borderRadius: 12 })}>مسح البحث والتصفية</button>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,320px),1fr))', gap: 10 }}>
        {list.map((t) => {
          const first = s.liveMode ? undefined : s.avail[t.id].map((d, i) => ({ i, sl: d.find((x) => !x.taken) })).find((x) => x.sl);
          return (
            <button key={t.id} onClick={() => openTeacher(t.id, t.types, first ? first.i : 0)} style={{ ...listBtn, alignItems: 'flex-start' }}>
              <Avatar ini={t.ini} size={52} fs={21} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{t.name}</span>
                <span style={{ fontSize: 14, color: color.body }}>{t.spec} · {t.levels}</span>
                <span style={{ fontSize: 13, color: color.muted }}>جلسات {t.types.join(' · ')} · {t.aud}</span>
                <span style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, color: color.ink }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: first ? color.primary : '#A0A89F' }} />
                  {s.liveMode ? 'اعرض المواعيد المتاحة' : first ? `أقرب موعد: ${dayL(first.i)}، ${timeIn(s.tz, first.sl!.h)}` : 'لا مواعيد متاحة هذا الأسبوع'}
                </span>
              </span>
              <span style={{ color: color.primary, alignSelf: 'center' }}><Icon name="chevL" /></span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Live: the student's waiting-list entries and make-up credits (PROMPT 44). */
function WaitAndMakeup() {
  const s = useApp();
  const [w, setW] = useState<E.WaitlistRow[]>([]); const [m, setM] = useState<E.MakeupRow[]>([]); const [busy, setBusy] = useState<number | null>(null);
  const load = () => { E.myWaitlist().then((r) => setW(r.results)).catch(() => {}); E.myMakeup().then((r) => setM(r.results)).catch(() => {}); };
  useEffect(load, []);
  const tz = tzOf(s.tz).iana;
  const when = (iso: string) => `${fmtDay(iso, tz)} · ${fmtTime(iso, tz)}`;
  const openW = w.filter((x) => x.status === 'waiting' || x.status === 'offered');
  const credits = m.filter((x) => x.status === 'available');
  if (!openW.length && !credits.length) return null;
  const run = async (id: number, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try { await fn(); toast(ok); load(); await loadStudentData(); } catch (e) { toast((e as ApiError).message, 'alert'); load(); } finally { setBusy(null); }
  };
  return (
    <>
      {openW.length > 0 && <section aria-labelledby="wl-h" style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 id="wl-h" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>قائمة الانتظار</h2>
        {openW.map((x) => (
          <div key={x.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${color.divider}`, paddingTop: 8 }}>
            <span style={{ fontWeight: 700 }}>{when(x.occurrence.starts_at)} · {x.occurrence.teacher_name}{x.occurrence.circle_name ? ` · ${x.occurrence.circle_name}` : ''}</span>
            {x.status === 'offered'
              ? <span style={{ color: color.primary, fontWeight: 700 }}>توفّر مقعد لك! احجزه قبل {when(x.offer_expires_at!)}، وإلا انتقل إلى التالي.</span>
              : <span style={muted(13)}>ترتيبك في القائمة: {x.position}</span>}
            <div style={{ display: 'flex', gap: 8 }}>
              {x.status === 'offered' && <button disabled={busy === x.id} onClick={() => void run(x.id, () => E.acceptOffer(x.id, E.newIdempotencyKey()), 'تم حجز المقعد')} style={primaryBtn(44, 14, { flex: 1 })}>احجز المقعد</button>}
              <button disabled={busy === x.id} onClick={() => void run(x.id, () => E.leaveWaitlist(x.id), 'خرجت من قائمة الانتظار')} style={outlineBtn(44, 14)}>الخروج من القائمة</button>
            </div>
          </div>
        ))}
      </section>}
      {credits.length > 0 && <section aria-labelledby="mk-h" style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 id="mk-h" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>جلسات تعويضية</h2>
        {credits.map((c) => {
          const t = s.teachers.find((x) => x.id === String(c.teacher));
          return (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: `1px solid ${color.divider}`, paddingTop: 8 }}>
              <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontWeight: 700 }}>مع {c.teacher_name}</span>
                <span style={muted(12)}>عن غياب {fmtDay(c.source_starts_at, tz)} · صالحة حتى {fmtDay(c.expires_at, tz)}</span></span>
              <button onClick={() => openTeacher(String(c.teacher), t?.types ?? ['فردية'], 0, c.id)} style={primaryBtn(44, 14, { padding: '0 12px' })}>احجز موعدًا تعويضيًا</button>
            </div>
          );
        })}
      </section>}
    </>
  );
}

/** A full slot (live): offer «الانضمام إلى قائمة الانتظار». */
function askWaitlist(occ: number, label: string) {
  openSheet({ kind: 'confirm', title: 'الموعد مكتمل', ok: 'الانضمام إلى قائمة الانتظار',
    body: `موعد ${label} محجوز بالكامل. انضم إلى قائمة الانتظار: إن توفّر مقعد يُعرض عليك أولًا حسب ترتيبك، وتصلك رسالة لتحجزه خلال مهلة محددة.`,
    onOk: () => { setState({ sheet: null }); E.joinWaitlist(occ).then((r) => toast(r.status === 'offered' ? 'توفّر مقعد لك الآن؛ احجزه من «حجوزاتي»' : `أُضفت إلى قائمة الانتظار (ترتيبك ${r.position})`))
      .catch((e) => toast((e as ApiError).message, 'alert')); } });
}

function BookingsTab() {
  const s = useApp();
  const upcoming = upcomingSessions(s); const past = pastSessions(s);
  return (
    <>
      {s.net.error && <NetError msg={s.net.error} />}
      {s.liveMode && <WaitAndMakeup />}
      {upcoming.length === 0 && (
        <div style={{ textAlign: 'center', padding: 24, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>لا توجد حجوزات قادمة</p>
          <button onClick={() => setState({ circTab: 'teachers' })} style={primaryBtn(48, 15, { padding: '0 18px', borderRadius: 12 })}>احجز جلسة</button>
        </div>
      )}
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>القادمة</h2>
      {upcoming.map((x) => (
        <button key={x.id} onClick={() => go('session', { id: x.id })} style={listBtn}>
          <span style={iconTile(48, color.sage)}><Icon name="cal" /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{x.when}</span>
            <span style={{ display: 'block', fontSize: 14, color: color.body, marginTop: 2 }}>{x.teacherName} · {x.type}</span>
          </span>
          <Badge kind={x.status} size="sm" style={{ padding: '4px 10px' }} />
        </button>
      ))}
      <h2 style={{ margin: '6px 0 0', fontSize: 16, fontWeight: 700, color: color.muted }}>السابقة والملغاة</h2>
      {past.map((x) => (
        <button key={x.id} onClick={() => go('session', { id: x.id })} style={{ ...listBtn, background: 'transparent' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{x.when}</span>
            <span style={{ display: 'block', fontSize: 13, color: color.muted, marginTop: 2 }}>{x.teacherName}</span>
          </span>
          <Badge kind={x.status} size="sm" style={{ padding: '4px 10px' }} />
        </button>
      ))}
    </>
  );
}

function LessonsTab() {
  const s = useApp(); const lt = s.lessonTopic;
  return (
    <>
      <Chips scroll options={[['all', 'الكل'], ['tajweed', 'التجويد'], ['hifz', 'الحفظ والمراجعة'], ['adab', 'آداب التلاوة'], ['ulum', 'علوم القرآن']] as const} value={lt} onChange={(k) => setState({ lessonTopic: k })} wrapStyle={{ paddingBottom: 0 }} />
      {LESSONS.filter((l) => lt === 'all' || l.topic === lt).map((l) => (
        <button key={l.id} onClick={() => go('lesson', { id: l.id })} style={listBtn}>
          <span style={iconTile(48, color.sand)}><Icon name={l.media === 'video' ? 'video' : 'headphones'} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{l.title}</span>
            <span style={{ display: 'block', fontSize: 13, color: color.muted, marginTop: 3 }}>{l.topicL} · {l.level} · {l.media === 'video' ? 'فيديو' : 'صوتي'} · {l.dur}</span>
          </span>
          {s.lessonDone[l.id] && <span style={{ color: color.primary, display: 'flex', gap: 2, alignItems: 'center', fontSize: 12, fontWeight: 700 }}><Icon name="check" size={18} /> مكتمل</span>}
        </button>
      ))}
    </>
  );
}

function QuizzesTab() {
  const quiz = useApp((s) => s.quiz);
  const list = [
    { id: 'q1', title: 'اختبار أحكام النون الساكنة والتنوين', meta: '5 أسئلة · 10 دقائق · يتضمن سؤال تلاوة', st: quiz?.submitted ? 'pending' : 'available', score: '' },
    { id: 'q3', title: 'اختبار المدود', meta: '10 أسئلة · 15 دقيقة', st: 'done', score: '8 من 10' },
    { id: 'q2', title: 'اختبار تلاوة: سورة النبأ 1–16', meta: 'سؤال تلاوة واحد', st: 'pending', score: '' },
  ];
  const spec = (x: typeof list[number]): BadgeSpec => x.st === 'available' ? { label: 'متاح', bg: color.sage, fg: color.primary, icon: 'circle' }
    : x.st === 'pending' ? { label: 'بانتظار تقييم المعلم', bg: color.warnBg, fg: color.warnInk, icon: 'clock' }
      : { label: `مكتمل · ${x.score}`, bg: color.primary, fg: color.ivory, icon: 'check' };
  return (
    <>
      {list.map((x) => (
        <button key={x.id} onClick={() => (x.st === 'available' ? startQuiz(x.id) : toast(x.st === 'pending' ? 'سيظهر الاختبار بعد تقييم المعلم لسؤال التلاوة' : 'النتيجة: ' + x.score, 'clock'))}
          style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>{x.title}</span>
          <span style={{ fontSize: 13, color: color.muted }}>{x.meta}</span>
          <Badge spec={spec(x)} size="sm" style={{ alignSelf: 'flex-start', padding: '4px 10px' }} />
        </button>
      ))}
    </>
  );
}

function NetError({ msg }: { msg: string }) {
  return (
    <div role="alert" style={{ background: color.dangerBg, borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ margin: 0, fontSize: 15, color: color.dangerDeep, fontWeight: 700, display: 'flex', gap: 8 }}><Icon name="alert" /> {msg}</p>
      <button onClick={() => loadStudentData()} style={{ alignSelf: 'flex-start', minHeight: 44, padding: '0 16px', border: 'none', borderRadius: 10, background: color.dangerDeep, color: color.card, fontWeight: 700, cursor: 'pointer' }}>إعادة المحاولة</button>
    </div>
  );
}

/* ---------------- Teacher page + slot picker ---------------- */
export function TeacherPage() {
  const s = useApp(); const B = s.bk; const t = teacherById(B.t);
  const wk = weekDays(s);
  // Live slots carry their kind (individual/group); show only those matching the chosen type.
  const fits = (x: Slot) => !x.kind || x.kind === B.type;
  const days = (s.avail[B.t] ?? Array.from({ length: 7 }, () => [] as Slot[])).map((d) => d.filter(fits));
  const totalFree = days.reduce((a, d) => a + d.filter((x) => !x.taken).length, 0);
  const dayFree = days[B.day].some((x) => !x.taken);
  const notify = !!s.notifyMe[B.t];
  const chosen = B.h !== null ? days[B.day].find((x) => x.h === B.h) : undefined;

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <BackHeader title={B.resched ? 'إعادة جدولة الجلسة' : 'صفحة المعلم'} sticky />
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <Avatar ini={t.ini} size={68} fs={28} />
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{t.name}</h2>
            <p style={{ margin: '4px 0 0', fontSize: 14, color: color.body }}>{t.spec} · {t.levels}</p>
            <p style={muted(13, { margin: '2px 0 0' })}>يدرّس {t.aud}</p>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.8, textWrap: 'pretty' }}>{t.bio}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>نوع الجلسة</p>
          <div style={{ display: 'flex', background: color.sunken, borderRadius: 14, padding: 4, gap: 4 }}>
            {t.types.map((x) => {
              const on = B.type === x;
              return <button key={x} aria-pressed={on} onClick={() => up('bk', { type: x, h: null })} style={{ flex: 1, minHeight: 48, border: 'none', borderRadius: 11, background: on ? color.primary : 'transparent', color: on ? color.ivory : color.body, fontSize: 14, fontWeight: on ? 700 : 500, cursor: 'pointer' }}>{x === 'فردية' ? 'فردية · 45 دقيقة' : 'جماعية · 60 دقيقة'}</button>;
            })}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>المواعيد المتاحة</p>
            <p style={muted(12, { display: 'flex', gap: 4, alignItems: 'center', background: color.sand, padding: '4px 10px', borderRadius: 999 })}><Icon name="globe" size={18} /> {tzLabel(s.tz)}</p>
          </div>
          {B.loading ? <p role="status" style={muted(14, { textAlign: 'center', padding: 16 })}>جارٍ تحميل المواعيد…</p>
            : B.error && s.liveMode && totalFree === 0 ? <NetError msg={B.error} />
            : totalFree === 0 ? (
            <div role="status" style={{ background: color.card, border: `1px dashed ${color.borderStrong}`, borderRadius: 16, padding: 20, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>لا توجد مواعيد متاحة هذا الأسبوع</p>
              <p style={muted(14)}>يحدّث المعلم مواعيده أسبوعيًا.</p>
              <button onClick={() => { setState({ notifyMe: { ...s.notifyMe, [B.t]: !notify } }); if (!notify) toast('سنرسل لك إشعارًا عند توفر موعد', 'bell'); }} aria-pressed={notify}
                style={{ minHeight: 48, padding: '0 18px', borderRadius: 12, border: `1.5px solid ${color.primary}`, background: 'transparent', color: color.primary, fontWeight: 700, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <Icon name="bell" /> {notify ? 'سنبلغك عند توفر موعد' : 'أبلغني عند توفر موعد'}
              </button>
            </div>
          ) : (
            <>
              <div role="listbox" aria-label="الأيام" style={{ display: 'flex', gap: 8, overflowX: 'auto', margin: '0 -16px', padding: '2px 16px' }}>
                {wk.map((d, i) => {
                  const free = days[i].filter((x) => !x.taken).length; const on = B.day === i;
                  return (
                    <button key={i} role="option" aria-selected={on} onClick={() => up('bk', { day: i, h: null, error: null })}
                      style={{ flexShrink: 0, width: 72, minHeight: 84, borderRadius: 14, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.ink, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, cursor: 'pointer' }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{d.label}</span>
                      <span style={{ fontFamily: font.latin, fontSize: 20, fontWeight: 700 }}>{d.num}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: on ? color.sage : free ? color.primary : color.faint }}>{free ? `${free} متاح` : 'لا يوجد'}</span>
                    </button>
                  );
                })}
              </div>
              {!dayFree && <p role="status" style={{ margin: 0, padding: 16, textAlign: 'center', fontSize: 14, color: color.muted, background: color.card, border: `1px dashed ${color.borderStrong}`, borderRadius: 14 }}>لا توجد مواعيد متاحة في هذا اليوم. جرّب يومًا آخر.</p>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(96px,1fr))', gap: 8 }}>
                {days[B.day].map((x) => {
                  const on = B.h === x.h; const label = slotTime(s, x);
                  return (
                    <button key={x.h} onClick={() => { if (!x.taken) up('bk', { h: x.h, error: null }); else if (s.liveMode && x.occ) askWaitlist(Number(x.occ), label); }}
                      disabled={x.taken && !(s.liveMode && x.occ)} aria-pressed={on} aria-label={x.taken ? `${label} محجوز${s.liveMode ? ' — الانضمام إلى قائمة الانتظار' : ''}` : label}
                      style={{ minHeight: 52, borderRadius: 12, border: `1.5px solid ${x.taken ? '#E0D9C8' : on ? color.primary : color.borderStrong}`, background: x.taken ? color.takenSlot : on ? color.primary : color.card, color: x.taken ? color.faint : on ? color.ivory : color.primary, fontSize: 15, fontWeight: 700, cursor: x.taken ? 'default' : 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.2 }}>
                      <span style={{ textDecoration: x.taken ? 'line-through' : 'none' }}>{label}</span>
                      {x.taken && <span style={{ fontSize: 11, fontWeight: 500 }}>محجوز</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div style={{ marginTop: 'auto', position: 'sticky', bottom: 0, background: color.ivory, padding: '10px 0 4px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${color.dividerHeader}` }}>
          <p style={{ margin: 0, fontSize: 14, color: color.body, textAlign: 'center' }}>{chosen ? `${wk[B.day].full} · ${slotTime(s, chosen)}` : 'لم تختر موعدًا بعد'}</p>
          <button onClick={() => (B.h === null ? toast('اختر موعدًا أولًا', 'alert') : go('bkreview'))} aria-disabled={B.h === null}
            style={primaryBtn(54, 17, { background: B.h !== null ? color.primary : color.disabledBtn })}>متابعة</button>
        </div>
      </div>
    </div>
  );
}

export function BookingReview() {
  const s = useApp(); const B = s.bk; const t = teacherById(B.t); const cancelH = s.pub.cancel_hours;
  const chosen = s.avail[B.t]?.[B.day]?.find((x) => x.h === B.h && (!x.kind || x.kind === B.type));
  const chips = [...s.tasks.filter((x) => x.status !== 'reviewed' && x.status !== 'submitted').slice(0, 3).map((x) => [x.id, x.title] as const), ['none', 'بدون مهمة'] as const];
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <BackHeader title="مراجعة الحجز" />
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        {B.error && (
          <div role="alert" style={{ background: color.dangerBg, borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, fontSize: 15, color: color.dangerDeep, fontWeight: 700, display: 'flex', gap: 8 }}><Icon name="alert" /> {B.error}</p>
            <button onClick={() => { up('bk', { error: null, h: null }); back(); }} style={{ alignSelf: 'flex-start', minHeight: 44, padding: '0 16px', border: 'none', borderRadius: 10, background: color.dangerDeep, color: color.card, fontWeight: 700, cursor: 'pointer' }}>اختر موعدًا آخر</button>
          </div>
        )}
        {B.makeup && <p style={{ margin: 0, padding: '10px 14px', borderRadius: 12, background: color.sand, fontSize: 14, fontWeight: 700 }}>جلسة تعويضية: يُستخدم رصيدك التعويضي لهذا الحجز.</p>}
        <KVCard rows={[
          ['المعلم', t.name],
          ['نوع الجلسة', `${B.type} · ${B.type === 'جماعية' ? '60 دقيقة' : '45 دقيقة'}`],
          ['اليوم', weekDays(s)[B.day].full],
          ['الوقت', <span style={{ textAlign: 'left' }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{chosen ? slotTime(s, chosen) : ''}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{tzLabel(s.tz)}</span></span>],
        ]} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>مهمة الجلسة</p>
          <Chips h={44} fs={13} options={chips} value={B.task || 'none'} onChange={(k) => up('bk', { task: k === 'none' ? null : k })} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="bk-note" style={{ fontSize: 15, fontWeight: 700 }}>ملاحظة للمعلم (اختياري)</label>
          <textarea id="bk-note" rows={3} value={B.note} onChange={(e) => up('bk', { note: e.target.value })} placeholder="مثال: أحتاج مساعدة في الآيات المتشابهة"
            style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15, color: color.ink, resize: 'vertical' }} />
        </div>
        <p style={muted(13, { lineHeight: 1.7, display: 'flex', gap: 6 })}><Icon name="clock" size={18} /> يمكنك الإلغاء أو إعادة الجدولة مجانًا قبل الموعد بـ {cancelH} ساعة.</p>
        <button onClick={confirmBooking} disabled={B.busy} style={primaryBtn(54, 17, { marginTop: 'auto' })}>{B.busy ? 'جارٍ التأكيد…' : B.resched ? 'تأكيد الموعد الجديد' : 'تأكيد الحجز'}</button>
      </div>
    </div>
  );
}

export function BookingDone() {
  const s = useApp();
  const x0 = s.sessions.find((y) => y.id === s.params.id);
  if (!x0) return null;
  const x = decoSession(x0, s);
  return (
    <div role="status" style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 12, padding: '24px 20px' }}>
      <span style={{ width: 84, height: 84, borderRadius: '50%', background: color.primary, color: color.ivory, display: 'grid', placeItems: 'center', boxShadow: `0 0 0 10px ${color.sage}` }}><Icon name="check" size={30} /></span>
      <h1 style={{ margin: '14px 0 0', fontSize: 24, fontWeight: 800 }}>تم تأكيد حجزك</h1>
      <p style={{ margin: 0, fontSize: 16, color: color.body }}>{x.teacherName}</p>
      <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{x.dateFull} · {x.timeL}</p>
      <p style={muted(13)}>{x.tzL}</p>
      <p style={muted(13, { margin: '6px 0 0' })}>{s.liveMode ? 'حُفظ الحجز على الخادم.' : 'سنذكّرك قبل الموعد بساعة. حجز تجريبي داخل النموذج.'}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', marginTop: 16 }}>
        <button onClick={() => replace('session', { id: x.id })} style={primaryBtn(54, 16)}>عرض تفاصيل الجلسة</button>
        <button onClick={() => reset('home', 'student')} style={outlineBtn(52, 15)}>العودة للرئيسية</button>
      </div>
    </div>
  );
}

export function SessionDetails() {
  const s = useApp();
  const [asking, setAsking] = useState(false);
  const x0 = s.sessions.find((y) => y.id === s.params.id);
  if (!x0) return <BackHeader title="تفاصيل الجلسة" />;
  const x = decoSession(x0, s);
  const ex = x0.excuse;
  const att = ATTENDANCE[x0.attendance ?? ''];
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <BackHeader title="تفاصيل الجلسة" />
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{x.when}</h2>
          <Badge kind={x.status} style={{ padding: '5px 12px' }} />
        </div>
        <KVCard rows={[
          ['المعلم', x.teacherName],
          ['التاريخ والوقت', <span style={{ textAlign: 'left' }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{x.dateFull} · {x.timeL}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{x.tzL}</span></span>],
          ...(x0.topic ? [['نوع الجلسة', `جلسة ${TOPIC[x0.topic] ?? ''}${x0.title ? ` — ${x0.title}` : ''}`] as [string, string]] : []),
          ['النوع والمدة', `${x.type} · ${x.dur} دقيقة`],
          ['مهمة الجلسة', x.taskL],
          ...(att ? [['الحضور', att] as [string, string]] : []),
        ]} />
        {ex && <ExcuseStatus ex={ex} />}
        {x.note && <p style={{ margin: 0, fontSize: 14, color: color.body, background: color.sand, padding: 12, borderRadius: 12 }}>ملاحظتك: {x.note}</p>}
        {x0.prepNote && <p style={{ margin: 0, fontSize: 14, color: color.body, background: color.sand, padding: 12, borderRadius: 12 }}>للتحضير: {x0.prepNote}</p>}
        {x.summary && (
          <div style={{ background: color.sageTint, borderRadius: 16, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: color.primary }}>ملخص المعلم بعد الجلسة</p>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.8 }}>{x.summary}</p>
          </div>
        )}
        {x.status === 'cancelled' && <p role="status" style={{ margin: 0, fontSize: 14, color: color.dangerInk, background: color.dangerBg, padding: 12, borderRadius: 12, display: 'flex', gap: 6 }}><Icon name="x" size={18} /> أُلغي هذا الحجز وأُعيد الموعد إلى المتاح.</p>}
        {x.active && (
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {x.isToday && <button onClick={() => go('live', { id: x.id })} style={primaryBtn()}><Icon name="video" /> {s.liveMode ? 'الدخول للجلسة' : 'ادخل غرفة الانتظار'}</button>}
            {x.notToday && <p style={muted(13, { textAlign: 'center' })}>سيظهر زر الدخول قبل الموعد بـ {s.pub.join_minutes} دقيقة.</p>}
            {s.liveMode && x0.startsAt && <button onClick={() => addToCalendar(x0)} style={outlineBtn(46, 14)}><Icon name="cal" size={18} /> إضافة إلى التقويم</button>}
            <div style={{ display: 'flex', gap: 10 }}>
              {/* A session the teacher created (with its Google invite) is moved by the teacher, not rebooked by the student. */}
              {!x0.topic && <button onClick={() => rescheduleSession(x0)} style={outlineBtn(52, 15, { flex: 1 })}>إعادة الجدولة</button>}
              {/* Students never cancel: they ask to be excused and the teacher decides. */}
              {!ex && (s.liveMode ? x0.canExcuse : true) && <button onClick={() => setAsking(true)} style={outlineBtn(52, 15, { flex: 1 })}>طلب اعتذار</button>}
            </div>
            {!ex && s.liveMode && !x0.canExcuse && <p style={muted(13, { textAlign: 'center' })}>انتهى وقت إرسال الاعتذار. سيتم تسجيل الغياب بدون عذر إذا لم تحضر.</p>}
          </div>
        )}
      </div>
      {asking && <ExcuseDialog x={x0} teacher={x.teacherName} when={`${x.dateFull} · ${x.timeL}`} type={`${x.type} · ${x.dur} دقيقة`} onClose={() => setAsking(false)} />}
    </div>
  );
}

const ATTENDANCE: Record<string, string> = { present: 'حضر', late: 'حضر متأخرًا', absent: 'غائب', excused: 'غاب بعذر' };

function ExcuseStatus({ ex }: { ex: NonNullable<Session['excuse']> }) {
  const [label, bg, fg] = ex.status === 'pending' ? ['الاعتذار قيد المراجعة', color.warnBg, color.warnInk]
    : ex.status === 'approved' ? ['تم قبول الاعتذار', color.sageTint, color.primary] : ['تم رفض الاعتذار', color.dangerBg, color.dangerInk];
  return (
    <div role="status" style={{ background: bg, color: fg, borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <strong style={{ fontSize: 15 }}>{label}</strong>
      {ex.reason && <span style={{ fontSize: 14, color: color.body }}>سبب الاعتذار: {ex.reason}</span>}
      {ex.teacher_response && <span style={{ fontSize: 14, color: color.body }}>رد المعلم: {ex.teacher_response}</span>}
    </div>
  );
}

/** «طلب اعتذار عن الجلسة»: the reason (5–500 characters) goes to the teacher, who approves or rejects it. */
function ExcuseDialog({ x, teacher, when, type, onClose }: { x: Session; teacher: string; when: string; type: string; onClose: () => void }) {
  const [reason, setReason] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const r = reason.trim();
    if (r.length < 5) return setErr('اكتب سبب الاعتذار (5 أحرف على الأقل).');
    setBusy(true); setErr(null);
    const fail = await requestExcuse(x, r);
    if (fail) { setErr(fail); setBusy(false); } else onClose();
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="طلب اعتذار عن الجلسة" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(20,33,31,.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <form noValidate onSubmit={submit} style={{ background: color.ivory, width: '100%', maxWidth: 520, borderRadius: '20px 20px 0 0', padding: '20px 16px calc(20px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>طلب اعتذار عن الجلسة</h2>
        <KVCard rows={[['المعلم', teacher], ['الموعد', when], ['نوع الجلسة', type]]} />
        <p style={muted(13)}>لن يُلغى الحجز. يراجع معلمك الاعتذار ويقبله أو يرفضه.</p>
        <label htmlFor="ex-r" style={labelStyle}>سبب الاعتذار</label>
        <textarea id="ex-r" autoFocus rows={4} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...inputStyle(err), minHeight: 110, paddingTop: 10 }} />
        <span style={muted(12)}>{reason.trim().length}/500</span>
        <FieldError msg={err} />
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" disabled={busy} onClick={onClose} style={outlineBtn(52, 15, { flex: 1 })}>إلغاء</button>
          <button type="submit" disabled={busy} style={primaryBtn(52, 15, { flex: 2 })}>{busy ? 'جارٍ الإرسال…' : 'إرسال الاعتذار'}</button>
        </div>
      </form>
    </div>
  );
}
