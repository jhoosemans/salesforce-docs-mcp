# Maintenance notes (local setup)

This is a personal note on top of the upstream [README](README.md), documenting how *this* clone is wired
into Claude Code and how to keep it up to date. Upstream repo:
https://github.com/SalesforceDiariesBySanket/salesforce-docs-mcp

## Current state

- Cloned to: `/Users/jesse/Projects/salesforce-docs-mcp`
- Index built: 2026-08-31 — 238 documents indexed (169 developer guides + 70 release notes),
  88,600 search chunks, ~292 MB database at `data/salesforce-docs.db`
- Doc coverage: release notes Winter '04 → Spring '26. **Nothing after Spring '26 is in the index
  until it's refreshed** (see below).
- **Update 2026-09-13:** index rebuilt through the new sync pipeline — 345 documents, 135,516 chunks,
  446 MB. Developer guides at **Winter '27** (docs version 264, API 68.0); release notes through
  **Summer '26** (Winter '27 notes PDF not published by Salesforce yet — the weekly check reports it).
  See "Incremental sync pipeline (2026-09-13)" at the end of this note.
- **Update 2026-09-23:** incremental sync run by Claude on Jesse's "Go" — `check-updates` flagged 16
  changed documents (97.1 MB), `update-docs` fetched and re-indexed them with `--changed-only`, 0 failed.
  Index now **345 documents, 135,541 chunks, 446.33 MB**; developer guides still at **Winter '27**,
  release notes still through **Summer '26** (the Winter '27 notes PDF is still unpublished).
  A second `check-updates` afterwards reports `changed 0 - Everything is up to date`.
  The 16: apex_api, api_console, api_meta, api_tooling, field_history_retention, fsc_dev_guide,
  health_cloud_dev_guide, object_reference, platform_events, salesforce_apex_developer_guide,
  salesforce_app_limits_cheatsheet, salesforce_chatter_rest_api, salesforce_large_data_volumes_bp,
  salesforce_record_access_under_the_hood, secure_coding, sfdx_dev.
  - `npm run test-search`: **344 passed, 17 failed** against the 16 documented on 2026-09-13. Every
    failure is a *relevance-ranking* assertion (does the top hit contain given keywords, for
    deliberately misspelled queries like "queuable apex job" or "metadta deploy"), not missing or
    corrupt data; the only two "no results" cases are `Database.getDeleted` and `Database.getUpdated`.
    Whether the extra failure is a real ranking shift or baseline drift cannot be told from here —
    the harness prints no per-test history and no previous run is stored. **If that matters, save a
    run's output as the baseline to diff against next time.**
  - **Two documents are gone upstream** and still sit in the index, still surfacing in results:
    `api_bulk_asynch.pdf` and `rest_api_ui.pdf` (HTTP 404, retired by Salesforce). Nothing removes
    them automatically; decide whether to drop them from the manifest and rebuild.
  - **Gotcha:** `check-updates` does **not** rewrite `data/last-check.txt` — only the launchd agent
    does. After a manual update that file keeps reporting `UPDATES AVAILABLE` until the next
    scheduled run, so do not read it as the current state.
- **Update 2026-09-26:** incremental sync run by Claude on Jesse's "Go". `check-updates` flagged 12
  changed documents (78.7 MB) — 11 of the 16 from 2026-09-23 plus `api_action`. Verified before
  fetching that this was a real upstream change and not validator churn: live `HEAD` showed
  `Last-Modified` moved from Fri 18 Sep to Fri 25 Sep with new ETags, and after download all 12
  sha256 values in the manifest differ from the 23 Sep ones. The two `update-docs` steps were run
  separately (`sync-docs`, then `build-index --changed-only`), 0 failed. Index now **345 documents,
  135,557 chunks, 446.44 MB**; developer guides still at **Winter '27**, release notes still through
  **Summer '26** (Winter '27 notes PDF still unpublished). A second `check-updates` afterwards
  reports `changed 0 - Everything is up to date`.
  - **Pattern:** Salesforce re-renders the "latest" Winter '27 developer PDFs every Friday (11, 18,
    25 Sep so far), so the weekly check will keep flagging roughly this set, ~80 MB a time. Whether
    the *text* changed cannot be told from headers; only the sha256 after download tells, and it has
    differed each time. Decide whether weekly is worth it or whether to sync only at release
    boundaries.
  - `last-check.txt` still says `UPDATES AVAILABLE` from the 21 Sep scheduled run (the gotcha
    above); it corrects itself at the next launchd run.
  - `test-search` was not run this time.

## Why the repo's own PDFs aren't used

The repo ships 361 PDFs via Git LFS, but the repo owner's GitHub LFS bandwidth quota is exhausted,
so `git lfs pull` fails with "This repository exceeded its LFS budget." Workaround: `scripts/download-from-salesforce.mjs`
(added locally, not upstream) ports the repo's own `scripts/final-download-developer-docs.ps1` and
`final-download-release-notes.ps1` to Node, and downloads the same PDFs directly from Salesforce's
official doc servers instead. It shells out to `curl` rather than using Node's `fetch`, because Node's
bundled CA store rejects Salesforce's certificate chain (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) even though
macOS's system trust store (which `curl` uses) accepts it fine.

Not every URL in the upstream scripts still resolves — many are years-old legacy doc pages that have
since been taken down (expect ~170/396 dev-doc URLs to succeed; all 70 release-note URLs currently
resolve). That's normal, not a bug to chase.

## How Claude Code is connected to this server

Two pieces, both already in place:

1. **MCP server registration** (global scope, applies in every project/directory) —
   `mcpServers.salesforce-docs` in `~/.claude.json`:
   ```json
   {
     "type": "stdio",
     "command": "/opt/homebrew/bin/node",
     "args": ["/Users/jesse/Projects/salesforce-docs-mcp/dist/index.js"]
   }
   ```
   (There's also a project-scoped copy in `~/Library/Mobile Documents/com~apple~CloudDocs/Documents/Claude/Projects/.mcp.json` from
   initial setup — harmless duplicate, the global one is what matters going forward.)

2. **Standing instruction** telling Claude to actually use it — `~/.claude/CLAUDE.md` tells Claude to
   check the `salesforce-docs` MCP tools for any Apex/LWC/SOQL/API/release-note question instead of
   answering from general training knowledge.

A new Claude Code session picks up the MCP server automatically. The **first time** it's used in a
given project directory, Claude Code will prompt a one-time trust/enable approval for the server.

## Refreshing the index

> **Superseded on 2026-09-13.** `refresh-docs.sh` re-downloads everything blind and *deletes the
> local PDF when a URL fails* (that is how 119 files went missing). Use the pipeline described in
> "Incremental sync pipeline (2026-09-13)" below instead. This section is kept for history.

Run this whenever you want current docs, or roughly every ~4 months (Salesforce ships three releases
a year — Spring/Summer/Winter, ~Feb/Jun/Oct):

```bash
/Users/jesse/Projects/salesforce-docs-mcp/scripts/refresh-docs.sh
```

This re-downloads the PDFs (most developer-guide URLs are "evergreen" and serve current content
automatically) and rebuilds `data/salesforce-docs.db`. Takes a few minutes, mostly the index build.
Afterwards, restart any Claude Code session that's actively using the server — it loads the database
once at startup, so a running session won't see the refresh until relaunched. A brand-new session
picks it up automatically.

### Adding a new release's release notes

Release-note URLs are pinned per-release (unlike most dev guides), so a **new Salesforce release**
needs one new line added to `scripts/final-download-release-notes.ps1`, in the `$releaseNotes` array,
following the existing pattern:

```powershell
@{name="Summer_26"; url="https://resources.docs.salesforce.com/rel1/doc/en-us/static/pdf/salesforce_summer26_release_notes.pdf"},
```

Then run `refresh-docs.sh`. If you're not sure of the exact URL, check
[Salesforce Release Notes](https://help.salesforce.com/s/articleView?id=release-notes.salesforce_release_notes.htm)
for the current release's PDF link, or just ask Claude to find and add it.

## Files added locally (not part of upstream repo)

> Both scripts below are superseded by the pipeline (see the 2026-09-13 section) and kept only
> until deleted; `MAINTENANCE.md` remains current.

- `scripts/download-from-salesforce.mjs` — the Node/curl PDF downloader described above
- `scripts/refresh-docs.sh` — one-command wrapper: download + rebuild index
- `MAINTENANCE.md` — this file


## Incremental sync pipeline (2026-09-13)

Replaces the "Refreshing the index" routine above. Code is on branch `doc-sync` in
`~/Projects/salesforce-docs-mcp` (repo moved out of iCloud Drive the same day) and pushed to
https://github.com/jhoosemans/salesforce-docs-mcp (fork; `upstream` = SalesforceDiariesBySanket).

**How it works.** `docs/manifest.json` is the source of truth: one entry per document with its source
URL, the release the local copy came from, and ETag / size / sha256. `check-updates` asks the CDN
(HEAD only, ~20 s for the whole corpus) and diffs validators against the manifest; `sync-docs`
downloads only what was flagged, validates the bytes are a PDF, writes beside and renames;
`build-index --changed-only` re-indexes only what was fetched and swaps the database in atomically.

```bash
cd ~/Projects/salesforce-docs-mcp
npm run check-updates                    # read-only; exit 3 = updates available
npm run sync-docs -- --dry-run           # show the plan and the MB total
npm run update-docs                      # sync-docs + build-index --changed-only
npm run test-search                      # regression (16 known failures on 2026-09-13; compare, don't read absolute)
```
Restart any running Claude Code session afterwards — the server loads the DB once at startup.

**Scheduled check.** launchd agent `com.jessehoosemans.salesforce-docs-check`
(`~/Library/LaunchAgents/…plist`) runs `scripts/scheduled-check.sh` every **Monday 09:00**: read-only,
posts a macOS notification only when there is something to fetch (or the check itself failed),
writes `data/last-check.txt`, `data/update-report.json`, `data/check.log`.
Notifications go through the **Opdrachten/Shortcuts** app: a shortcut named exactly
`Salesforce docs notify` with one action, *Toon melding* (title "Salesforce docs", body = *Invoer
opdracht*). It must exist or nothing is shown — `scripts/scheduled-check.sh --notify-test` says which
path it used. Why (2026-09-14, macOS 26): `osascript display notification` is attributed to the
launching app and launchd has none; `terminal-notifier` (Homebrew) is ad-hoc signed and Gatekeeper
rejects it — both are dropped silently and never appear in Notification settings. On a notification: say
"Go" to Claude, or run `npm run update-docs` yourself. Manage with
`launchctl kickstart gui/$UID/com.jessehoosemans.salesforce-docs-check` (run now) /
`launchctl bootout gui/$UID/com.jessehoosemans.salesforce-docs-check` (remove).

**Facts the pipeline rests on (all verified 2026-09-13).**
- Salesforce's CDN (Akamai NetStorage) serves strong `ETag`, `Last-Modified`, `Content-Length` on HEAD.
- The unversioned `https://resources.docs.salesforce.com/sfdc/pdf/{name}.pdf` paths are **dead (404)**.
  Working form: `/{docsVersion}/latest/en-us/sfdc/pdf/{name}.pdf` — distinct bytes per release.
  Docs version = 2 per release: 258 Winter '26 (API 65.0), 260 Spring '26, 262 Summer '26, **264 Winter '27
  (68.0, live since ≥ 11 Sep 2026)**. `check-updates` confirms the current one by probing canary guides.
- Release notes: `/rel1/doc/en-us/static/pdf/salesforce_{season}{yy}_release_notes.pdf`; each release's
  PDF appears some weeks after its developer guides.
- Node `fetch` fails against the CDN with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; `curl` (macOS trust store)
  works. All HTTP goes through `curl` in `scripts/lib/http.ts`.
- Some retired PDFs `302` to an HTML page on architect.salesforce.com; the check goes by content-type.
- **Git LFS:** the fork shares the parent's exhausted LFS quota, so any LFS API call fails. PDFs and
  `data/` are no longer tracked (branch `doc-sync`). Before pushing, `git fetch origin` so the LFS
  pre-push hook has `origin/*` to exclude; a fresh clone needs `GIT_LFS_SKIP_SMUDGE=1 git clone …`.

**Known leftovers.** `docs/pdfs/salesforce1_url_schemes.pdf` (an HTML page) and
`docs/help-products/sales_agents.pdf` (LFS pointer) are junk, retired upstream, skipped by the index —
safe to delete. `get_release_notes` with `release: "Summer 26"` returns Spring '07: pre-existing
server bug in release-name matching, not touched. Rollback DB: `data/salesforce-docs.db.bak-2026-09-13`.
