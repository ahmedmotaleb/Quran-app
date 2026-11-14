/** Meeting links (owner request, 14 Nov 2026). Mirrors backend apps/scheduling/meeting.py: keep the two in step.
 *  normalizeMeetingUrl: «meet.google.com/abc-defg-hij» → «https://meet.google.com/abc-defg-hij» (once), http → https,
 *  spaces and invisible characters removed; the path, meeting ID and query are kept. Other schemes are refused.
 *  The server checks again (known meeting hosts only, no host/sign-in links) and stores what it normalized. */
const PROVIDERS: [string, string[], string][] = [
  ['google_meet', ['meet.google.com'], 'Google Meet'],
  ['zoom', ['zoom.us'], 'Zoom'],
  ['jitsi', ['meet.jit.si'], 'Jitsi Meet'],
  ['teams', ['teams.microsoft.com', 'teams.live.com'], 'Microsoft Teams'],
];
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿ ]/g;

export class MeetingLinkError extends Error {}

export function normalizeMeetingUrl(raw: string): string {
  let u = (raw || '').replace(INVISIBLE, '').trim().replace(/^["'<>«»]+|["'<>«»]+$/g, '').trim();
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (m && u.slice(m[0].length, m[0].length + 2) === '//') {
    const scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') throw new MeetingLinkError('الرابط غير صالح.');
    u = 'https' + u.slice(m[1].length);
  } else if (m && !m[1].includes('.')) {
    throw new MeetingLinkError('الرابط غير صالح.');        // javascript:, data:, mailto:…
  } else {
    u = 'https://' + u;
  }
  return u;
}

/** The provider of a safe join link, or null (https, a known meeting host, no credentials in it). */
export function meetingProvider(url: string): { key: string; label: string } | null {
  let p: URL;
  try { p = new URL(url); } catch { return null; }
  if (p.protocol !== 'https:' || p.username || p.password || (p.port && p.port !== '443')) return null;
  const host = p.hostname.toLowerCase();
  const hit = PROVIDERS.find(([, hosts]) => hosts.some((h) => host === h || host.endsWith('.' + h)));
  return hit ? { key: hit[0], label: hit[2] } : null;
}

/** Opens a meeting link outside HALQA: the Meet/Zoom/Teams app when installed (Android hands the https link to it),
 *  otherwise a browser tab. Only safe meeting links are opened; HALQA is never navigated away. */
export function openMeeting(url: string): boolean {
  if (!meetingProvider(url)) return false;
  window.open(url, '_blank', 'noopener,noreferrer');   // with noopener the return value is null even on success
  return true;
}
