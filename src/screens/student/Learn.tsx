import { color, font } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackHeader, PlayButton, PlayerBar, card, outlineBtn, primaryBtn, usePlayer } from '@/components/ui';
import { LESSONS, QUIZ } from '@/data/demo';
import { LessonPageLive, QuizPageLive } from './LearnLive';
import { back, openSheet, quizUnanswered, replace, setState, toast, up, useApp } from '@/store/store';

export function LessonPage() {
  const s = useApp();
  if (s.liveMode) return <LessonPageLive />;
  const l = LESSONS.find((x) => x.id === s.params.id) || LESSONS[0];
  const nx = LESSONS[(LESSONS.indexOf(l) + 1) % LESSONS.length];
  const dur = parseInt(l.dur, 10) * 60;
  const key = 'lesson-' + l.id;
  const pl = usePlayer(key, dur, null);
  const done = !!s.lessonDone[l.id];
  return (
    <div>
      <BackHeader title="الدرس" />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {l.media === 'video' && (
          <div style={{ aspectRatio: '16/9', borderRadius: 18, background: color.primary, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: color.ivory, position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', width: 260, height: 260, borderRadius: '50%', border: '30px solid rgba(216,229,215,.07)', left: -90, bottom: -140 }} />
            <span style={{ position: 'relative' }}><PlayButton playing={pl.playing} onClick={pl.toggle} size={64} bg={color.ivory} fg={color.primary} /></span>
            <span style={{ fontSize: 12, color: color.liveSub, position: 'relative' }}>مكان مشغّل الفيديو</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 13, color: color.muted, fontWeight: 700 }}>{l.topicL} · {l.level} · {l.dur}</p>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{l.title}</h2>
        </div>
        <div style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <PlayerBar k={key} dur={dur} showButton={l.media === 'audio'} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>المواد المرفقة</p>
          {[{ name: 'ملخص الدرس', meta: 'PDF · 2 صفحات' }, { name: 'تمارين تطبيقية', meta: 'PDF · 4 صفحات' }].map((f) => (
            <button key={f.name} onClick={() => toast('تنزيل تجريبي — يحتاج ربطًا بالتخزين', 'file')}
              style={{ minHeight: 56, padding: '8px 14px', borderRadius: 14, border: `1px solid ${color.border}`, background: color.card, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
              <span style={{ color: color.primary }}><Icon name="file" /></span>
              <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{f.name}</span><span style={{ display: 'block', fontSize: 12, color: color.muted }}>{f.meta}</span></span>
              <span style={{ color: color.primary }}><Icon name="upload" /></span>
            </button>
          ))}
        </div>
        <button onClick={() => { setState({ lessonDone: { ...s.lessonDone, [l.id]: true } }); toast('أحسنت، سُجّل الدرس كمكتمل'); }} disabled={done} style={primaryBtn(52, 16, { opacity: done ? 0.85 : 1 })}>
          <Icon name="check" /> {done ? 'أكملت هذا الدرس' : 'علّم الدرس كمكتمل'}
        </button>
        <button onClick={() => replace('lesson', { id: nx.id })} style={{ minHeight: 56, padding: '8px 14px', borderRadius: 14, border: `1px dashed ${color.borderStrong}`, background: 'transparent', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'right', cursor: 'pointer', color: color.ink }}>
          <span style={{ flex: 1 }}><span style={{ display: 'block', fontSize: 12, color: color.muted }}>التالي في المسار</span><span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{nx.title}</span></span>
          <span style={{ color: color.primary }}><Icon name="chevL" /></span>
        </button>
      </div>
    </div>
  );
}

export function QuizPage() {
  const live = useApp((s) => s.liveMode);
  const Q = useApp((s) => s.quiz);
  if (live) return <QuizPageLive />;
  if (!Q) return <BackHeader title="اختبار أحكام النون الساكنة" />;
  const qq = QUIZ[Q.idx];
  const mcq = QUIZ.filter((x) => !x.rec);
  const correct = mcq.filter((x, i) => Q.ans[i] === x.a).length;
  const isLast = Q.idx === QUIZ.length - 1;
  const submit = () => {
    const un = quizUnanswered(Q);
    openSheet({
      kind: 'confirm', title: 'تسليم الاختبار؟', body: un ? `لم تُجب عن ${un} من الأسئلة. هل تريد التسليم على أي حال؟` : 'لن تتمكن من تعديل إجاباتك بعد التسليم.', ok: 'سلّم الاختبار',
      onOk: () => setState((st) => ({ sheet: null, quiz: { ...st.quiz!, phase: 'result', submitted: true } })),
    });
  };

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <BackHeader title="اختبار أحكام النون الساكنة" />
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        {Q.phase === 'intro' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
            <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>قبل أن تبدأ</p>
              <ul style={{ margin: 0, padding: '0 20px 0 0', fontSize: 15, lineHeight: 2, color: color.body }}>
                <li>5 أسئلة: 4 اختيار من متعدد، وسؤال تلاوة واحد.</li><li>المدة المقترحة 10 دقائق، دون مؤقت إلزامي.</li>
                <li>يمكنك التنقل بين الأسئلة قبل التسليم.</li><li>سؤال التلاوة يقيّمه معلمك، وتظهر نتيجته لاحقًا.</li>
              </ul>
            </div>
            <button onClick={() => up('quiz', { phase: 'q' })} style={primaryBtn(54, 17, { marginTop: 'auto' })}>ابدأ الاختبار</button>
          </div>
        )}
        {Q.phase === 'q' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
            <div style={{ display: 'flex', gap: 6 }} role="navigation" aria-label="الأسئلة">
              {QUIZ.map((x, i) => {
                const cur = i === Q.idx; const answered = Q.ans[i] !== undefined || (x.rec && Q.rec);
                return <button key={i} onClick={() => up('quiz', { idx: i })} aria-label={`السؤال ${i + 1}`} aria-current={cur ? 'step' : undefined}
                  style={{ flex: 1, minHeight: 44, borderRadius: 10, border: `1.5px solid ${color.borderStrong}`, background: cur ? color.primary : answered ? color.sage : color.card, color: cur ? color.ivory : color.primary, fontFamily: font.latin, fontWeight: 700, cursor: 'pointer' }}>{i + 1}</button>;
              })}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: color.muted, fontWeight: 700 }}>السؤال {Q.idx + 1} من {QUIZ.length}</p>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, lineHeight: 1.6 }}>{qq.q}</h2>
            {!qq.rec && (
              <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {qq.o!.map((o, i) => {
                  const on = Q.ans[Q.idx] === i;
                  return (
                    <button key={i} role="radio" aria-checked={on} onClick={() => up('quiz', { ans: { ...Q.ans, [Q.idx]: i } })}
                      style={{ minHeight: 56, padding: '0 16px', borderRadius: 14, border: `1.5px solid ${on ? color.primary : color.borderChip}`, background: on ? color.sageTint : color.card, display: 'flex', alignItems: 'center', gap: 12, fontSize: 16, fontWeight: 700, color: color.ink, cursor: 'pointer', textAlign: 'right' }}>
                      <span style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${color.primary}`, display: 'grid', placeItems: 'center', flexShrink: 0 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: on ? color.primary : 'transparent' }} /></span>{o}
                    </button>
                  );
                })}
              </div>
            )}
            {qq.rec && (
              <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center' }}>
                {Q.rec && <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: color.primary, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="check" /> أُرفق التسجيل (تجريبي)</p>}
                <button onClick={() => { up('quiz', { rec: true }); toast('أُرفق تسجيل تجريبي للسؤال'); }} style={primaryBtn(52, 16, { padding: '0 22px' })}><Icon name="mic" /> سجّل إجابتك</button>
                <p style={{ margin: 0, fontSize: 13, color: color.muted }}>يقيّم المعلم هذا السؤال بعد التسليم.</p>
              </div>
            )}
            <div style={{ marginTop: 'auto', display: 'flex', gap: 10 }}>
              {Q.idx > 0 && <button onClick={() => up('quiz', { idx: Q.idx - 1 })} style={outlineBtn(54, 16, { padding: '0 20px' })}>السابق</button>}
              {!isLast && <button onClick={() => up('quiz', { idx: Q.idx + 1 })} style={primaryBtn(54, 17, { flex: 1 })}>التالي</button>}
              {isLast && <button onClick={submit} style={primaryBtn(54, 17, { flex: 1 })}>تسليم الاختبار</button>}
            </div>
          </div>
        )}
        {Q.phase === 'result' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: color.primary, color: color.ivory, borderRadius: 20, padding: 20, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ margin: 0, fontSize: 14, color: color.sage }}>أسئلة الاختيار</p>
              <p style={{ margin: 0, fontSize: 34, fontWeight: 800 }}>{correct} من {mcq.length}</p>
              <p style={{ margin: 0, fontSize: 14, color: color.sage, display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}><Icon name="clock" size={18} /> سؤال التلاوة بانتظار تقييم المعلم</p>
            </div>
            {mcq.map((x, i) => {
              const ok = Q.ans[i] === x.a; const c = ok ? color.primary : color.dangerInk;
              return (
                <div key={i} style={{ ...card, borderRadius: 14, padding: '12px 14px', display: 'flex', gap: 10 }}>
                  <span style={{ color: c, flexShrink: 0, marginTop: 2 }}><Icon name={ok ? 'check' : 'x'} size={18} /></span>
                  <div>
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{x.q}</p>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: c, fontWeight: 700 }}>{ok ? 'إجابة صحيحة' : 'إجابة غير صحيحة'}</p>
                    <p style={{ margin: '2px 0 0', fontSize: 13, color: color.muted }}>الإجابة الصحيحة: {x.o![x.a!]}</p>
                  </div>
                </div>
              );
            })}
            <button onClick={back} style={primaryBtn()}>العودة إلى الاختبارات</button>
          </div>
        )}
      </div>
    </div>
  );
}
