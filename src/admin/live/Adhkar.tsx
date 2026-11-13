/** «إدارة مكتبة الأذكار»: every entry is reviewed before it is published or sent. Quranic entries are added by surah
 *  and ayah numbers only — their text is copied by the server from the verified Quran text, never typed. Sunnah
 *  entries need the collection, the hadith number and the grading (صحيح / حسن). Approve / reject (with a reason),
 *  enable / disable, a test notice to your own devices, delivery stats and failed deliveries. */
import { cloneElement, useCallback, useEffect, useState } from 'react';
import { color, font } from '@/theme/tokens';
import * as AD from '@/api/adhkar';
import { can, toast } from '../adminStore';
import { card } from '../AdminTables';
import { chip, dateTime, errMsg, Modal, smallBtn, useDebounced } from './ui';

const TABS: [string, string][] = [['pending', 'بانتظار المراجعة'], ['approved', 'معتمدة'], ['rejected', 'مرفوضة'], ['', 'الكل']];
const TONE: Record<string, [string, string]> = { pending: ['#F3E6CC', '#6B470C'], approved: [color.sage, color.primary], rejected: [color.dangerBg, color.dangerInk] };
const PUSH: Record<string, string> = { sent: 'وصل إلى الخدمة', partial: 'وصل جزئيًا', failed: 'فشل', no_devices: 'لا أجهزة', pending: 'قيد الإرسال', skipped: 'لم يُرسل' };
const inp = { minHeight: 44, borderRadius: 10, border: `1px solid ${color.borderStrong}`, padding: '0 10px', fontSize: 15, fontFamily: 'inherit', background: color.card } as const;

export default function AdhkarLive() {
  const [view, setView] = useState<'library' | 'stats'>('library');
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="admin-adhkar">
      <div role="tablist" aria-label="القسم" style={{ display: 'flex', gap: 8 }}>
        <button role="tab" aria-selected={view === 'library'} onClick={() => setView('library')} style={{ ...chip(view === 'library'), minHeight: 44 }}>المكتبة والمراجعة</button>
        <button role="tab" aria-selected={view === 'stats'} onClick={() => setView('stats')} style={{ ...chip(view === 'stats'), minHeight: 44 }}>الإرسال والإحصاءات</button>
      </div>
      {view === 'library' ? <Library /> : <Stats />}
    </section>
  );
}

function Library() {
  const [tab, setTab] = useState('pending'); const [cat, setCat] = useState(''); const [src, setSrc] = useState(''); const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [data, setData] = useState<{ count: number; counts: Record<string, number>; categories: AD.Category[]; rows: AD.AdminDhikr[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<AD.AdminDhikr | 'new' | null>(null); const [reject, setReject] = useState<AD.AdminDhikr | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setErr(null);
    AD.adminList({ status: tab, category: cat, source: src, q: dq }).then((r) => setData({ count: r.count, ...r.results })).catch((e) => setErr(errMsg(e)));
  }, [tab, cat, src, dq]);
  useEffect(() => { load(); }, [load]);
  const manage = can('adhkar.manage'); const approve = can('adhkar.approve');
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); if (msg) toast(msg); load(); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  };
  const seed = () => act(async () => {
    const r = await AD.adminSeed();
    toast(`أُضيفت ${r.created} آية للمراجعة${r.existing ? ` (${r.existing} موجودة)` : ''}${r.missing.length ? `؛ تعذّر ${r.missing.length}` : ''}`);
  }, '');
  const c = data?.counts ?? {};
  return (
    <>
      <p style={{ margin: 0, fontSize: 13, color: color.body, lineHeight: 1.8 }}>
        لا يُعرض ذكر للمستخدمين ولا يُرسل إشعارًا إلا بعد اعتماده. نص الآيات يُنسخ من النص القرآني المعتمد ولا يُكتب يدويًا. أحاديث السنة تحتاج إلى المصدر ورقم الحديث ودرجته (صحيح أو حسن فقط).
      </p>
      <div role="tablist" aria-label="حالة المراجعة" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {TABS.map(([k, l]) => <button key={k || 'all'} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ ...chip(tab === k), minHeight: 44 }}>
          {l}{k && c[k] !== undefined ? ` (${c[k]})` : ''}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="search" aria-label="بحث في نص الذكر" placeholder="بحث في النص" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...inp, flex: '1 1 200px' }} />
        <select aria-label="الفئة" value={cat} onChange={(e) => setCat(e.target.value)} style={inp}>
          <option value="">كل الفئات</option>{data?.categories.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        <select aria-label="المصدر" value={src} onChange={(e) => setSrc(e.target.value)} style={inp}>
          <option value="">القرآن والسنة</option><option value="quran">القرآن الكريم</option><option value="hadith">السنة النبوية</option>
        </select>
        {manage && <button onClick={() => setEdit('new')} style={{ ...smallBtn('primary'), minHeight: 44 }}>إضافة ذكر</button>}
        {manage && <button disabled={busy} onClick={() => void seed()} style={{ ...smallBtn(), minHeight: 44 }}>إضافة الآيات المقترحة</button>}
      </div>
      {err ? <p role="alert" style={{ color: color.danger, margin: 0 }}>{err}</p>
        : !data ? <p role="status" style={{ color: color.muted, margin: 0 }}>جارٍ التحميل…</p>
        : !data.rows.length ? <p style={{ ...card, padding: 18, margin: 0, color: color.muted }}>لا توجد أذكار هنا.{manage && tab === 'pending' && !data.count ? ' استخدم «إضافة الآيات المقترحة» لإضافة آيات من النص القرآني المعتمد للمراجعة.' : ''}</p>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.count > data.rows.length && <p style={{ margin: 0, fontSize: 13, color: color.muted }}>يُعرض أول {data.rows.length} من {data.count}. استخدم البحث أو الفئة لتضييق القائمة.</p>}
          {data.rows.map((d) => (
            <article key={d.id} data-dhikr={d.id} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
                <span style={{ padding: '3px 10px', borderRadius: 999, fontWeight: 700, background: TONE[d.status][0], color: TONE[d.status][1] }}>{d.status_label}</span>
                {!d.enabled && <span style={{ padding: '3px 10px', borderRadius: 999, fontWeight: 700, background: color.dangerBg, color: color.dangerInk }}>معطّل</span>}
                <strong style={{ color: color.primary }}>{d.category_label}</strong>
                <span style={{ color: color.muted }}>· {d.time_label}{d.repetition ? ` · ${d.repetition} مرة` : ''}</span>
              </div>
              <p lang="ar" style={{ margin: 0, fontFamily: d.source_type === 'quran' ? font.quran : undefined, fontSize: 18, lineHeight: 2, color: color.inkQuran }}>{d.text}</p>
              <p style={{ margin: 0, fontSize: 13 }}><strong>المصدر:</strong> {d.source_type === 'quran' ? 'القرآن الكريم · ' : ''}{d.source}
                {d.reference_url && <> · <a href={d.reference_url} target="_blank" rel="noopener noreferrer">المرجع</a></>}</p>
              <p style={{ margin: 0, fontSize: 12, color: color.muted }}>
                {d.origin === 'quran_reference' ? 'من الآيات المقترحة' : `أضافه ${d.created_by ?? '—'}`} · {dateTime(d.created_at)}
                {d.reviewed_by && d.reviewed_at && <> · راجعه {d.reviewed_by} في {dateTime(d.reviewed_at)}</>}
                {d.review_note && <> · سبب: {d.review_note}</>}
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {approve && d.status !== 'approved' && <button disabled={busy} onClick={() => void act(() => AD.adminReview(d.id, 'approve'), 'اعتُمد الذكر')} style={{ ...smallBtn('primary'), minHeight: 44 }}>اعتماد</button>}
                {approve && d.status !== 'rejected' && <button disabled={busy} onClick={() => setReject(d)} style={{ ...smallBtn('danger'), minHeight: 44 }}>رفض</button>}
                {manage && <button onClick={() => setEdit(d)} style={{ ...smallBtn(), minHeight: 44 }}>تعديل</button>}
                {manage && <button disabled={busy} onClick={() => void act(() => AD.adminEnable(d.id, !d.enabled), d.enabled ? 'عُطّل الذكر' : 'فُعّل الذكر')} style={{ ...smallBtn(), minHeight: 44 }}>{d.enabled ? 'تعطيل' : 'تفعيل'}</button>}
                {manage && d.status === 'approved' && d.enabled && <button disabled={busy} onClick={() => void act(async () => { const r = await AD.adminTest(d.id); toast(r.message); }, '')} style={{ ...smallBtn(), minHeight: 44 }}>إشعار تجريبي لأجهزتي</button>}
              </div>
            </article>
          ))}
        </div>}
      {edit && <Editor row={edit === 'new' ? null : edit} categories={data?.categories ?? []} onClose={() => setEdit(null)} onDone={(m) => { toast(m); setEdit(null); load(); }} />}
      {reject && <Reject row={reject} onClose={() => setReject(null)} onDone={() => { toast('رُفض الذكر'); setReject(null); load(); }} />}
    </>
  );
}

function Reject({ row, onClose, onDone }: { row: AD.AdminDhikr; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!note.trim()) return setErr('اكتب سبب الرفض (مثل: المصدر غير صحيح، الدرجة غير ثابتة).');
    setBusy(true);
    try { await AD.adminReview(row.id, 'reject', note.trim()); onDone(); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal title={`رفض: ${row.source}`} onClose={() => { if (!busy) onClose(); }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, fontWeight: 700 }}>سبب الرفض
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} style={inp} /></label>
      {err && <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={() => void go()} style={{ ...smallBtn('danger'), minHeight: 44 }}>رفض</button>
        <button onClick={onClose} style={{ ...smallBtn(), minHeight: 44 }}>إلغاء</button>
      </div>
    </Modal>
  );
}

const TIMES: [string, string][] = [['any', 'أي وقت'], ['morning', 'الصباح'], ['evening', 'المساء'], ['sleep', 'النوم'], ['waking', 'الاستيقاظ']];
function Editor({ row, categories, onClose, onDone }: { row: AD.AdminDhikr | null; categories: AD.Category[]; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState<Record<string, string>>(() => ({
    category: row?.category ?? 'quran_dua', source_type: row?.source_type ?? 'quran',
    surah: String(row?.surah ?? ''), ayah_from: String(row?.ayah_from ?? ''), ayah_to: String(row?.ayah_to ?? ''),
    text: row?.source_type === 'hadith' ? row.text : '', hadith_collection: row?.hadith_collection ?? '', hadith_number: row?.hadith_number ?? '',
    grading: row?.grading ?? '', graded_by: row?.graded_by ?? '', reference_url: row?.reference_url ?? '',
    repetition: row?.repetition ? String(row.repetition) : '', time_of_day: row?.time_of_day ?? 'any',
  }));
  const [errs, setErrs] = useState<Record<string, string>>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const quran = f.source_type === 'quran';
  const num = (v: string) => (v.trim() ? Number(v) : null);
  const submit = async () => {
    setBusy(true); setErr(null); setErrs({});
    const b: Record<string, unknown> = { category: f.category, source_type: f.source_type, repetition: num(f.repetition), time_of_day: f.time_of_day, reference_url: f.reference_url.trim() };
    if (quran) Object.assign(b, { surah: num(f.surah), ayah_from: num(f.ayah_from), ayah_to: num(f.ayah_to) ?? num(f.ayah_from) });
    else Object.assign(b, { text: f.text, hadith_collection: f.hadith_collection, hadith_number: f.hadith_number, grading: f.grading, graded_by: f.graded_by });
    try {
      if (row) await AD.adminEdit(row.id, b); else await AD.adminCreate(b);
      onDone(row ? 'حُفظ التعديل (تغيير المصدر يعيده إلى المراجعة)' : 'أُضيف الذكر وينتظر المراجعة');
    } catch (e) {
      const x = e as { fields?: Record<string, string[]> };
      if (x.fields) setErrs(Object.fromEntries(Object.entries(x.fields).map(([k, v]) => [k, ([] as string[]).concat(v)[0]])));
      setErr(errMsg(e)); setBusy(false);
    }
  };
  const field = (k: string, label: string, el: JSX.Element) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, fontWeight: 700, flex: '1 1 140px' }}>{label}{cloneElement(el, { 'aria-label': label, 'aria-invalid': !!errs[k] || undefined })}
      {errs[k] && <span role="alert" style={{ fontSize: 12, color: color.dangerInk, fontWeight: 400 }}>{errs[k]}</span>}</label>
  );
  return (
    <Modal title={row ? 'تعديل الذكر' : 'إضافة ذكر'} onClose={() => { if (!busy) onClose(); }} wide>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {field('source_type', 'المصدر', <select value={f.source_type} onChange={set('source_type')} style={inp}><option value="quran">القرآن الكريم</option><option value="hadith">السنة النبوية</option></select>)}
        {field('category', 'الفئة', <select value={f.category} onChange={set('category')} style={inp}>{categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>)}
        {field('time_of_day', 'الوقت', <select value={f.time_of_day} onChange={set('time_of_day')} style={inp}>{TIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}
      </div>
      {quran ? (
        <>
          <p style={{ margin: 0, fontSize: 13, color: color.muted }}>اكتب رقم السورة والآيات فقط؛ يُنسخ النص من النص القرآني المعتمد في الحلقة.</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {field('surah', 'رقم السورة (1–114)', <input inputMode="numeric" value={f.surah} onChange={set('surah')} style={inp} />)}
            {field('ayah_from', 'من الآية', <input inputMode="numeric" value={f.ayah_from} onChange={set('ayah_from')} style={inp} />)}
            {field('ayah_to', 'إلى الآية', <input inputMode="numeric" value={f.ayah_to} onChange={set('ayah_to')} style={inp} />)}
          </div>
        </>
      ) : (
        <>
          {field('text', 'نص الحديث كما في المصدر', <textarea value={f.text} onChange={set('text')} rows={5} style={{ ...inp, padding: 10, lineHeight: 1.9 }} />)}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {field('hadith_collection', 'الكتاب (مثل: صحيح البخاري)', <input value={f.hadith_collection} onChange={set('hadith_collection')} style={inp} />)}
            {field('hadith_number', 'رقم الحديث', <input value={f.hadith_number} onChange={set('hadith_number')} style={inp} />)}
            {field('grading', 'الدرجة', <select value={f.grading} onChange={set('grading')} style={inp}><option value="">اختر…</option><option value="sahih">صحيح</option><option value="hasan">حسن</option></select>)}
            {field('graded_by', 'المُصحِّح (مثل: الألباني)', <input value={f.graded_by} onChange={set('graded_by')} style={inp} />)}
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {field('repetition', 'عدد التكرار (فقط إن ورد في المصدر)', <input inputMode="numeric" value={f.repetition} onChange={set('repetition')} style={inp} />)}
        {field('reference_url', 'رابط المرجع (اختياري)', <input dir="ltr" value={f.reference_url} onChange={set('reference_url')} style={inp} />)}
      </div>
      {err && <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={() => void submit()} style={{ ...smallBtn('primary'), minHeight: 44 }}>{row ? 'حفظ' : 'إضافة للمراجعة'}</button>
        <button onClick={onClose} style={{ ...smallBtn(), minHeight: 44 }}>إلغاء</button>
      </div>
    </Modal>
  );
}

function Stats() {
  const [s, setS] = useState<AD.Stats | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { AD.adminStats().then(setS).catch((e) => setErr(errMsg(e))); }, []);
  if (err) return <p role="alert" style={{ color: color.danger, margin: 0 }}>{err}</p>;
  if (!s) return <p role="status" style={{ color: color.muted, margin: 0 }}>جارٍ التحميل…</p>;
  const tile = (n: number | string, l: string) => (
    <div style={{ ...card, padding: 14, flex: '1 1 140px' }}><div style={{ fontSize: 24, fontWeight: 800, color: color.primary }}>{n}</div><div style={{ fontSize: 13, color: color.muted }}>{l}</div></div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="adhkar-stats">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {tile(s.notices_7d, 'تذكيرات آخر 7 أيام')}{tile(s.accounts_7d, 'حسابات وصلتها')}
        {tile(s.library.approved ?? 0, 'أذكار معتمدة')}{tile(s.library.pending ?? 0, 'بانتظار المراجعة')}
      </div>
      <section style={{ ...card, padding: 14 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>حالة الإرسال (آخر 7 أيام)</h3>
        {Object.keys(s.by_push_status).length
          ? <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.9 }}>{Object.entries(s.by_push_status).map(([k, n]) => <li key={k}>{PUSH[k] ?? k}: {n}</li>)}</ul>
          : <p style={{ margin: 0, color: color.muted }}>لم يُرسل شيء بعد.</p>}
        <p style={{ margin: '8px 0 0', fontSize: 12, color: color.muted }}>«وصل إلى الخدمة» يعني أن خدمة الإشعارات قبلته؛ قد يؤخر نظام الهاتف عرضه (توفير البطارية).</p>
      </section>
      {!!s.top.length && <section style={{ ...card, padding: 14 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>الأكثر إرسالًا</h3>
        <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.9 }}>{s.top.map((t) => <li key={t.dhikr}>{t.source}: {t.sent}</li>)}</ul>
      </section>}
      <section style={{ ...card, padding: 14 }} aria-label="الإرسال الفاشل">
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>الإرسال الفاشل</h3>
        {s.failed.length
          ? <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.9, fontSize: 13 }}>{s.failed.map((x, i) => <li key={i}>{dateTime(x.at)} · {x.role} · {PUSH[x.status] ?? x.status} · محاولات {x.attempts}{x.error ? ` · ${x.error}` : ''}</li>)}</ul>
          : <p style={{ margin: 0, color: color.muted }}>لا يوجد إرسال فاشل.</p>}
      </section>
    </div>
  );
}
