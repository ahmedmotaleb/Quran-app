#!/usr/bin/env bash
# Halqa operations setup (pack prompt 26): alerts by email, an uptime check, log-based metrics, and an hourly
# Cloud Scheduler trigger for the maintenance job. Run once in Cloud Shell as the project owner:
#
#   bash deploy/gcp-ops.sh
#
# Safe to run again: existing items (matched by name) are kept, missing ones are created.
# Everything here is within Google Cloud's free allowances for a project of this size.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-halqa}"
JOB="$SERVICE-tasks"
RUN_SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA="$SERVICE-deploy@$PROJECT.iam.gserviceaccount.com"
test -n "$PROJECT" || { echo "Set the project first: gcloud config set project <id>"; exit 1; }
read -rp "Email address for alerts: " EMAIL
[[ "$EMAIL" == *@*.* ]] || { echo "That does not look like an email address."; exit 1; }

echo "== APIs"
gcloud services enable monitoring.googleapis.com logging.googleapis.com cloudscheduler.googleapis.com --project "$PROJECT"
HOST=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)' | sed 's#https://##')
test -n "$HOST" || { echo "Cloud Run service $SERVICE not found in $REGION"; exit 1; }
TOKEN=$(gcloud auth print-access-token)
API="https://monitoring.googleapis.com/v3/projects/$PROJECT"
call() { curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

echo "== Email notification channel"
CHANNEL=$(gcloud beta monitoring channels list --project "$PROJECT" --filter "labels.email_address=\"$EMAIL\"" --format 'value(name)' | head -1)
if [ -z "$CHANNEL" ]; then
  CHANNEL=$(gcloud beta monitoring channels create --project "$PROJECT" --display-name "Halqa owner ($EMAIL)" --type email \
    --channel-labels "email_address=$EMAIL" --format 'value(name)')
fi
echo "   $CHANNEL"

echo "== Log-based metrics (counters; no personal data is extracted)"
BASE='((resource.type="cloud_run_revision" AND resource.labels.service_name="'$SERVICE'") OR (resource.type="cloud_run_job" AND resource.labels.job_name="'$JOB'"))'
metric() {  # name, description, filter, label(optional)
  local f; f=$(mktemp --suffix .json)
  python3 - "$1" "$2" "$BASE AND $3" "${4:-}" > "$f" <<'PY'
import json, sys
name, desc, flt, label = sys.argv[1:5]
m = {"name": name, "description": desc, "filter": flt,
     "metricDescriptor": {"metricKind": "DELTA", "valueType": "INT64", "unit": "1", "labels": []}}
if label:
    m["metricDescriptor"]["labels"] = [{"key": label, "valueType": "STRING"}]
    m["labelExtractors"] = {label: "EXTRACT(jsonPayload.msg)"}
print(json.dumps(m))
PY
  if gcloud logging metrics describe "$1" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud logging metrics update "$1" --project "$PROJECT" --config-from-file "$f" >/dev/null
  else
    gcloud logging metrics create "$1" --project "$PROJECT" --config-from-file "$f" >/dev/null
  fi
  rm -f "$f"; echo "   $1"
}
metric halqa_ops_failures "Failed uploads to storage, readiness failures, maintenance steps, email sends, unhandled errors" \
  'jsonPayload.msg=("media_store_failed" OR "ready_check_failed" OR "scheduled_step_failed" OR "recovery_email_failed" OR "setup_email_failed" OR "unhandled_error" OR "notification_failed")' event
metric halqa_auth_signals "Failed sign-ins, account lockouts and wrong admin codes (counts only)" \
  'jsonPayload.msg=("login_failed" OR "auth_locked" OR "mfa_failed")' event
metric halqa_capacity_warnings "Hourly stats over a limit: database > 400 MB, connections > 80%, recordings > 8 GB" \
  'jsonPayload.msg="ops_stats" AND (jsonPayload.db_size_mb>400 OR jsonPayload.db_connections_pct>80 OR jsonPayload.media_mb>8000)'
metric halqa_maintenance_heartbeat "One per completed hourly maintenance run" 'jsonPayload.msg="ops_stats"'

echo "== Uptime check (/api/health every 15 minutes from 3 regions; does not touch the database)"
UPTIME=$(call "$API/uptimeCheckConfigs" | python3 -c "import json,sys;print(next((c['name'] for c in json.load(sys.stdin).get('uptimeCheckConfigs',[]) if c['displayName']=='Halqa health'),''))")
if [ -z "$UPTIME" ]; then
  UPTIME=$(call -X POST "$API/uptimeCheckConfigs" -d @- <<JSON | python3 -c "import json,sys;print(json.load(sys.stdin)['name'])"
{"displayName": "Halqa health", "period": "900s", "timeout": "30s",
 "monitoredResource": {"type": "uptime_url", "labels": {"project_id": "$PROJECT", "host": "$HOST"}},
 "httpCheck": {"path": "/api/health", "port": 443, "useSsl": true, "validateSsl": true, "requestMethod": "GET"},
 "contentMatchers": [{"content": "\"status\"", "matcher": "CONTAINS_STRING"}],
 "selectedRegions": ["EUROPE", "USA_VIRGINIA", "ASIA_PACIFIC"]}
JSON
)
fi
CHECK_ID="${UPTIME##*/}"; echo "   $UPTIME"

echo "== Alert policies"
EXISTING=$(call "$API/alertPolicies?pageSize=200" | python3 -c "import json,sys;print('\n'.join(p['displayName'] for p in json.load(sys.stdin).get('alertPolicies',[])))")
policy() {  # display name; JSON conditions array; documentation (markdown)
  if grep -qxF "$1" <<<"$EXISTING"; then echo "   kept: $1"; return; fi
  python3 - "$1" "$2" "$3" "$CHANNEL" <<'PY' | call -X POST "$API/alertPolicies" -d @- >/dev/null
import json, sys
name, conditions, doc, channel = sys.argv[1:5]
print(json.dumps({"displayName": name, "combiner": "OR", "enabled": True, "notificationChannels": [channel],
                  "conditions": json.loads(conditions), "alertStrategy": {"autoClose": "86400s"},
                  "documentation": {"mimeType": "text/markdown", "content": doc}}))
PY
  echo "   created: $1"
}
RUN='resource.type="cloud_run_revision" AND resource.label.service_name="'$SERVICE'"'
LOGRES='resource.type=one_of("cloud_run_revision","cloud_run_job")'
th() {  # filter, aligner, period, reducer, comparison, value, duration, [groupBy]
  python3 -c "
import json,sys
f,al,per,red,cmp,val,dur,grp=sys.argv[1:9]
a={'alignmentPeriod':per,'perSeriesAligner':al,'crossSeriesReducer':red}
if grp: a['groupByFields']=[grp]
print(json.dumps({'filter':f,'aggregations':[a],'comparison':cmp,'thresholdValue':float(val),'duration':dur,'trigger':{'count':1}}))" "$@" ""
}
cond() { python3 -c "import json,sys;print(json.dumps([{'displayName':n,'conditionThreshold':json.loads(c)} for n,c in zip(sys.argv[1::2],sys.argv[2::2])]))" "$@"; }

policy "Halqa: app unreachable" "$(cond 'Health check failing from 2+ regions' "$(th "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"$CHECK_ID\"" ALIGN_NEXT_OLDER 1200s REDUCE_COUNT_FALSE COMPARISON_GT 1 0s)")" \
"**Owner:** project owner. **Action:** open the app address; check Cloud Run → $SERVICE → Revisions (a failed deploy?) and Logs. GitHub → Actions → Deploy shows the last release. Roll back from Cloud Run → Revisions → Manage traffic."
policy "Halqa: server errors" "$(cond '5 or more 5xx responses in 5 minutes' "$(th "metric.type=\"run.googleapis.com/request_count\" AND $RUN AND metric.label.response_code_class=\"5xx\"" ALIGN_SUM 300s REDUCE_SUM COMPARISON_GT 4 0s)")" \
"**Action:** Cloud Run → $SERVICE → Logs, filter \`severity>=ERROR\`. Each error has a \`request_id\` the user also sees. \`unhandled_error\` lines carry the traceback. If it started with a deploy, roll back the revision."
policy "Halqa: slow responses" "$(cond 'p95 latency above 4 s for 30 minutes' "$(th "metric.type=\"run.googleapis.com/request_latencies\" AND $RUN" ALIGN_PERCENTILE_95 300s REDUCE_MAX COMPARISON_GT 4000 1800s)")" \
"**Action:** check the database (Neon console → Monitoring) and Cloud Run CPU. Single slow requests after idle time are cold starts and do not trigger this; 30 minutes of slowness is real. See docs/LOADTEST.md for measured capacity."
policy "Halqa: memory near the limit" "$(cond 'memory above 85% for 5 minutes' "$(th "metric.type=\"run.googleapis.com/container/memory/utilizations\" AND $RUN" ALIGN_PERCENTILE_99 300s REDUCE_MAX COMPARISON_GT 0.85 300s)")" \
"**Action:** an instance is close to 512 MB and may restart. Look for large uploads or a burst of sign-ins in the logs. Raise memory with \`gcloud run services update $SERVICE --region $REGION --memory 1Gi\` (still within the free allowance at low traffic)."
policy "Halqa: at maximum instances" "$(cond '2 instances for 15 minutes' "$(th "metric.type=\"run.googleapis.com/container/instance_count\" AND $RUN" ALIGN_MAX 300s REDUCE_SUM COMPARISON_GT 1.5 900s)")" \
"**Action:** sustained demand at the configured maximum (2). Check latency and errors; if users are affected, raise \`--max-instances\` and watch the billing budget."
policy "Halqa: operational failure" "$(cond 'any failed upload, readiness, maintenance step, email or unhandled error' "$(th "metric.type=\"logging.googleapis.com/user/halqa_ops_failures\" AND $LOGRES" ALIGN_SUM 300s REDUCE_SUM COMPARISON_GT 0 0s metric.label.event)")" \
"**Action:** the incident names the event. Logs Explorer: \`jsonPayload.msg=\"<event>\"\`. media_store_failed → R2 status/keys (\`/api/ready\`); ready_check_failed → database or cache; scheduled_step_failed → Cloud Run → Jobs → $JOB; *_email_failed → SMTP settings. Lines with \`synthetic: true\` come from the alert drill."
policy "Halqa: sign-in abuse" "$(cond 'more than 100 failed sign-ins in 15 minutes' "$(th "metric.type=\"logging.googleapis.com/user/halqa_auth_signals\" AND $LOGRES AND metric.label.event=\"login_failed\"" ALIGN_SUM 900s REDUCE_SUM COMPARISON_GT 100 0s)" 'an account was locked' "$(th "metric.type=\"logging.googleapis.com/user/halqa_auth_signals\" AND $LOGRES AND metric.label.event=\"auth_locked\"" ALIGN_SUM 300s REDUCE_SUM COMPARISON_GT 0 0s)")" \
"**Action:** Admin portal → Settings → audit log shows \`auth.login_failed\` / \`auth.locked\` with the email domain. Locks clear after 15 minutes. For sustained attacks, lower THROTTLE_AUTH or add Cloud Armor."
policy "Halqa: capacity limit approaching" "$(cond 'hourly stats over a limit' "$(th "metric.type=\"logging.googleapis.com/user/halqa_capacity_warnings\" AND $LOGRES" ALIGN_SUM 3600s REDUCE_SUM COMPARISON_GT 0 0s)")" \
"**Action:** Logs Explorer: \`jsonPayload.msg=\"ops_stats\"\` shows db_size_mb (Neon free: 512 MB), db_connections_pct and media_mb (R2 free: 10 GB). Plan an upgrade or clean-up before the limit."
policy "Halqa: maintenance not running" "$(python3 -c "
import json;print(json.dumps([{'displayName':'no hourly maintenance run for 3 hours','conditionAbsent':{'filter':'metric.type=\"logging.googleapis.com/user/halqa_maintenance_heartbeat\" AND resource.type=\"cloud_run_job\"','aggregations':[{'alignmentPeriod':'3600s','perSeriesAligner':'ALIGN_SUM','crossSeriesReducer':'REDUCE_SUM'}],'duration':'10800s','trigger':{'count':1}}}]))")" \
"**Action:** reminders and review tasks are not being generated. Cloud Scheduler → halqa-tasks-hourly (last run status) and Cloud Run → Jobs → $JOB → executions."

echo "== Hourly maintenance trigger (Cloud Scheduler; replaces the GitHub cron, which GitHub pauses in idle public repos)"
gcloud run jobs add-iam-policy-binding "$JOB" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$RUN_SA" --role roles/run.invoker >/dev/null
if ! gcloud scheduler jobs describe halqa-tasks-hourly --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs create http halqa-tasks-hourly --project "$PROJECT" --location "$REGION" --schedule "53 * * * *" --time-zone UTC \
    --uri "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run" --http-method POST \
    --oauth-service-account-email "$RUN_SA" >/dev/null
fi
echo "   halqa-tasks-hourly (minute 53 of every hour)"

echo "== Read-only access for GitHub Actions (alert drill and scheduler check)"
for role in roles/logging.viewer roles/monitoring.viewer roles/cloudscheduler.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$DEPLOY_SA" --role "$role" --condition None >/dev/null
done

echo
echo "Done. Next: GitHub → Actions → Ops → task 'alert-drill'. Within ~10 minutes $EMAIL should receive"
echo "'Halqa: operational failure' and 'Halqa: sign-in abuse' emails marked with the drill's synthetic events."
