/**
 * Shared admin list toolkit: list state in the URL, server-side search/filter/sort/pagination, row selection
 * (current page, or "all N filtered results" sent to the server as the validated filter, never as thousands of
 * ids), a sticky bulk-action bar, confirmation with typed «حذف» for large destructive requests, per-record results,
 * an RTL filter drawer with removable chips, sortable headers, and cards instead of a table on narrow screens.
 * The server decides every rule; this file only presents it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { color, font } from '@/theme/tokens';
import { FieldError, inputStyle, labelStyle } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { ApiError, type Page } from '@/api/client';
import { card } from '../AdminTables';
import { toast } from '../adminStore';
import * as A from './api';
import { chip, errMsg, Modal, smallBtn } from './ui';

export const PAGE_SIZE = 20;

/* ---------------- numbers in Arabic ---------------- */
/** «عنصر واحد»، «عنصرين»، «3 عناصر»، «12 عنصرًا». */
export function items(n: number) {
  if (n === 1) return 'عنصر واحد';
  if (n === 2) return 'عنصرين';
  if (n >= 3 && n <= 10) return `${n} عناصر`;
  return `${n} عنصرًا`;
}

/* ---------------- URL state ---------------- */
type Q = Record<string, string>;
function readHash(): { path: string; q: Q } {
  const h = window.location.hash.replace(/^#/, '');
  const [path, query = ''] = h.split('?');
  return { path, q: Object.fromEntries(new URLSearchParams(query)) };
}
/** List state (search, filters, sort, page) kept in `#/admin/<section>?…` so refresh, back/forward and shared links
 *  keep the view. Only filter values go in the URL: never personal data beyond what the admin typed to search. */
export function useListUrl(section: string) {
  const [q, setQ] = useState<Q>(() => readHash().q);
  useEffect(() => {
    const on = () => setQ(readHash().q);
    window.addEventListener('popstate', on); window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, []);
  const update = useCallback((patch: Q, push = true) => {
    const next: Q = { ...readHash().q, ...patch };
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] === undefined) delete next[k];
    if (!('page' in patch)) delete next.page; // any filter change returns to page 1
    const s = new URLSearchParams(next).toString();
    const url = `#/admin/${section}${s ? `?${s}` : ''}`;
    if (url !== window.location.hash) window.history[push ? 'pushState' : 'replaceState'](null, '', url);
    setQ(next);
  }, [section]);
  return { q, update };
}

/* ---------------- server list ---------------- */
export function useServerList<T>(fetcher: (params: Q) => Promise<Page<T>>, params: Q) {
  const key = JSON.stringify(params);
  const [data, setData] = useState<Page<T> | null>(null); const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current; setLoading(true); setErr(null);
    try { const d = await fetcher(JSON.parse(key)); if (my === seq.current) setData(d); }
    catch (e) { if (my === seq.current) setErr(errMsg(e)); } finally { if (my === seq.current) setLoading(false); }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  return { data, err, loading, reload: load };
}

/** Debounced search box value that writes to the URL (replace, so typing does not flood history). */
export function useUrlSearch(q: Q, update: (p: Q, push?: boolean) => void) {
  const [text, setText] = useState(q.q ?? '');
  useEffect(() => { setText(q.q ?? ''); }, [q.q]);
  useEffect(() => {
    const t = setTimeout(() => { if ((q.q ?? '') !== text.trim()) update({ q: text.trim() }, false); }, 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return [text, setText] as const;
}

/* ---------------- selection ---------------- */
export type Selection = { mode: 'ids'; ids: Set<number> } | { mode: 'all'; excluded: Set<number> };
export function useSelection(resetKey: string) {
  const [sel, setSel] = useState<Selection>({ mode: 'ids', ids: new Set() });
  // A different filter or search means a different set of results: start again.
  useEffect(() => { setSel({ mode: 'ids', ids: new Set() }); }, [resetKey]);
  const has = (id: number) => (sel.mode === 'all' ? !sel.excluded.has(id) : sel.ids.has(id));
  const toggle = (id: number) => setSel((s) => {
    if (s.mode === 'all') { const e = new Set(s.excluded); if (e.has(id)) e.delete(id); else e.add(id); return { mode: 'all', excluded: e }; }
    const n = new Set(s.ids); if (n.has(id)) n.delete(id); else n.add(id); return { mode: 'ids', ids: n };
  });
  const setMany = (ids: number[], on: boolean) => setSel((s) => {
    if (s.mode === 'all') { const e = new Set(s.excluded); ids.forEach((i) => (on ? e.delete(i) : e.add(i))); return { mode: 'all', excluded: e }; }
    const n = new Set(s.ids); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return { mode: 'ids', ids: n };
  });
  const count = (total: number) => (sel.mode === 'all' ? Math.max(0, total - sel.excluded.size) : sel.ids.size);
  return {
    sel, has, toggle, setMany, count,
    selectAllFiltered: () => setSel({ mode: 'all', excluded: new Set() }),
    clear: () => setSel({ mode: 'ids', ids: new Set() }),
    keepOnly: (ids: number[]) => setSel({ mode: 'ids', ids: new Set(ids) }),
  };
}
export type Sel = ReturnType<typeof useSelection>;

export function Checkbox({ checked, indeterminate = false, onChange, label, disabled }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label={label} disabled={disabled}
    aria-checked={indeterminate ? 'mixed' : checked} style={{ width: 22, height: 22, accentColor: color.primary, cursor: 'pointer', margin: 0 }} />;
}

/* ---------------- columns, table and cards ---------------- */
export interface Col<T> { key: string; label: string; sort?: string; cell: (r: T) => ReactNode; primary?: boolean; latin?: boolean }
function useNarrow(q = '(max-width: 760px)') {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, [q]);
  return m;
}

export function SortTh({ label, k, sort, setSort }: { label: string; k?: string; sort: string; setSort: (s: string) => void }) {
  const th: CSSProperties = { padding: '12px 16px', fontWeight: 700, color: color.body, whiteSpace: 'nowrap', textAlign: 'right' };
  if (!k) return <th scope="col" style={th}>{label}</th>;
  const cur = sort.replace(/^-/, '') === k; const desc = cur && sort.startsWith('-');
  return (
    <th scope="col" aria-sort={cur ? (desc ? 'descending' : 'ascending') : 'none'} style={th}>
      <button onClick={() => setSort(cur && !desc ? `-${k}` : k)} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: cur ? color.primary : color.body, cursor: 'pointer', display: 'inline-flex', gap: 4, alignItems: 'center', minHeight: 32 }}>
        {label}<span aria-hidden="true" style={{ fontFamily: font.latin, fontSize: 12, opacity: cur ? 1 : 0.35 }}>{cur ? (desc ? '▼' : '▲') : '↕'}</span>
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{cur ? (desc ? ' (تنازلي)' : ' (تصاعدي)') : ' (رتّب)'}</span>
      </button>
    </th>
  );
}

export function DataView<T extends { id: number }>({ rows, cols, sel, total, rowLabel, sort, setSort, loading, err, retry, selectable = true }: {
  rows: T[] | undefined; cols: Col<T>[]; sel: Sel; total: number; rowLabel: (r: T) => string; sort: string; setSort: (s: string) => void;
  loading: boolean; err: string | null; retry: () => void; selectable?: boolean;
}) {
  const narrow = useNarrow();
  const ids = rows?.map((r) => r.id) ?? [];
  const on = ids.filter((i) => sel.has(i)).length;
  const head = selectable && (
    <Checkbox checked={ids.length > 0 && on === ids.length} indeterminate={on > 0 && on < ids.length} disabled={!ids.length}
      onChange={() => sel.setMany(ids, on !== ids.length)} label="تحديد كل الصفوف الظاهرة" />
  );
  const status = (
    <>
      {loading && !rows?.length && !err && <p role="status" style={{ margin: 0, padding: 28, textAlign: 'center', color: color.muted }}>جارٍ التحميل…</p>}
      {err && <div role="alert" style={{ padding: 20, display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}><span style={{ color: color.danger }}>{err}</span><button onClick={retry} style={smallBtn('primary')}>إعادة المحاولة</button></div>}
      {!loading && !err && rows && rows.length === 0 && <p style={{ margin: 0, padding: 28, textAlign: 'center', color: color.muted }}>لا توجد نتائج مطابقة.</p>}
    </>
  );
  if (narrow) {
    const sortable = cols.filter((c) => c.sort);
    return (
      <div aria-busy={loading} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {selectable && <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>{head}<span style={{ fontSize: 14 }}>كل الظاهر</span></label>}
          {sortable.length > 0 && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginInlineStart: 'auto' }}>
            <Icon name="sort" size={18} /> ترتيب
            <select aria-label="ترتيب حسب" value={sort} onChange={(e) => setSort(e.target.value)} style={{ ...inputStyle(null), minHeight: 40, width: 'auto' }}>
              {sortable.flatMap((c) => [<option key={c.sort} value={c.sort}>{c.label} ▲</option>, <option key={'-' + c.sort} value={'-' + c.sort}>{c.label} ▼</option>])}
            </select>
          </label>}
        </div>
        <ul role="list" aria-label={`النتائج: ${total}`} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows?.map((r) => {
            const s = sel.has(r.id);
            return (
              <li key={r.id} style={{ ...card, padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start', borderColor: s ? color.primary : undefined, boxShadow: s ? `inset 4px 0 0 ${color.primary}` : undefined }}>
                {selectable && <div style={{ paddingTop: 2 }}><Checkbox checked={s} onChange={() => sel.toggle(r.id)} label={`تحديد ${rowLabel(r)}`} /></div>}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {cols.map((c) => c.primary
                    ? <div key={c.key} style={{ fontWeight: 700 }}>{c.cell(r)}</div>
                    : <div key={c.key} style={{ display: 'flex', gap: 8, fontSize: 14 }}><span style={{ color: color.muted, minWidth: 96 }}>{c.label}</span><span style={{ flex: 1, fontFamily: c.latin ? font.latin : undefined }}>{c.cell(r)}</span></div>)}
                  {s && <span style={{ fontSize: 12, color: color.primary, fontWeight: 700 }}>✓ محدد</span>}
                </div>
              </li>
            );
          })}
        </ul>
        {status}
      </div>
    );
  }
  return (
    <div style={{ ...card, overflowX: 'auto' }} aria-busy={loading}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, minWidth: 760 }}>
        <thead><tr style={{ background: color.sand, textAlign: 'right' }}>
          {selectable && <th scope="col" style={{ padding: '12px 0 12px 4px', width: 44, paddingInlineStart: 16 }}>{head}</th>}
          {cols.map((c) => <SortTh key={c.key} label={c.label} k={c.sort} sort={sort} setSort={setSort} />)}
        </tr></thead>
        <tbody>
          {rows?.map((r) => {
            const s = sel.has(r.id);
            return (
              <tr key={r.id} aria-selected={selectable ? s : undefined} style={{ borderTop: `1px solid ${color.divider}`, background: s ? '#EEF4EC' : undefined }}>
                {selectable && <td style={{ padding: '12px 0', paddingInlineStart: 16, width: 44, boxShadow: s ? `inset -4px 0 0 ${color.primary}` : undefined }}><Checkbox checked={s} onChange={() => sel.toggle(r.id)} label={`تحديد ${rowLabel(r)}`} /></td>}
                {cols.map((c) => c.primary
                  ? <th key={c.key} scope="row" style={{ padding: '12px 16px', textAlign: 'right' }}>{c.cell(r)}</th>
                  : <td key={c.key} style={{ padding: '12px 16px', color: color.body, fontFamily: c.latin ? font.latin : undefined }}>{c.cell(r)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {status}
    </div>
  );
}

export function Pager({ page, total, setPage }: { page: number; total: number; setPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (!total) return null;
  return (
    <nav aria-label="الصفحات" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <p style={{ margin: 0, fontSize: 14, color: color.muted }}>عرض {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} من {total}</p>
      {pages > 1 && <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="الصفحة السابقة" style={smallBtn()}><Icon name="chevR" size={18} /></button>
        <span style={{ fontFamily: font.latin, minWidth: 64, textAlign: 'center' }}>{page} / {pages}</span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="الصفحة التالية" style={smallBtn()}><Icon name="chevL" size={18} /></button>
      </div>}
    </nav>
  );
}

/* ---------------- selection summary and bulk bar ---------------- */
export function SelectionSummary({ sel, pageIds, total }: { sel: Sel; pageIds: number[]; total: number }) {
  const n = sel.count(total);
  const allPage = pageIds.length > 0 && pageIds.every((i) => sel.has(i));
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minHeight: 40 }}>
      <button onClick={() => sel.setMany(pageIds, true)} disabled={!pageIds.length || (allPage && sel.sel.mode === 'ids')} style={smallBtn()}>تحديد الكل</button>
      <button onClick={sel.clear} disabled={n === 0} style={smallBtn()}>إلغاء التحديد</button>
      <span role="status" aria-live="polite" style={{ fontSize: 14, color: n ? color.ink : color.muted, fontWeight: n ? 700 : 400 }}>
        {sel.sel.mode === 'all' ? `تم تحديد جميع النتائج (${n} عنصر)` : n ? `تم تحديد ${n} عنصر` : ''}
      </span>
      {sel.sel.mode === 'ids' && allPage && total > pageIds.length && n === pageIds.length && (
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', background: color.sand, borderRadius: 10, padding: '4px 10px', fontSize: 14 }}>
          تم تحديد {pageIds.length} عنصر في هذه الصفحة
          <button onClick={sel.selectAllFiltered} style={{ ...smallBtn('primary'), minHeight: 36 }}>تحديد جميع النتائج الـ {total}</button>
        </span>
      )}
    </div>
  );
}

export interface BulkDef {
  key: string;                     // server action name
  label: string;                   // button
  tone?: 'primary' | 'danger' | 'plain';
  reason?: boolean;                // the server requires a reason
  destructive?: boolean;           // delete / archive: «تأكيد الحذف», typed «حذف» at 10+ records
  title?: string;                  // dialog title
  body: (n: number) => string;     // what will happen
  ok: (n: number) => string;       // confirm button
}

export function BulkBar({ resource, sel, total, actions, filter, onDone }: {
  resource: string; sel: Sel; total: number; actions: BulkDef[]; filter: Record<string, string>; onDone: () => void;
}) {
  const [run, setRun] = useState<BulkDef | null>(null); const [result, setResult] = useState<{ def: BulkDef; r: A.BulkResult } | null>(null);
  const n = sel.count(total);
  if (n === 0 && !result) return null;
  return (
    <>
      {n > 0 && (
        <div role="toolbar" aria-label="إجراءات على المحدد" style={{ position: 'sticky', bottom: 12, zIndex: 15, ...card, background: color.primary, color: color.ivory, padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', boxShadow: '0 8px 24px rgba(20,33,31,.25)' }}>
          <span style={{ fontWeight: 800, fontSize: 15, marginInlineEnd: 6 }}><span style={{ fontFamily: font.latin }}>{n}</span> محدد</span>
          {actions.map((a) => (
            <button key={a.key} onClick={() => setRun(a)} style={{ ...smallBtn(a.tone === 'danger' ? 'danger' : 'plain'), ...(a.tone === 'danger' ? { background: color.danger, color: color.ivory, borderColor: color.danger } : {}), display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {a.tone === 'danger' && <Icon name="trash" size={16} />}{a.label}
            </button>
          ))}
          <button onClick={sel.clear} style={{ ...smallBtn(), marginInlineStart: 'auto', background: 'transparent', color: color.ivory, borderColor: 'rgba(247,243,232,.5)' }}>إلغاء التحديد</button>
        </div>
      )}
      {run && <BulkConfirm def={run} resource={resource} sel={sel} total={total} filter={filter} onClose={() => setRun(null)}
        onDone={(r) => {
          setRun(null);
          const ok = r.success; const bad = r.failed + r.skipped;
          if (bad === 0) { toast(`تم تنفيذ الإجراء على ${items(ok)}`); sel.clear(); }
          else { setResult({ def: run, r }); sel.sel.mode === 'ids' ? sel.keepOnly(r.results.filter((x) => x.outcome === 'failed').map((x) => x.id)) : sel.clear(); }
          onDone();
        }} />}
      {result && <ResultDialog def={result.def} r={result.r} onClose={() => setResult(null)} />}
    </>
  );
}

function BulkConfirm({ def, resource, sel, total, filter, onClose, onDone }: {
  def: BulkDef; resource: string; sel: Sel; total: number; filter: Record<string, string>; onClose: () => void; onDone: (r: A.BulkResult) => void;
}) {
  const [n, setN] = useState(sel.count(total));
  const [reason, setReason] = useState(''); const [typed, setTyped] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const needType = !!def.destructive && n >= 10;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return; // no second submission
    if (def.reason && reason.trim().length < 3) return setErr('اكتب السبب (3 أحرف على الأقل).');
    if (needType && typed.trim() !== 'حذف') return setErr('اكتب «حذف» للتأكيد.');
    setBusy(true); setErr(null);
    const body: A.BulkBody = { action: def.key, reason: reason.trim(), ...(needType ? { confirm: 'حذف' } : {}) };
    if (sel.sel.mode === 'all') Object.assign(body, { filter, expected: n, exclude_ids: [...sel.sel.excluded] });
    else body.ids = [...sel.sel.ids];
    try { onDone(await A.bulkAction(resource, body)); }
    catch (x) {
      const a = x as ApiError;
      if (a?.code === 'results_changed') { const now = Number(a.fields?.expected?.[0] ?? n); setN(now); setErr(`تغيّرت النتائج: أصبح العدد ${now}. راجع ثم أكّد من جديد.`); }
      else setErr(a?.field?.('reason') ?? a?.field?.('confirm') ?? errMsg(x));
      setBusy(false);
    }
  };
  const title = def.title ?? (def.destructive ? 'تأكيد الحذف' : def.label);
  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <form noValidate onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.8 }}>{def.body(n)}</p>
        {def.reason && <>
          <label htmlFor="bk-r" style={labelStyle}>السبب (يُحفظ في سجل التدقيق)</label>
          <textarea id="bk-r" rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...inputStyle(null), minHeight: 80, paddingTop: 10 }} />
        </>}
        {needType && <>
          <label htmlFor="bk-c" style={labelStyle}>اكتب حذف للتأكيد</label>
          <input id="bk-c" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" style={inputStyle(null)} />
        </>}
        <FieldError msg={err} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={{ ...smallBtn(), minHeight: 48 }}>إلغاء</button>
          <button type="submit" disabled={busy} aria-busy={busy}
            style={{ ...smallBtn(def.tone === 'danger' || def.destructive ? 'danger' : 'primary'), minHeight: 48, flex: 1, ...(def.tone === 'danger' || def.destructive ? { background: color.danger, color: color.ivory } : {}) }}>
            {busy ? 'جارٍ التنفيذ…' : def.ok(n)}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResultDialog({ def, r, onClose }: { def: BulkDef; r: A.BulkResult; onClose: () => void }) {
  return (
    <Modal title={`نتيجة: ${def.label}`} onClose={onClose}>
      <p role="status" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>تم تنفيذ الإجراء على {r.success} من {items(r.requested)}</p>
      {r.failed > 0 && <p style={{ margin: 0, color: color.dangerInk, fontWeight: 700 }}>تعذر تنفيذ الإجراء على {items(r.failed)}</p>}
      {r.skipped > 0 && <p style={{ margin: 0, color: color.muted }}>{items(r.skipped)} في الحالة المطلوبة بالفعل، فلم {r.skipped === 1 ? 'يتغيّر' : 'تتغيّر'}.</p>}
      <details open={r.results.length <= 6}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, minHeight: 32 }}>الأسباب</summary>
        <ul style={{ margin: '8px 0 0', paddingInlineStart: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {r.results.map((x) => <li key={`${x.id}-${x.code}`} style={{ fontSize: 14 }}><strong>{x.label || `#${x.id}`}</strong> — {x.message}{x.outcome === 'skipped' ? ' (تُرك كما هو)' : ''}</li>)}
        </ul>
      </details>
      <button onClick={onClose} style={{ ...smallBtn('primary'), minHeight: 48 }}>تم</button>
    </Modal>
  );
}

/* ---------------- filters: drawer and chips ---------------- */
export type FilterField =
  | { key: string; label: string; type: 'select'; options: [string, string][] }
  | { key: string; label: string; type: 'bool'; yes: string; no: string }
  | { key: string; label: string; type: 'text'; placeholder?: string }
  | { key: string; label: string; type: 'dates'; from: string; to: string }
  | { key: string; label: string; type: 'remote'; load: () => Promise<[string, string][]> };

const daysAgo = (n: number) => { const d = new Date(Date.now() - n * 86_400_000); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(d); };
const PRESETS: [number, string][] = [[7, 'آخر 7 أيام'], [30, 'آخر 30 يوم'], [90, 'آخر 90 يوم']];

/** Remote option lists (teachers, circles, courses) shared by drawer and chips. */
function useOptions(fields: FilterField[]) {
  const [opts, setOpts] = useState<Record<string, [string, string][]>>({});
  useEffect(() => {
    let on = true;
    fields.forEach((f) => { if (f.type === 'remote') f.load().then((o) => on && setOpts((p) => ({ ...p, [f.key]: o }))).catch(() => {}); });
    return () => { on = false; };
  }, [fields]);
  return opts;
}

export function chipLabels(fields: FilterField[], q: Record<string, string>, opts: Record<string, [string, string][]>): { keys: string[]; text: string }[] {
  const out: { keys: string[]; text: string }[] = [];
  for (const f of fields) {
    if (f.type === 'dates') {
      const a = q[f.from], b = q[f.to];
      if (!a && !b) continue;
      const preset = !b && PRESETS.find(([n]) => daysAgo(n) === a);
      out.push({ keys: [f.from, f.to], text: `${f.label}: ${preset ? preset[1] : `${a ? `من ${a}` : ''}${a && b ? ' ' : ''}${b ? `إلى ${b}` : ''}`}` });
      continue;
    }
    const v = q[f.key]; if (!v) continue;
    if (f.type === 'select') out.push({ keys: [f.key], text: `${f.options.find((o) => o[0] === v)?.[1] ?? v}` });
    else if (f.type === 'bool') out.push({ keys: [f.key], text: v === '1' ? f.yes : f.no });
    else if (f.type === 'remote') out.push({ keys: [f.key], text: `${f.label}: ${opts[f.key]?.find((o) => o[0] === v)?.[1] ?? `#${v}`}` });
    else out.push({ keys: [f.key], text: `${f.label}: ${v}` });
  }
  return out;
}

export function FilterControls({ fields, q, update }: { fields: FilterField[]; q: Record<string, string>; update: (p: Record<string, string>, push?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const opts = useOptions(fields);
  const chips = useMemo(() => chipLabels(fields, q, opts), [fields, q, opts]);
  const clearAll = () => update(Object.fromEntries(fields.flatMap((f) => (f.type === 'dates' ? [[f.from, ''], [f.to, '']] : [[f.key, '']]))));
  return (
    <>
      <button onClick={() => setOpen(true)} aria-haspopup="dialog" style={{ ...smallBtn(chips.length ? 'primary' : 'plain'), minHeight: 48, display: 'inline-flex', gap: 6, alignItems: 'center', borderRadius: 12 }}>
        <Icon name="filter" size={18} /> تصفية{chips.length ? <span style={{ fontFamily: font.latin }}> ({chips.length})</span> : ''}
      </button>
      {chips.length > 0 && (
        <div role="group" aria-label="عوامل التصفية المطبّقة" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flexBasis: '100%' }}>
          {chips.map((c) => (
            <button key={c.keys.join()} onClick={() => update(Object.fromEntries(c.keys.map((k) => [k, ''])))} aria-label={`إزالة عامل التصفية: ${c.text}`}
              style={{ ...chip(true), minHeight: 36, fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}>{c.text} <span aria-hidden="true">×</span></button>
          ))}
          <button onClick={clearAll} style={{ ...smallBtn(), minHeight: 36, fontSize: 13 }}>مسح الكل</button>
        </div>
      )}
      {open && <FilterDrawer fields={fields} q={q} opts={opts} onClose={() => setOpen(false)} onApply={(v) => { update(v); setOpen(false); }} />}
    </>
  );
}

function FilterDrawer({ fields, q, opts, onClose, onApply }: { fields: FilterField[]; q: Record<string, string>; opts: Record<string, [string, string][]>; onClose: () => void; onApply: (v: Record<string, string>) => void }) {
  const keys = fields.flatMap((f) => (f.type === 'dates' ? [f.from, f.to] : [f.key]));
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, q[k] ?? ''])));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('select,input,button')?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); prev?.focus(); };
  }, [onClose]);
  const set = (k: string, x: string) => setV((p) => ({ ...p, [k]: x }));
  const sel = (id: string, k: string, o: [string, string][]) => (
    <select id={id} value={v[k]} onChange={(e) => set(k, e.target.value)} style={inputStyle(null)}>
      <option value="">الكل</option>{o.map(([a, b]) => <option key={a} value={a}>{b}</option>)}
    </select>
  );
  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, background: 'rgba(20,33,31,.45)', zIndex: 50, display: 'flex', justifyContent: 'flex-start' }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="تصفية النتائج" style={{ background: color.ivory, width: 'min(380px, 100%)', height: '100%', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 0 32px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, flex: 1, display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="filter" /> تصفية</h2>
          <button onClick={onClose} aria-label="إغلاق" style={{ width: 44, height: 44, border: 'none', background: 'transparent', cursor: 'pointer', color: color.muted }}><Icon name="x" /></button>
        </div>
        <form noValidate onSubmit={(e) => { e.preventDefault(); onApply(v); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {fields.map((f) => {
            const id = `flt-${f.type === 'dates' ? f.from : f.key}`;
            if (f.type === 'dates') return (
              <fieldset key={id} style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <legend style={labelStyle}>{f.label}</legend>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {PRESETS.map(([n, l]) => { const on = v[f.from] === daysAgo(n) && !v[f.to]; return <button type="button" key={n} aria-pressed={on} onClick={() => setV((p) => ({ ...p, [f.from]: daysAgo(n), [f.to]: '' }))} style={{ ...chip(on), minHeight: 36, fontSize: 13 }}>{l}</button>; })}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ flex: 1, fontSize: 13 }}>من<input type="date" dir="ltr" value={v[f.from]} onChange={(e) => set(f.from, e.target.value)} style={inputStyle(null, true)} /></label>
                  <label style={{ flex: 1, fontSize: 13 }}>إلى<input type="date" dir="ltr" value={v[f.to]} onChange={(e) => set(f.to, e.target.value)} style={inputStyle(null, true)} /></label>
                </div>
              </fieldset>
            );
            return (
              <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor={id} style={labelStyle}>{f.label}</label>
                {f.type === 'select' && sel(id, f.key, f.options)}
                {f.type === 'remote' && sel(id, f.key, opts[f.key] ?? [])}
                {f.type === 'bool' && sel(id, f.key, [['1', f.yes], ['0', f.no]])}
                {f.type === 'text' && <input id={id} value={v[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} style={inputStyle(null)} />}
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 8, position: 'sticky', bottom: 0, background: color.ivory, paddingTop: 8 }}>
            <button type="submit" style={{ ...smallBtn('primary'), minHeight: 48, flex: 1 }}>تطبيق</button>
            <button type="button" onClick={() => setV(Object.fromEntries(keys.map((k) => [k, ''])))} style={{ ...smallBtn(), minHeight: 48 }}>مسح الكل</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---------------- shared option loaders ---------------- */
export const teacherOptions = async (): Promise<[string, string][]> =>
  (await A.listPeople({ role: 'teacher', page_size: 100, sort: 'name' })).results.map((t) => [String(t.id), t.full_name]);
export const studentOptions = async (): Promise<[string, string][]> =>
  (await A.listPeople({ role: 'student', page_size: 100, sort: 'name' })).results.map((t) => [String(t.id), t.full_name]);
export const circleOptions = async (): Promise<[string, string][]> =>
  (await A.listCircles({ page_size: '100', sort: 'name' })).results.map((c) => [String(c.id), c.name]);
export const courseOptions = async (): Promise<[string, string][]> =>
  (await A.listCourses({ page_size: '100', sort: 'title' })).results.map((c) => [String(c.id), c.title]);

/** Params for the list API from the URL state: everything but the UI-only keys. */
export function listParams(q: Record<string, string>, defaults: Record<string, string> = {}) {
  const p: Record<string, string> = { ...defaults, ...q, page_size: String(PAGE_SIZE) };
  return p;
}
/** The filter sent with "all filtered results": the same params minus paging and sort. */
export function filterOf(params: Record<string, string>) {
  const { page: _p, page_size: _s, sort: _o, ...f } = params; // eslint-disable-line @typescript-eslint/no-unused-vars
  return f;
}

/* ---------------- short lists inside a detail panel (sessions, lessons, enrollments, questions) ---------------- */
/** Master checkbox, «تحديد الكل» / «إلغاء التحديد» and the count, for a short list that is fully loaded. */
export function InlineSelectHeader({ sel, ids, what }: { sel: Sel; ids: number[]; what: string }) {
  const on = ids.filter((i) => sel.has(i)).length;
  const n = sel.count(ids.length);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minHeight: 40 }}>
      <Checkbox checked={ids.length > 0 && on === ids.length} indeterminate={on > 0 && on < ids.length} disabled={!ids.length}
        onChange={() => sel.setMany(ids, on !== ids.length)} label={`تحديد كل ${what}`} />
      <button onClick={() => sel.setMany(ids, true)} disabled={!ids.length || on === ids.length} style={{ ...smallBtn(), minHeight: 36 }}>تحديد الكل</button>
      <button onClick={sel.clear} disabled={!n} style={{ ...smallBtn(), minHeight: 36 }}>إلغاء التحديد</button>
      <span role="status" aria-live="polite" style={{ fontSize: 14, fontWeight: n ? 700 : 400 }}>{n ? `تم تحديد ${n} عنصر` : ''}</span>
    </div>
  );
}
