// Halqa load profile (pack prompt 25). Run only against an isolated environment seeded with `seed_load`:
//   k6 run -e BASE=http://localhost:8090 -e PASSWORD=... -e RACE_OCC=<id> loadtest/halqa.js
// Accounts: load-s0000..load-s0499 (students), load-t00..load-t09 (teachers), load-p0000.. (parents).
// Profile: students ramp 0→25 (pilot), hold, then 25→50, hold; 5 teachers and 5 parents throughout; one upload
// worker; and a 50-way race for one 1-seat slot. Think time 2–5 s between screens, like a person using the app.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.BASE || 'http://localhost:8090').replace(/\/$/, '') + '/api/v1/';
const PASSWORD = __ENV.PASSWORD || 'load-test-only-1';
const STUDENTS = +(__ENV.STUDENTS || 500), TEACHERS = +(__ENV.TEACHERS || 10), PARENTS = Math.floor(STUDENTS / 2);
const HOLD = __ENV.HOLD || '3m';
const raceWins = new Counter('race_bookings_won');
const raceRefused = new Counter('race_bookings_refused');
const businessRefusals = new Counter('business_refusals'); // 409 "full"/"overlap" etc. — expected, not errors
const audio = open('./sample.webm', 'b');

// A refused booking (409) is a correct answer, not a server failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

const NAMES = ['login', 'me', 'today', 'assignments', 'progress', 'surah', 'teachers', 'slots', 'book', 'lessons', 'lesson',
  'tests', 'unread', 'notifications', 't_dashboard', 't_students', 't_grading', 't_progress', 'p_children', 'p_weekly',
  'p_progress', 'upload', 'submit', 'race_book'];
const thresholds = { http_req_failed: ['rate<0.01'] };
for (const n of NAMES) thresholds[`http_req_duration{name:${n}}`] = ['p(95)<60000']; // per-endpoint rows in the summary

const minutes = (s) => (s.endsWith('m') ? +s.slice(0, -1) * 60 : +s.replace('s', ''));
const holdS = minutes(HOLD);
export const options = {
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max', 'count'],
  thresholds,
  scenarios: {
    students: { executor: 'ramping-vus', exec: 'student', startVUs: 0, gracefulRampDown: '20s',
      stages: [{ duration: '1m', target: 25 }, { duration: HOLD, target: 25 }, { duration: '1m', target: 50 }, { duration: HOLD, target: 50 },
        { duration: '20s', target: 0 }] },
    teachers: { executor: 'constant-vus', exec: 'teacher', vus: 5, duration: `${2 * holdS + 140}s` },
    parents: { executor: 'constant-vus', exec: 'parent', vus: 5, duration: `${2 * holdS + 140}s` },
    uploads: { executor: 'per-vu-iterations', exec: 'uploader', vus: 1, iterations: 15, startTime: '90s', maxDuration: `${2 * holdS}s` },
    race: { executor: 'per-vu-iterations', exec: 'racer', vus: 50, iterations: 1, startTime: `${holdS + 120}s`, maxDuration: '2m' },
  },
};

const pick = (n) => Math.floor(Math.random() * n);
const pad = (n, w) => String(n).padStart(w, '0');
const think = () => sleep(2 + Math.random() * 3);

function login(email) {
  const r = http.post(BASE + 'auth/login', JSON.stringify({ email, password: PASSWORD, client: 'native', device: 'k6' }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } });
  check(r, { 'login 200': (x) => x.status === 200 });
  const token = r.status === 200 ? r.json('token') : null;
  const user = r.status === 200 ? r.json('user') : null;
  return { user, params: (name, extra = {}) => ({ headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, tags: { name } }) };
}
const get = (s, path, name) => { const r = http.get(BASE + path, s.params(name)); check(r, { [`${name} ok`]: (x) => x.status === 200 }); return r; };

// Each virtual user is one person on one device: they sign in once and later visits restore the session (as the PWA
// does), with an occasional fresh sign-in. Password hashing (Argon2) is deliberately expensive, so signing in on
// every visit would overstate the load.
let mine = null;
function session(email) {
  if (!mine || !mine.user || Math.random() < 0.1) mine = login(email);
  return mine;
}

export function student() {
  // One app "visit": several screens with pauses.
  const s = session(`load-s${pad((__VU * 37) % STUDENTS, 4)}@example.test`);
  if (!s.user) { sleep(5); return; }
  get(s, 'me', 'me'); get(s, 'today', 'today'); get(s, 'notifications/unread', 'unread'); think();
  get(s, 'assignments', 'assignments'); think();
  get(s, `quran/surahs/${[1, 18, 36, 67, 78, 2][pick(6)]}`, 'surah'); think();
  get(s, 'progress/me', 'progress'); think();
  if (Math.random() < 0.5) {
    const teachers = get(s, 'teachers', 'teachers');
    const list = teachers.status === 200 ? (teachers.json('results') || teachers.json()) : [];
    if (list.length) {
      const t = list[pick(list.length)];
      const slots = get(s, `teachers/${t.id}/slots`, 'slots');
      const open = slots.status === 200 ? (slots.json('results') || slots.json()).filter((x) => (x.seats_left ?? 1) > 0) : [];
      think();
      if (open.length && Math.random() < 0.3) {
        const occ = open[pick(open.length)];
        const r = http.post(BASE + 'bookings', JSON.stringify({ occurrence: occ.id }), s.params('book', { 'Idempotency-Key': `k6-${__VU}-${__ITER}` }));
        if (r.status === 409) businessRefusals.add(1); else check(r, { 'book 201': (x) => x.status === 201 || x.status === 200 });
      }
    }
  } else {
    const lessons = get(s, 'lessons', 'lessons');
    const list = lessons.status === 200 ? (lessons.json('results') || lessons.json()) : [];
    if (list.length) { think(); get(s, `lessons/${list[pick(list.length)].id}`, 'lesson'); }
    get(s, 'tests', 'tests');
  }
  think(); get(s, 'notifications', 'notifications'); think();
}

export function teacher() {
  const s = session(`load-t${pad(__VU % TEACHERS, 2)}@example.test`);
  if (!s.user) { sleep(5); return; }
  get(s, 'teacher/dashboard', 't_dashboard'); think();
  const st = get(s, 'teacher/students', 't_students');
  const list = st.status === 200 ? (st.json('results') || st.json()) : [];
  think(); get(s, 'teacher/grading', 't_grading');
  for (let i = 0; i < 3 && list.length; i++) { think(); get(s, `teacher/students/${list[pick(list.length)].id}/progress`, 't_progress'); }
  think();
}

export function parent() {
  const s = session(`load-p${pad((__VU * 13) % PARENTS, 4)}@example.test`);
  if (!s.user) { sleep(5); return; }
  const ch = get(s, 'parent/children', 'p_children');
  const list = ch.status === 200 ? (ch.json('results') || ch.json()) : [];
  think(); get(s, 'parent/weekly-summary', 'p_weekly');
  if (list.length) { think(); get(s, `parent/children/${(list[0].student || list[0]).id}/progress`, 'p_progress'); }
  think();
}

export function uploader() {
  // A smaller sample of the heaviest write path: a ~200 KB recording, then submitting it for a task.
  const s = login(`load-s${pad(__ITER * 7 % STUDENTS, 4)}@example.test`);
  if (!s.user) return;
  const up = http.post(BASE + 'media/recitations', { file: http.file(audio, 'r.webm', 'audio/webm'), duration_seconds: '60' },
    { headers: { Authorization: s.params('upload').headers.Authorization }, tags: { name: 'upload' } });
  check(up, { 'upload 201': (x) => x.status === 201 });
  const tasks = get(s, 'assignments', 'assignments');
  const open = tasks.status === 200 ? (tasks.json('results') || tasks.json()).filter((t) => ['not_started', 'in_progress'].includes(t.status)) : [];
  if (up.status === 201 && open.length) {
    const r = http.post(BASE + `assignments/${open[0].id}/submissions`, JSON.stringify({ media: up.json('id') }),
      s.params('submit', { 'Idempotency-Key': `k6-up-${__ITER}` }));
    check(r, { 'submit 201': (x) => x.status === 201 });
  }
  sleep(5);
}

export function racer() {
  // 50 different students, already signed in, press "book" for the same 1-seat slot at the same moment.
  const s = login(`load-s${pad(STUDENTS - 1 - (__VU % 50), 4)}@example.test`);
  if (!s.user) return;
  const at = Math.ceil(Date.now() / 10000) * 10000 + 10000; // next 10-second boundary, at least 10 s away
  sleep((at - Date.now()) / 1000);
  const r = http.post(BASE + 'bookings', JSON.stringify({ occurrence: +__ENV.RACE_OCC }), s.params('race_book', { 'Idempotency-Key': `race-${__VU}` }));
  if (r.status === 201 || r.status === 200) raceWins.add(1); else if (r.status === 409) raceRefused.add(1);
  check(r, { 'race answered 201 or 409': (x) => [200, 201, 409].includes(x.status) });
}

export function handleSummary(data) {
  const m = data.metrics, rows = [];
  for (const n of NAMES) {
    const t = m[`http_req_duration{name:${n}}`];
    if (t && t.values.count) rows.push(`| ${n} | ${t.values.count} | ${t.values.med.toFixed(0)} | ${t.values['p(95)'].toFixed(0)} | ${t.values['p(99)'].toFixed(0)} | ${t.values.max.toFixed(0)} |`);
  }
  const all = m.http_req_duration.values, failed = m.http_req_failed.values;
  const md = [
    `Requests: ${m.http_reqs.values.count} (${m.http_reqs.values.rate.toFixed(1)}/s). Failed (5xx/timeouts/unexpected): ${(failed.rate * 100).toFixed(2)}%. ` +
    `All requests p50/p95/p99: ${all.med.toFixed(0)}/${all['p(95)'].toFixed(0)}/${all['p(99)'].toFixed(0)} ms.`,
    `Booking race for one seat: won ${m.race_bookings_won ? m.race_bookings_won.values.count : 0}, refused ${m.race_bookings_refused ? m.race_bookings_refused.values.count : 0}. ` +
    `Ordinary booking refusals (full/overlap): ${m.business_refusals ? m.business_refusals.values.count : 0}. Checks passed: ${(m.checks.values.rate * 100).toFixed(2)}%.`,
    '', '| endpoint | requests | p50 ms | p95 ms | p99 ms | max ms |', '| --- | --- | --- | --- | --- | --- |', ...rows, '',
  ].join('\n');
  return { stdout: md, 'loadtest-summary.md': md, 'loadtest-summary.json': JSON.stringify(data) };
}
