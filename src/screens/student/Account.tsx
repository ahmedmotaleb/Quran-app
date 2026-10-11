import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackButton, Segmented, Switch, card, dangerOutlineBtn } from '@/components/ui';
import { tzOf } from '@/lib/format';
import { go, logout, openSheet, setState, up, useApp } from '@/store/store';

const NOTIFS = [['tasks', 'تذكير بالواجبات'], ['sessions', 'تذكير قبل الجلسات'], ['feedback', 'تقييمات المعلم'], ['news', 'أخبار الحلقة']] as const;
const rowBtn = { width: '100%', minHeight: 52, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', gap: 8, padding: 0, cursor: 'pointer', color: color.ink, fontSize: 15 } as const;

export default function Account() {
  const s = useApp(); const role = s.role;
  const name = role === 'teacher' ? 'الشيخ عبدالرحمن السالم' : role === 'parent' ? 'أحمد العلي' : s.user.name;
  const email = role === 'teacher' ? 'teacher@halqa.app' : role === 'parent' ? 'parent@halqa.app' : s.user.email;
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
          {([['المستوى', s.user.level], ['الهدف اليومي', s.user.goal], ['المعلم المرتبط', 'الشيخ عبدالرحمن السالم']] as const).map(([k, v], i) => (
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
      <section style={{ ...card, padding: '4px 16px' }}>
        <button onClick={() => openSheet({ kind: 'info', title: 'المساعدة', body: 'للمساعدة في الحجز أو التسجيل أو الاشتراك، تواصل مع فريق الدعم عبر support@halqa.app. نرد عادة خلال يوم عمل.' })}
          style={{ ...rowBtn, borderBottom: `1px solid ${color.divider}` }}><Icon name="help" size={18} /><span style={{ flex: 1, textAlign: 'right' }}>المساعدة</span><Icon name="chevL" size={18} /></button>
        <button onClick={() => openSheet({ kind: 'info', title: 'الخصوصية', body: 'تسجيلاتك لا يطّلع عليها إلا معلمك المرتبط وإدارة الحلقة. يرى ولي الأمر بيانات أبنائه المرتبطين فقط. يمكنك طلب حذف تسجيلاتك في أي وقت.' })}
          style={rowBtn}><Icon name="shield" size={18} /><span style={{ flex: 1, textAlign: 'right' }}>الخصوصية</span><Icon name="chevL" size={18} /></button>
      </section>
      <button onClick={() => openSheet({ kind: 'confirm', title: 'تسجيل الخروج؟', body: 'ستحتاج إلى إدخال بريدك وكلمة المرور للعودة.', ok: 'تسجيل الخروج', danger: true, onOk: logout })}
        style={dangerOutlineBtn(52, 16)}><Icon name="leave" /> تسجيل الخروج</button>
      <p style={{ margin: 0, fontSize: 12, color: color.muted, textAlign: 'center', fontFamily: font.latin }}>HALQA · v0.1 prototype</p>
    </div>
  );
}
