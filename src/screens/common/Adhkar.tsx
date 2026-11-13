/** «الأذكار والأدعية» — every role. Only entries an administrator approved are listed (Quran: text from the verified
 *  Quran text, with surah and ayah; Sunnah: with the collection, number and grading). Browse by category, search,
 *  favorites, the full text with its source, a repetition counter where the source gives a number, and sharing with
 *  the source attached. `#/adhkar?id=<n>` (a tapped reminder) opens that entry. Also «إعدادات الأذكار والتنبيهات». */
import { useEffect, useState } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackHeader, Switch, card, muted, outlineBtn, pageCol, primaryBtn } from '@/components/ui';
import { type ApiError } from '@/api/client';
import * as AD from '@/api/adhkar';
import { go, toast, useApp } from '@/store/store';
import { arDigits, hourLabel } from '@/lib/time';

const errText = (e: unknown) => (e as ApiError)?.message || 'تعذّر التحميل. تحقق من الاتصال.';

export default function Adhkar() {
  const id = Number(useApp((s) => s.params.id) || 0);
  return id ? <DhikrView id={id} /> : <Library />;
}

function Library() {
  const [cat, setCat] = useState(''); const [q, setQ] = useState(''); const [fav, setFav] = useState(false);
  const [data, setData] = useState<{ categories: AD.Category[]; results: AD.Dhikr[] } | null>(null); const [err, setErr] = useState('');
  useEffect(() => {
    const t = setTimeout(() => { AD.list({ category: cat, q: q.trim(), favorites: fav }).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errText(e))); }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [cat, q, fav]);
  const cats = (data?.categories ?? []).filter((c) => (c.count ?? 0) > 0);
  const chip = (on: boolean) => ({ minHeight: 40, padding: '0 14px', borderRadius: 999, border: `1.5px solid ${on ? color.primary : color.borderStrong}`, background: on ? color.primary : color.card,
    color: on ? color.ivory : color.primary, fontWeight: 700, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0 });
  return (
    <div style={pageCol(12)} data-testid="adhkar-library">
      <BackHeader title="الأذكار والأدعية" sticky />
      <p style={muted(13, { lineHeight: 1.7 })}>من القرآن الكريم والسنة النبوية الصحيحة فقط، وكل ذكر معه مصدره. تراجعها الإدارة قبل نشرها.</p>
      <input type="search" aria-label="ابحث في الأذكار" placeholder="ابحث في الأذكار (بدون تشكيل)" value={q} onChange={(e) => setQ(e.target.value)}
        style={{ minHeight: 48, borderRadius: 12, border: `1.5px solid ${color.borderInput}`, padding: '0 12px', fontSize: 16, background: color.card }} />
      <div role="tablist" aria-label="الفئات" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
        <button role="tab" aria-selected={!cat && !fav} onClick={() => { setCat(''); setFav(false); }} style={chip(!cat && !fav)}>الكل</button>
        <button role="tab" aria-selected={fav} onClick={() => { setFav(!fav); setCat(''); }} style={chip(fav)}>المفضلة</button>
        {cats.map((c) => <button key={c.key} role="tab" aria-selected={cat === c.key} onClick={() => { setCat(c.key); setFav(false); }} style={chip(cat === c.key)}>{c.label} <span style={{ opacity: 0.7 }}>({arDigits(c.count ?? 0)})</span></button>)}
      </div>
      {err && <p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err}</p>}
      {data && !data.results.length && <p style={muted(15, { padding: 24, textAlign: 'center' })}>{fav ? 'لم تضف أذكارًا إلى المفضلة بعد.' : q ? 'لا توجد نتائج.' : 'لا توجد أذكار معتمدة بعد. تُضاف بعد مراجعة الإدارة لمصادرها.'}</p>}
      <div role="list" aria-label="الأذكار" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data?.results.map((d) => (
          <button key={d.id} role="listitem" onClick={() => go('adhkar', { id: String(d.id) })}
            style={{ ...card, padding: '12px 14px', textAlign: 'right', cursor: 'pointer', color: color.ink, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: color.primary }}>{d.category_label}{d.favorite ? ' · ★' : ''}</span>
            <span lang="ar" style={{ fontFamily: d.source_type === 'quran' ? font.quran : undefined, fontSize: 18, lineHeight: 2, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.text}</span>
            <span style={muted(12)}>{d.source}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DhikrView({ id }: { id: number }) {
  const [d, setD] = useState<AD.Dhikr | null>(null); const [err, setErr] = useState(''); const [n, setN] = useState(0);
  useEffect(() => { AD.one(id).then((x) => { setD(x); setN(0); }).catch((e) => setErr(errText(e))); }, [id]);
  if (err) return <div style={pageCol()}><BackHeader title="الأذكار والأدعية" /><p role="alert" style={{ margin: 0, color: color.dangerInk }}>{err}</p></div>;
  if (!d) return <div style={pageCol()}><BackHeader title="الأذكار والأدعية" /><p role="status" style={muted(14)}>جارٍ التحميل…</p></div>;
  const toggleFav = async () => {
    try { const r = await AD.favorite(d.id, !d.favorite); setD({ ...d, favorite: r.favorite }); toast(r.favorite ? 'أُضيف إلى المفضلة' : 'أُزيل من المفضلة'); }
    catch (e) { toast(errText(e), 'alert'); }
  };
  const shareText = `${d.text}\n— ${d.source}\n(من تطبيق الحلقة)`;
  const share = async () => {
    try {
      if (navigator.share) { await navigator.share({ text: shareText }); return; }
      await navigator.clipboard.writeText(shareText); toast('نُسخ النص مع مصدره');
    } catch { /* cancelled */ }
  };
  const done = d.repetition ? n >= d.repetition : false;
  return (
    <div style={pageCol(14)} data-testid="dhikr-view">
      <BackHeader title={d.category_label} sticky />
      <article style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p lang="ar" style={{ margin: 0, fontFamily: d.source_type === 'quran' ? font.quran : undefined, fontSize: d.source_type === 'quran' ? 24 : 21, lineHeight: 2.2, color: color.inkQuran, whiteSpace: 'pre-wrap' }}>{d.text}</p>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: 13 }}>
          <dt style={{ color: color.muted }}>المصدر</dt><dd style={{ margin: 0, fontWeight: 700 }}>{d.source_type === 'quran' ? `القرآن الكريم · ${d.source}` : d.source}</dd>
          {d.time_of_day !== 'any' && <><dt style={{ color: color.muted }}>الوقت</dt><dd style={{ margin: 0 }}>{d.time_label}</dd></>}
          {d.repetition && <><dt style={{ color: color.muted }}>العدد</dt><dd style={{ margin: 0 }}>{arDigits(d.repetition)} مرة</dd></>}
          {d.reference_url && <><dt style={{ color: color.muted }}>المرجع</dt><dd style={{ margin: 0 }}><a href={d.reference_url} target="_blank" rel="noopener noreferrer" style={{ color: color.primary }}>فتح المرجع</a></dd></>}
        </dl>
      </article>
      {d.repetition && (
        <section aria-label="عدّاد التكرار" style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <button onClick={() => setN(done ? n : n + 1)} aria-label={`عدّ: ${n} من ${d.repetition}`}
            style={{ width: 140, height: 140, borderRadius: '50%', border: 'none', background: done ? color.sage : color.primary, color: done ? color.primary : color.ivory, fontSize: 34, fontWeight: 800, cursor: 'pointer' }}>
            {arDigits(n)}<span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>من {arDigits(d.repetition)}</span>
          </button>
          <span role="status" style={muted(14)}>{done ? 'أتممت العدد. تقبّل الله منك.' : 'اضغط الدائرة مع كل مرة.'}</span>
          {n > 0 && <button onClick={() => setN(0)} style={outlineBtn(40, 13, { padding: '0 14px' })}>إعادة العدّ</button>}
        </section>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => void toggleFav()} aria-pressed={!!d.favorite} style={outlineBtn(48, 15, { flex: 1 })}>{d.favorite ? '★ في المفضلة' : '☆ أضف إلى المفضلة'}</button>
        <button onClick={() => void share()} style={primaryBtn(48, 15, { flex: 1, borderRadius: 12 })}><Icon name="share" size={18} /> مشاركة مع المصدر</button>
      </div>
    </div>
  );
}

/* ---------------- «إعدادات الأذكار والتنبيهات» (in «حسابي») ---------------- */
const HOURS = Array.from({ length: 24 }, (_, h) => h);
export function AdhkarSettingsCard() {
  const [p, setP] = useState<AD.Prefs | null>(null); const [err, setErr] = useState('');
  useEffect(() => { AD.prefs().then(setP).catch(() => {}); }, []);
  if (!p) return null;
  const save = async (patch: Partial<AD.Prefs>) => {
    const prev = p; setP({ ...p, ...patch }); setErr('');
    try { setP(await AD.savePrefs(patch)); toast('حُفظت إعدادات الأذكار'); }
    catch (e) { setP(prev); const x = e as ApiError; setErr(Object.values(x.fields ?? {}).flat()[0] as string ?? x.message); }
  };
  const sel = { minHeight: 44, borderRadius: 10, border: `1.5px solid ${color.borderInput}`, background: color.card, padding: '0 8px', fontSize: 15, fontFamily: 'inherit' } as const;
  const hourSel = (k: keyof AD.Prefs, label: string, disabled = false) => (
    <select aria-label={label} value={p[k] as number} disabled={disabled} onChange={(e) => void save({ [k]: Number(e.target.value) } as Partial<AD.Prefs>)} style={{ ...sel, opacity: disabled ? 0.5 : 1 }}>
      {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
    </select>
  );
  const row = (k: 'morning' | 'evening' | 'sleep', label: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 52 }}>
      <span style={{ flex: 1, fontSize: 15 }}>{label}</span>
      {hourSel(`${k}_hour` as keyof AD.Prefs, `وقت ${label}`, !p[`${k}_on` as keyof AD.Prefs] || !p.enabled)}
      <Switch on={!!p[`${k}_on` as keyof AD.Prefs]} onToggle={() => void save({ [`${k}_on`]: !p[`${k}_on` as keyof AD.Prefs] } as Partial<AD.Prefs>)} label={label} />
    </div>
  );
  return (
    <section aria-labelledby="adh-h" data-testid="adhkar-settings" style={{ ...card, padding: '4px 16px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <h2 id="adh-h" style={{ margin: '12px 0 0', fontSize: 14, color: color.muted, fontWeight: 700 }}>إعدادات الأذكار والتنبيهات</h2>
      <p style={muted(12, { lineHeight: 1.7 })}>بتوقيت منطقتك الزمنية (<bdi dir="ltr">{p.timezone}</bdi>). تصل إلى أجهزتك حتى لو كان التطبيق مغلقًا. إيقافها لا يوقف إشعارات الحلقة والواجبات والجلسات.</p>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 52 }}><span style={{ flex: 1, fontSize: 15, fontWeight: 700 }}>تفعيل الأذكار</span>
        <Switch on={p.enabled} onToggle={() => void save({ enabled: !p.enabled })} label="تفعيل الأذكار" /></div>
      {row('morning', 'أذكار الصباح')}
      {row('evening', 'أذكار المساء')}
      {row('sleep', 'أذكار النوم')}
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 52 }}><span style={{ flex: 1, fontSize: 15 }}>أدعية من القرآن</span>
        <Switch on={p.quran_dua_on} onToggle={() => void save({ quran_dua_on: !p.quran_dua_on })} label="أدعية من القرآن" /></div>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 52 }}><span style={{ flex: 1, fontSize: 15 }}>أدعية من السنة</span>
        <Switch on={p.sunnah_dua_on} onToggle={() => void save({ sunnah_dua_on: !p.sunnah_dua_on })} label="أدعية من السنة" /></div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 52, fontSize: 15 }}><span style={{ flex: 1 }}>تكرار التذكيرات</span>
        <select aria-label="تكرار التذكيرات" value={p.interval_hours} disabled={!p.enabled} onChange={(e) => void save({ interval_hours: Number(e.target.value) })} style={sel}>
          {[[1, 'كل ساعة'], [2, 'كل ساعتين'], [3, 'كل 3 ساعات'], [4, 'كل 4 ساعات'], [0, 'متوقف']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
      {p.interval_hours > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 52, fontSize: 15 }}>
        <span style={{ flex: '1 1 120px' }}>من</span>{hourSel('window_start', 'بداية التذكيرات')}<span>إلى</span>{hourSel('window_end', 'نهاية التذكيرات')}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 52, fontSize: 15 }}>
        <span style={{ flex: '1 1 120px' }}>ساعات الهدوء</span>{hourSel('quiet_start', 'بداية ساعات الهدوء')}<span>إلى</span>{hourSel('quiet_end', 'نهاية ساعات الهدوء')}</div>
      {err && <p role="alert" style={{ margin: 0, fontSize: 13, color: color.dangerInk }}>{err}</p>}
      <button onClick={() => go('adhkar', {})} style={outlineBtn(44, 14, { marginTop: 6 })}>فتح الأذكار والأدعية</button>
    </section>
  );
}
