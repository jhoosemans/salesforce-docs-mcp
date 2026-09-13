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
writes `data/last-check.txt`, `data/update-report.json`, `data/check.log`. On a notification: say
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
