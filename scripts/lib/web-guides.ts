/**
 * Documentation guides read as web pages instead of PDFs (phase 3 of PRD_SEARCH_V2.md).
 *
 *   lwc      - Lightning Web Components Developer Guide, Markdown pages listed in /docs/llms-lwc.txt
 *   apexcode - Apex Developer Guide, per-page HTML from the atlas JSON API
 *   apexref  - Apex Reference Guide, same API
 *
 * State lives in two places:
 *   docs/web-guides.json        tracked; per guide: release, page count, hashes, fetchedAt
 *   docs/pages/<guide>/         git-ignored page cache, with index.json listing every page
 *
 * The site ignores conditional requests (If-None-Match answers 200, measured 2026-10-28) and the
 * LWC pages all carry the deploy time as Last-Modified, so a page edit is only visible by
 * downloading the page. The weekly check therefore compares what one request per guide can see
 * (its release and page list); sync downloads every page and compares content hashes.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import type { DatabaseSync } from "node:sqlite";

import { DocCategory, DocType } from "../../src/types.js";
import { download, mapWithConcurrency, sleep } from "./http.js";
import { PROJECT_ROOT } from "./manifest.js";
import type { Release } from "./release.js";
import type { Finding } from "./scan.js";
import { cleanMarkdown, htmlToText, packChunks, splitSections } from "./pages.js";

export const PAGES_DIR = join(PROJECT_ROOT, "docs", "pages");
export const WEB_GUIDES_PATH = join(PROJECT_ROOT, "docs", "web-guides.json");

const SITE = "https://developer.salesforce.com";
const MAX_CHUNK = 1500;
/**
 * developer.salesforce.com rate-limits with 403s: about 16 requests/s was blocked within a minute,
 * about 4/s ran 3,566 pages clean (both 2026-10-28); the block lasted about 30 min.
 * 2/s keeps a margin: a full sync takes about 30 min. Every request, across workers, waits its turn.
 */
const MIN_REQUEST_INTERVAL_MS = 500;
/** After a 403/429, wait this long and retry once; still blocked, stop the guide */
const BLOCKED_PAUSE_MS = 60_000;

let nextRequestAt = 0;
async function throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, nextRequestAt - now);
    nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
    if (wait) await sleep(wait);
}

const isBlocked = (status: number) => status === 403 || status === 429;

interface ListedPage {
    id: string;
    title: string;
    /** Public page a reader can open */
    url: string;
    fetchUrl: string;
}

interface Listing {
    /** The guide's own release; null when the source does not say (LWC Markdown) */
    release: string | null;
    apiVersion: string | null;
    /** Atlas doc version, e.g. "264.0"; changes when the guide moves to a new release */
    docVersion: string | null;
    pages: ListedPage[];
}

export interface WebGuide {
    id: string;
    title: string;
    /** documents.file_name in the index */
    fileName: string;
    subcategory: string;
    docType: DocType;
    keywords: string[];
    format: "markdown" | "html";
    /** Where the guide starts, for the document's source_url */
    homeUrl: string;
    list(): Promise<Listing>;
}

export interface GuideState {
    title: string;
    fileName: string;
    release: string | null;
    apiVersion: string | null;
    docVersion: string | null;
    pageCount: number;
    /** Hash of the sorted page ids and titles: what the weekly check compares */
    pageListHash: string;
    /** Hash of every page's content hash: what decides whether the guide is re-indexed */
    contentHash: string;
    /** When the content last changed (not when it was last downloaded) */
    fetchedAt: string;
}

interface WebGuidesFile {
    schemaVersion: 1;
    guides: Record<string, GuideState>;
}

interface PageEntry {
    id: string;
    title: string;
    url: string;
    file: string;
    sha256: string;
}

interface PageIndex {
    guide: string;
    pages: PageEntry[];
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function getText(url: string): Promise<string> {
    await throttle();
    const result = await download(url);
    if (!result.ok || !result.bytes) throw new Error(`${url}: ${result.error}`);
    return result.bytes.toString("utf8");
}

/** Atlas guides: one TOC request gives the version and every page. */
function atlasGuide(id: string, title: string, fileName: string, docType: DocType, keywords: string[]): WebGuide {
    return {
        id, title, fileName, subcategory: "apex", docType, keywords, format: "html",
        homeUrl: `${SITE}/docs/atlas.en-us.${id}.meta/${id}/`,
        async list() {
            const meta = JSON.parse(await getText(`${SITE}/docs/get_document/atlas.en-us.${id}.meta`));
            const docVersion: string = meta.version.doc_version;
            const pages = new Map<string, ListedPage>();
            const walk = (nodes: any[]) => {
                for (const node of nodes ?? []) {
                    const page = (node.a_attr?.href as string | undefined)?.split("#")[0];
                    if (page && !pages.has(page)) {
                        pages.set(page, {
                            id: page.replace(/\.htm$/, ""),
                            title: String(node.text ?? page),
                            url: `${SITE}/docs/atlas.en-us.${id}.meta/${id}/${page}`,
                            fetchUrl: `${SITE}/docs/get_document_content/${id}/${page}/en-us/${docVersion}`
                        });
                    }
                    walk(node.children);
                }
            };
            walk(meta.toc);
            return {
                release: String(meta.version.version_text ?? "").match(/^(Spring|Summer|Winter) '\d{2}/)?.[0] ?? null,
                apiVersion: meta.version.release_version ?? null,
                docVersion,
                pages: [...pages.values()]
            };
        }
    };
}

const LWC_INDEX = `${SITE}/docs/llms-lwc.txt`;
const LWC_SECTION = "## Lightning Web Components Developer Guide";

export const WEB_GUIDES: WebGuide[] = [
    {
        id: "lwc",
        title: "Lightning Web Components Developer Guide",
        fileName: "web_lwc_developer_guide",
        subcategory: "lightning",
        docType: DocType.DEVELOPER_GUIDE,
        keywords: ["lwc", "lightning web components", "component"],
        format: "markdown",
        homeUrl: `${SITE}/docs/platform/lwc/guide/`,
        async list() {
            const index = await getText(LWC_INDEX);
            const start = index.indexOf(LWC_SECTION);
            if (start < 0) throw new Error(`${LWC_INDEX}: section "${LWC_SECTION}" not found`);
            const end = index.indexOf("\n## ", start + LWC_SECTION.length);
            const section = index.slice(start, end < 0 ? undefined : end);
            const pages = [...section.matchAll(/^- \[(.+?)\]\((https:\/\/[^)]+\.md)\)/gm)].map(([, title, url]) => ({
                id: url.split("/").pop()!.replace(/\.md$/, ""),
                title,
                url: url.replace(/\.md$/, ".html"),
                fetchUrl: url
            }));
            return { release: null, apiVersion: null, docVersion: null, pages };
        }
    },
    atlasGuide("apexcode", "Apex Developer Guide", "web_apex_developer_guide", DocType.DEVELOPER_GUIDE, ["apex", "trigger", "batch", "test"]),
    atlasGuide("apexref", "Apex Reference Guide", "web_apex_reference_guide", DocType.API_REFERENCE, ["apex", "class", "method", "namespace"])
];

export function loadWebGuides(): WebGuidesFile {
    if (!existsSync(WEB_GUIDES_PATH)) return { schemaVersion: 1, guides: {} };
    return JSON.parse(readFileSync(WEB_GUIDES_PATH, "utf8")) as WebGuidesFile;
}

function saveWebGuides(file: WebGuidesFile): void {
    const tmp = `${WEB_GUIDES_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
    renameSync(tmp, WEB_GUIDES_PATH);
}

function pageIndexPath(guide: WebGuide): string {
    return join(PAGES_DIR, guide.id, "index.json");
}

function loadPageIndex(guide: WebGuide): PageIndex | null {
    const path = pageIndexPath(guide);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as PageIndex : null;
}

function pageListHash(pages: Array<{ id: string; title: string }>): string {
    return sha256(pages.map(page => `${page.id}\t${page.title}`).sort().join("\n"));
}

function contentHash(pages: PageEntry[]): string {
    return sha256(pages.map(page => `${page.id}:${page.sha256}`).sort().join("\n"));
}

/** What the index records as the guide's version: content plus release */
function indexKey(state: GuideState): string {
    return sha256(`${state.contentHash}|${state.apiVersion}`);
}

/** The guide's release; LWC Markdown carries none, so it is the release being synced to */
function releaseOf(listing: Listing, target: Release): { release: string; apiVersion: string } {
    return listing.release && listing.apiVersion
        ? { release: listing.release, apiVersion: listing.apiVersion }
        : { release: target.name, apiVersion: target.apiVersion };
}

// ---------------------------------------------------------------- check (read-only)

/** One request per guide. Findings use the same statuses as the PDF scan. */
export async function checkWebGuides(target: Release, filter: (id: string) => boolean = () => true): Promise<Finding[]> {
    const state = loadWebGuides();
    const findings: Finding[] = [];

    for (const guide of WEB_GUIDES) {
        if (!filter(guide.id) && !filter(guide.fileName)) continue;
        const recorded = state.guides[guide.id];
        const finding = (status: Finding["status"], reason: string, upstreamRelease: string | null = null): Finding => ({
            id: guide.fileName,
            fileName: guide.fileName,
            kind: "developer_guide",
            status,
            reason,
            checkedUrl: guide.homeUrl,
            localRelease: recorded?.release ?? null,
            targetRelease: upstreamRelease ?? target.name,
            local: { exists: loadPageIndex(guide) !== null, sizeBytes: null },
            upstream: { status: 200, etag: null, lastModified: null, sizeBytes: null }
        });

        let listing: Listing;
        try {
            listing = await guide.list();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A refusal (rate limit) says nothing about the guide, like a blocked PDF probe
            const status = /HTTP (403|429)\b/.test(message) ? "blocked" : "error";
            findings.push({ ...finding(status, `web guide: ${message}`), upstream: { status: 0, etag: null, lastModified: null, sizeBytes: null } });
            continue;
        }
        const upstream = releaseOf(listing, target);

        if (!recorded) {
            findings.push(finding("new-upstream", `web guide, ${listing.pages.length} pages, not fetched yet`, upstream.release));
        } else if (!loadPageIndex(guide)) {
            findings.push(finding("missing-locally", "web guide pages not on disk (docs/pages is not versioned)", upstream.release));
        } else if (listing.docVersion !== recorded.docVersion || Number(upstream.apiVersion) > Number(recorded.apiVersion)) {
            findings.push(finding("stale-baseline", `web guide moved from ${recorded.release} to ${upstream.release}`, upstream.release));
        } else if (pageListHash(listing.pages) !== recorded.pageListHash) {
            const before = new Set((loadPageIndex(guide)?.pages ?? []).map(page => page.id));
            const after = new Set(listing.pages.map(page => page.id));
            const added = [...after].filter(id => !before.has(id)).length;
            const removed = [...before].filter(id => !after.has(id)).length;
            findings.push(finding("changed", `web guide page list changed: ${added} added, ${removed} removed, ${listing.pages.length} pages`, upstream.release));
        } else {
            findings.push(finding("unchanged", `web guide, ${listing.pages.length} pages; page edits show only on sync`, upstream.release));
        }
    }
    return findings;
}

// ---------------------------------------------------------------- sync (downloads)

export interface SyncResult {
    guide: string;
    pages: number;
    changedPages: number;
    failed: Array<{ id: string; error: string }>;
    contentChanged: boolean;
    /** Set when the site kept refusing requests and the sync stopped early */
    blocked: boolean;
}

/** A Markdown page must not be an HTML error page; an atlas page must be {id, title, content} */
function validPage(format: WebGuide["format"], body: string): boolean {
    if (format === "markdown") return body.trim().length > 0 && !/^\s*<!DOCTYPE html/i.test(body);
    try {
        return typeof JSON.parse(body).content === "string";
    } catch {
        return false;
    }
}

/**
 * Download every page of a guide and record which ones changed. A page that fails keeps its
 * previous copy, so a transient error never drops a page from the index.
 */
export async function syncWebGuide(guide: WebGuide, target: Release, concurrency: number, log: (line: string) => void): Promise<SyncResult> {
    const dir = join(PAGES_DIR, guide.id);
    mkdirSync(dir, { recursive: true });
    const previous = new Map((loadPageIndex(guide)?.pages ?? []).map(page => [page.id, page]));
    const listing = await guide.list();
    const ext = guide.format === "markdown" ? "md" : "json";

    const failed: SyncResult["failed"] = [];
    let changedPages = 0;
    let done = 0;
    let blocked = false;
    let pausing: Promise<void> | null = null;
    const keepPrevious = (old: PageEntry | undefined): PageEntry | null => {
        if (!old || !existsSync(join(dir, old.file))) return null;
        // Page indexes from the pilot carry no hash: take it from the copy on disk
        return old.sha256 ? old : { ...old, sha256: sha256(readFileSync(join(dir, old.file), "utf8")) };
    };

    const entries = await mapWithConcurrency(listing.pages, concurrency, async page => {
        const file = `${page.id}.${ext}`;
        const old = previous.get(page.id);
        if (blocked) {
            failed.push({ id: page.id, error: "skipped: site is refusing requests" });
            return keepPrevious(old);
        }
        await throttle();
        let result = await download(page.fetchUrl);
        if (isBlocked(result.status)) {
            // One pause shared by all workers, then one retry
            pausing ??= (log(`  ${guide.id}: HTTP ${result.status}, pausing ${BLOCKED_PAUSE_MS / 1000} s`), sleep(BLOCKED_PAUSE_MS));
            await pausing;
            await throttle();
            result = await download(page.fetchUrl);
            if (isBlocked(result.status) && !blocked) {
                blocked = true;
                log(`  ${guide.id}: still HTTP ${result.status} after the pause; stopping, previous copies kept`);
            }
        }
        if (++done % 250 === 0) log(`  ${guide.id}: ${done}/${listing.pages.length}`);

        const body = result.bytes?.toString("utf8") ?? "";
        if (!result.ok || !validPage(guide.format, body)) {
            failed.push({ id: page.id, error: result.error ?? "not a documentation page" });
            return keepPrevious(old);
        }
        const hash = sha256(body);
        if (hash !== old?.sha256 || !existsSync(join(dir, file))) {
            writeFileSync(join(dir, file), body);
            changedPages++;
        }
        return { id: page.id, title: page.title, url: page.url, file, sha256: hash };
    });

    const pages = entries.filter((entry): entry is PageEntry => entry !== null);
    writeFileSync(pageIndexPath(guide), JSON.stringify({ guide: guide.id, pages } satisfies PageIndex, null, 2) + "\n");

    const file = loadWebGuides();
    const recorded = file.guides[guide.id];
    const hash = contentHash(pages);
    const { release, apiVersion } = releaseOf(listing, target);
    file.guides[guide.id] = {
        title: guide.title,
        fileName: guide.fileName,
        release,
        apiVersion,
        docVersion: listing.docVersion,
        pageCount: pages.length,
        pageListHash: pageListHash(listing.pages),
        contentHash: hash,
        fetchedAt: hash === recorded?.contentHash ? recorded.fetchedAt : new Date().toISOString()
    };
    saveWebGuides(file);
    return { guide: guide.id, pages: pages.length, changedPages, failed, contentChanged: hash !== recorded?.contentHash, blocked };
}

// ---------------------------------------------------------------- index

function pageText(guide: WebGuide, raw: string): { title: string; text: string } {
    if (guide.format === "markdown") return { title: "", text: cleanMarkdown(raw) };
    const page = JSON.parse(raw) as { title: string; content: string };
    return { title: page.title, text: htmlToText(page.content) };
}

/**
 * Reference pages title methods by their bare name ("getDeleted(sObjectType, ...)") under a page
 * titled "Database Class". Add the qualified name so a query for "Database.getDeleted" matches
 * the method's own section, not only pages that happen to spell it out.
 */
function qualifiedName(pageTitle: string, heading: string | null): string | null {
    const owner = pageTitle.match(/^([\w.]+) (?:Class|Interface|Enum)$/)?.[1];
    return owner && heading && /^\w+\(/.test(heading) ? `${owner}.${heading}` : null;
}

/** Guides whose pages are on disk but whose current content is not what the index holds */
export function webGuidesNeedingIndex(db: DatabaseSync, filter: (id: string) => boolean = () => true): WebGuide[] {
    const state = loadWebGuides();
    const indexed = db.prepare("SELECT sha256 FROM documents WHERE file_name = ?");
    return WEB_GUIDES.filter(guide => {
        const recorded = state.guides[guide.id];
        if (!recorded || !loadPageIndex(guide) || !(filter(guide.id) || filter(guide.fileName))) return false;
        return indexed.get(guide.fileName)?.sha256 !== indexKey(recorded);
    });
}

/**
 * (Re)index one guide as one document. Each page section becomes chunks that start with its
 * "Page › Section" title; the title also goes to chunks.search_title, which the full-text index
 * weights above body text. The caller rebuilds the full-text index afterwards.
 */
export function indexWebGuide(db: DatabaseSync, guide: WebGuide): { pages: number; chunks: number } {
    const recorded = loadWebGuides().guides[guide.id];
    const pageIndex = loadPageIndex(guide);
    if (!recorded || !pageIndex) throw new Error(`${guide.id}: not synced (npm run sync-web -- --only ${guide.id})`);
    const dir = join(PAGES_DIR, guide.id);

    db.prepare("DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE file_name = ?)").run(guide.fileName);
    db.prepare("DELETE FROM documents WHERE file_name = ?").run(guide.fileName);
    const documentId = Number(db.prepare(`
        INSERT INTO documents (file_name, file_path, category, subcategory, doc_type, title, keywords, api_version,
            last_updated, source_url, sha256, page_count, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 9)
    `).run(
        guide.fileName, `docs/pages/${guide.id}`, DocCategory.CORE_PLATFORM, guide.subcategory, guide.docType,
        guide.title, JSON.stringify(guide.keywords), recorded.apiVersion, recorded.release, guide.homeUrl,
        indexKey(recorded), pageIndex.pages.length
    ).lastInsertRowid);

    const chunks = insertPageChunks(db, documentId, pageIndex.pages.map(page => {
        const { title, text } = pageText(guide, readFileSync(join(dir, page.file), "utf8"));
        return { title: title || page.title, text, url: page.url };
    }));
    return { pages: pageIndex.pages.length, chunks };
}

/**
 * Write a document's pages as chunks: each page section becomes chunks that start with its
 * "Page › Section" title, which also goes to chunks.search_title (weighted in the full-text index).
 * Shared by web guides and Help snapshots. Returns the number of chunks.
 */
export function insertPageChunks(db: DatabaseSync, documentId: number, pages: Array<{ title: string; text: string; url: string }>): number {
    const insertChunk = db.prepare(`
        INSERT INTO chunks (document_id, chunk_index, content, content_lower, section_title, page_number, page_url, search_title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let chunkIndex = 0;
    pages.forEach((page, pageNumber) => {
        for (const section of splitSections(page.title, page.text)) {
            const qualified = qualifiedName(page.title, section.heading);
            const header = qualified ? `${section.title}\n${qualified}` : section.title;
            for (const piece of packChunks(section.text, MAX_CHUNK)) {
                const content = `${header}\n\n${piece}`;
                insertChunk.run(documentId, chunkIndex++, content, content.toLowerCase(), section.title, pageNumber + 1, page.url, header);
            }
        }
    });
    return chunkIndex;
}
