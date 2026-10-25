/** How a person's name is shown (owner request, 25 October 2026): every teacher's name carries the Arabic title —
 *  «الشيخ» for a man, «الأستاذة» for a woman. The same rule runs on the server (backend/apps/accounts/display.py),
 *  which already sends display fields (`teacher_name`, `display_name`, notifications) formatted; this file covers
 *  names the app holds as raw user objects. The stored name is never changed: editable fields use `full_name`.
 *  Titles already typed into a teacher's name are removed first (never «الشيخ الشيخ …»). Students, parents and
 *  admin-only accounts are shown as they are; a teacher whose gender is not set is shown without a guessed title. */
export type Gender = 'male' | 'female' | '' | null | undefined;
type Person = { full_name: string; role?: string; gender?: Gender; status?: string; display_name?: string };

const TITLE: Record<string, string> = { male: 'الشيخ', female: 'الأستاذة' };
const LEADING = /^\s*(?:(?:ال)?أستاذة?|(?:ال)?استاذة?|(?:ال)?شيخة?|أ\s*[./]|أ\/)\s*/u;

export function stripTitle(name: string): string {
  let n = (name ?? '').trim();
  for (;;) {
    const m = n.match(LEADING);
    if (!m || !n.slice(m[0].length).trim()) return n;
    n = n.slice(m[0].length).trim();
  }
}

/** «الشيخ أحمد محمد» / «الأستاذة مريم أحمد»; the plain stored name when the gender is not set. */
export function formatTeacherName(t: { full_name: string; gender?: Gender }): string {
  const title = TITLE[t.gender ?? ''];
  return title ? `${title} ${stripTitle(t.full_name)}` : (t.full_name ?? '').trim();
}

/** Any account's shown name: the server's `display_name` when sent, else teachers formatted, everyone else as stored. */
export function nameOf(u: Person): string {
  if (u.display_name) return u.display_name;
  return u.role === 'teacher' && u.status !== 'deleted' ? formatTeacherName(u) : u.full_name;
}

/** First letter for an avatar, ignoring a title. */
export const initialOf = (name: string) => stripTitle(name).charAt(0) || '؟';
