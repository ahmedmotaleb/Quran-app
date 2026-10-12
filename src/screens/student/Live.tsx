import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { Avatar, RecDot, Spinner, card, outlineBtn, primaryBtn } from '@/components/ui';
import { fmt, rangeL } from '@/lib/format';
import { back, openSheet, reset, setState, up, useApp } from '@/store/store';
import { decoSession, upcomingSessions } from '@/store/selectors';

const ctrl = (on: boolean) => ({
  width: 56, height: 56, borderRadius: '50%', border: 'none', background: on ? 'rgba(247,243,232,.14)' : color.ivory,
  color: on ? color.ivory : color.liveBg, display: 'grid', placeItems: 'center', cursor: 'pointer',
});

export default function Live() {
  const s = useApp(); const LV = s.live; const role = s.role;
  const found = s.sessions.find((y) => y.id === s.params.id);
  const ls = found ? decoSession(found, s) : upcomingSessions(s)[0];
  const other = role === 'teacher' ? { name: 'يوسف أحمد', ini: 'ي' } : { name: ls?.teacherName ?? '', ini: ls?.ini ?? '' };
  const me = role === 'teacher' ? { name: 'أنت (المعلم)', ini: 'ع' } : { name: 'أنت', ini: s.user.first[0] };
  const lt = ls && s.tasks.find((k) => k.id === ls.task);
  const taskL = lt ? rangeL(lt) : 'تلاوة حرة'; const taskT = lt ? lt.title : '';
  const isLive = LV.phase === 'live' || LV.phase === 'reconnecting';
  const recon = LV.phase === 'reconnecting';
  const toHome = () => reset(role === 'teacher' ? 'tdash' : 'home', role);
  const toPlan = () => reset(role === 'teacher' ? 'tdash' : 'plan', role);

  const micCam = (
    <>
      <button onClick={() => up('live', { mic: !LV.mic })} aria-label={LV.mic ? 'كتم الميكروفون' : 'تشغيل الميكروفون'} aria-pressed={LV.mic} style={ctrl(LV.mic)}><Icon name={LV.mic ? 'mic' : 'micOff'} /></button>
      <button onClick={() => up('live', { cam: !LV.cam })} aria-label={LV.cam ? 'إيقاف الكاميرا' : 'تشغيل الكاميرا'} aria-pressed={LV.cam} style={ctrl(LV.cam)}><Icon name={LV.cam ? 'video' : 'videoOff'} /></button>
    </>
  );

  return (
    <div style={{ minHeight: '100%', background: color.liveBg, color: color.ivory, display: 'flex', flexDirection: 'column' }}>
      {LV.phase === 'waiting' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '8px 16px 20px', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={back} aria-label="رجوع" style={{ width: 48, height: 48, border: 'none', background: 'transparent', color: color.ivory, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="chevR" /></button>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>غرفة الانتظار</h1>
          </div>
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <p style={{ margin: 0, fontSize: 15, color: color.liveSub }}>جلستك مع {other.name} تبدأ خلال</p>
            <p dir="ltr" role="timer" style={{ margin: 0, fontFamily: font.latin, fontSize: 44, fontWeight: 600 }}>{fmt(LV.count)}</p>
          </div>
          <div style={{ aspectRatio: '4/3', borderRadius: 20, background: color.liveTile, display: 'grid', placeItems: 'center', position: 'relative' }}>
            {LV.cam ? <Avatar ini={me.ini} size={96} fs={40} /> : <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: color.liveSub, fontSize: 14 }}><Icon name="videoOff" size={30} /> الكاميرا متوقفة</span>}
            <span style={{ position: 'absolute', bottom: 10, right: 12, fontSize: 13, background: 'rgba(0,0,0,.35)', padding: '4px 10px', borderRadius: 999 }}>معاينتك · {LV.mic ? 'الميكروفون يعمل' : 'الميكروفون مكتوم'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16 }}>{micCam}</div>
          <div style={{ background: 'rgba(247,243,232,.08)', borderRadius: 14, padding: '12px 14px', fontSize: 14, display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="book" size={18} /> مهمة الجلسة: {taskL}</div>
          <button onClick={() => up('live', { phase: 'connecting', c: 0 })} style={primaryBtn(54, 17, { marginTop: 'auto', background: color.ivory, color: color.primary, fontWeight: 800 })}>ادخل الجلسة</button>
          <p style={{ margin: 0, fontSize: 12, color: color.liveSub2, textAlign: 'center' }}>الاتصال المرئي محاكاة داخل النموذج — يحتاج ربطًا بخدمة اتصال مباشر.</p>
        </div>
      )}
      {LV.phase === 'connecting' && (
        <div role="status" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}><Spinner light /><p style={{ margin: 0, fontSize: 16 }}>جارٍ الاتصال بالجلسة…</p></div>
      )}
      {isLive && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '8px 12px 12px', gap: 10, position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px' }}>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><RecDot /> <span dir="ltr" style={{ fontFamily: font.latin, fontWeight: 600 }}>{fmt(LV.secs)}</span></span>
            {recon
              ? <span style={{ fontSize: 13, color: color.liveWarn, display: 'flex', gap: 4, alignItems: 'center' }}><Icon name="wifiOff" size={18} /> اتصال ضعيف</span>
              : <span style={{ fontSize: 13, color: color.liveSub, display: 'flex', gap: 4, alignItems: 'center' }}><Icon name="wifi" size={18} /> اتصال جيد</span>}
          </div>
          {recon && (
            <div role="alert" style={{ background: color.offlineBar, borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Spinner light /><span style={{ flex: 1, fontSize: 14 }}>انقطع الاتصال. جارٍ إعادة المحاولة… (المحاولة {LV.attempt} من 3)</span>
              <button onClick={() => up('live', { phase: 'connecting', c: 0, attempt: 0 })} style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(247,243,232,.4)', background: 'transparent', color: color.ivory, fontWeight: 700, cursor: 'pointer' }}>الآن</button>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 240, borderRadius: 20, background: color.liveTile, display: 'grid', placeItems: 'center', position: 'relative' }}>
            <span style={{ width: 110, height: 110, borderRadius: '50%', background: color.sage, color: color.primary, fontSize: 44, fontWeight: 800, display: 'grid', placeItems: 'center', boxShadow: '0 0 0 6px rgba(198,166,107,.35)' }}>{other.ini}</span>
            <span style={{ position: 'absolute', bottom: 10, right: 12, fontSize: 13, background: 'rgba(0,0,0,.35)', padding: '4px 10px', borderRadius: 999 }}>{other.name} · يتحدث</span>
            <div style={{ position: 'absolute', top: 10, left: 10, width: 96, height: 128, borderRadius: 14, background: color.liveTileSelf, display: 'grid', placeItems: 'center', border: '2px solid rgba(247,243,232,.2)' }}>
              {LV.cam ? <Avatar ini={me.ini} size={48} fs={20} bg={color.ivory} /> : <span style={{ color: color.liveSub }}><Icon name="videoOff" /></span>}
              <span style={{ position: 'absolute', bottom: 4, fontSize: 11 }}>{me.name}</span>
            </div>
          </div>
          {LV.taskOpen && (
            <div style={{ background: color.ivory, color: color.ink, borderRadius: 16, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <p style={{ margin: 0, fontSize: 13, color: color.muted, fontWeight: 700 }}>مهمة الجلسة</p>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{taskT}</p>
              <p style={{ margin: 0, fontSize: 14, color: color.body }}>{taskL}</p>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 14, padding: '6px 0' }}>
            {micCam}
            <button onClick={() => up('live', { taskOpen: !LV.taskOpen })} aria-label="إظهار أو إخفاء مهمة الجلسة" aria-pressed={LV.taskOpen} style={ctrl(true)}><Icon name="book" /></button>
            <button onClick={() => openSheet({ kind: 'confirm', title: 'الخروج من الجلسة؟', body: 'يمكنك العودة ما دامت الجلسة قائمة.', ok: 'اخرج من الجلسة', danger: true, onOk: () => setState((st) => ({ sheet: null, live: { ...st.live, phase: 'ended' } })) })}
              aria-label="الخروج من الجلسة" style={{ width: 72, height: 56, borderRadius: 999, border: 'none', background: color.leave, color: color.card, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="leave" /></button>
          </div>
        </div>
      )}
      {LV.phase === 'failed' && (
        <div role="alert" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
          <span style={{ color: color.liveWarn }}><Icon name="wifiOff" size={30} /></span>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>تعذّر الاتصال بالجلسة</h2>
          <p style={{ margin: 0, fontSize: 15, color: color.liveSub, lineHeight: 1.7 }}>تحقق من اتصالك بالإنترنت. الجلسة ما زالت قائمة ويمكنك العودة إليها.</p>
          <button onClick={() => up('live', { phase: 'connecting', c: 0, attempt: 0 })} style={primaryBtn(52, 16, { padding: '0 24px', background: color.ivory, color: color.primary, fontWeight: 800 })}><Icon name="refresh" /> إعادة المحاولة</button>
          <button onClick={toHome} style={{ minHeight: 48, border: 'none', background: 'transparent', color: color.ivory, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>الخروج</button>
        </div>
      )}
      {LV.phase === 'ended' && (
        <div style={{ flex: 1, background: color.ivory, color: color.ink, display: 'flex', flexDirection: 'column', padding: '20px 16px', gap: 14 }}>
          <span style={{ width: 64, height: 64, borderRadius: '50%', background: color.sage, color: color.primary, display: 'grid', placeItems: 'center', alignSelf: 'center' }}><Icon name="check" size={30} /></span>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, textAlign: 'center' }}>انتهت الجلسة</h1>
          <p style={{ margin: 0, fontSize: 14, color: color.muted, textAlign: 'center' }}>مع {other.name} · المدة <bdi dir="ltr" style={{ fontFamily: font.latin }}>{fmt(LV.secs)}</bdi></p>
          <div style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p style={{ margin: 0, fontSize: 13, color: color.muted, fontWeight: 700 }}>ما تمت تغطيته</p>
            <p style={{ margin: 0, fontSize: 15 }}>{taskT} — {taskL}</p>
          </div>
          <div style={{ background: color.sageTint, borderRadius: 16, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p style={{ margin: 0, fontSize: 13, color: color.primary, fontWeight: 700 }}>{role === 'teacher' ? 'الخطوة التالية' : 'ملاحظات المعلم'}</p>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.8 }}>{role === 'teacher' ? 'أضف ملخص الجلسة وأنشئ الواجب التالي للطالب.' : 'سيضيف المعلم ملخص الجلسة وواجبك التالي خلال ساعة، وستصلك إشعارات بذلك.'}</p>
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', gap: 10 }}>
            <button onClick={toHome} style={outlineBtn(52, 15, { flex: 1 })}>الرئيسية</button>
            <button onClick={toPlan} style={primaryBtn(52, 15, { flex: 1 })}>عرض الخطة</button>
          </div>
        </div>
      )}
    </div>
  );
}
