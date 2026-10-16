# Load test (pack prompt 25)

"Hundreds of registered students" is the product target. This page records what was **measured**, in which
environment, and the range that is safe to claim. Nothing here is extrapolated beyond the tested configuration.

## Environment (workflow **Load test**, run by hand from GitHub Actions)

| Part | Tested | Production |
| --- | --- | --- |
| App | The production Docker image of the tested commit, `--cpus 1 --memory 512m`, gunicorn 2 workers × 4 threads | Cloud Run, 1 vCPU, 512 MiB, same image and server settings, 0–2 instances |
| Database | PostgreSQL 16 on the same runner (`pg_stat_statements` on), ~1 ms away | Neon (Frankfurt) from europe-west1: adds network latency per query; free compute is smaller |
| Object storage | moto (S3 API) on the runner | Cloudflare R2. Measured separately by the smoke test after every deploy: 200 KB upload 713–785 ms, signed read 316–835 ms |
| Client | k6 v0.54 on the same runner | Phones over mobile networks |

Rate limits per address are raised for the test, because every virtual user comes from one machine. Lockout
and all other rules stay on.

## Dataset (`manage.py seed_load`)

- 500 students, 10 teachers (50 students each) and 250 parents (one child each).
- 3,000 tasks, 3 published courses (15 lessons) and 1 quiz.
- 1,960 session slots over 2 weeks, plus one 1-seat slot for the booking race.
- The verified Quran text (Tanzil, 6,236 ayahs).

## Profile (`loadtest/halqa.js`)

- **Students:** ramp to **25 active** over 1 min, hold 3 min, ramp to **50 active** over 1 min, hold 3 min. A
  "visit" is: Today, unread count, tasks, a surah, progress, then either teacher slots (30 % of those also book)
  or lessons and quizzes, then the inbox. There are 2–5 s pauses between screens, sessions are restored like the
  PWA does, and 10 % of visits sign in afresh.
- **Teachers:** 5 throughout (dashboard, students, grading queue, three student progress pages).
- **Parents:** 5 throughout (children, weekly summary, child progress).
- **Uploads:** 15 recordings of ~200 KB, each submitted for a task.
- **Booking race:** 50 different students, already signed in, book the same 1-seat slot in the same instant.

## Results

### Run 1: 16 October 2026, main at `84e2807`

| Measure | Result |
| --- | --- |
| Requests | 8,666 (16.7/s) |
| Failed (5xx, timeouts, unexpected status) | **0.00 %** |
| Latency, all requests: p50 / p95 / p99 | **7 / 23 / 310 ms** |
| Checks passed | 100 % |
| Booking race (50 students, 1 seat) | **1 booked, 49 refused** ("slot taken") — no double booking |
| Container | 0 restarts, not OOM-killed |
| Slowest frequent queries | Slot lookup 4.4 ms mean (max 61 ms); rate-limit cache update 0.6 ms mean |

Per-endpoint p95/p99 and CPU/memory peaks are in each run's job summary and annotations.

## Fixes made because of measurements

1. **Password hashing memory.** Django's Argon2 default needs ~100 MB and 139 ms per hash (measured). Eight
   concurrent sign-ins could need ~800 MB on a 512 MB instance. It now uses Argon2id with OWASP parameters
   (19 MiB). Old hashes upgrade at the next sign-in.
2. **Teacher dashboard N+1.** The falling-scores rule ran one query per student (56 queries for 50 students).
   It is now one window query (7 queries), with a test that the count does not grow with class size.

## What can be claimed

- On one Cloud Run-sized instance, **50 simultaneously active students plus 10 staff/parents** were served with no
  errors and sub-second p99. Booking stays correct under a 50-way race. "500 registered students" is supported for
  this activity level, since most registered users are not active at the same moment.
- **Not yet measured:** Neon's network latency and compute limits under this load, Cloud Run cold starts, more
  than 50 active users, and real mobile networks. Before promising more, run the same profile against a staging
  Cloud Run service with its own Neon branch.
