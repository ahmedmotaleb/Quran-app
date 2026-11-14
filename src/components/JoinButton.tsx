/** «انضم إلى الجلسة» — one tap opens the session's meeting (Google Meet, Zoom, Teams or Jitsi) in its app or the
 *  browser (owner request, 14 Nov 2026).
 *  - Student: the link is asked from the server at the tap (bookings/<id>/join). Only the booked student gets it, and
 *    only while the join window is open; it is never stored on the device or shown in lists.
 *  - Teacher: their own session's link (already theirs).
 *  - Disabled, with the reason, when there is no link yet or the session is not open for joining. */
import { useState } from 'react';
import { color } from '@/theme/tokens';
import { Icon } from '@/components/Icon';
import { primaryBtn } from '@/components/ui';
import { joinBooking } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { meetingProvider, openMeeting } from '@/lib/meeting';

type Props = { size?: number; reason?: string; light?: boolean } & (
  | { booking: number; canJoin: boolean; hasLink: boolean; url?: undefined }
  | { url: string; booking?: undefined; canJoin?: undefined; hasLink?: undefined }
);

export function JoinButton(p: Props) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const size = p.size ?? 52;
  const teacherUrl = p.url !== undefined ? p.url : null;
  const valid = teacherUrl !== null ? !!meetingProvider(teacherUrl) : p.canJoin && p.hasLink;
  const why = teacherUrl !== null ? (teacherUrl ? 'الرابط غير صالح' : 'أضف رابط الجلسة أولًا')
    : !p.hasLink ? 'لم يُضف رابط الجلسة بعد' : (p.reason ?? 'يُفتح الدخول قبل الموعد بقليل');

  const go = async () => {
    setErr(null);
    if (teacherUrl !== null) { if (!openMeeting(teacherUrl)) setErr('الرابط غير صالح.'); return; }
    setBusy(true);
    try {
      const r = await joinBooking(p.booking!);
      if (!openMeeting(r.url)) setErr('الرابط غير صالح.');
      setFallback(r.url);                // if the phone blocked the new window, a plain link stays tappable
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'تعذّر الاتصال. تحقق من الإنترنت وحاول مرة أخرى.');
    } finally { setBusy(false); }
  };

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
      <button onClick={() => void go()} disabled={!valid || busy} aria-busy={busy} data-testid="join-session"
        aria-label={valid ? 'انضم إلى الجلسة' : `انضم إلى الجلسة (غير متاح: ${why})`}
        style={primaryBtn(size, 16, { fontWeight: 800, opacity: valid ? 1 : 0.55, ...(p.light ? { background: color.ivory, color: color.primary } : {}) })}>
        <Icon name="video" /> {busy ? 'جارٍ فتح الجلسة…' : 'انضم إلى الجلسة'}
      </button>
      {!valid && <span style={{ fontSize: 12, color: p.light ? color.liveSub : color.muted, textAlign: 'center' }}>{why}</span>}
      {err && <span role="alert" style={{ fontSize: 13, color: p.light ? color.ivory : color.dangerInk }}>{err}</span>}
      {fallback && <a href={fallback} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: p.light ? color.ivory : color.primary, fontWeight: 700, textAlign: 'center' }}>لم تُفتح الجلسة؟ اضغط هنا</a>}
    </span>
  );
}
