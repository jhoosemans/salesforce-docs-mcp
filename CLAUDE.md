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
npm run update-docs                      # sync-docs, then build-index --changed-only
npm run build-index                      # full rebuild (5-10 min); --changed-only for incremental
npm run build-manifest                   # re-derive the manifest (carries recorded state forward)
npm run test-search                      # 361 search assertions; compare pass count to the previous run
npm run test-llm-judge                   # LLM-judged relevance
scripts/scheduled-check.sh               # what launchd runs weekly; --notify-test to test the notification
```

Restart any running Claude Code session after re-indexing: the server loads the DB once at startup.
`npm start` / a session start never writes the DB (guarded by the `documents` table existing).

## Architecture

**Server** (`src/`): 9 MCP tools registered in `src/index.ts`. `src/db/database.ts` loads
`data/salesforce-docs.db` (~450 MB) wholesale into memory with `sql.js` (pure JS, no FTS5).
Search = `src/utils/intent.ts` (query → category filter) → LIKE over `chunks.content_lower`
(`src/db/queries.ts`) → LRU cache. Chunks come from `src/utils/chunker.ts` (1500 chars, 150 overlap);
`src/utils/classifier.ts` maps filenames to category/doc_type/priority. Design doc: `MCP_ARCHITECTURE.md`.

**Corpus** (`docs/`, git-ignored): `docs/pdfs` (developer guides), `docs/release-notes`,
`docs/help-products`. Regenerable from Salesforce; never versioned (see LFS gotcha).

**Pipeline** (`scripts/` + `scripts/lib/`): `docs/manifest.json` (tracked) is the source of truth —
one entry per document with source URL, provenance, release/API version, ETag/size/sha256,
`fetchedAt`/`indexedAt`. `lib/scan.ts` classifies each document (new / changed / unchanged / frozen /
gone / not-yet-published) from a HEAD probe; both `check-updates` and `sync-docs` run the same scan so
they cannot disagree. `lib/release.ts` is the release calendar (docs version ↔ season ↔ API version).
`lib/http.ts` is the only place HTTP happens. `build-index --changed-only` indexes entries with
`fetchedAt > indexedAt`, stamps `documents.api_version / last_updated / source_url / sha256`, and
migrates older DBs in place.

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
- `scripts/download-from-salesforce.mjs` and `scripts/refresh-docs.sh` are the superseded, destructive
  path (delete-on-failure). Don't run or extend them.
- `scripts/final-download-*.ps1` are not run; they survive only as the URL lists `build-manifest` parses.
