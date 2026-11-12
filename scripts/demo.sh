#!/usr/bin/env bash
# End-to-end walkthrough against the local stack: imports the sample catalog (15 rows, 3 invalid),
# then a generated 100k-row file, showing the presigned upload, the queue hand-off, live progress
# and the per-row error report.
#
#   docker compose up -d --build
#   ./scripts/demo.sh                 # DEMO_ROWS=100000 DEMO_PAUSE=1 by default
#
# Requires bash, curl and jq. Run from the repository root.
set -euo pipefail

API=${API:-http://localhost:3000}
KEY=${API_KEY:-local-dev-api-key-change-me}
ROWS=${DEMO_ROWS:-100000}
PAUSE=${DEMO_PAUSE:-1}

for bin in curl jq; do command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }; done

bold=$'\e[1m' dim=$'\e[2m' cyan=$'\e[36m' green=$'\e[32m' yellow=$'\e[33m' red=$'\e[31m' reset=$'\e[0m'
n=0
# jq on Windows prints CRLF; strip it so captured ids stay clean.
jqr() { jq "$@" | tr -d '\r'; }
step() { n=$((n + 1)); printf '\n%s%s[%d] %s%s\n' "$bold" "$cyan" "$n" "$1" "$reset"; }
say() { printf '%s%s%s\n' "$dim" "$*" "$reset"; }
pause() { sleep "$PAUSE"; }
status() {
  local c=$1 color=$green
  ((c >= 400)) && color=$red
  ((c >= 300 && c < 400)) && color=$yellow
  printf '%s%s → %s%s%s\n' "$bold" "$2" "$color" "$c" "$reset"
}
# call METHOD PATH [curl args...]: prints the status line and leaves the body in $BODY.
call() {
  local method=$1 path=$2
  shift 2
  local out
  out=$(curl -sS -X "$method" "$API$path" -H "x-api-key: $KEY" -w '\n%{http_code}' "$@")
  BODY=${out%$'\n'*}
  status "${out##*$'\n'}" "$method $path"
}

wait_for() {
  local id=$1 width=36
  while :; do
    local s
    s=$(curl -sS "$API/v1/imports/$id" -H "x-api-key: $KEY")
    local st processed failed
    st=$(jqr -r .import.status <<<"$s")
    processed=$(jqr -r '.import.processedRows // 0' <<<"$s")
    failed=$(jqr -r '.import.failedRows // 0' <<<"$s")
    local denom=$ROWS_EXPECTED
    local filled=$((denom > 0 ? processed * width / denom : 0))
    ((filled > width)) && filled=$width
    printf '\r  %-22s [%s%s] %7d rows  %s%d rejected%s ' "$st" \
      "$(printf '%*s' "$filled" '' | tr ' ' '#')" "$(printf '%*s' $((width - filled)) '')" \
      "$processed" "$yellow" "$failed" "$reset"
    case $st in COMPLETED | COMPLETED_WITH_ERRORS | FAILED) echo; break ;; esac
    sleep 0.3
  done
}

# run_import FILE: create -> presigned PUT -> start -> follow progress. Sets IMPORT_ID.
run_import() {
  local file=$1 name size
  name=$(basename "$file")
  size=$(wc -c <"$file" | tr -d ' ')
  ROWS_EXPECTED=$(($(wc -l <"$file") - 1))

  step "Create the import ($name, $size bytes)"
  say "The API stores it as AWAITING_UPLOAD and returns a presigned S3 URL (MinIO locally)."
  call POST /v1/imports -H "Idempotency-Key: demo-$(date +%s)-$RANDOM" -H 'Content-Type: application/json' \
    -d "{\"fileName\":\"$name\",\"format\":\"csv\",\"fileSize\":$size}"
  jqr -C '{import: {id: .import.id, status: .import.status}, upload: {url: (.upload.url | .[0:72] + "…"), headers: .upload.headers}}' <<<"$BODY"
  IMPORT_ID=$(jqr -r .import.id <<<"$BODY")
  local url
  url=$(jqr -r .upload.url <<<"$BODY")
  pause

  step "Upload straight to object storage"
  say "The bytes never touch the API: the signed URL is the credential (15 min, size and type signed)."
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT --upload-file "$file" -H 'Content-Type: text/csv' "$url")
  local path=${url%%\?*}
  status "$code" "PUT ${path%%/imports/*}/…/${path##*/} (presigned)"
  pause

  step "Start processing"
  say "HeadObject checks the size, AWAITING_UPLOAD -> QUEUED (conditional UPDATE), {importId} goes to SQS."
  call POST "/v1/imports/$IMPORT_ID/start"
  jqr -C '{id: .import.id, status: .import.status}' <<<"$BODY"
  pause

  step "Worker: stream, validate, upsert in batches"
  say "A separate worker takes a Redis lock, streams the file and upserts 500 rows per transaction."
  wait_for "$IMPORT_ID"
  call GET "/v1/imports/$IMPORT_ID"
  jqr -C '.import | {status, totalRows, processedRows, failedRows, startedAt, finishedAt}' <<<"$BODY"
  pause
}

step "Health"
call GET /ready
jqr -C . <<<"$BODY"
status "$(curl -sS -o /dev/null -w '%{http_code}' "$API/v1/imports")" "GET /v1/imports (no API key)"
say "Every /v1 route requires an API key."
pause

run_import fixtures/products-sample.csv

step "Per-row error report"
say "Invalid rows are rejected individually; the valid ones were imported."
call GET "/v1/imports/$IMPORT_ID/errors?limit=50"
jqr -C '.data | map({rowNumber, field, message})' <<<"$BODY"
call GET "/v1/imports/$IMPORT_ID/errors.csv"
printf '%s\n' "$BODY"
pause

big="${TMPDIR:-/tmp}/large-products-$$.csv"
trap 'rm -f "$big"' EXIT
step "Generate a $ROWS-row catalog"
say "Every 997th row has an invalid price."
awk -v rows="$ROWS" 'BEGIN {
  print "sku,name,description,price,stock,category"
  split("tools home office electronics", cat, " ")
  for (i = 1; i <= rows; i++) {
    price = (i % 997 == 0) ? "0" : sprintf("%d.%02d", 10 + i % 500, i % 100)
    printf "DEMO-%06d,Product %d,Generated row,%s,%d,%s\n", i, i, price, i % 300, cat[i % 4 + 1]
  }
}' >"$big"
printf '%s (%s bytes)\n' "$(basename "$big")" "$(wc -c <"$big" | tr -d ' ')"
pause

run_import "$big"

step "Done"
say "Interactive API reference: $API/docs · MinIO console: http://localhost:9001"
