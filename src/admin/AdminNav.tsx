/** Admin portal navigation (owner request 23 Oct): a grouped vertical sidebar on the right (RTL) on wide screens,
 *  collapsible to icons; on screens under 900px a top header whose ☰ opens the same menu as a drawer from the right.
 *  Navigation only: record actions stay next to the records. Sections the signed-in admin may not open are not shown
 *  (the server still checks every request). */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon, type IconName } from '@/components/Icon';
import { BRAND } from '@/theme/brand';
import { LIVE } from '@/api/client';
import { adminLogout, canSection, goSection, useAdmin, type Section } from './adminStore';

const TrustedDevices = lazy(() => import('./live/Settings').then((m) => ({ default: m.TrustedDevices })));

export type NavItem = [Section, string, IconName];
/** Groups in display order; the first group has no heading. */
export const NAV_GROUPS: [string | null, NavItem[]][] = [
  [null, [['overview', 'نظرة عامة', 'home']]],
  ['المستخدمون', [['students', 'الطلاب', 'user'], ['teachers', 'المعلمون', 'award'], ['parents', 'أولياء الأمور', 'users']]],
  ['التعليم', [['circles', 'الحلقات', 'target'], ['lectures', 'المحاضرات', 'video'], ['quizzes', 'الاختبارات', 'plan']]],
  ['التشغيل', [['bookings', 'الجلسات والحجوزات', 'cal'], ['excuses', 'طلبات الاعتذار', 'inbox']]],
  ['الإدارة', [['subs', 'الاشتراكات', 'file'], ['admins', 'الإدارة والصلاحيات', 'shield'], ['settings', 'الإعدادات', 'settings']]],
];
export const NAV: NavItem[] = NAV_GROUPS.flatMap(([, xs]) => xs);
/** Live: no payments yet (no Subscriptions); demo: no admins or excuses screens. */
const shown = (k: Section) => (LIVE ? k !== 'subs' && canSection(k) : k !== 'admins' && k !== 'excuses');

const LEVEL: Record<string, string> = {
  owner: 'المالك', academic_manager: 'مدير أكاديمي', support: 'خدمة العملاء', content: 'إدارة المحتوى', sessions: 'مسؤول الجلسات',
  read_only: 'مشاهدة فقط', custom: 'صلاحيات مخصصة',
};
const COLLAPSE_KEY = 'halqa.admin.sidebar.collapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

function Brand({ compact = false, onClick }: { compact?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`${BRAND.ar} — نظرة عامة`} title="نظرة عامة"
      style={{ display: 'flex', alignItems: 'center', gap: 10, border: 'none', background: 'transparent', color: color.ivory, cursor: 'pointer', padding: compact ? 0 : '0 6px', textAlign: 'right', width: compact ? 'auto' : '100%', justifyContent: compact ? 'center' : 'flex-start' }}>
      <img src="/assets/halqa-mark-ivory.png" alt="" style={{ width: compact ? 40 : 44, height: compact ? 40 : 44, objectFit: 'contain', flexShrink: 0 }} />
      {!compact && <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
        <span style={{ fontSize: 19, fontWeight: 800 }}>{BRAND.ar}</span>
        <span style={{ fontSize: 12, fontFamily: font.latin, letterSpacing: 1.5, color: color.sage }}>HALQA</span>
        <span style={{ fontSize: 12, color: color.liveSub }}>لوحة الإدارة</span>
      </span>}
    </button>
  );
}

function NavList({ sec, counts, compact = false, onGo }: { sec: Section; counts: Partial<Record<Section, number>>; compact?: boolean; onGo: (k: Section) => void }) {
  return (
    <nav aria-label="التنقل في لوحة الإدارة" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {NAV_GROUPS.map(([g, items]) => {
        const vis = items.filter(([k]) => shown(k));
        if (!vis.length) return null;
        return (
          <div key={g ?? 'top'} role="group" aria-label={g ?? undefined} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {g && (compact
              ? <hr aria-hidden="true" style={{ border: 'none', borderTop: '1px solid rgba(247,243,232,.18)', margin: '8px 10px' }} />
              : <p aria-hidden="true" style={{ margin: '8px 14px 2px', fontSize: 12, fontWeight: 700, color: color.sage, opacity: 0.85 }}>{g}</p>)}
            {vis.map(([k, l, ic]) => {
              const cur = sec === k; const c = counts[k] ?? 0;
              const name = c > 0 ? `${l} ${c}` : l;
              return (
                <button key={k} type="button" onClick={() => onGo(k)} aria-current={cur ? 'page' : undefined}
                  aria-label={compact ? (c > 0 ? `${l} — ${c} بانتظار إجراء` : l) : undefined} title={compact ? name : undefined}
                  style={{ position: 'relative', minHeight: 42, padding: compact ? 0 : '0 14px', border: 'none', borderRadius: 12,
                    background: cur ? color.ivory : 'transparent', color: cur ? color.primary : color.ivory, fontSize: 15, fontWeight: cur ? 800 : 600,
                    textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: compact ? 'center' : 'flex-start', gap: 10, cursor: 'pointer', width: '100%' }}>
                  {cur && <span aria-hidden="true" style={{ position: 'absolute', insetInlineStart: 0, top: 10, bottom: 10, width: 4, borderRadius: 4, background: color.gold }} />}
                  <Icon name={ic} size={20} />
                  {!compact && <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</span>}
                  {c > 0 && <span aria-label={compact ? undefined : `${c} بانتظار إجراء`} style={compact
                    ? { position: 'absolute', top: 4, insetInlineEnd: 8, minWidth: 18, height: 18, borderRadius: 999, background: color.gold, color: color.ink, fontFamily: font.latin, fontSize: 11, display: 'grid', placeItems: 'center', padding: '0 4px' }
                    : { minWidth: 24, height: 24, borderRadius: 999, background: color.gold, color: color.ink, fontFamily: font.latin, fontSize: 12, display: 'grid', placeItems: 'center', padding: '0 6px' }}>{c}</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

/* ---------------- account block ---------------- */
function AccountModal({ kind, onClose }: { kind: 'account' | 'security'; onClose: () => void }) {
  const me = useAdmin((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); prev?.focus?.(); };
  }, [onClose]);
  const a = me?.admin_access;
  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(20,33,31,.45)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={kind === 'account' ? 'حسابي' : 'الأمان'}
        style={{ background: color.ivory, color: color.ink, borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 19, fontWeight: 800 }}>{kind === 'account' ? 'حسابي' : 'الأمان'}</h2>
          <button type="button" onClick={onClose} aria-label="إغلاق" style={{ width: 44, height: 44, border: 'none', background: 'transparent', cursor: 'pointer', color: color.muted }}><Icon name="x" /></button>
        </div>
        {kind === 'account' ? (<>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{me?.full_name ?? 'مدير المنصة'}</p>
          {me?.email && <p dir="ltr" style={{ margin: 0, fontFamily: font.latin, color: color.muted, textAlign: 'right' }}>{me.email}</p>}
          <p style={{ margin: 0 }}>مستوى الوصول: <strong>{a ? (a.level === 'owner' ? LEVEL.owner : LEVEL[a.preset] ?? a.preset) : LIVE ? '—' : 'عرض تجريبي'}</strong>{a && a.level !== 'owner' ? ` · ${a.permissions.length} صلاحية` : ''}</p>
          <p style={{ margin: 0 }}>التحقق بخطوتين: <strong>{me?.mfa_enabled ? 'مفعّل' : 'غير مفعّل'}</strong></p>
        </>) : (<>
          <p style={{ margin: 0 }}>التحقق بخطوتين: <strong>{me?.mfa_enabled ? 'مفعّل' : 'غير مفعّل'}</strong></p>
          {LIVE ? <Suspense fallback={null}><TrustedDevices /></Suspense> : <p style={{ margin: 0, color: color.muted }}>الأجهزة الموثوقة متاحة في النسخة الحقيقية.</p>}
        </>)}
      </div>
    </div>
  );
}

function AccountBlock({ compact = false, extra }: { compact?: boolean; extra?: ReactNode }) {
  const me = useAdmin((s) => s.me);
  const [menu, setMenu] = useState(false); const [modal, setModal] = useState<'account' | 'security' | null>(null);
  const name = me?.full_name || 'مدير المنصة';
  const a = me?.admin_access;
  const level = a ? (a.level === 'owner' ? LEVEL.owner : LEVEL[a.preset] ?? a.preset) : LIVE ? '' : 'عرض تجريبي';
  const avatar = (
    <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: '50%', background: color.ivory, color: color.primary, display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 17, flexShrink: 0 }}>{name.trim()[0]}</span>
  );
  const action = (label: string, icon: IconName, run: () => void) => (
    <button type="button" onClick={() => { setMenu(false); run(); }} style={{ minHeight: compact ? 40 : 36, border: 'none', background: compact ? 'transparent' : 'rgba(247,243,232,.08)', color: compact ? color.ink : color.ivory, fontSize: 13, fontWeight: 600, textAlign: 'right', padding: '0 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 10, flex: compact ? undefined : '1 1 auto', justifyContent: compact ? 'flex-start' : 'center' }}>
      <Icon name={icon} size={16} /> {label}
    </button>
  );
  const actions = <>{action('حسابي', 'user', () => setModal('account'))}{action('الأمان', 'lock', () => setModal('security'))}{action('تسجيل الخروج', 'leave', () => void adminLogout())}</>;
  return (
    <div style={{ position: 'relative', borderTop: '1px solid rgba(247,243,232,.18)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {compact ? (<>
        <button type="button" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-haspopup="menu" aria-label={`حساب المسؤول: ${name}`} title={name}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', display: 'grid', placeItems: 'center', minHeight: 48 }}>{avatar}</button>
        {menu && <div role="menu" style={{ position: 'absolute', bottom: 56, insetInlineStart: 8, zIndex: 40, background: color.ivory, borderRadius: 14, boxShadow: '0 12px 28px -10px rgba(0,0,0,.4)', padding: 8, minWidth: 200, display: 'flex', flexDirection: 'column' }}>
          <p style={{ margin: '4px 10px 6px', color: color.ink, fontWeight: 800 }}>{name}<span style={{ display: 'block', fontSize: 12, fontWeight: 500, color: color.muted }}>{level}</span></p>
          {actions}
        </div>}
      </>) : (<>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px' }}>
          {avatar}
          <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            {level && <span style={{ display: 'block', fontSize: 12, color: color.sage }}>{level}</span>}</span>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{actions}</div>
        {extra}
      </>)}
      {modal && <AccountModal kind={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

/* ---------------- desktop sidebar ---------------- */
export function AdminSidebar({ sec, counts, footer }: { sec: Section; counts: Partial<Record<Section, number>>; footer?: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => { const v = !collapsed; setCollapsed(v); try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* per-device convenience only */ } };
  return (
    <aside aria-label="القائمة الجانبية" data-collapsed={collapsed ? '1' : '0'} style={{ flex: `0 0 ${collapsed ? 80 : 264}px`, width: collapsed ? 80 : 264,
      minWidth: collapsed ? 80 : 264, maxWidth: collapsed ? 80 : 264, boxSizing: 'border-box', overflow: 'visible', background: color.primary, color: color.ivory,
      position: 'sticky', top: 0, height: '100dvh', display: 'flex', flexDirection: 'column', padding: collapsed ? '16px 10px' : '18px 12px', gap: 10, transition: 'flex-basis .15s, width .15s' }}>
      <div style={{ display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center', gap: 8 }}>
        <Brand compact={collapsed} onClick={() => goSection('overview')} />
        <button type="button" onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? 'توسيع القائمة' : 'طي القائمة'} title={collapsed ? 'توسيع القائمة' : 'طي القائمة'}
          style={{ width: 40, height: 40, flexShrink: 0, border: '1px solid rgba(247,243,232,.3)', borderRadius: 10, background: 'transparent', color: color.ivory, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
          <Icon name={collapsed ? 'chevL' : 'chevR'} size={18} />
        </button>
      </div>
      <hr aria-hidden="true" style={{ border: 'none', borderTop: '1px solid rgba(247,243,232,.18)', margin: 0 }} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', margin: '0 -4px', padding: '0 4px' }}>
        <NavList sec={sec} counts={counts} compact={collapsed} onGo={(k) => goSection(k)} />
      </div>
      <AccountBlock compact={collapsed} extra={collapsed ? undefined : footer} />
    </aside>
  );
}

/* ---------------- narrow screens: header + drawer ---------------- */
export function AdminTopBar({ sec, title, counts, footer }: { sec: Section; title: string; counts: Partial<Record<Section, number>>; footer?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null); const panel = useRef<HTMLDivElement>(null);
  const total = Object.entries(counts).reduce((n, [k, v]) => n + (shown(k as Section) ? v ?? 0 : 0), 0);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('[data-drawer-close]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'Tab' && panel.current) { // keep focus inside the drawer
        const f = [...panel.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea')].filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    window.addEventListener('keydown', key);
    const scroll = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = scroll; opener.current?.focus(); };
  }, [open]);
  return (
    <>
      <header style={{ position: 'sticky', top: 0, zIndex: 30, background: color.primary, color: color.ivory, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', paddingTop: 'calc(8px + env(safe-area-inset-top))' }}>
        <button ref={opener} type="button" onClick={() => setOpen(true)} aria-label="فتح القائمة" aria-expanded={open} aria-controls="admin-drawer"
          style={{ position: 'relative', width: 44, height: 44, border: 'none', borderRadius: 10, background: 'rgba(247,243,232,.12)', color: color.ivory, fontSize: 22, cursor: 'pointer' }}>
          ☰{total > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 4, insetInlineEnd: 4, width: 10, height: 10, borderRadius: 999, background: color.gold }} />}
        </button>
        <img src="/assets/halqa-mark-ivory.png" alt={BRAND.ar} style={{ width: 34, height: 34, objectFit: 'contain' }} />
        <p style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 17, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</p>
      </header>
      {open && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(20,33,31,.5)' }}>
          <div ref={panel} id="admin-drawer" role="dialog" aria-modal="true" aria-label="قائمة لوحة الإدارة"
            style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: 'min(86vw, 340px)', background: color.primary, color: color.ivory, display: 'flex', flexDirection: 'column', gap: 10,
              padding: '14px 12px', paddingTop: 'calc(14px + env(safe-area-inset-top))', paddingBottom: 'calc(14px + env(safe-area-inset-bottom))', boxShadow: '-12px 0 32px -12px rgba(0,0,0,.45)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}><Brand onClick={() => { goSection('overview'); setOpen(false); }} /></div>
              <button data-drawer-close type="button" onClick={() => setOpen(false)} aria-label="إغلاق القائمة"
                style={{ width: 44, height: 44, border: 'none', borderRadius: 10, background: 'rgba(247,243,232,.12)', color: color.ivory, cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" /></button>
            </div>
            <hr aria-hidden="true" style={{ border: 'none', borderTop: '1px solid rgba(247,243,232,.18)', margin: 0 }} />
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <NavList sec={sec} counts={counts} onGo={(k) => { goSection(k); setOpen(false); }} />
            </div>
            <AccountBlock extra={footer} />
          </div>
        </div>
      )}
    </>
  );
}
