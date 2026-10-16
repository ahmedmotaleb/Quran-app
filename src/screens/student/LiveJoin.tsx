/** Live mode: a session is held in the meeting service the teacher chose (Google Meet, Zoom, Jitsi or Teams; pack
 *  prompt 19). The app never shows a simulated call. The booked student asks the server for the link, which is
 *  only given while the join window is open, and the link opens in the meeting app or a new tab. Attendance stays
 *  the teacher's decision. */
import { useEffect, useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { BackHeader, card, muted, primaryBtn } from '@/components/ui';
import { joinBooking } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { rangeL, tzOf } from '@/lib/format';
import { dayLabel, fmtTime } from '@/lib/time';
import { useApp } from '@/store/store';

export default function LiveJoin() {
  const s = useApp(); const tz = tzOf(s.tz).iana;
  const x = s.sessions.find((y) => y.id === s.params.id);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; label: string } | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  if (!x?.startsAt || !x.endsAt) return <><BackHeader title="الجلسة" sticky /><p style={muted(15, { padding: 24, textAlign: 'center' })}>لم نجد هذه الجلسة.</p></>;

  const opens = new Date(x.startsAt).getTime() - s.pub.join_minutes * 60_000;
  const ended = now > new Date(x.endsAt).getTime();
  const cancelled = x.status === 'cancelled';
  const open = !ended && !cancelled && now >= opens;
  const task = x.task ? s.tasks.find((t) => t.id === x.task) : undefined;

  const join = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await joinBooking(Number(x.id));
      setLink({ url: r.url, label: r.provider_label });
      // Opens the meeting app or a new tab; if the browser blocks it, the link below stays tappable.
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'تعذّر الاتصال. تحقق من الإنترنت وحاول مرة أخرى.');
    } finally { setBusy(false); }
  };

  return (
    <div>
      <BackHeader title="الجلسة المباشرة" sticky />
      <div style={{ padding: '4px 16px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{x.teacherName}</p>
          <p style={muted(15)}>{dayLabel(x.startsAt, tz)} · {fmtTime(x.startsAt, tz)} · {x.dur} دقيقة · {x.type}</p>
          {task && <p style={{ margin: '4px 0 0', fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="book" size={18} /> {task.title} · {rangeL(task)}</p>}
        </div>

        {cancelled ? <Note icon="alert" text="أُلغيت هذه الجلسة." />
          : ended ? <Note icon="check" text="انتهت هذه الجلسة. يسجّل معلمك الحضور." />
          : !open ? <Note icon="clock" text={`يُفتح الدخول قبل البداية بـ ${s.pub.join_minutes} دقائق (${fmtTime(new Date(opens).toISOString(), tz)}).`} />
          : !x.hasLink ? <Note icon="clock" text="لم يضف معلمك رابط الجلسة بعد. سيظهر هنا عند إضافته." />
          : null}

        {open && (
          <button onClick={join} disabled={busy} aria-busy={busy} style={primaryBtn(54, 17, { fontWeight: 800, opacity: busy ? 0.7 : 1 })}>
            <Icon name="video" /> {busy ? 'جارٍ فتح الجلسة…' : 'ادخل الجلسة'}
          </button>
        )}
        {err && <p role="alert" style={{ margin: 0, fontSize: 14, color: color.dangerInk }}>{err}</p>}
        {link && (
          <p style={muted(14)}>
            إن لم تُفتح الجلسة تلقائيًا: <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ color: color.primary, fontWeight: 700 }}>افتح {link.label || 'رابط الجلسة'}</a>
          </p>
        )}
        <p style={muted(13)}>تُعقد الجلسة في خدمة الاجتماعات التي اختارها معلمك. لا يُسجَّل الصوت أو الصورة في الحلقة، والحضور يسجّله المعلم.</p>
      </div>
    </div>
  );
}

function Note({ icon, text }: { icon: 'alert' | 'check' | 'clock'; text: string }) {
  return <p role="status" style={{ ...card, margin: 0, padding: 14, fontSize: 15, display: 'flex', gap: 8, alignItems: 'center' }}><Icon name={icon} size={20} /> {text}</p>;
}
