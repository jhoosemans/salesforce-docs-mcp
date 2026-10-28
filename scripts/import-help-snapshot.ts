#!/usr/bin/env node
/**
 * Write Salesforce Help articles read in a browser into docs/help/<snapshot>/ (see
 * scripts/lib/help-snapshots.ts). The input is the export from scripts/help-snapshot-reader.js:
 * a JSON array of {id, title, listTitle, level, group, url, savedAt, html}, or a Claude Code
 * tool-result file wrapping it ([{type, text}]).
 *
 *   npm run import-help-snapshot -- --snapshot sso --title "Salesforce Help: Single Sign-On" <export.json>
 *
 * Replaces the snapshot folder's index.json; article files are overwritten by id.
 * Then: npm run build-index -- --changed-only
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "./lib/args.js";
import { HELP_DIR } from "./lib/help-snapshots.js";

interface ExportedArticle {
    id: string;
    title?: string;
    listTitle: string;
    level: number;
    group: string;
    url: string;
    savedAt: string;
    html: string;
}

function readExport(path: string): ExportedArticle[] {
    let value: unknown = JSON.parse(readFileSync(path, "utf8"));
    // A tool-result file wraps the page's return value, followed by a "(captured at origin ...)" trailer
    if (Array.isArray(value) && (value[0] as any)?.type === "text") {
        value = JSON.parse(String((value[0] as any).text).replace(/\n\s*\(captured at origin[\s\S]*$/, "").trim());
    }
    if (typeof value === "string") value = JSON.parse(value);
    if (!Array.isArray(value)) throw new Error(`${path}: expected an array of articles`);
    return value as ExportedArticle[];
}

function main(): void {
    const args = parseArgs();
    const snapshot = args.values.get("snapshot");
    const title = args.values.get("title");
    const input = args.positional[0];
    if (!snapshot || !title || !input) throw new Error("Usage: import-help-snapshot --snapshot <id> --title <title> <export.json>");

    const articles = readExport(input).filter(article => article.html && article.html.length > 0);
    const dir = join(HELP_DIR, snapshot);
    mkdirSync(dir, { recursive: true });

    const entries = articles.map(article => {
        const file = `${article.id.replace(/^xcloud\./, "").replace(/\.htm$/, "")}.html`;
        writeFileSync(join(dir, file), article.html);
        return { id: article.id, title: article.title || article.listTitle, url: article.url, file, level: article.level, group: article.group };
    });
    const savedAt = articles.map(article => article.savedAt).sort()[0];
    writeFileSync(join(dir, "index.json"), JSON.stringify({ title, savedAt, articles: entries }, null, 2) + "\n");
    console.log(`${entries.length} articles written to docs/help/${snapshot}/ (saved ${savedAt.slice(0, 10)})`);
}

main();
