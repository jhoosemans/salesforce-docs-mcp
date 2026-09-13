#!/bin/bash
# Scheduled, read-only check for new or updated Salesforce documentation.
#
# Run by launchd (see MAINTENANCE.md) - never downloads or indexes anything.
# It runs check-updates, keeps the JSON report and a one-line status file,
# and posts a macOS notification only when there is something to act on:
#
#   exit 3  updates available  -> notification, then run `npm run update-docs`
#   exit 0  nothing to do      -> silent
#   exit 2  CDN unreachable    -> silent (offline is normal), logged
#   other   error              -> notification, so a broken check is noticed
#
#   scripts/scheduled-check.sh            # what launchd runs
#   scripts/scheduled-check.sh --notify-test   # only exercise the notification

set -u
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REPORT=data/update-report.json
LOG=data/check.log
STATUS=data/last-check.txt

notify() {
    # $1 title, $2 message. osascript is enough; no extra tooling needed.
    osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--notify-test" ]; then
    notify "Salesforce docs" "Notification test - the scheduled check can reach you."
    exit 0
fi

mkdir -p data
{
    echo "==== $(date '+%Y-%m-%d %H:%M:%S') check-updates"
    npm run --silent check-updates -- --json "$REPORT" 2>&1 | grep -v 'DeprecationWarning\|trace-deprecation'
    echo "exit=${PIPESTATUS[0]}"
} >> "$LOG" 2>&1
code=$(tail -1 "$LOG" | sed 's/exit=//')

summary() {
    node -e '
      const r = require("./'"$REPORT"'");
      const s = r.summary;
      const n = (s["new-upstream"] ?? 0) + (s["changed"] ?? 0) + (s["stale-baseline"] ?? 0) + (s["missing-locally"] ?? 0);
      const pending = r.findings.filter(f => f.status === "not-yet-published").map(f => f.fileName.replace(/\.pdf$/, "")).join(", ");
      console.log(`${n} to fetch (${s["new-upstream"] ?? 0} new, ${s["changed"] ?? 0} changed) against ${r.targetRelease.name}` + (pending ? `; awaiting ${pending}` : ""));
    ' 2>/dev/null || echo "summary unavailable"
}

case "$code" in
    0) line="$(date '+%Y-%m-%d %H:%M') up to date - $(summary)" ;;
    3) line="$(date '+%Y-%m-%d %H:%M') UPDATES AVAILABLE - $(summary)"
       notify "Salesforce docs: updates available" "$(summary). Run: npm run update-docs" ;;
    2) line="$(date '+%Y-%m-%d %H:%M') CDN unreachable (offline?) - nothing checked" ;;
    *) line="$(date '+%Y-%m-%d %H:%M') ERROR exit $code - see data/check.log"
       notify "Salesforce docs: check failed" "exit $code - see data/check.log" ;;
esac
echo "$line" > "$STATUS"
echo "$line"
exit "$code"
