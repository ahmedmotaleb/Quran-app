import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackButton, Segmented, Switch, card, dangerOutlineBtn } from '@/components/ui';
import { tzOf } from '@/lib/format';
import { go, logout, openSheet, setState, toast, up, useApp } from '@/store/store';
import { INSTALL_STEPS, promptInstall, useInstall } from '@/pwa/install';
import { LIVE } from '@/api/client';
import { useEffect, useState } from 'react';
import { disablePush, enablePush, pushState, type PushState } from '@/pwa/push';

const NOTIFS = [['tasks', 'تذكير بالواجبات'], ['sessions', 'تذكير قبل الجلسات'], ['feedback', 'تقييمات المعلم'], ['news', 'أخبار الحلقة']] as const;
const rowBtn = { width: '100%', minHeight: 52, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', gap: 8, padding: 0, cursor: 'pointer', color: color.ink, fontSize: 15 } as const;

export default function Account() {
  const s = useApp(); const role = s.role;
  const live = s.liveMode;
  const name = live ? s.user.name : role === 'teacher' ? 'الشيخ عبدالرحمن السالم' : role === 'parent' ? 'أحمد العلي' : s.user.name;
  const email = live ? s.user.email : role === 'teacher' ? 'teacher@halqa.app' : role === 'parent' ? 'parent@halqa.app' : s.user.email;
  // Live: the teachers who assigned this student's tasks.
  const myTeachers = [...new Set(s.tasks.map((t) => t.teacherName).filter(Boolean))].join('، ') || 'لم يُربط معلم بعد';
  const ini = role === 'teacher' ? 'ع' : role === 'parent' ? 'أ' : s.user.first[0];
  const roleL = { student: 'حساب طالب', teacher: 'حساب معلم', parent: 'حساب ولي أمر', admin: 'حساب إدارة' }[role || 'student'];
  const tz = tzOf(s.tz);

  return (
    <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        {role === 'parent' && <BackButton style={{ marginInlineStart: -8 }} />}
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>حسابي</h1>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, ...card, padding: 16 }}>
        <span aria-hidden="true" style={{ width: 60, height: 60, borderRadius: '50%', background: color.primary, color: color.ivory, fontSize: 24, fontWeight: 800, display: 'grid', placeItems: 'center' }}>{ini}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{name}</p>
          <p dir="ltr" style={{ margin: '2px 0 0', fontFamily: font.latin, fontSize: 13, color: color.muted, textAlign: 'right' }}>{email}</p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: color.primary, fontWeight: 700 }}>{roleL}</p>
        </div>
      </div>
      {role === 'student' && (
        <section style={{ ...card, padding: '4px 16px' }}>
          <h2 style={{ margin: '12px 0 4px', fontSize: 14, color: color.muted, fontWeight: 700 }}>التعلّم</h2>
          {([['المستوى', s.user.level], ['الهدف اليومي', s.user.goal], ['المعلم المرتبط', live ? myTeachers : 'الشيخ عبدالرحمن السالم']] as const).map(([k, v], i) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: i < 2 ? `1px solid ${color.divider}` : 'none' }}>
              <span style={{ fontSize: 15 }}>{k}</span><span style={{ fontSize: 15, fontWeight: 700 }}>{v}</span>
            </div>
          ))}
        </section>
      )}
      {role === 'teacher' && (
        <button onClick={() => go('tcontent')} style={{ minHeight: 60, padding: '0 16px', borderRadius: 16, border: `1px solid ${color.border}`, background: color.card, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ color: color.primary }}><Icon name="layers" /></span><span style={{ flex: 1, fontSize: 15, fontWeight: 700 }}>إنشاء محاضرة أو اختبار</span><span style={{ color: color.primary }}><Icon name="chevL" /></span>
        </button>
      )}
      <section style={{ ...card, padding: '4px 16px' }}>
        <h2 style={{ margin: '12px 0 4px', fontSize: 14, color: color.muted, fontWeight: 700 }}>الإشعارات</h2>
        {NOTIFS.map(([k, l]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 52, borderBottom: `1px solid ${color.divider}` }}>
            <span style={{ fontSize: 15 }}>{l}</span>
            <Switch on={s.notif[k]} label={l} onToggle={() => up('notif', { [k]: !s.notif[k] })} />
          </div>
        ))}
      </section>
      <section style={{ ...card, padding: '4px 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ margin: '12px 0 0', fontSize: 14, color: color.muted, fontWeight: 700 }}>العرض</h2>
        <p style={{ margin: 0, fontSize: 15, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="type" size={18} /> حجم الخط</p>
        <Segmented role="group" label="حجم الخط" options={[['s', 'صغير'], ['m', 'متوسط'], ['l', 'كبير']] as const} value={s.uiScale} onChange={(k) => setState({ uiScale: k })} />
        <button onClick={() => openSheet({ kind: 'tz' })} style={{ ...rowBtn, textAlign: 'right' }}>
          <span style={{ color: color.primary }}><Icon name="globe" size={18} /></span><span style={{ flex: 1 }}>المنطقة الزمنية</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{tz.label} ({tz.gmt})</span><span style={{ color: color.primary }}><Icon name="chevL" size={18} /></span>
        </button>
      </section>
      <InstallRow />
      {LIVE && <PushRow />}
      <section style={{ ...card, padding: '4px 16px' }}>
        <button onClick={() => openSheet({ kind: 'info', title: 'المساعدة', body: `للمساعدة في الحجز أو التسجيل، تواصل مع فريق الدعم عبر ${(LIVE && useApp.getState().pub.support_email) || 'halqa.app.eg@gmail.com'}. نرد عادة خلال يوم عمل.` })}
          style={{ ...rowBtn, borderBottom: `1px solid ${color.divider}` }}><Icon name="help" size={18} /><span style={{ flex: 1, textAlign: 'right' }}>المساعدة</span><Icon name="chevL" size={18} /></button>
        <button onClick={() => openSheet({ kind: 'info', title: 'الخصوصية', body: 'تسجيلاتك لا يطّلع عليها إلا معلمك المرتبط وإدارة الحلقة. يرى ولي الأمر بيانات أبنائه المرتبطين فقط. يُحذف التسجيل تلقائيًا بعد 48 ساعة من تقييم المعلم، وتبقى الدرجات والملاحظات. يمكنك طلب حذف تسجيلاتك في أي وقت.' })}
          style={rowBtn}><Icon name="shield" size={18} /><span style={{ flex: 1, textAlign: 'right' }}>الخصوصية</span><Icon name="chevL" size={18} /></button>
      </section>
      <button onClick={() => openSheet({ kind: 'confirm', title: 'تسجيل الخروج؟', body: 'ستحتاج إلى إدخال بريدك وكلمة المرور للعودة.', ok: 'تسجيل الخروج', danger: true, onOk: logout })}
        style={dangerOutlineBtn(52, 16)}><Icon name="leave" /> تسجيل الخروج</button>
      <p style={{ margin: 0, fontSize: 12, color: color.muted, textAlign: 'center', fontFamily: font.latin }}>{LIVE ? 'HALQA · v0.1' : 'HALQA · v0.1 prototype'}</p>
    </div>
  );
}

/** Offers to install the PWA on the home screen; hidden when already installed or unsupported. */
function InstallRow() {
  const how = useInstall();
  if (!how) return null;
  const click = async () => {
    if (how === 'prompt') { if (await promptInstall()) toast('ثُبّت التطبيق على جهازك'); return; }
    openSheet({ kind: 'info', ...INSTALL_STEPS[how] });
  };
  return (
    <button onClick={click} style={{ ...card, minHeight: 56, padding: '0 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', color: color.ink, fontSize: 15, fontWeight: 700, textAlign: 'right' }}>
      <span style={{ color: color.primary }}><Icon name="upload" size={18} /></span>
      <span style={{ flex: 1 }}>ثبّت التطبيق على جهازك</span>
      <span style={{ color: color.primary }}><Icon name="chevL" size={18} /></span>
    </button>
  );
}


const PUSH_TEXT: Record<PushState, string> = {
  'unsupported': 'هذا المتصفح لا يدعم إشعارات الجوال. ستجد كل الإشعارات داخل التطبيق.',
  'ios-install': 'على iPhone وiPad: ثبّت التطبيق على الشاشة الرئيسية أولًا (iOS 16.4 أو أحدث)، ثم فعّل الإشعارات من هنا.',
  'server-off': 'إشعارات الجوال غير مفعّلة على الخادم بعد. ستجد كل الإشعارات داخل التطبيق.',
  'denied': 'رُفض إذن الإشعارات لهذا الموقع. فعّله من إعدادات المتصفح ثم عد إلى هنا.',
  'off': 'تصلك تنبيهات قصيرة عند وصول تقييم أو واجب أو تذكير بجلسة، دون تفاصيل على شاشة القفل.',
  'on': 'الإشعارات مفعّلة على هذا الجهاز. تظهر تنبيهات عامة فقط، والتفاصيل داخل التطبيق.',
};

/** Phone notifications for this device: explained first, permission asked only on tap, easy to turn off. */
function PushRow() {
  const [st, setSt] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setSt).catch(() => setSt('unsupported')); }, []);
  if (!st) return null;
  const act = async () => {
    setBusy(true);
    try { const n = st === 'on' ? await disablePush() : await enablePush(); setSt(n); if (n === 'on') toast('ستصلك الإشعارات على هذا الجهاز'); if (n === 'off' && st === 'on') toast('أُوقفت الإشعارات على هذا الجهاز'); }
    catch { toast('تعذّر تغيير الإشعارات. حاول مرة أخرى.', 'alert'); }
    finally { setBusy(false); }
  };
  const can = st === 'on' || st === 'off';
  return (
    <section aria-labelledby="push-h" style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: color.primary }}><Icon name="bell" size={18} /></span>
        <h2 id="push-h" style={{ flex: 1, margin: 0, fontSize: 15, fontWeight: 700 }}>إشعارات على هذا الجهاز</h2>
        {can && <Switch on={st === 'on'} onToggle={() => { if (!busy) act(); }} label="إشعارات على هذا الجهاز" />}
      </div>
      <p role="status" style={{ margin: 0, fontSize: 13, color: color.muted, lineHeight: 1.7 }}>{PUSH_TEXT[st]}</p>
    </section>
  );
}
