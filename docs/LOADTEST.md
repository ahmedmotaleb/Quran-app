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

### Run 2: 16 October 2026, main at `06bc3f4` (after the E2E and logout changes)

| Measure | Result |
| --- | --- |
| Requests | 8,639 (16.6/s), **0.00 %** failed, checks 100 % |
| Latency, all requests: p50 / p95 / p99 | **7 / 21 / 265 ms** |
| Booking race | **1 booked, 49 refused**; 4 ordinary "slot full/overlap" refusals during browsing |
| App CPU (1 vCPU) | max 62 %, average 14 % (79 five-second samples) |
| App memory | max **343 MiB of 512**; 0 restarts, not OOM-killed |
| Database | max 9 connections, 0 waiting locks; slowest frequent query 3.1 ms mean (slot lookup) |

Per endpoint (requests, then p50 / p95 / p99 in ms):

| Endpoint | n | p50 | p95 | p99 | | Endpoint | n | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sign-in | 226 | 28 | 1,425 | 1,673 | | lessons | 393 | 6 | 8 | 11 |
| me | 711 | 4 | 6 | 9 | | lesson | 393 | 8 | 11 | 13 |
| today | 711 | 12 | 16 | 23 | | tests | 393 | 5 | 7 | 10 |
| assignments | 726 | 7 | 10 | 14 | | notifications | 709 | 7 | 10 | 14 |
| progress | 711 | 15 | 22 | 28 | | teacher dashboard | 123 | 14 | 19 | 107 |
| surah text | 711 | 6 | 8 | 12 | | teacher student progress | 369 | 16 | 21 | 28 |
| teachers | 318 | 6 | 8 | 11 | | parent weekly summary | 236 | 17 | 26 | 33 |
| teacher slots | 318 | 16 | 20 | 23 | | parent child progress | 236 | 17 | 24 | 30 |
| book | 82 | 17 | 23 | 25 | | upload 200 KB | 15 | 16 | 71 | 167 |
| race booking (50 at once) | 50 | 174 | 370 | 390 | | submit | 15 | 14 | 18 | 19 |

Sign-in is the only slow endpoint, by design. Password hashing is deliberately expensive, and its p95 comes from
the burst of 50 simultaneous sign-ins before the race. Everyday screens stay under 30 ms at p99.

## Fixes made because of measurements

1. **Password hashing memory.** Django's Argon2 default needs ~100 MB and 139 ms per hash (measured). Eight
   concurrent sign-ins could need ~800 MB on a 512 MB instance. It now uses Argon2id with OWASP parameters
   (19 MiB). Old hashes upgrade at the next sign-in.
2. **Teacher dashboard N+1.** The falling-scores rule ran one query per student (56 queries for 50 students).
   It is now one window query (7 queries), with a test that the count does not grow with class size.

## Staging runs (PROMPT 47)

The same profile runs against the real staging Cloud Run service and its own Neon database: **Actions → Load test →
target `staging`, steps e.g. `50,100,200`**. Go higher only if the previous step stayed healthy. The workflow:

- seeds the staging database with `seed_load` (later runs use `--refresh`, which adds slots and a new race slot) and
  imports the verified Quran text if staging has none;
- raises the per-address rate limits on staging for the run only, because every virtual user comes from one runner.
  It restores them afterwards, even if the run fails;
- reports k6 error rate and p50/p95/p99 per endpoint, Cloud Run instances, CPU and memory (Cloud Monitoring), database
  connections (sampled every 10 s), and booking-race correctness. The run fails unless exactly 1 booking is confirmed
  on the 1-seat slot;
- skips the upload worker when staging has no recordings bucket (the report says so).

### Staging run 1: 23 October 2026, main at `ba31e1d`+ (run 40039533416)

Real staging Cloud Run (1 vCPU / 512 MiB, max 2 instances, same settings as production) with its own Neon database
(Frankfurt); k6 on a GitHub-hosted runner. Steps: **50 → 100 → 200 active students**, 3 min each, plus 5 teachers,
5 parents and a 50-way booking race. Uploads skipped (staging has no recordings bucket).

| Measure | Result (whole run) |
| --- | --- |
| Requests | 29,986 (39.5/s) |
| Failed (5xx, timeouts, unexpected) | **0.00 %**; all checks passed |
| Latency p50 / p95 / p99 | 263 / 1,517 / 2,500 ms |
| Booking race (1 seat, 50 at once) | **1 won, 49 refused**; 1 confirmed booking in the database |
| Cloud Run instances | 2 (the configured maximum was reached) |
| CPU / memory (p99 per minute) | 80 % / 69 % |
| Database connections (max) | 17 |

Slowest endpoints at p95 (ms): book 2,083 · progress 1,700 · login 1,658 · lesson 1,608 · assignments 1,545 ·
notifications 1,495; p99 up to ~3.2 s for booking. Teacher grading p95 1,009 ms, parent weekly summary 1,416 ms.

Reading: up to 200 simultaneously active students on the free-tier-sized setup worked without errors and kept booking
correct, but at the top step both instances were busy (CPU 80 %) and p95 rose to ~1.5 s. 200 is the measured
ceiling for the current limits (max 2 instances); going further needs more instances (a cost decision) and a new
run. Figures are for the whole run; per-step figures are not separated in this report.

## What can be claimed

- On one Cloud Run-sized instance, **50 simultaneously active students plus 10 staff/parents** were served with no
  errors, sub-second p99, and CPU and memory to spare (62 % / 343 MiB peaks). Booking stays correct under a 50-way race. "500 registered students" is supported for
  this activity level, since most registered users are not active at the same moment.
- **Not yet measured:** Neon's network latency and compute limits under this load, Cloud Run cold starts, more
  than 50 active users, and real mobile networks. Before promising more, run the same profile against a staging
  Cloud Run service with its own Neon branch.
