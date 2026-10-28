/**
 * Salesforce Help articles saved once, by hand, as a dated snapshot.
 *
 * Help (help.salesforce.com) has no PDF or machine-readable route for some subjects - single
 * sign-on is documented in detail only there. A snapshot is a folder of saved article bodies:
 *
 *   docs/help/<snapshot>/index.json    title, savedAt, articles [{id, title, url, file, level, group}]
 *   docs/help/<snapshot>/<id>.html     the article body (Help's slds-text-longform element)
 *
 * docs/help/ is git-ignored: the content is Salesforce's, for local use only, and must not be
 * committed or shipped in a shared index. No check can see Help change; refresh by hand.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { DatabaseSync } from "node:sqlite";

import { DocCategory, DocType } from "../../src/types.js";
import { PROJECT_ROOT } from "./manifest.js";
import { estimatedCurrentRelease } from "./release.js";
import { htmlToText } from "./pages.js";
import { insertPageChunks } from "./web-guides.js";

export const HELP_DIR = join(PROJECT_ROOT, "docs", "help");

export interface HelpSnapshot {
    id: string;
    /** documents.file_name in the index */
    fileName: string;
    title: string;
    category: DocCategory;
    /** Must match the subcategory intent detection routes to (src/utils/intent.ts) */
    subcategory: string;
    keywords: string[];
}

export const HELP_SNAPSHOTS: HelpSnapshot[] = [
    {
        id: "sso",
        fileName: "help_single_sign_on",
        title: "Salesforce Help: Single Sign-On",
        category: DocCategory.SECURITY,
        subcategory: "security",
        keywords: ["sso", "saml", "auth provider", "openid connect", "identity provider", "jit"]
    }
];

interface SnapshotIndex {
    title: string;
    savedAt: string;
    articles: Array<{ id: string; title: string; url: string; file: string; level: number; group: string }>;
}

function loadSnapshot(snapshot: HelpSnapshot): SnapshotIndex | null {
    const path = join(HELP_DIR, snapshot.id, "index.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SnapshotIndex : null;
}

/** Hash of every saved article: re-index only when the snapshot was refreshed */
function snapshotKey(snapshot: HelpSnapshot, index: SnapshotIndex): string {
    const hash = createHash("sha256").update(index.savedAt);
    for (const article of index.articles) hash.update(readFileSync(join(HELP_DIR, snapshot.id, article.file)));
    return hash.digest("hex");
}

/**
 * Article body HTML to text, starting at the article's title (drops Help's breadcrumb list).
 * "Required Editions" and "User Permissions" stay in the article's lead section: as sections of
 * their own they are boilerplate that the weighted title pushes up the results.
 */
function articleText(html: string): string {
    const text = htmlToText(html.replace(/<nav\b[\s\S]*?<\/nav>/gi, ""))
        .replace(/^#{1,3} (Required Editions|User Permissions(?: Needed)?)\s*$/gim, "**$1**");
    const title = text.search(/^# /m);
    return title > 0 ? text.slice(title) : text;
}

export function snapshotsNeedingIndex(db: DatabaseSync, filter: (id: string) => boolean = () => true): HelpSnapshot[] {
    const indexed = db.prepare("SELECT sha256 FROM documents WHERE file_name = ?");
    return HELP_SNAPSHOTS.filter(snapshot => {
        if (!(filter(snapshot.id) || filter(snapshot.fileName))) return false;
        const index = loadSnapshot(snapshot);
        return index !== null && indexed.get(snapshot.fileName)?.sha256 !== snapshotKey(snapshot, index);
    });
}

/** (Re)index a snapshot as one document, dated by when it was saved. */
export function indexSnapshot(db: DatabaseSync, snapshot: HelpSnapshot): { pages: number; chunks: number } {
    const index = loadSnapshot(snapshot);
    if (!index) throw new Error(`${snapshot.id}: no snapshot in docs/help/${snapshot.id}`);
    const saved = new Date(index.savedAt);
    const release = estimatedCurrentRelease(saved);

    db.prepare("DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE file_name = ?)").run(snapshot.fileName);
    db.prepare("DELETE FROM documents WHERE file_name = ?").run(snapshot.fileName);
    const documentId = Number(db.prepare(`
        INSERT INTO documents (file_name, file_path, category, subcategory, doc_type, title, keywords, api_version,
            last_updated, source_url, sha256, page_count, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 8)
    `).run(
        snapshot.fileName, `docs/help/${snapshot.id}`, snapshot.category, snapshot.subcategory, DocType.IMPLEMENTATION_GUIDE,
        `${snapshot.title} (saved ${index.savedAt.slice(0, 10)})`, JSON.stringify(snapshot.keywords), release.apiVersion,
        release.name, index.articles[0]?.url ?? null, snapshotKey(snapshot, index), index.articles.length
    ).lastInsertRowid);

    const chunks = insertPageChunks(db, documentId, index.articles.map(article => ({
        title: article.title,
        text: articleText(readFileSync(join(HELP_DIR, snapshot.id, article.file), "utf8")),
        url: article.url
    })));
    return { pages: index.articles.length, chunks };
}
