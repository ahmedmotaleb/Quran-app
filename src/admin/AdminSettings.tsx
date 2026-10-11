import { useState, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, Switch, inputStyle, labelStyle, outlineBtn, primaryBtn } from '@/components/ui';
import { TZS } from '@/data/demo';
import { tzOf } from '@/lib/format';
import { saveSettings, useAdmin } from './adminStore';
import { card } from './AdminTables';
import type { AdminSettings as Settings } from './adminData';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{title}</h2>
      {children}
    </section>
  );
}

/** Platform settings. Edits stay in a draft until saved; validation errors show beside each field. */
export default function AdminSettings() {
  const saved = useAdmin((s) => s.settings);
  const [v, setV] = useState<Settings>(saved);
  const [errs, setErrs] = useState<Record<string, string | null>>({});
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  const up = (o: Partial<Settings>) => { setV({ ...v, ...o }); setErrs({}); };
  const num = (k: keyof Settings, label: string, unit: string, min: number, max: number) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={'st-' + k} style={labelStyle}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input id={'st-' + k} type="number" inputMode="numeric" min={min} max={max} dir="ltr" value={v[k] as number} aria-invalid={!!errs[k]}
          onChange={(e) => up({ [k]: e.target.value === '' ? ('' as unknown as number) : Number(e.target.value) })}
          style={inputStyle(errs[k], false, { width: 110, fontFamily: font.latin, textAlign: 'center' })} />
        <span style={{ fontSize: 14, color: color.muted }}>{unit}</span>
      </div>
      <FieldError msg={errs[k]} />
    </div>
  );
  const sw = (k: 'reminders' | 'parentReports' | 'openSignup', label: string, hint: string) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 52, borderTop: `1px solid ${color.divider}`, paddingTop: 12 }}>
      <span><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{label}</span><span style={{ display: 'block', fontSize: 13, color: color.muted, marginTop: 2 }}>{hint}</span></span>
      <Switch on={v[k]} label={label} onToggle={() => up({ [k]: !v[k] })} />
    </div>
  );
  const save = () => {
    const e: Record<string, string> = {};
    if (v.orgName.trim().length < 2) e.orgName = 'أدخل اسم الجهة';
    if (!EMAIL_RE.test(v.supportEmail.trim())) e.supportEmail = 'صيغة البريد الإلكتروني غير صحيحة';
    const range = (k: keyof Settings, min: number, max: number) => { const n = v[k] as number; if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) e[k] = `أدخل رقمًا بين ${min} و ${max}`; };
    range('cancelHours', 0, 72); range('joinMinutes', 0, 30); range('durIndividual', 15, 120); range('durGroup', 30, 180);
    if (Object.keys(e).length) { setErrs(e); return; }
    saveSettings({ ...v, orgName: v.orgName.trim(), supportEmail: v.supportEmail.trim() });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      <Group title="الجهة">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="st-org" style={labelStyle}>اسم الجهة</label>
            <input id="st-org" value={v.orgName} aria-invalid={!!errs.orgName} onChange={(e) => up({ orgName: e.target.value })} style={inputStyle(errs.orgName)} />
            <FieldError msg={errs.orgName} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="st-mail" style={labelStyle}>بريد الدعم</label>
            <input id="st-mail" type="email" dir="ltr" value={v.supportEmail} aria-invalid={!!errs.supportEmail} onChange={(e) => up({ supportEmail: e.target.value })} style={inputStyle(errs.supportEmail, true)} />
            <FieldError msg={errs.supportEmail} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="st-tz" style={labelStyle}>المنطقة الزمنية الافتراضية</label>
            <select id="st-tz" value={v.tz} onChange={(e) => up({ tz: e.target.value })} style={{ ...inputStyle(false), padding: '0 12px' }}>
              {TZS.map((t) => <option key={t.id} value={t.id}>{t.label} ({tzOf(t.id).gmt})</option>)}
            </select>
            <p style={{ margin: 0, fontSize: 12, color: color.muted }}>تُخزَّن الأوقات بالتوقيت العالمي وتُعرض لكل مستخدم بتوقيته.</p>
          </div>
        </div>
      </Group>
      <Group title="الجلسات والحجز">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
          {num('durIndividual', 'مدة الجلسة الفردية', 'دقيقة', 15, 120)}
          {num('durGroup', 'مدة الجلسة الجماعية', 'دقيقة', 30, 180)}
          {num('cancelHours', 'الإلغاء المجاني قبل الموعد', 'ساعة', 0, 72)}
          {num('joinMinutes', 'فتح الدخول قبل الموعد', 'دقيقة', 0, 30)}
        </div>
      </Group>
      <Group title="الحسابات والإشعارات">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: -12 }}>
          {sw('openSignup', 'السماح بإنشاء حسابات الطلاب', 'الحسابات الجديدة تحتاج اعتمادًا وربطًا من الإدارة. لا يمنح التسجيل العام صلاحيات معلم أو إدارة.')}
          {sw('reminders', 'تذكير قبل الجلسات', 'إشعار للطالب والمعلم قبل الموعد بساعة.')}
          {sw('parentReports', 'تقرير أسبوعي لأولياء الأمور', 'ملخص الحضور والواجبات وآخر تقييم للأبناء المرتبطين فقط.')}
        </div>
      </Group>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', position: 'sticky', bottom: 0, background: color.ivory, padding: '12px 0' }}>
        <button onClick={save} disabled={!dirty} style={primaryBtn(48, 15, { padding: '0 24px', borderRadius: 12, opacity: dirty ? 1 : 0.5, cursor: dirty ? 'pointer' : 'default' })}>حفظ الإعدادات</button>
        <button onClick={() => { setV(saved); setErrs({}); }} disabled={!dirty} style={outlineBtn(48, 15, { padding: '0 18px', borderRadius: 12, opacity: dirty ? 1 : 0.5, cursor: dirty ? 'pointer' : 'default' })}>تراجع عن التغييرات</button>
        {dirty && <span role="status" style={{ fontSize: 13, color: color.warnInk }}>توجد تغييرات غير محفوظة</span>}
      </div>
    </div>
  );
}
