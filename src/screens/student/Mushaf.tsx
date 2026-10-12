import type { FormEvent } from 'react';
import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackButton, Spinner, card, muted } from '@/components/ui';
import { SUR } from '@/data/demo';
import { jumpTo, loadSurah, loadSurahList, openSheet, playAyah, stopMushaf, up, useApp } from '@/store/store';

const stepBtn = { width: 32, height: 44, border: 'none', background: 'transparent', color: color.primary, cursor: 'pointer', display: 'grid', placeItems: 'center' } as const;
const num = { fontFamily: font.latin, fontWeight: 700, fontSize: 14, minWidth: 20, textAlign: 'center' } as const;

export default function Mushaf() {
  const M = useApp((s) => s.m);
  const setM = (o: Partial<typeof M>) => up('m', o);
  const max = M.data?.numberOfAyahs ?? M.to;
  const name = M.data ? M.data.name : SUR[M.surah] ? 'سورة ' + SUR[M.surah][0] : '…';
  const playL = M.playing ? 'إيقاف التلاوة' : 'تشغيل النطاق';

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', minHeight: 56, position: 'sticky', top: 0, background: color.ivory, zIndex: 5, borderBottom: `1px solid ${color.dividerHeader}` }}>
        <BackButton />
        <button onClick={() => { openSheet({ kind: 'surahs' }); loadSurahList(); }} aria-label="اختر السورة"
          style={{ flex: 1, minHeight: 48, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: color.ink, textAlign: 'right', padding: 0 }}>
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 18, fontWeight: 800 }}>{name}</span>
            <span style={{ fontSize: 12, color: color.muted }}>{M.data ? `${M.data.numberOfAyahs} آية · الجزء ${M.data.ayahs[0].juz}` : ' '}</span>
          </span>
          <span style={{ color: color.primary }}><Icon name="chevD" size={18} /></span>
        </button>
        <button onClick={() => setM({ font: Math.max(18, M.font - 2) })} aria-label="تصغير الخط" style={{ width: 44, height: 48, border: 'none', background: 'transparent', color: color.primary, fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>أ-</button>
        <button onClick={() => setM({ font: Math.min(40, M.font + 2) })} aria-label="تكبير الخط" style={{ width: 44, height: 48, border: 'none', background: 'transparent', color: color.primary, fontSize: 19, fontWeight: 800, cursor: 'pointer' }}>أ+</button>
        <button onClick={() => M.bookmark && jumpTo(M.bookmark)} aria-label={M.bookmark ? `علامة عند الآية ${M.bookmark}` : 'لا توجد علامة'}
          style={{ width: 48, height: 48, borderRadius: 14, border: 'none', background: 'transparent', color: color.goldInk, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
          <Icon name="bookmark" />
        </button>
      </header>

      <div style={{ padding: '12px 16px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); jumpTo(M.jump); }} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <label htmlFor="m-jump" style={{ fontSize: 13, color: color.muted, fontWeight: 700 }}>انتقل إلى آية</label>
          <input id="m-jump" type="number" inputMode="numeric" min={1} max={M.data?.numberOfAyahs} dir="ltr" value={M.jump} onChange={(e) => setM({ jump: e.target.value })}
            style={{ width: 64, minHeight: 44, borderRadius: 10, border: `1.5px solid ${color.borderInput}`, background: color.card, fontFamily: font.latin, fontSize: 15, textAlign: 'center' }} />
          <button type="submit" style={{ minHeight: 44, padding: '0 12px', border: 'none', borderRadius: 10, background: color.sage, color: color.primary, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>انتقل</button>
        </form>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginInlineStart: 'auto' }} role="group" aria-label="نطاق الحفظ">
          <span style={{ fontSize: 13, color: color.muted, fontWeight: 700 }}>النطاق</span>
          <button onClick={() => setM({ from: Math.max(1, M.from - 1) })} aria-label="بداية النطاق ناقص" style={stepBtn}><Icon name="minus" size={18} /></button>
          <span dir="ltr" style={num}>{M.from}</span>
          <button onClick={() => setM({ from: Math.min(M.to, M.from + 1) })} aria-label="بداية النطاق زائد" style={stepBtn}><Icon name="plus" size={18} /></button>
          <span style={{ color: color.muted }}>–</span>
          <button onClick={() => setM({ to: Math.max(M.from, M.to - 1) })} aria-label="نهاية النطاق ناقص" style={stepBtn}><Icon name="minus" size={18} /></button>
          <span dir="ltr" style={num}>{M.to}</span>
          <button onClick={() => setM({ to: Math.min(max, M.to + 1) })} aria-label="نهاية النطاق زائد" style={stepBtn}><Icon name="plus" size={18} /></button>
        </div>
      </div>

      <div style={{ flex: 1, padding: '0 16px 16px' }}>
        {M.loading && (
          <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '48px 0' }}><Spinner /><p style={muted(14)}>جارٍ تحميل النص من المصدر…</p></div>
        )}
        {M.error && !M.loading && (
          <div role="alert" style={{ background: color.card, border: `1px dashed ${color.borderStrong}`, borderRadius: 16, padding: '24px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 }}>
            <span style={{ color: color.dangerInk }}><Icon name="alert" size={30} /></span>
            <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>تعذّر تحميل النص القرآني</p>
            <p style={muted(14, { lineHeight: 1.7 })}>{M.errMsg ?? 'لا نعرض أي نص قرآني إلا من مصدر معتمد. تحقق من الاتصال ثم أعد المحاولة.'}</p>
            <button onClick={() => loadSurah(M.surah)} style={{ minHeight: 48, padding: '0 20px', border: 'none', borderRadius: 12, background: color.primary, color: color.ivory, fontWeight: 700, cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="refresh" /> إعادة المحاولة</button>
          </div>
        )}
        {M.data && !M.loading && (
          <>
            <div style={{ ...card, borderRadius: 18, padding: '20px 18px', position: 'relative' }}>
              <div lang="ar" style={{ fontFamily: font.quran, fontSize: M.font, lineHeight: 2.25, textAlign: 'justify', color: color.inkQuran }}>
                {M.data.ayahs.map((a) => {
                  const n = a.numberInSurah; const inR = n >= M.from && n <= M.to; const cur = M.cur === n; const fl = M.flash === n; const bm = M.bookmark === n;
                  const open = () => openSheet({ kind: 'ayah', n });
                  return (
                    <span key={n} id={'ayah-' + n} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }} role="button" tabIndex={0}
                      aria-label={`الآية ${n}${inR ? '، ضمن النطاق' : ''}${bm ? '، عليها علامة' : ''}`}
                      style={{ cursor: 'pointer', borderRadius: 8, padding: '2px 2px', background: cur ? '#CFE0CD' : fl ? '#F1E5C9' : inR ? '#E5EEE3' : 'transparent', boxShadow: `inset 0 -2px 0 ${cur ? color.gold : 'transparent'}` }}>
                      {a.text}{' '}
                      <span aria-hidden="true" style={{ display: 'inline-grid', placeItems: 'center', minWidth: '1.4em', height: '1.4em', borderRadius: '50%', border: `1px solid ${color.gold}`, fontFamily: font.latin, fontSize: '.45em', fontWeight: 700, verticalAlign: 'middle', background: bm ? color.gold : 'transparent', color: bm ? color.card : color.goldInk }}>{n}</span>{' '}
                    </span>
                  );
                })}
              </div>
            </div>
            <p style={muted(12, { margin: '10px 0 0', lineHeight: 1.7 })}>النص: رسم المصحف العثماني من مشروع Tanzil عبر واجهة alquran.cloud. الصوت: everyayah.com. اضغط على أي آية لتحديد النطاق أو وضع علامة.</p>
          </>
        )}
      </div>

      <div style={{ position: 'sticky', bottom: 0, background: color.card, borderTop: `1px solid ${color.border}`, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => (M.playing ? stopMushaf() : playAyah(M.from, 0))} aria-label={playL} disabled={!M.data}
          style={{ width: 52, height: 52, borderRadius: '50%', border: 'none', background: color.primary, color: color.ivory, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0, opacity: M.data ? 1 : 0.6 }}>
          <Icon name={M.playing ? 'pause' : 'play'} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{playL}</p>
          <p style={muted(12, { margin: '2px 0 0' })}>{M.playing ? `الآية ${M.cur} · التكرار ${M.rep + 1} من ${M.repeat}` : `النطاق ${M.from}–${M.to} · مشاري العفاسي`}</p>
        </div>
        <div role="group" aria-label="تكرار النطاق" style={{ display: 'flex', alignItems: 'center', gap: 2, border: `1px solid ${color.borderChip}`, borderRadius: 12, padding: 2 }}>
          <span style={{ color: color.muted, padding: '0 4px' }}><Icon name="repeat" size={18} /></span>
          {[1, 3, 5].map((n) => {
            const on = M.repeat === n;
            return (
              <button key={n} aria-pressed={on} aria-label={`تكرار ${n} مرات`} onClick={() => setM({ repeat: n })}
                style={{ minWidth: 36, minHeight: 40, border: 'none', borderRadius: 10, background: on ? color.primary : 'transparent', color: on ? color.ivory : color.primary, fontFamily: font.latin, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>×{n}</button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
