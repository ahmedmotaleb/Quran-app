import type { CSSProperties, ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { primaryBtn } from '@/components/ui';
import { LEVELS, STATUS, TEACHER_NAMES, TOPICS, type Status } from './adminData';
import {
  PAGE_SIZE, confirmAction, setAdmin, setStatus, toast, useAdmin, type AdminState, type Dialog, type Section,
} from './adminStore';

export const card: CSSProperties = { background: color.card, border: `1px solid ${color.border}`, borderRadius: 16 };

interface Act { label: string; click: () => void; primary?: boolean; danger?: boolean }
interface Row { id: number; name: string; search: string; cells: ReactNode[]; st: Status; acts: Act[]; extra?: string; open?: () => void }
interface Config {
  cols: string[]; rows: Row[]; searchL: string;
  extra?: { label: string; options: [string, string][] };
  add?: { label: string; dialog: Dialog };
}

const STATUS_ORDER: Status[] = ['pending', 'active', 'confirmed', 'full', 'draft', 'completed', 'cancelled', 'expired', 'off'];
const open = (dialog: Dialog) => () => setAdmin({ dialog });
const all = (l: string, opts: string[]): [string, string][] => [['all', l], ...opts.map((o) => [o, o] as [string, string])];

/** Suspend/reactivate with a confirmation step for the destructive direction. */
function toggleAct(list: 'users' | 'teachers' | 'circles', id: number, name: string, st: Status): Act {
  return st === 'off'
    ? { label: 'إعادة تفعيل', click: () => setStatus(list, id, 'active', `أُعيد تفعيل ${name}`) }
    : { label: 'إيقاف', danger: true, click: () => confirmAction(`إيقاف ${name}؟`, 'لن يتمكن من الدخول أو الظهور للطلاب حتى إعادة التفعيل. لا تُحذف أي بيانات.', 'إيقاف', () => setStatus(list, id, 'off', `أُوقف ${name}`)) };
}

function config(s: AdminState): Config {
  switch (s.sec) {
    case 'students': {
      const rows = s.users.filter((u) => u.role !== 'ولي أمر').map((x): Row => ({
        id: x.id, name: x.name, search: x.name + ' ' + x.email, st: x.st, extra: x.level, open: open({ kind: 'student', id: x.id }),
        cells: [x.level ?? '—', x.teacher ?? <span style={{ color: color.warnInk }}>غير مرتبط</span>, x.parent ?? '—'],
        acts: x.st === 'pending'
          ? [{ label: 'اعتماد وربط', primary: true, click: open({ kind: 'link', id: x.id, approve: true }) }]
          : [{ label: 'تعديل الربط', click: open({ kind: 'link', id: x.id, approve: false }) }, { label: 'تعديل', click: open({ kind: 'user', id: x.id, role: x.role }) }, toggleAct('users', x.id, x.name, x.st)],
      }));
      return { cols: ['الطالب', 'المستوى', 'المعلم', 'ولي الأمر'], rows, searchL: 'ابحث بالاسم أو البريد', extra: { label: 'المستوى', options: all('كل المستويات', LEVELS) }, add: { label: 'إضافة طالب', dialog: { kind: 'user', id: null, role: 'طالب' } } };
    }
    case 'parents': {
      const rows = s.users.filter((u) => u.role === 'ولي أمر').map((x): Row => ({
        id: x.id, name: x.name, search: x.name + ' ' + x.email, st: x.st,
        cells: [<bdi dir="ltr" style={{ fontFamily: font.latin }}>{x.email}</bdi>, x.children.length ? x.children.join('، ') : <span style={{ color: color.warnInk }}>غير مرتبط</span>],
        acts: x.st === 'pending'
          ? [{ label: 'اعتماد وربط', primary: true, click: open({ kind: 'link', id: x.id, approve: true }) }]
          : [{ label: 'ربط الأبناء', click: open({ kind: 'link', id: x.id, approve: false }) }, { label: 'تعديل', click: open({ kind: 'user', id: x.id, role: x.role }) }, toggleAct('users', x.id, x.name, x.st)],
      }));
      return { cols: ['ولي الأمر', 'البريد الإلكتروني', 'الأبناء المرتبطون'], rows, searchL: 'ابحث بالاسم أو البريد', add: { label: 'إضافة ولي أمر', dialog: { kind: 'user', id: null, role: 'ولي أمر' } } };
    }
    case 'teachers': {
      const rows = s.teachers.map((x): Row => ({
        id: x.id, name: x.name, search: x.name + ' ' + x.spec, st: x.st, open: open({ kind: 'teacher', id: x.id }),
        cells: [x.spec, x.types, <span style={{ fontFamily: font.latin }}>{s.users.filter((u) => u.teacher === x.name && u.st === 'active').length}</span>],
        acts: x.st === 'pending'
          ? [{ label: 'اعتماد', primary: true, click: () => setStatus('teachers', x.id, 'active', 'تم اعتماد ' + x.name) }, { label: 'رفض', danger: true, click: () => confirmAction('رفض طلب الانضمام؟', `سيُبلَّغ ${x.name} برفض الطلب.`, 'رفض الطلب', () => setStatus('teachers', x.id, 'off', 'رُفض الطلب')) }]
          : [toggleAct('teachers', x.id, x.name, x.st)],
      }));
      return { cols: ['المعلم', 'التخصص', 'أنواع الجلسات', 'الطلاب'], rows, searchL: 'ابحث بالاسم أو التخصص' };
    }
    case 'circles': {
      const rows = s.circles.map((x): Row => ({
        id: x.id, name: x.name, search: x.name + ' ' + x.teacher, st: x.st, extra: x.teacher,
        cells: [x.teacher, x.schedule, <span style={{ fontFamily: font.latin }} dir="ltr">{x.members} / {x.capacity}</span>],
        acts: [
          ...(x.st === 'draft' ? [{ label: 'نشر', primary: true, click: () => setStatus('circles', x.id, x.members >= x.capacity ? 'full' : 'active', `نُشرت «${x.name}» للطلاب`) }] : []),
          { label: 'تعديل', click: open({ kind: 'circle', id: x.id }) },
          ...(x.st !== 'draft' ? [toggleAct('circles', x.id, x.name, x.st)] : []),
        ],
      }));
      return { cols: ['الحلقة', 'المعلم', 'الموعد (القاهرة)', 'الطلاب'], rows, searchL: 'ابحث باسم الحلقة أو المعلم', extra: { label: 'المعلم', options: all('كل المعلمين', TEACHER_NAMES) }, add: { label: 'حلقة جديدة', dialog: { kind: 'circle', id: null } } };
    }
    case 'bookings': {
      const rows = s.bookings.map((x): Row => ({
        id: x.id, name: x.student, search: x.student + ' ' + x.teacher, st: x.st, extra: x.teacher,
        cells: [x.teacher, x.when, x.type],
        acts: x.st === 'confirmed'
          ? [{ label: 'إلغاء الحجز', danger: true, click: () => confirmAction('إلغاء الحجز؟', `سيُلغى موعد ${x.student} مع ${x.teacher} (${x.when}) ويُبلَّغ الطرفان، ويعود الموعد متاحًا.`, 'إلغاء الحجز', () => setStatus('bookings', x.id, 'cancelled', 'أُلغي الحجز وأُبلغ الطرفان')) }]
          : [],
      }));
      return { cols: ['الطالب', 'المعلم', 'الموعد (القاهرة)', 'النوع'], rows, searchL: 'ابحث باسم الطالب أو المعلم', extra: { label: 'المعلم', options: all('كل المعلمين', TEACHER_NAMES) } };
    }
    case 'lectures':
    case 'quizzes': {
      const ck = s.sec === 'lectures' ? 'lecture' : 'quiz';
      const rows = s.content.filter((c) => c.kind === ck).map((x): Row => ({
        id: x.id, name: x.name, search: x.name + ' ' + x.by, st: x.st, extra: x.topic,
        cells: [x.by, x.k, `${x.topic} · ${x.level}`],
        acts: x.st === 'pending'
          ? [{ label: 'نشر', primary: true, click: () => setStatus('content', x.id, 'active', 'نُشر للطلاب') }, { label: 'إعادة للمعلم', click: () => setStatus('content', x.id, 'off', 'أُعيد للمعلم مع ملاحظة') }]
          : x.st === 'active'
            ? [{ label: 'إلغاء النشر', danger: true, click: () => confirmAction('إلغاء النشر؟', `سيختفي «${x.name}» من مكتبة الطلاب.`, 'إلغاء النشر', () => setStatus('content', x.id, 'off', 'أُلغي النشر')) }]
            : [{ label: 'نشر', primary: true, click: () => setStatus('content', x.id, 'active', 'نُشر للطلاب') }, { label: 'تعديل', click: open({ kind: 'content', id: x.id, ckind: ck }) }],
      }));
      return {
        cols: [ck === 'lecture' ? 'المحاضرة' : 'الاختبار', 'المعلم', 'النوع', 'الموضوع · المستوى'], rows, searchL: 'ابحث بالعنوان أو المعلم',
        extra: { label: 'الموضوع', options: all('كل المواضيع', TOPICS) },
        add: { label: ck === 'lecture' ? 'محاضرة جديدة' : 'اختبار جديد', dialog: { kind: 'content', id: null, ckind: ck } },
      };
    }
    case 'subs': {
      const rows = s.subs.map((x): Row => ({
        id: x.id, name: x.name, search: x.name, st: x.st, cells: [x.plan, x.due],
        acts: x.st === 'active' ? [{ label: 'تفاصيل', click: () => toast('سجل المدفوعات (تجريبي) — يحتاج ربطًا بمزود الدفع') }]
          : [{ label: 'تفعيل', primary: true, click: () => setStatus('subs', x.id, 'active', 'تم تفعيل الاشتراك') }],
      }));
      return { cols: ['المشترك', 'الباقة', 'التجديد'], rows, searchL: 'ابحث بالاسم' };
    }
    default: return { cols: [], rows: [], searchL: '' };
  }
}

const chip = (on: boolean): CSSProperties => ({ minHeight: 44, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' });
const actBtn = (a: Act): CSSProperties => ({
  minHeight: 40, padding: '0 12px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${a.primary ? color.primary : a.danger ? color.dangerBorder : color.borderStrong}`,
  background: a.primary ? color.primary : 'transparent', color: a.primary ? color.ivory : a.danger ? color.dangerInk : color.primary,
});

export function StatusPill({ st }: { st: Status }) {
  const t = STATUS[st];
  return <span style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>{t.label}</span>;
}

export function TableSection({ sec }: { sec: Section }) {
  const s = useAdmin();
  const cfg = config(s);
  const q = s.q.trim();
  const present = new Set(cfg.rows.map((r) => r.st));
  const statuses = STATUS_ORDER.filter((k) => present.has(k));
  const rows = cfg.rows.filter((r) => (!q || r.search.includes(q)) && (s.f === 'all' || r.st === s.f) && (s.extra === 'all' || r.extra === s.extra));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(s.page, pages);
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const count = (k: Status | 'all') => cfg.rows.filter((r) => k === 'all' || r.st === k).length;

  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input key={sec} type="search" aria-label={cfg.searchL} placeholder={cfg.searchL} value={s.q} onChange={(e) => setAdmin({ q: e.target.value, page: 1 })}
          style={{ flex: '1 1 240px', minHeight: 48, padding: '0 14px', borderRadius: 12, border: `1.5px solid ${color.borderInput}`, background: color.card, fontSize: 15 }} />
        {cfg.extra && (
          <select aria-label={cfg.extra.label} value={s.extra} onChange={(e) => setAdmin({ extra: e.target.value, page: 1 })}
            style={{ minHeight: 48, maxWidth: 240, padding: '0 12px', borderRadius: 12, border: `1.5px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontWeight: 700, fontSize: 15 }}>
            {cfg.extra.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {cfg.add && <button onClick={() => setAdmin({ dialog: cfg.add!.dialog })} style={primaryBtn(48, 15, { padding: '0 16px', borderRadius: 12, gap: 6, marginInlineStart: 'auto' })}><Icon name="plus" size={18} /> {cfg.add.label}</button>}
      </div>
      <div role="group" aria-label="تصفية حسب الحالة" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
        {(['all', ...statuses] as const).map((k) => (
          <button key={k} aria-pressed={s.f === k} onClick={() => setAdmin({ f: k, page: 1 })} style={chip(s.f === k)}>
            {k === 'all' ? 'الكل' : STATUS[k].label} <span style={{ fontFamily: font.latin, opacity: 0.75 }}>({count(k)})</span>
          </button>
        ))}
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 760 }}>
          <thead>
            <tr style={{ background: color.sand, textAlign: 'right' }}>
              {[...cfg.cols, 'الحالة', 'إجراء'].map((c) => <th key={c} scope="col" style={{ padding: '12px 16px', fontWeight: 700, color: color.body, whiteSpace: 'nowrap' }}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              return (
                <tr key={r.id} style={{ borderTop: `1px solid ${color.divider}` }}>
                  <th scope="row" style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>
                    {r.open
                      ? <button onClick={r.open} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: color.primary, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, textAlign: 'right', minHeight: 32 }}>{r.name}</button>
                      : r.name}
                  </th>
                  {r.cells.map((c, i) => <td key={i} style={{ padding: '12px 16px', color: color.body }}>{c}</td>)}
                  <td style={{ padding: '12px 16px' }}><StatusPill st={r.st} /></td>
                  <td style={{ padding: '8px 16px' }}>
                    {r.acts.length ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        {r.acts.map((a) => <button key={a.label} onClick={a.click} aria-label={`${a.label}: ${r.name}`} style={actBtn(a)}>{a.label}</button>)}
                      </div>
                    ) : <span style={{ color: color.faint }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p style={{ margin: 0, padding: 28, textAlign: 'center', color: color.muted }}>لا توجد نتائج مطابقة.</p>}
      </div>
      {rows.length > 0 && <Pager page={page} pages={pages} total={rows.length} />}
    </>
  );
}

function Pager({ page, pages, total }: { page: number; pages: number; total: number }) {
  const go = (p: number) => { setAdmin({ page: Math.max(1, Math.min(pages, p)) }); window.scrollTo({ top: 0 }); };
  // Window of up to 5 page numbers around the current page.
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const nums = Array.from({ length: Math.min(5, pages) }, (_, i) => start + i);
  const btn = (on: boolean, disabled = false): CSSProperties => ({ minWidth: 44, minHeight: 44, padding: '0 10px', borderRadius: 10, border: `1px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.primary, fontFamily: font.latin, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1 });
  return (
    <nav aria-label="الصفحات" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <p style={{ margin: 0, fontSize: 14, color: color.muted }}>عرض {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} من {total}</p>
      {pages > 1 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => go(page - 1)} disabled={page === 1} aria-label="الصفحة السابقة" style={btn(false, page === 1)}><Icon name="chevR" size={18} /></button>
          {nums.map((n) => <button key={n} onClick={() => go(n)} aria-label={`الصفحة ${n}`} aria-current={n === page ? 'page' : undefined} style={btn(n === page)}>{n}</button>)}
          <button onClick={() => go(page + 1)} disabled={page === pages} aria-label="الصفحة التالية" style={btn(false, page === pages)}><Icon name="chevL" size={18} /></button>
        </div>
      )}
    </nav>
  );
}
