# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first MCP server (stdio) that answers Salesforce documentation questions from a SQLite index
of official Salesforce PDFs, plus a pipeline that keeps that corpus current. Jesse's fork of
`SalesforceDiariesBySanket/salesforce-docs-mcp`; `origin` = fork, `upstream` = original (read-only).
Claude Code runs `dist/index.js` via `mcpServers.salesforce-docs` in `~/.claude.json`.

Local operating notes (paths, schedule, rollback, history) live in `MAINTENANCE.md`.

## Commands

```bash
npm run build            # tsc -> dist/ (what the MCP server runs; rebuild after touching src/)
npm run typecheck        # tsc --noEmit over scripts/ and src/ (tsconfig.scripts.json)
npm run dev              # run the server from source (tsx)

npm run check-updates                    # read-only CDN diff vs docs/manifest.json; exit 3 = updates
npm run sync-docs -- --dry-run           # plan + MB total; --only apex,lwc / --kind release_notes
npm run sync-web -- --dry-run            # web guides (LWC, Apex dev, Apex reference): page counts, no download
npm run update-docs                      # sync-docs, sync-web, then build-index --changed-only
npm run build-index                      # full rebuild from PDFs on disk; --changed-only for incremental.
                                         # Refuses to replace a bigger live index (--allow-shrink):
                                         # the live index holds legacy documents whose PDF isn't here
npm run build-manifest                   # re-derive the manifest (carries recorded state forward)
npm run test-search                      # 361 search assertions; compare pass count to the previous run
npm run test-llm-judge                   # LLM-judged relevance
scripts/scheduled-check.sh               # what launchd runs weekly; --notify-test to test the notification
                                         # (needs the "Salesforce docs notify" shortcut - see MAINTENANCE.md)
```

Restart any running Claude Code session after re-indexing: the server loads the DB once at startup.
`npm start` / a session start never writes the DB (guarded by the `documents` table existing).

## Architecture

**Server** (`src/`): 9 MCP tools registered in `src/index.ts`. `src/db/database.ts` opens
`data/salesforce-docs.db` (~525 MB) read-only from disk with `node:sqlite` (built into Node ≥ 22.13;
no npm database dependency). Search = `src/utils/intent.ts` (query → category filter) → FTS5 match
on `chunks_fts`, ranked by BM25 × document priority (`src/db/queries.ts`; query translation and
index DDL in `src/db/fts.ts`) → LRU cache. Chunks come from `src/utils/chunker.ts` (1500 chars, 150 overlap);
`src/utils/classifier.ts` maps filenames to category/doc_type/priority. Design doc: `MCP_ARCHITECTURE.md`.

**Corpus** (`docs/`, git-ignored): `docs/pdfs` (developer guides), `docs/release-notes`,
`docs/help-products`, and `docs/pages/<guide>` (web-page guides). Regenerable from Salesforce; never
versioned (see LFS gotcha).

**Pipeline** (`scripts/` + `scripts/lib/`): `docs/manifest.json` (tracked) is the source of truth —
one entry per document with source URL, provenance, release/API version, ETag/size/sha256,
`fetchedAt`/`indexedAt`. `lib/scan.ts` classifies each document (new / changed / unchanged / frozen /
gone / not-yet-published) from a HEAD probe; both `check-updates` and `sync-docs` run the same scan so
they cannot disagree. `lib/release.ts` is the release calendar (docs version ↔ season ↔ API version).
`lib/http.ts` is the only place HTTP happens. `build-index --changed-only` indexes entries with
`fetchedAt > indexedAt`, stamps `documents.api_version / last_updated / source_url / sha256`, and
migrates older DBs in place.

**Web guides** (`scripts/lib/web-guides.ts`, `sync-web`): guides read as pages instead of PDFs - LWC
(Markdown from `/docs/llms-lwc.txt`), Apex Developer and Apex Reference (atlas JSON API). State in
`docs/web-guides.json` (tracked: release, page count, page-list and content hashes). `check-updates`
adds one request per guide (new release or changed page list); `sync-web` downloads every page and
re-indexes a guide only when its content hash changed. Each guide is one document; chunks are page
sections with `page_url` and `search_title`, which `chunks_fts` weights `TITLE_WEIGHT` x above body
text. A PDF a web guide replaces is superseded in `docs/superseded.json`, never deleted, and only
while its successor is in the index.

Decisions already made — don't re-litigate: developer guides replace in place, release notes
accumulate; retired documents stay in the index (`--prune` exists, default off); frozen legacy docs
are kept at their pinned edition; the check is read-only and the scheduled job only notifies.

## Gotchas (all measured, dates in MAINTENANCE.md)

- **Transport is `curl`, not `fetch`.** Node's CA store rejects the CDN chain
  (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Don't "simplify" `lib/http.ts` back to `fetch`.
- **Unversioned `/sfdc/pdf/{name}.pdf` URLs are dead.** Only `/{docsVersion}/latest/en-us/sfdc/pdf/`
  works; `upstreamUrl()` rebases every guide onto the target release. `canonicalUrl()` is an identity
  shape, never fetched directly.
- **Release notes are per-release documents** — never "stale" against the current release; they're
  discovered by name from the calendar and reported `not-yet-published` until Salesforce serves them.
- **A 200 can be an HTML page** (redirect to architect.salesforce.com). Content-type decides.
- **Git LFS is poisoned.** The fork shares the parent's exhausted quota; any LFS call fails.
  `git fetch origin` before pushing (the pre-push hook needs `origin/*` to exclude upstream history);
  fresh clones need `GIT_LFS_SKIP_SMUDGE=1`.
- **Small PDFs**: pass `new Uint8Array(buffer)` to pdf-parse, never the raw Buffer (pool byteOffset).
- **`chunks_fts` is an external-content FTS5 index**: it does not follow `chunks` by itself.
  `build-index` rebuilds it (~2 s) after every write; any other script that changes `chunks` must too.
  Never build FTS queries by hand: `toFtsQuery()` quotes every term, so user input is never FTS5 syntax.
- **developer.salesforce.com ignores conditional requests** (If-None-Match answers 200) and LWC pages
  carry the deploy time as Last-Modified: a page edit is only visible by downloading the page.
  Its HTML pages answer 403 to scripts; fetch only the `.md` pages and the JSON API. It rate-limits
  with 403s (about 16 requests/s was blocked, about 4/s was fine): `lib/web-guides.ts` spaces every
  request 500 ms apart across workers (a full sync takes about 30 min) and stops a guide that stays blocked after a 60 s pause.
- `scripts/download-from-salesforce.mjs` and `scripts/refresh-docs.sh` are the superseded, destructive
  path (delete-on-failure). Don't run or extend them.
- `scripts/final-download-*.ps1` are not run; they survive only as the URL lists `build-manifest` parses.
