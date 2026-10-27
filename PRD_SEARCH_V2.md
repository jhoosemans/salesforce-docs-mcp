# PRD: Search v2 — full-text index, recency ranking, better sources

Status: **draft, awaiting sign-off** · 2026-10-27 · baseline commit `ab2e1e2`

## Problem

Claude asks this server Salesforce questions and must get the *current, correct* page back, fast.
Today it falls short in three ways:

1. **Search is slow and the ranking is crude.** sql.js has no usable full-text index, so every
   search reads all 134k chunks with `LIKE` (~150 ms per meaningful term; 1.6 s for a long
   question). The stopgap in `ab2e1e2` fixed *which* chunks get scored but made the median
   4× slower (21 → 90 ms). Each running server also holds the whole 471 MB database in memory
   (490 MB RSS per Claude Code session).
2. **Old documents compete as equals with current ones.** 86 non-release-note documents are
   API version < 60 (e.g. *Dbcom Apex Language Reference*, Summer '12, API 25.0 — priority 9,
   the same as the Winter '27 Apex Developer Guide). Before `ab2e1e2`, legacy documents topped
   most failures (*Dbcom Chatter Rest Api*, *Dbcom Api Rest*, *Apex Workbook*); of the 8 failures
   left, 2 still have one on top (*Apex Workbook*, *Dbcom Api Meta*) and 1 has Spring '22 release notes.
4. **Typos find nothing useful.** 4 of the 8 remaining failures are misspellings
   ("schedulble", "furture", "metadta", "shring"). Neither LIKE nor FTS5 word matching corrects them.
3. **The corpus has gaps and damaged text.** Two core guides are missing: the **LWC Developer
   Guide** (no longer published as PDF; `lightning.pdf` is the Aura guide) and the **current Apex
   Reference Guide** (only the Summer '12 *Dbcom Apex Language Reference* is indexed — so every
   `System`/`Database` method signature comes from a 2012 edition or not at all). PDF extraction glues
   words together (`publicvoidexecute`, `FROMAsyncApexJob`), which hurts any word-based search.

## What already exists (checked)

| Option | Verdict | Evidence |
|---|---|---|
| sql.js FTS4 | Rejected | Available, but no built-in ranking and the DB still loads into memory. |
| `better-sqlite3` | Not needed | Native npm dependency; Node already ships SQLite. |
| **`node:sqlite` (built into Node) + FTS5** | **Chosen** | Measured on a DB copy, Node 26.12.1 / SQLite 3.54.1: opens in 2 ms, 17 MB RSS; `"database.executebatch" scope size` 0.6 ms (Apex Developer Guide on top); 6-term OR question 69 ms; trigram substring 1 ms. No experimental warning. |
| Embeddings / vector search | Out (for now) | Claude is the caller and already rephrases vague questions (`expand_search_query`). Adds a model, slower re-indexing, more moving parts. Revisit only if lexical search plateaus. |
| Meilisearch / Typesense / Elasticsearch | Out | A server to run for one user. |
| Upstream repo + 4 forks | Nothing to reuse | 2 unanswered issues, no PRs; only fork Soforce touched search (TMF source filter). |
| Salesforce `llms.txt` + Markdown / JSON pages | **Pilot** | See *Sources* below. |

## Success criteria

All measured by `npm run test-search` (361 assertions, per-query ms) unless stated.

1. **No regression:** ≥ 353 / 361 passing (the `ab2e1e2` level); target ≥ 357.
2. **Speed:** median ≤ 20 ms, p90 ≤ 100 ms, max ≤ 300 ms over the 361 queries
   (today 90 / 588 / 1576 ms).
3. **Memory / startup:** server RSS ≤ 100 MB after first search; DB open ≤ 100 ms.
4. **Recency** — new test group, ~20 subject queries (e.g. "Chatter REST feed elements",
   "Metadata API deploy", "Apex REST service", "streaming API subscribe"): no document with
   API version < 50 in the top 3 unless the query names an old release or the document.
   Every result shows its release and API version.
5. **Edge cases still behave:** dotted names (`Database.getDeleted`), underscores/hyphens,
   wildcard and injection strings return results or a clean empty result, never an FTS syntax error.
6. **Pipeline:** `npm run update-docs` rebuilds the full-text index as part of `build-index`;
   `check-updates` and the weekly launchd job behave unchanged.
7. **Sources pilot (phase 3):** LWC questions ("wire decorator", "toast", "parent to child")
   return LWC Developer Guide pages on top; `Database.getDeleted` returns its current Apex
   Reference page.

## Scope

**In**
- Phase 1 — Engine: replace sql.js with `node:sqlite`; FTS5 index built by `build-index`;
  query translation (quote/escape terms, stopwords, AND-then-OR fallback); BM25 ranking blended
  with document priority; intent filters and LRU cache kept.
- Phase 2 — Recency: freshness weight per document, explicit `supersededBy` links for legacy
  documents, edition shown in results, recency test group.
- Phase 3 — Sources pilot: LWC Developer Guide from Salesforce's Markdown pages, Apex Developer
  Guide from the page JSON API; compare against the PDF version; go/no-go for wider use.

**Out**
- Embeddings, external search servers, a hosted service.
- Changing the 9 MCP tools' names or required parameters (an optional parameter may be added).
- Re-litigating settled decisions: guides replace in place, release notes accumulate, retired
  documents stay (`--prune` off), the scheduled job only notifies.
- Migrating all ~19k pages away from PDFs (decided after the pilot, not in this PRD).
- README/upstream "pure JavaScript" positioning — this fork diverges deliberately.

## Constraints

- Local-first, no new runtime dependency. Requires Node ≥ 22 for `node:sqlite`
  (exact minimum unverified — measured only on 26.12.1); `engines` in `package.json` moves up from `>=18`.
- The DB is regenerable and never versioned (Git LFS is poisoned). Keep a `.bak` of the current DB
  before the first v2 build.
- Disk: word index +58 MB (measured). Trigram index for substring matching +410 MB — decide in
  phase 1 (see open questions).
- Fetching stays in `scripts/lib/http.ts` (curl). Be polite to developer.salesforce.com: throttle,
  fetch per-guide versions first, pages only when the version changed.
- Running Claude Code sessions must be restarted after a re-index (unchanged).

## Design notes

### Recency ranking (phase 2)

Every document already carries `release` and `apiVersion` (manifest) and `documents.api_version`
(DB). Three mechanisms, simplest first:

1. **Freshness weight** in the final score:
   `score = bm25 × priorityWeight × freshness`, where `freshness` is 1.0 for documents on the
   current release (`urlKind: latest`) and decays with releases behind for pinned/static
   documents, with a floor (start: −3 % per release, floor 0.35; tuned against test-search).
   Release notes: no decay when the query names a release; otherwise newest first among
   release notes, and release notes rank below a current guide on the same subject.
2. **`supersededBy`** in the manifest for legacy documents whose subject a current guide covers
   (e.g. *Dbcom Apex Language Reference* → Apex Developer Guide / Apex Reference; *Dbcom Chatter
   Rest Api* → Connect REST API). Superseded documents get a strong penalty unless named in the
   query. This is a hand-maintained list (~30 entries expected); reviewed, not inferred.
3. **Edition in every result** ("Summer '12 · API 25.0 · legacy"), so Claude can see age and say so.

Rejected: automatic subject clustering across editions (complex, opaque; mechanisms 1–2 cover
the measured failures).

### Sources (phase 3) — findings, 2026-10-27

Verified by fetching:

- `developer.salesforce.com/robots.txt` points AI agents to `/llms.txt` and `/docs/llms.txt`;
  `/docs/` page and JSON endpoints are not disallowed.
- `/docs/llms.txt` lists ~60 product indexes. Newer guides (e.g. `llms-lwc.txt`, 862 lines) link to
  **Markdown pages** (`.../platform/lwc/guide/apex-call-imperative.md` → `text/markdown`, clean
  prose and fenced code blocks).
- `llms-product-docs.txt` lists **19,338 classic ("atlas") pages**: Apex Reference 8,773, Object
  Reference 1,895, Metadata API 707, Apex Developer Guide 548, Tooling API 347, UI API 269, and more.
  These link to HTML, not Markdown (`.md` variant returns HTML).
- The atlas **JSON API** returns per-page clean HTML with titles
  (`/docs/get_document_content/apexcode/apex_batch_interface.htm/en-us/262.0` →
  `{id, title, content}`; `Database.Batchable` spacing intact) and a per-guide TOC with
  `version` (`Winter '27`, API 68.0, doc 264.0), `available_versions` and `pdf_url`.

Implications: pages are natural chunks with real titles (better results than 1,500-char PDF
slices), version detection is one request per guide, and LWC becomes available at all.
Cost: thousands of requests instead of 345 PDFs, a per-page manifest, and an undocumented API
that may change.

## Plan

Each phase ends with test-search before/after and a sign-off before the next.

**Phase 1 — Engine**
1. Back up `data/salesforce-docs.db` → `.bak-<date>`. *(overwrites nothing; backup first)*
2. `build-index`: create FTS5 table (`porter unicode61`, `tokenchars '._'`) after chunks;
   `--changed-only` keeps it in sync. Decide on trigram (open question 1).
3. `database.ts`: open the DB file read-only with `node:sqlite`; drop sql.js.
4. `queries.ts`: translate queries to FTS5 syntax (quote every term, stopwords out, AND first,
   OR fallback), BM25 × priority, keep intent filters, cache, result shape.
5. Re-index. **⚠ Replaces `data/salesforce-docs.db`** (restorable from step 1's backup).
6. Measure against success criteria 1–3, 5, 6. Restart Claude Code sessions.

**Phase 2 — Recency**
7. Add `supersededBy` to the manifest (list shown to Jesse for review before writing).
8. Freshness weight + edition in output; add the recency test group; tune; measure criterion 4.

**Phase 3 — Sources pilot**
9. Fetch LWC Developer Guide (Markdown), Apex Developer Guide and Apex Reference Guide (JSON)
   into a pilot table; index alongside the PDFs.
10. Compare answers and test results; write the go/no-go with numbers.

Nothing in this plan touches Salesforce orgs, donor data or anything external beyond read-only
HTTP GETs to Salesforce's public documentation.

## Open questions

1. **Trigram index (+410 MB)?** It recovers substring matches in glued PDF text. If phase 3
   replaces the worst PDFs, it may not be worth the disk. *Assumption: start without it, add if
   edge-case tests fail.*
2. **Minimum Node version** for `node:sqlite` without a flag — unverified; only 26.12.1 tested.
3. **Terms of use** for bulk fetching developer.salesforce.com pages — not checked. robots.txt
   allows it and points AI agents there, but that isn't the terms.
4. **Release notes as HTML?** Not investigated; release notes may stay PDF.
5. **Manifest count mismatch:** 471 manifest entries vs 345 indexed documents (126 never indexed —
   likely not-yet-published / gone). Probably fine; confirm during phase 1.
6. **Freshness constants** (−3 %/release, floor 0.35) are a starting guess, to be tuned.
7. **Typo tolerance** — in scope or not? Options: FTS5 `fts5vocab` table + edit-distance
   correction of unknown terms before searching (cheap, local), or leave it to Claude to retry
   with a corrected query (the caller rarely misspells). *Assumption: out of scope; the 4 typo
   tests stay failing unless the trigram index happens to fix them.*
8. **Pilot scope: add the Apex Reference Guide?** `Database.getDeleted` / `getUpdated` return
   nothing under the `core_platform` filter because the current Apex Reference is not indexed.
   It is the largest atlas guide (8,773 pages). *Assumption: include it in the phase-3 pilot
   with the LWC and Apex Developer guides — it is the gap Claude hits most when writing Apex.*
