# Monitoring and alerts

Set up once with `bash deploy/gcp-ops.sh` in Cloud Shell (asks for the alert email). Everything uses Google
Cloud's free allowances. Logs are JSON lines with a `severity`, a `request_id` (also shown to the user in error
messages), and only safe context. Passwords, tokens, codes, secrets, keys and signed media links are never logged
(`apps/core/logging.py` redacts those keys; `test_auth.py` and `test_health.py` check reset links and email
addresses do not appear).

## Alerts (email to the owner)

| Alert | Fires when | Signal | First action |
| --- | --- | --- | --- |
| App unreachable | `/api/health` fails from 2 of 3 regions (checked every 15 min) | Uptime check | Cloud Run → halqa → Revisions/Logs; roll back the revision if a deploy broke it |
| Server errors | ≥ 5 HTTP 5xx in 5 min | Cloud Run `request_count` | Logs, `severity>=ERROR`; match the user's `request_id`; `unhandled_error` has the traceback |
| Slow responses | p95 > 4 s for 30 min | Cloud Run `request_latencies` | Neon monitoring, Cloud Run CPU; see [LOADTEST.md](LOADTEST.md) |
| Memory near the limit | > 85 % of 512 MB for 5 min | Cloud Run memory | Look for upload or sign-in bursts; raise to 1 GiB if repeated |
| At maximum instances | 2 instances for 15 min | Cloud Run `instance_count` | Sustained demand; raise `--max-instances` if users are affected |
| Operational failure | any `media_store_failed`, `ready_check_failed`, `scheduled_step_failed`, `recovery_email_failed`, `setup_email_failed`, `notification_failed`, `unhandled_error` | log metric `halqa_ops_failures` (label `event`) | The incident names the event; Logs Explorer `jsonPayload.msg="<event>"` |
| Sign-in abuse | > 100 failed sign-ins in 15 min, or any account lockout | log metric `halqa_auth_signals` | Admin → Settings → audit log (email domain only); locks clear after 15 min |
| Capacity limit approaching | database > 400 MB (Neon free 512 MB), connections > 80 %, recordings > 8 GB (R2 free 10 GB) | hourly `ops_stats` log line | Plan an upgrade or clean-up |
| Maintenance not running | no `ops_stats` from the hourly job for 3 h | log metric `halqa_maintenance_heartbeat` (absence) | Cloud Scheduler `halqa-tasks-hourly`; Cloud Run → Jobs → `halqa-tasks` |

Also in place: the 1 USD billing budget alert, GitHub's email when the deploy or scheduled workflow fails, and
`/api/ready` (database, migrations, shared cache; 503 with the reason when any fails).

## Hourly stats

The maintenance job logs one aggregate line per run:
`{"msg": "ops_stats", "db_size_mb", "db_connections", "db_connections_pct", "media_objects", "media_mb", "uploads_failed_24h"}`.
There are no names, emails or object keys. Logs Explorer: `jsonPayload.msg="ops_stats"`.

## Drill

GitHub → Actions → **Ops** → task `alert-drill`:

1. The production job runs `manage.py emit_test_alert`. It logs one event per monitored failure path, each with
   `synthetic: true`. Nothing else happens.
2. The workflow waits until all six events appear in Cloud Logging.
3. The owner should then receive "Halqa: operational failure" (grouped by event) and "Halqa: sign-in abuse"
   within about 10 minutes. The incidents close on their own.

Paths with synthetic events: storage upload failure, readiness failure, maintenance step failure, email send
failure, unhandled server error, account lockout.

Uptime, 5xx, latency, memory and instance alerts use Cloud Run's own metrics. Check them in Monitoring → Alerting
with each policy's condition preview.
