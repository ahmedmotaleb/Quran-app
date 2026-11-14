#!/usr/bin/env bash
# One-time: create HALQA's Android signing key (owner only). Run in Cloud Shell or on your own computer:
#   bash deploy/android-keystore.sh
# It creates halqa-release.jks in your home folder, asks you for its password (typing is hidden), and prints:
#   1. the four GitHub secrets to add (Settings → Secrets and variables → Actions → New repository secret);
#   2. the certificate's SHA-256 fingerprint (public) for the site's /.well-known/assetlinks.json.
# Nothing secret is printed except where you are told to paste it into GitHub yourself.
#
# KEEP halqa-release.jks AND ITS PASSWORD SAFE (two copies, offline). Without them you can never publish an update to
# the same app; a new key is a new app for every installed phone.
set -euo pipefail
KS="${KS:-$HOME/halqa-release.jks}"
ALIAS="${ALIAS:-halqa}"
command -v keytool >/dev/null || { echo "keytool (Java) is needed: in Cloud Shell it is installed."; exit 1; }
[ -e "$KS" ] && { echo "$KS already exists; not overwriting it."; exit 1; }

read -r -s -p "New keystore password (at least 12 characters): " PW; echo
[ ${#PW} -ge 12 ] || { echo "Too short."; exit 1; }
read -r -s -p "Again: " PW2; echo
[ "$PW" = "$PW2" ] || { echo "Passwords differ."; exit 1; }

keytool -genkeypair -keystore "$KS" -storetype PKCS12 -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10950 \
  -dname "CN=HALQA, O=HALQA, C=EG" -storepass "$PW" -keypass "$PW" >/dev/null
FP=$(keytool -list -v -keystore "$KS" -alias "$ALIAS" -storepass "$PW" | awk '/SHA256:/{print $2; exit}')
unset PW PW2

cat <<MSG

Created $KS (keep it, and its password, safe).

GitHub → Settings → Secrets and variables → Actions → New repository secret:
  HALQA_KEYSTORE_BASE64   = the output of:  base64 -w0 "$KS"
  HALQA_KEYSTORE_PASSWORD = the password you typed
  HALQA_KEY_ALIAS         = $ALIAS
  HALQA_KEY_PASSWORD      = the same password
Optional repository VARIABLE: HALQA_APP_HOST = your app's host (e.g. app.example.com) if not the Cloud Run address.

Signing certificate SHA-256 (public):
  $FP
Publish it for Digital Asset Links (Cloud Shell):
  gcloud run services update halqa --region europe-west1 --update-env-vars "ANDROID_CERT_SHA256=$FP"
Then GitHub → Actions → "Android (TWA)" → Run workflow builds the signed APK and AAB.
MSG
