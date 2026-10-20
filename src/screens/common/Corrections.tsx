/** Student mistakes / correction history (pack prompt 33). Learning points recorded by the teacher at an ayah, with a
 *  category, priority and status. Students see their own (with the teacher's note and guidance), parents see a
 *  safe summary (no free text), teachers record, follow up and resolve. Counts are never shown as a score. */
import { useEffect, useState } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackHeader, Chips, FieldError, card, inputStyle, labelStyle, muted, outlineBtn, primaryBtn } from '@/components/ui';
import { api, ApiError, type Page } from '@/api/client';
import { SUR } from '@/data/demo';
import { go, toast, useApp } from '@/store/store';

export type CorrectionStatus = 'new' | 'improving' | 'corrected';
export type CorrectionPriority = 'minor' | 'review' | 'important';
export interface ApiCorrection {
  id: number; student: number; category: string; category_label: string; surah: number; ayah: number; priority: CorrectionPriority;
  status: CorrectionStatus; source: string; times: number; created_at: string; resolved_at: string | null;
  note?: string; guidance?: string; internal_note?: string; teacher_name?: string; student_name?: string; follow_up?: number | null;
}
export interface CorrectionSummary {
  open: number; new: number; improving: number; corrected: number; recurring: number;
  by_category: { category: string; label: string; open: number; total: number }[];
  trend: { week: string; added: number; corrected: number }[];
}
interface Category { value: string; label: string; memorization: boolean }

export const STATUS_L: Record<CorrectionStatus, string> = { new: 'جديد', improving: 'يتحسن', corrected: 'تم التصحيح' };
export const PRIORITY_L: Record<CorrectionPriority, string> = { minor: 'بسيط', review: 'يحتاج مراجعة', important: 'مهم' };
const STATUS_C: Record<CorrectionStatus, [string, string]> = {
  new: [color.warnBg, color.warnInk], improving: [color.goldTint, color.goldInk], corrected: [color.sage, color.primary],
};

let catsP: Promise<Category[]> | null = null;
function useCategories() {
  const [c, setC] = useState<Category[]>([]);
  useEffect(() => {
    catsP ??= api<Category[]>('GET', 'corrections/categories').catch((e) => { catsP = null; throw e; });
    let on = true; catsP.then((x) => on && setC(x)).catch(() => {}); return () => { on = false; };
  }, []);
  return c;
}

const ref = (c: { surah: number; ayah: number }) => `سورة ${SUR[c.surah]?.[0] ?? c.surah} · الآية ${c.ayah}`;
const qs = (q: Record<string, string | number | undefined>) =>
  Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

function Pill({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 700 }}>{children}</span>;
}

/* ---------------- Teacher: record a correction ---------------- */
export interface CorrectionContext {
  student: number; source: 'submission' | 'session' | 'task' | 'review';
  submission?: number; booking?: number; assignment?: number; surah?: number; from?: number; to?: number;
}

export function CorrectionForm({ ctx, onSaved, label = 'إضافة خطأ' }: { ctx: CorrectionContext; onSaved?: () => void; label?: string }) {
  const cats = useCategories();
  const [open, setOpen] = useState(false);
  const blank = { category: '', surah: ctx.surah ?? 1, ayah: ctx.from ?? 1, priority: 'review' as CorrectionPriority, note: '', guidance: '', internal_note: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const id = `cf-${ctx.source}-${ctx.submission ?? ctx.booking ?? ctx.assignment ?? ctx.student}`;
  const maxAyah = SUR[f.surah]?.[1] ?? 1;
  const ayahs = ctx.surah && ctx.from && ctx.to && f.surah === ctx.surah
    ? Array.from({ length: ctx.to - ctx.from + 1 }, (_, i) => ctx.from! + i) : Array.from({ length: maxAyah }, (_, i) => i + 1);

  if (!open) return (
    <button onClick={() => { setF(blank); setErr({}); setOpen(true); }} style={outlineBtn(44, 14, { padding: '0 14px', borderRadius: 12, alignSelf: 'flex-start' })}>
      <Icon name="plus" size={18} /> {label}
    </button>
  );
  const save = async () => {
    if (!f.category) { setErr({ category: 'اختر نوع الخطأ.' }); return; }
    setBusy(true); setErr({});
    try {
      await api('POST', 'corrections', { ...f, student: ctx.student, source: ctx.source, submission: ctx.submission, booking: ctx.booking, assignment: ctx.assignment });
      toast('حُفظت الملاحظة وأُبلغ الطالب'); setOpen(false); onSaved?.();
    } catch (e) {
      const x = e as ApiError;
      const fe: Record<string, string> = {};
      for (const k of ['category', 'ayah', 'surah', 'note', 'guidance', 'submission', 'booking', 'assignment']) { const m = x.field?.(k); if (m) fe[k] = m; }
      setErr(Object.keys(fe).length ? fe : { _: x.message || 'تعذّر الحفظ.' });
    } finally { setBusy(false); }
  };
  const sel = { ...inputStyle(false), padding: '0 12px', fontSize: 15 };
  return (
    <section aria-label="إضافة خطأ" style={{ ...card, borderColor: color.gold, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={labelStyle}>نوع الخطأ</span>
      <div role="radiogroup" aria-label="نوع الخطأ" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {cats.map((c) => {
          const on = f.category === c.value;
          return <button key={c.value} role="radio" aria-checked={on} onClick={() => setF({ ...f, category: c.value })}
            style={{ minHeight: 40, padding: '0 12px', borderRadius: 999, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.primary : color.card, color: on ? color.ivory : color.ink, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{c.label}</button>;
        })}
      </div>
      <FieldError msg={err.category} fs={12} />
      <div style={{ display: 'flex', gap: 8 }}>
        <label style={{ ...labelStyle, flex: 2 }}>السورة
          <select id={`${id}-s`} value={f.surah} onChange={(e) => setF({ ...f, surah: +e.target.value, ayah: 1 })} style={{ ...sel, display: 'block', marginTop: 4, width: '100%' }}>
            {Object.keys(SUR).map((k) => <option key={k} value={k}>{SUR[+k][0]}</option>)}
          </select>
        </label>
        <label style={{ ...labelStyle, flex: 1 }}>الآية
          <select id={`${id}-a`} value={f.ayah} onChange={(e) => setF({ ...f, ayah: +e.target.value })} style={{ ...sel, display: 'block', marginTop: 4, width: '100%' }}>
            {ayahs.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <FieldError msg={err.ayah || err.surah} fs={12} />
      <span style={labelStyle}>الأولوية</span>
      <Chips options={[['minor', 'بسيط'], ['review', 'يحتاج مراجعة'], ['important', 'مهم']] as const} value={f.priority} onChange={(k) => setF({ ...f, priority: k })} wrapStyle={{ paddingBottom: 0 }} />
      <label style={labelStyle}>ملاحظة للطالب
        <textarea rows={2} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="مثال: انتبه لمدّ المنفصل هنا" style={{ ...inputStyle(err.note), display: 'block', marginTop: 4, width: '100%', padding: '8px 12px', resize: 'vertical' }} />
      </label>
      <label style={labelStyle}>التوجيه (كيف يصحّحه)
        <textarea rows={2} maxLength={500} value={f.guidance} onChange={(e) => setF({ ...f, guidance: e.target.value })} placeholder="مثال: مدّه أربع حركات واستمع للتلاوة مرتين" style={{ ...inputStyle(err.guidance), display: 'block', marginTop: 4, width: '100%', padding: '8px 12px', resize: 'vertical' }} />
      </label>
      <label style={labelStyle}>ملاحظة داخلية (للمعلمين والإدارة فقط)
        <input maxLength={500} value={f.internal_note} onChange={(e) => setF({ ...f, internal_note: e.target.value })} style={{ ...inputStyle(false), display: 'block', marginTop: 4, width: '100%' }} />
      </label>
      {(err._ || err.submission || err.booking || err.assignment) && <p role="alert" style={{ margin: 0, color: color.dangerInk, fontSize: 13 }}>{err._ || err.submission || err.booking || err.assignment}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={busy} aria-busy={busy} style={primaryBtn(44, 15, { flex: 1, borderRadius: 10, opacity: busy ? 0.7 : 1 })}>حفظ الخطأ</button>
        <button onClick={() => setOpen(false)} style={{ minHeight: 44, padding: '0 14px', borderRadius: 10, border: `1px solid ${color.borderStrong}`, background: 'transparent', color: color.primary, fontWeight: 700, cursor: 'pointer' }}>إلغاء</button>
      </div>
    </section>
  );
}

/* ---------------- One correction (all roles) ---------------- */
function CorrectionCard({ c, teacher, onChange }: { c: ApiCorrection; teacher: boolean; onChange?: () => void }) {
  const [busy, setBusy] = useState(false);
  const role = useApp((s) => s.role);
  const [bg, fg] = STATUS_C[c.status];
  const patch = async (status: CorrectionStatus) => {
    setBusy(true);
    try { await api('PATCH', `corrections/${c.id}`, { status }); toast(status === 'corrected' ? 'سُجّل التصحيح' : 'حُدّثت الحالة'); onChange?.(); }
    catch (e) { toast((e as ApiError).message, 'alert'); } finally { setBusy(false); }
  };
  const followUp = async (kind: 'ayah' | 'tajweed' | 'rerecord') => {
    setBusy(true);
    try { await api('POST', `corrections/${c.id}/follow-up`, { kind }); toast('أُنشئت مهمة متابعة للطالب'); onChange?.(); }
    catch (e) { toast((e as ApiError).message, 'alert'); } finally { setBusy(false); }
  };
  const small = { minHeight: 40, padding: '0 12px', borderRadius: 10, border: `1px solid ${color.borderStrong}`, background: color.card, color: color.primary, fontSize: 13, fontWeight: 700, cursor: 'pointer' } as const;
  return (
    <div data-testid="correction" style={{ ...card, borderRadius: 14, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 120, fontSize: 15, fontWeight: 800 }}>{c.category_label}</span>
        <Pill bg={bg} fg={fg}>{STATUS_L[c.status]}</Pill>
        {c.priority === 'important' && <Pill bg={color.dangerBg} fg={color.dangerInk}>مهم</Pill>}
      </div>
      <span style={{ fontSize: 13, color: color.body }}>{ref(c)}{c.student_name && teacher ? ` · ${c.student_name}` : ''}</span>
      {c.times > 1 && <span style={{ fontSize: 12, color: color.warnInk, fontWeight: 700 }}>تكرّر في هذا الموضع {c.times} مرات</span>}
      {c.note && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{c.note}</p>}
      {c.guidance && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: color.primary }}><strong>التوجيه:</strong> {c.guidance}</p>}
      {teacher && c.internal_note && <p style={muted(12)}>ملاحظة داخلية: {c.internal_note}</p>}
      <span style={muted(12)}>{c.created_at.slice(0, 10)}{c.resolved_at ? ` · صُحّح ${c.resolved_at.slice(0, 10)}` : ''}{c.follow_up ? ' · لها مهمة متابعة' : ''}</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {role !== 'parent' && <button onClick={() => go('mushaf', { s: c.surah, from: c.ayah, to: c.ayah })} style={small}><Icon name="book" size={16} /> افتح في المصحف</button>}
        {teacher && c.status !== 'corrected' && <>
          {c.status === 'new' && <button disabled={busy} onClick={() => patch('improving')} style={small}>يتحسن</button>}
          <button disabled={busy} onClick={() => patch('corrected')} style={small}>تم التصحيح</button>
          {!c.follow_up && <button disabled={busy} onClick={() => followUp(c.category === 'hifz' || c.category === 'omission' || c.category === 'order' ? 'ayah' : 'tajweed')} style={small}>أنشئ مهمة متابعة</button>}
        </>}
        {teacher && c.status === 'corrected' && <button disabled={busy} onClick={() => patch('improving')} style={small}>إعادة فتح</button>}
      </div>
    </div>
  );
}

function useCorrections(query: Record<string, string | number | undefined>, bump: number) {
  const [d, setD] = useState<ApiCorrection[] | null>(null); const [err, setErr] = useState<string | null>(null);
  const key = qs({ ...query, page_size: 100 });
  useEffect(() => {
    let on = true; setErr(null);
    api<Page<ApiCorrection>>('GET', `corrections?${key}`).then((x) => on && setD(x.results)).catch((e) => on && setErr((e as Error).message));
    return () => { on = false; };
  }, [key, bump]);
  return { d, err };
}

/** Teacher: the correction list for one student / submission / session, with the add form. */
export function TeacherCorrections({ ctx, title = 'الأخطاء والملاحظات', filter }: { ctx: CorrectionContext; title?: string; filter?: Record<string, string | number> }) {
  const [bump, setBump] = useState(0);
  const { d, err } = useCorrections(filter ?? { student: ctx.student }, bump);
  return (
    <section aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h3>
      <CorrectionForm ctx={ctx} onSaved={() => setBump(bump + 1)} />
      {err && <p role="alert" style={muted(13)}>تعذّر التحميل: {err}</p>}
      {d?.length === 0 && <p style={muted(13)}>لا توجد أخطاء مسجّلة هنا.</p>}
      {d?.map((c) => <CorrectionCard key={c.id} c={c} teacher onChange={() => setBump(bump + 1)} />)}
    </section>
  );
}

/* ---------------- Summary card (student progress, parent, teacher student file) ---------------- */
export function CorrectionsSummaryCard({ student, who }: { student?: number; who: 'student' | 'parent' | 'teacher' }) {
  const [s, setS] = useState<CorrectionSummary | null>(null);
  useEffect(() => {
    let on = true; setS(null);
    api<CorrectionSummary>('GET', `corrections/summary${student ? `?student=${student}` : ''}`).then((x) => on && setS(x)).catch(() => {});
    return () => { on = false; };
  }, [student]);
  if (!s || (s.open + s.corrected === 0 && who !== 'student')) return null;
  const tiles: [string, number][] = [['تحتاج مراجعة', s.new], ['تتحسن', s.improving], ['تم تصحيحها', s.corrected]];
  const top = s.by_category.filter((x) => x.open > 0).slice(0, 3);
  return (
    <section aria-labelledby={`cs-${who}`} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 id={`cs-${who}`} style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{who === 'student' ? 'نقاط للمراجعة' : 'نقاط المراجعة من المعلم'}</h2>
      {s.open + s.corrected === 0 ? <p style={muted(13)}>لا توجد نقاط مسجّلة بعد. سيضيف معلمك هنا ما يحتاج مراجعة.</p> : <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
          {tiles.map(([l, v]) => (
            <div key={l} style={{ background: color.ivory, borderRadius: 12, padding: '8px 10px', textAlign: 'center' }}>
              <p style={{ margin: 0, fontFamily: font.latin, fontSize: 22, fontWeight: 800 }}>{v}</p>
              <p style={muted(12)}>{l}</p>
            </div>
          ))}
        </div>
        {s.recurring > 0 && <p style={{ margin: 0, fontSize: 13, color: color.warnInk, fontWeight: 700 }}>{s.recurring} نقطة تكرّرت في الموضع نفسه</p>}
        {top.length > 0 && <p style={muted(13)}>أكثر ما يحتاج انتباهًا: {top.map((x) => `${x.label} (${x.open})`).join('، ')}</p>}
      </>}
      {who === 'student' && <button onClick={() => go('mistakes')} style={outlineBtn(44, 14, { borderRadius: 12 })}>أخطائي</button>}
      {who === 'parent' && <p style={muted(12)}>تفاصيل الملاحظات يراها الطالب ومعلمه؛ هنا ملخص فقط.</p>}
    </section>
  );
}

/* ---------------- Student: «أخطائي» ---------------- */
type MTab = 'open' | 'recurring' | 'done' | 'surah' | 'cat';
export function MyMistakes() {
  const [t, setT] = useState<MTab>('open');
  const query = t === 'open' ? { open: 1 } : t === 'recurring' ? { open: 1, recurring: 1 } : t === 'done' ? { status: 'corrected' } : { open: 1 };
  const { d, err } = useCorrections(query, 0);
  const groups = d && (t === 'surah' || t === 'cat')
    ? Object.entries(d.reduce<Record<string, ApiCorrection[]>>((a, c) => { const k = t === 'surah' ? `سورة ${SUR[c.surah]?.[0] ?? c.surah}` : c.category_label; (a[k] ??= []).push(c); return a; }, {}))
    : null;
  const empty: Record<MTab, string> = {
    open: 'لا توجد نقاط تحتاج مراجعة الآن. أحسنت!', recurring: 'لا توجد أخطاء متكررة.', done: 'لم تُصحَّح أي نقطة بعد.',
    surah: 'لا توجد نقاط مفتوحة.', cat: 'لا توجد نقاط مفتوحة.',
  };
  return (
    <div>
      <BackHeader title="أخطائي" sticky />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={muted(13, { lineHeight: 1.7 })}>نقاط سجّلها معلمك لتراجعها. ليست درجة؛ كل نقطة تصحّحها خطوة إلى الأمام.</p>
        <Chips scroll options={[['open', 'يحتاج مراجعة'], ['recurring', 'أخطاء متكررة'], ['done', 'تم تصحيحها'], ['surah', 'حسب السورة'], ['cat', 'حسب النوع']] as const}
          value={t} onChange={setT} wrapStyle={{ paddingBottom: 0 }} />
        {err && <p role="alert" style={muted(14)}>تعذّر التحميل: {err}</p>}
        {!d && !err && <p role="status" style={muted(14)}>جارٍ التحميل…</p>}
        {d?.length === 0 && <p style={muted(15, { textAlign: 'center', padding: 24 })}>{empty[t]}</p>}
        {groups ? groups.map(([k, list]) => (
          <section key={k} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{k} <span style={muted(13)}>({list.length})</span></h2>
            {list.map((c) => <CorrectionCard key={c.id} c={c} teacher={false} />)}
          </section>
        )) : d?.map((c) => <CorrectionCard key={c.id} c={c} teacher={false} />)}
      </div>
    </div>
  );
}

/* ---------------- Teacher dashboard card ---------------- */
interface Overview {
  students_with_open: { student: number; name: string; open: number }[];
  repeated_memorization: { id: number; student: number; name: string; label: string; surah: number; ayah: number; times: number }[];
  repeated_tajweed: Overview['repeated_memorization'];
  awaiting_recheck: Overview['repeated_memorization'];
}
export function TeacherCorrectionsCard() {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => { let on = true; api<Overview>('GET', 'teacher/corrections/overview').then((x) => on && setO(x)).catch(() => {}); return () => { on = false; }; }, []);
  if (!o || (!o.students_with_open.length)) return null;
  const rows: [string, Overview['repeated_memorization']][] = [
    ['أخطاء حفظ متكررة', o.repeated_memorization], ['أخطاء تجويد متكررة', o.repeated_tajweed], ['نقاط تنتظر إعادة التحقق', o.awaiting_recheck],
  ];
  return (
    <section aria-labelledby="tcc-h" style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 id="tcc-h" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>نقاط مفتوحة لدى طلابك</h2>
      {o.students_with_open.slice(0, 5).map((x) => (
        <button key={x.student} onClick={() => go('tstudent', { id: String(x.student) })} style={{ minHeight: 48, padding: '6px 12px', borderRadius: 12, border: `1px solid ${color.divider}`, background: color.ivory, textAlign: 'right', cursor: 'pointer', color: color.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{x.name}</span><span style={{ fontSize: 13, color: color.body }}>{x.open} نقطة</span><Icon name="chevL" size={18} />
        </button>
      ))}
      {rows.filter(([, l]) => l.length).map(([h, l]) => (
        <details key={h} style={{ fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', minHeight: 40, display: 'flex', alignItems: 'center', fontWeight: 700 }}>{h} ({l.length})</summary>
          <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.9 }}>
            {l.map((x) => <li key={x.id}>{x.name} · {x.label} · {ref(x)}{x.times > 1 ? ` · ${x.times} مرات` : ''}</li>)}
          </ul>
        </details>
      ))}
    </section>
  );
}
