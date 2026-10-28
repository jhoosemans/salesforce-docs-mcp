#!/usr/bin/env node
/**
 * Phase 3 pilot: index the guides fetched by fetch-pages into a copy of the live index.
 *
 * Each guide becomes one document; each page section (a method, a heading) becomes one or more
 * chunks that start with their "Page › Section" title, so the title is searchable too.
 * The live index is never written: the output is data/pilot.db, rebuilt from a fresh copy
 * on every run.
 *
 * Usage: npm run index-pages -- [--only lwc,apexref] [--replace-pdf] [--out data/pilot.db]
 *   --replace-pdf  mark the PDF edition of a piloted guide as superseded by the web edition
 */

import { copyFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";
import { chunkText } from "../src/utils/chunker.js";
import { rebuildFtsIndex } from "../src/db/fts.js";
import { DocCategory, DocType } from "../src/types.js";
import { makeFilter, parseArgs } from "./lib/args.js";
import { estimatedCurrentRelease } from "./lib/release.js";
import { cleanMarkdown, htmlToText, splitSections } from "./lib/pages.js";
import { PAGES_DIR, type GuideIndex } from "./fetch-pages.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DB = join(PROJECT_ROOT, "data", "salesforce-docs.db");
const MAX_CHUNK = 1500;

interface GuideTarget {
    fileName: string;
    subcategory: string;
    docType: DocType;
    keywords: string[];
    /** The PDF this guide would replace, if it is in the corpus */
    pdf: string | null;
}

const TARGETS: Record<string, GuideTarget> = {
    lwc: { fileName: "web_lwc_developer_guide", subcategory: "lightning", docType: DocType.DEVELOPER_GUIDE, keywords: ["lwc", "lightning web components", "component"], pdf: null },
    apexcode: { fileName: "web_apex_developer_guide", subcategory: "apex", docType: DocType.DEVELOPER_GUIDE, keywords: ["apex", "trigger", "batch", "test"], pdf: "salesforce_apex_developer_guide.pdf" },
    apexref: { fileName: "web_apex_reference_guide", subcategory: "apex", docType: DocType.API_REFERENCE, keywords: ["apex", "class", "method", "namespace"], pdf: null }
};

function pageText(index: GuideIndex, raw: string): { title: string; text: string } {
    if (index.format === "markdown") return { title: "", text: cleanMarkdown(raw) };
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

function indexGuide(db: DatabaseSync, name: string, target: GuideTarget): { pages: number; chunks: number } {
    const dir = join(PAGES_DIR, name);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as GuideIndex;
    // The Markdown guide carries no release; it tracks the current one
    const current = estimatedCurrentRelease(new Date(index.fetchedAt));
    const release = index.release ?? current.name;
    const apiVersion = index.apiVersion ?? current.apiVersion;

    db.prepare("DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE file_name = ?)").run(target.fileName);
    db.prepare("DELETE FROM documents WHERE file_name = ?").run(target.fileName);
    const documentId = Number(db.prepare(`
        INSERT INTO documents (file_name, file_path, category, subcategory, doc_type, title, keywords, api_version,
            last_updated, source_url, page_count, priority, edition, edition_label, freshness)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
        target.fileName, relative(PROJECT_ROOT, dir), DocCategory.CORE_PLATFORM, target.subcategory, target.docType,
        index.title, JSON.stringify(target.keywords), apiVersion, release, index.pages[0]?.url ?? null,
        index.pages.length, 9, Number(apiVersion), `${release} (API ${apiVersion}), web pages`
    ).lastInsertRowid);

    const insertChunk = db.prepare(`
        INSERT INTO chunks (document_id, chunk_index, content, content_lower, section_title, page_number)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    let chunkIndex = 0;
    index.pages.forEach((page, pageNumber) => {
        const { title, text } = pageText(index, readFileSync(join(dir, page.file), "utf8"));
        const pageTitle = title || page.title;
        for (const section of splitSections(pageTitle, text)) {
            const qualified = qualifiedName(pageTitle, section.heading);
            const header = qualified ? `${section.title}\n${qualified}` : section.title;
            const pieces = section.text.length <= MAX_CHUNK
                ? [section.text]
                : chunkText(section.text, { maxChunkSize: MAX_CHUNK, overlapSize: 150 }).map(chunk => chunk.content);
            for (const piece of pieces) {
                if (piece.trim().length === 0) continue;
                const content = `${header}\n\n${piece}`;
                insertChunk.run(documentId, chunkIndex++, content, content.toLowerCase(), section.title, pageNumber + 1);
            }
        }
    });
    return { pages: index.pages.length, chunks: chunkIndex };
}

function main(): void {
    const args = parseArgs();
    const only = makeFilter(args.values.get("only"));
    const out = join(PROJECT_ROOT, args.values.get("out") ?? join("data", "pilot.db"));
    if (out === LIVE_DB) throw new Error("index-pages never writes the live index; pass another --out");

    rmSync(out, { force: true });
    copyFileSync(LIVE_DB, out);
    const db = new DatabaseSync(out);
    db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; BEGIN");

    for (const [name, target] of Object.entries(TARGETS)) {
        if (!only(name)) continue;
        if (!existsSync(join(PAGES_DIR, name, "index.json"))) {
            console.log(`${name}: not fetched (npm run fetch-pages -- --only ${name})`);
            continue;
        }
        const { pages, chunks } = indexGuide(db, name, target);
        console.log(`${name}: ${pages} pages -> ${chunks} chunks as ${target.fileName}`);
        if (args.flags.has("replace-pdf") && target.pdf) {
            const result = db.prepare("UPDATE documents SET superseded_by = ?, freshness = freshness * 0.25 WHERE file_name = ?").run(target.fileName, target.pdf);
            console.log(`  ${target.pdf}: ${Number(result.changes) ? "marked superseded" : "not in the index"}`);
        }
    }
    db.exec("COMMIT");
    rebuildFtsIndex(db);
    db.close();
    console.log(`Pilot index: ${out}`);
}

main();
