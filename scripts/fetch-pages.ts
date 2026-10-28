#!/usr/bin/env node
/**
 * Phase 3 pilot: fetch documentation guides page by page instead of as PDFs.
 *
 *   lwc      - Lightning Web Components Developer Guide, Markdown pages listed in /docs/llms-lwc.txt
 *   apexcode - Apex Developer Guide, per-page HTML from the atlas JSON API
 *   apexref  - Apex Reference Guide, same API
 *
 * Pages land in docs/pages/<guide>/ with an index.json (title, version, page list, ETags).
 * Resumable: a page already on disk is not fetched again unless --refresh is passed.
 *
 * Usage: npm run fetch-pages -- [--only lwc,apexref] [--concurrency 4] [--refresh]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { download, mapWithConcurrency, sleep } from "./lib/http.js";
import { makeFilter, numberOption, parseArgs } from "./lib/args.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PAGES_DIR = join(PROJECT_ROOT, "docs", "pages");

const SITE = "https://developer.salesforce.com";
const LWC_INDEX = `${SITE}/docs/llms-lwc.txt`;
const LWC_SECTION = "## Lightning Web Components Developer Guide";

export interface PageEntry {
    id: string;
    title: string;
    /** Public page users can open */
    url: string;
    /** File under docs/pages/<guide>/ */
    file: string;
    etag: string | null;
}

export interface GuideIndex {
    guide: string;
    title: string;
    /** "Winter '27", when the source says so */
    release: string | null;
    apiVersion: string | null;
    format: "markdown" | "html";
    fetchedAt: string;
    pages: PageEntry[];
    failed: Array<{ id: string; error: string }>;
}

interface GuideSource {
    title: string;
    format: "markdown" | "html";
    list(): Promise<{ release: string | null; apiVersion: string | null; pages: Array<{ id: string; title: string; url: string; fetchUrl: string }> }>;
}

async function getText(url: string): Promise<string> {
    const result = await download(url);
    if (!result.ok || !result.bytes) throw new Error(`${url}: ${result.error}`);
    return result.bytes.toString("utf8");
}

/** Atlas guides (apexcode, apexref): one TOC request gives the version and every page. */
function atlasGuide(deliverable: string, title: string): GuideSource {
    return {
        title,
        format: "html",
        async list() {
            const meta = JSON.parse(await getText(`${SITE}/docs/get_document/atlas.en-us.${deliverable}.meta`));
            const docVersion: string = meta.version.doc_version;
            const versionText: string = meta.version.version_text ?? "";
            const pages = new Map<string, { id: string; title: string; url: string; fetchUrl: string }>();
            const walk = (nodes: any[]) => {
                for (const node of nodes ?? []) {
                    const href: string | undefined = node.a_attr?.href;
                    const page = href?.split("#")[0];
                    if (page && !pages.has(page)) {
                        pages.set(page, {
                            id: page.replace(/\.htm$/, ""),
                            title: String(node.text ?? page),
                            url: `${SITE}/docs/atlas.en-us.${deliverable}.meta/${deliverable}/${page}`,
                            fetchUrl: `${SITE}/docs/get_document_content/${deliverable}/${page}/en-us/${docVersion}`
                        });
                    }
                    walk(node.children);
                }
            };
            walk(meta.toc);
            return {
                release: versionText.match(/^(Spring|Summer|Winter) '\d{2}/)?.[0] ?? null,
                apiVersion: meta.version.release_version ?? null,
                pages: [...pages.values()]
            };
        }
    };
}

const GUIDES: Record<string, GuideSource> = {
    lwc: {
        title: "Lightning Web Components Developer Guide",
        format: "markdown",
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
            // The Markdown pages carry no release; the guide tracks the current one
            return { release: null, apiVersion: null, pages };
        }
    },
    apexcode: atlasGuide("apexcode", "Apex Developer Guide"),
    apexref: atlasGuide("apexref", "Apex Reference Guide")
};

/** An atlas page answers 200 with {id, title, content}; anything else is a failure. */
function validPage(format: "markdown" | "html", body: string): boolean {
    if (format === "markdown") return !/^\s*<!DOCTYPE html/i.test(body) && body.trim().length > 0;
    try {
        return typeof JSON.parse(body).content === "string";
    } catch {
        return false;
    }
}

async function fetchGuide(name: string, source: GuideSource, concurrency: number, refresh: boolean): Promise<GuideIndex> {
    const dir = join(PAGES_DIR, name);
    mkdirSync(dir, { recursive: true });
    const indexPath = join(dir, "index.json");
    const previous: GuideIndex | null = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : null;
    const etags = new Map((previous?.pages ?? []).map(page => [page.id, page.etag]));

    const { release, apiVersion, pages } = await source.list();
    console.log(`${name}: ${pages.length} pages${release ? `, ${release}` : ""}${apiVersion ? ` (API ${apiVersion})` : ""}`);

    const ext = source.format === "markdown" ? "md" : "json";
    const failed: GuideIndex["failed"] = [];
    let fetched = 0;
    const entries = await mapWithConcurrency(pages, concurrency, async page => {
        const file = `${page.id}.${ext}`;
        const path = join(dir, file);
        const entry: PageEntry = { id: page.id, title: page.title, url: page.url, file, etag: etags.get(page.id) ?? null };
        if (!refresh && existsSync(path)) return entry;

        const result = await download(page.fetchUrl);
        const body = result.bytes?.toString("utf8") ?? "";
        if (!result.ok || !validPage(source.format, body)) {
            failed.push({ id: page.id, error: result.error ?? "not a documentation page" });
            return null;
        }
        writeFileSync(path, body);
        entry.etag = result.etag;
        if (++fetched % 100 === 0) console.log(`  ${name}: ${fetched} fetched`);
        await sleep(100);
        return entry;
    });

    const index: GuideIndex = {
        guide: name,
        title: source.title,
        release,
        apiVersion,
        format: source.format,
        fetchedAt: new Date().toISOString(),
        pages: entries.filter((entry): entry is PageEntry => entry !== null),
        failed
    };
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
    console.log(`${name}: ${fetched} fetched, ${index.pages.length - fetched} already on disk, ${failed.length} failed`);
    return index;
}

async function main(): Promise<void> {
    const args = parseArgs();
    const only = makeFilter(args.values.get("only"));
    const concurrency = numberOption(args, "concurrency", 4);
    const refresh = args.flags.has("refresh");

    let failures = 0;
    for (const [name, source] of Object.entries(GUIDES)) {
        if (!only(name)) continue;
        const index = await fetchGuide(name, source, concurrency, refresh);
        failures += index.failed.length;
        for (const failure of index.failed.slice(0, 10)) console.log(`  failed ${failure.id}: ${failure.error}`);
    }
    process.exitCode = failures > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
