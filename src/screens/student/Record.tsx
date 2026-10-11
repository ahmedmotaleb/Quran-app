import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackHeader, PlayerBar, RecDot, Spinner, StatusBlock, card, linkBtn, muted, outlineBtn, primaryBtn } from '@/components/ui';
import { fmt } from '@/lib/format';
import { recording } from '@/services/media';
import {
  back, demoRec, openSheet, pauseRec, reset, resetRec, resumeRec, setState, startRec, stopRec, submitRec, up, useApp,
} from '@/store/store';

const STATUS: Record<string, string> = { idle: 'جاهز للتسجيل', requesting: 'بانتظار إذن الميكروفون…', recording: 'جارٍ التسجيل', paused: 'متوقف مؤقتًا', review: 'استمع قبل التسليم' };

export default function Record() {
  const s = useApp();
  const R = s.rec; const ph = R.phase;
  const rt = s.tasks.find((x) => x.id === R.task);
  const taskL = rt ? `${rt.title} · الآيات ${rt.from}–${rt.to}` : '';
  const durL = fmt(R.secs);
  const showWave = ['recording', 'paused', 'review', 'idle', 'requesting'].includes(ph);

  const levels = Array.from({ length: 32 }, (_, i) => {
    const on = ph === 'recording';
    const h = on ? 8 + Math.abs(Math.sin((R.secs * 4 + i) * 1.7) * Math.cos(i * 0.9 + R.secs)) * 44
      : ph === 'paused' || ph === 'review' ? 6 + Math.abs(Math.sin(i * 1.3)) * 22 : 6;
    return { h: Math.round(h), c: on ? color.primary : '#B9C9B8' };
  });

  const redo = () => openSheet({
    kind: 'confirm', title: 'إعادة التسجيل؟', body: 'سيُحذف التسجيل الحالي ولن يمكن استعادته.', ok: 'احذف وأعد التسجيل', danger: true,
    onOk: () => { resetRec(); setState({ sheet: null }); },
  });
  const pickable = s.tasks.filter((t) => t.status === 'not_started' || t.status === 'in_progress');

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <BackHeader title="تسجيل التلاوة" />
      <div style={{ padding: '0 16px 20px', display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        {ph === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={muted(14, { fontWeight: 700 })}>اربط التسجيل بمهمة</p>
            <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pickable.map((t) => {
                const on = t.id === R.task;
                return (
                  <button key={t.id} role="radio" aria-checked={on} onClick={() => up('rec', { task: t.id })}
                    style={{ minHeight: 48, padding: '8px 14px', borderRadius: 12, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.sage : color.card, color: color.ink, fontSize: 14, fontWeight: 700, textAlign: 'right', cursor: 'pointer' }}>
                    {t.title} ({t.from}–{t.to})
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {(ph === 'recording' || ph === 'paused') && (
          <div style={{ background: color.sageTint, borderRadius: 12, padding: '10px 14px', fontSize: 14, color: color.primary, fontWeight: 700, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="book" size={18} /> {taskL}</div>
        )}
        {showWave && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, minHeight: 280 }}>
            <p role="status" style={{ margin: 0, fontSize: 15, fontWeight: 700, color: color.body, display: 'flex', alignItems: 'center', gap: 8 }}>{ph === 'recording' && <RecDot />}{STATUS[ph]}</p>
            <p dir="ltr" style={{ margin: 0, fontFamily: font.latin, fontSize: 56, fontWeight: 600, color: color.ink, letterSpacing: 1 }}>{durL}</p>
            <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 4, height: 64 }}>
              {levels.map((l, i) => <span key={i} style={{ width: 4, borderRadius: 4, height: l.h, background: l.c }} />)}
            </div>
            {R.demo && <p style={muted(12)}>تسجيل تجريبي — لا يُلتقط صوت فعلي</p>}
          </div>
        )}
        {ph === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <button onClick={startRec} aria-label="ابدأ التسجيل" style={{ width: 84, height: 84, borderRadius: '50%', border: 'none', background: color.primary, color: color.ivory, display: 'grid', placeItems: 'center', cursor: 'pointer', boxShadow: `0 0 0 8px ${color.sage}` }}><Icon name="mic" size={30} /></button>
            <p style={{ margin: '6px 0 0', fontSize: 15, fontWeight: 700 }}>ابدأ التسجيل</p>
            <p style={muted(13)}>اختر مكانًا هادئًا، وسجّل النطاق كاملًا دون النظر.</p>
            <button onClick={demoRec} style={linkBtn(14, { textDecoration: 'underline' })}>استخدم تسجيلًا تجريبيًا بدون ميكروفون</button>
          </div>
        )}
        {ph === 'requesting' && <div style={{ display: 'flex', justifyContent: 'center' }}><Spinner /></div>}
        {ph === 'recording' && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24, alignItems: 'center' }}>
            <button onClick={pauseRec} aria-label="إيقاف مؤقت" style={{ minWidth: 64, minHeight: 64, borderRadius: '50%', border: `1.5px solid ${color.borderStrong}`, background: color.card, color: color.primary, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><Icon name="pause" /></button>
            <button onClick={stopRec} style={primaryBtn(64, 16, { padding: '0 28px', borderRadius: 999 })}><Icon name="stop" /> إنهاء التسجيل</button>
          </div>
        )}
        {ph === 'paused' && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24, alignItems: 'center' }}>
            <button onClick={resumeRec} style={{ ...outlineBtn(64, 16, { padding: '0 22px', borderRadius: 999, background: color.card, gap: 8 }) }}><Icon name="mic" /> متابعة</button>
            <button onClick={stopRec} style={primaryBtn(64, 16, { padding: '0 28px', borderRadius: 999 })}><Icon name="stop" /> إنهاء</button>
          </div>
        )}
        {ph === 'review' && (
          <>
            <div style={{ ...card, padding: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
              <PlayerBar k="rec" dur={R.secs} url={recording.url} btnSize={52} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={redo} style={outlineBtn(54, 16, { padding: '0 18px' })}><Icon name="refresh" /> إعادة</button>
              <button onClick={submitRec} style={primaryBtn(54, 17, { flex: 1 })}><Icon name="upload" /> تسليم التلاوة</button>
            </div>
          </>
        )}
        {ph === 'denied' && (
          <div role="alert" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 }}>
            <span style={{ width: 64, height: 64, borderRadius: '50%', background: color.dangerBg, color: color.dangerInk, display: 'grid', placeItems: 'center', alignSelf: 'center' }}><Icon name="micOff" size={30} /></span>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, textAlign: 'center' }}>لم يُسمح بالوصول إلى الميكروفون</h2>
            <ol style={{ margin: 0, padding: '0 20px 0 0', fontSize: 14, lineHeight: 1.9, color: color.body }}>
              <li>افتح إعدادات التطبيق أو المتصفح.</li><li>اختر «الأذونات» ثم «الميكروفون».</li><li>اسمح للحلقة بالوصول، ثم عد وحاول مجددًا.</li>
            </ol>
            <button onClick={startRec} style={primaryBtn(54, 16)}>حاول مرة أخرى</button>
            <button onClick={demoRec} style={outlineBtn(52, 15)}>تابع بتسجيل تجريبي</button>
          </div>
        )}
        {ph === 'empty' && (
          <StatusBlock role="alert" icon="alert" iconBg={color.warnBg} iconFg={color.warnInk} title="التسجيل قصير جدًا" body={`لم نلتقط تلاوة كافية (${durL}). سجّل 3 ثوانٍ على الأقل.`}>
            <button onClick={resetRec} style={primaryBtn(54, 16, { padding: '0 28px' })}>سجّل من جديد</button>
          </StatusBlock>
        )}
        {ph === 'uploading' && (
          <div role="status" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14, textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>جارٍ رفع التسجيل…</h2>
            <div role="progressbar" aria-valuenow={Math.round(R.prog)} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, borderRadius: 8, background: color.track, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: color.primary, width: `${Math.round(R.prog)}%` }} />
            </div>
            <p dir="ltr" style={{ margin: 0, fontFamily: font.latin, fontSize: 14, color: color.muted }}>{Math.round(R.prog)}%</p>
            <p style={muted(13)}>لا تغلق التطبيق حتى يكتمل الرفع.</p>
          </div>
        )}
        {ph === 'failed' && (
          <StatusBlock role="alert" icon="upload" iconBg={color.dangerBg} iconFg={color.dangerInk} title="تعذّر رفع التسجيل. حاول مرة أخرى" body={`تسجيلك (${durL}) محفوظ على الجهاز ولن يُفقد.`}>
            <button onClick={submitRec} style={primaryBtn(54, 16, { padding: '0 28px' })}><Icon name="refresh" /> إعادة المحاولة</button>
            <button onClick={back} style={linkBtn(15, { minHeight: 48 })}>لاحقًا</button>
          </StatusBlock>
        )}
        {ph === 'success' && (
          <div role="status" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 12 }}>
            <span style={{ width: 80, height: 80, borderRadius: '50%', background: color.primary, color: color.ivory, display: 'grid', placeItems: 'center', boxShadow: `0 0 0 10px ${color.sage}` }}><Icon name="check" size={30} /></span>
            <h2 style={{ margin: '12px 0 0', fontSize: 22, fontWeight: 800 }}>تم تسليم تلاوتك</h2>
            <p style={{ margin: 0, fontSize: 15, color: color.body, lineHeight: 1.7 }}>{taskL} · {durL}<br />حالة المهمة الآن: تم التسليم. سيصلك إشعار عند تقييم المعلم.</p>
            <p style={{ margin: 0, fontSize: 12, color: color.muted, background: color.sand, padding: '6px 12px', borderRadius: 999 }}>تسليم تجريبي داخل النموذج — لم يُرفع أي ملف إلى خادم</p>
            <div style={{ display: 'flex', gap: 10, width: '100%', marginTop: 8 }}>
              <button onClick={() => reset('home', 'student')} style={outlineBtn(52, 15, { flex: 1 })}>الرئيسية</button>
              <button onClick={back} style={primaryBtn(52, 15, { flex: 1 })}>عرض المهمة</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
