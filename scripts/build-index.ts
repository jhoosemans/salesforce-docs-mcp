/**
 * Build Index Script
 *
 * Parses PDF files and builds the SQLite search index.
 * Writes with node:sqlite and builds the FTS5 full-text index (src/db/fts.ts) before the swap.
 *
 *   npm run build-index                      # full rebuild (every PDF, ~5-10 min)
 *   npm run build-index -- --changed-only    # only what sync-docs just fetched (seconds)
 *   npm run build-index -- --changed-only --prune
 *
 * Options:
 *   --changed-only   Re-index only documents the manifest marks as fetched but
 *                    not yet indexed. Requires an existing database.
 *   --prune          Also drop documents whose PDF is no longer on disk.
 *   --allow-shrink   Let a full build replace an index that holds more documents
 *                    (the live index keeps documents whose PDF is not on this machine).
 *   --only <list>    Restrict to matching ids/substrings/globs.
 *   --dry-run        Report what would be indexed; write nothing.
 *
 * Every indexed document records the release it came from (api_version), its
 * source URL and its sha256, so search results can say which release they
 * describe and the next incremental build knows what is already current.
 */

/// <reference path="../src/types/node-sqlite.d.ts" />
/// <reference path="../src/types/pdf-parse.d.ts" />

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from "fs";
import { join, basename } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { DatabaseSync } from "node:sqlite";
import pdfParse from "pdf-parse";

import { chunkText, cleanPdfText } from "../src/utils/chunker.js";
import { hasFtsIndex, rebuildFtsIndex } from "../src/db/fts.js";
import { DocCategory, DocType } from "../src/types.js";
import { makeFilter, parseArgs } from "./lib/args.js";
import { sha256 } from "./lib/http.js";
import { estimatedCurrentRelease, releaseFromFileName } from "./lib/release.js";
import { inspectLocal } from "./lib/local.js";
import {
    Manifest,
    ManifestDocument,
    MANIFEST_PATH,
    documentPath,
    loadManifest,
    saveManifest
} from "./lib/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, "..");
const PDF_DIR = join(PROJECT_ROOT, "docs", "pdfs");
const RELEASE_NOTES_DIR = join(PROJECT_ROOT, "docs", "release-notes");
const DATA_DIR = join(PROJECT_ROOT, "data");
const DB_PATH = join(DATA_DIR, "salesforce-docs.db");
const SUPERSEDED_PATH = join(PROJECT_ROOT, "docs", "superseded.json");

// Freshness: a document's weight in search ranking by how many releases it trails the
// newest document in the index. 0.97 per release (10 releases ~ 3 years -> 0.74), never
// below 0.35 so old documents stay findable; superseded documents (docs/superseded.json)
// get a further 0.25.
const FRESHNESS_DECAY_PER_RELEASE = 0.97;
const FRESHNESS_FLOOR = 0.35;
const SUPERSEDED_FACTOR = 0.25;

// Document mapping based on filename patterns
const DOCUMENT_PATTERNS: Array<{
    pattern: RegExp;
    category: DocCategory;
    subcategory: string;
    docType: DocType;
    priority: number;
    keywords: string[];
}> = [
    { pattern: /apex/i, category: DocCategory.CORE_PLATFORM, subcategory: "apex", docType: DocType.DEVELOPER_GUIDE, priority: 9, keywords: ["apex", "class", "trigger", "dml"] },
    { pattern: /lwc|lightning/i, category: DocCategory.CORE_PLATFORM, subcategory: "lightning", docType: DocType.DEVELOPER_GUIDE, priority: 9, keywords: ["lwc", "lightning", "component", "aura"] },
    { pattern: /visualforce|pages_dev/i, category: DocCategory.CORE_PLATFORM, subcategory: "visualforce", docType: DocType.DEVELOPER_GUIDE, priority: 7, keywords: ["visualforce", "page", "controller"] },
    { pattern: /soql|sosl|query/i, category: DocCategory.CORE_PLATFORM, subcategory: "soql_sosl", docType: DocType.DEVELOPER_GUIDE, priority: 9, keywords: ["soql", "sosl", "query", "search"] },
    { pattern: /formula|validation/i, category: DocCategory.CORE_PLATFORM, subcategory: "formulas", docType: DocType.DEVELOPER_GUIDE, priority: 7, keywords: ["formula", "validation"] },
    { pattern: /api_rest|rest_api/i, category: DocCategory.APIS, subcategory: "rest_api", docType: DocType.API_REFERENCE, priority: 10, keywords: ["rest", "api", "http", "endpoint"] },
    { pattern: /bulk/i, category: DocCategory.APIS, subcategory: "bulk_api", docType: DocType.API_REFERENCE, priority: 8, keywords: ["bulk", "api", "data loading"] },
    { pattern: /meta/i, category: DocCategory.APIS, subcategory: "metadata_api", docType: DocType.API_REFERENCE, priority: 9, keywords: ["metadata", "deploy", "retrieve"] },
    { pattern: /tooling/i, category: DocCategory.APIS, subcategory: "tooling_api", docType: DocType.API_REFERENCE, priority: 8, keywords: ["tooling", "api", "development"] },
    { pattern: /streaming|platform_events|change_data/i, category: DocCategory.APIS, subcategory: "streaming_api", docType: DocType.API_REFERENCE, priority: 8, keywords: ["streaming", "events", "cdc"] },
    { pattern: /^api\.|sforce_api|soap/i, category: DocCategory.APIS, subcategory: "soap_api", docType: DocType.API_REFERENCE, priority: 7, keywords: ["soap", "api", "wsdl"] },
    { pattern: /chatter/i, category: DocCategory.APIS, subcategory: "chatter_api", docType: DocType.API_REFERENCE, priority: 6, keywords: ["chatter", "social", "feed"] },
    { pattern: /analytics|bi_dev/i, category: DocCategory.APIS, subcategory: "analytics_api", docType: DocType.API_REFERENCE, priority: 7, keywords: ["analytics", "tableau", "reports"] },
    { pattern: /sfdx|sf_cli/i, category: DocCategory.DEV_TOOLS, subcategory: "sfdx_cli", docType: DocType.DEVELOPER_GUIDE, priority: 9, keywords: ["sfdx", "cli", "scratch org", "deploy"] },
    { pattern: /pkg|package|isv/i, category: DocCategory.DEV_TOOLS, subcategory: "packaging", docType: DocType.DEVELOPER_GUIDE, priority: 8, keywords: ["package", "2gp", "1gp", "managed"] },
    { pattern: /devops|migration/i, category: DocCategory.DEV_TOOLS, subcategory: "devops", docType: DocType.DEVELOPER_GUIDE, priority: 7, keywords: ["devops", "ci/cd", "pipeline"] },
    { pattern: /mobile|sdk/i, category: DocCategory.DEV_TOOLS, subcategory: "mobile_sdk", docType: DocType.DEVELOPER_GUIDE, priority: 6, keywords: ["mobile", "sdk", "ios", "android"] },
    { pattern: /sales_|cpq/i, category: DocCategory.CLOUDS, subcategory: "sales_cloud", docType: DocType.DEVELOPER_GUIDE, priority: 7, keywords: ["sales", "opportunity", "cpq", "quote"] },
    { pattern: /service_|case|chat|voice|field_service|knowledge/i, category: DocCategory.CLOUDS, subcategory: "service_cloud", docType: DocType.DEVELOPER_GUIDE, priority: 7, keywords: ["service", "case", "knowledge", "chat"] },
    { pattern: /communities|experience|exp_cloud/i, category: DocCategory.CLOUDS, subcategory: "experience_cloud", docType: DocType.DEVELOPER_GUIDE, priority: 7, keywords: ["community", "experience", "portal", "site"] },
    { pattern: /marketing|buddymedia|radian/i, category: DocCategory.CLOUDS, subcategory: "marketing_cloud", docType: DocType.DEVELOPER_GUIDE, priority: 5, keywords: ["marketing", "campaign", "email"] },
    { pattern: /health|fsc|insurance|automotive|edu_cloud|nonprofit|life_sciences|media|retail|mfg/i, category: DocCategory.CLOUDS, subcategory: "industry_clouds", docType: DocType.DEVELOPER_GUIDE, priority: 6, keywords: ["industry", "vertical"] },
    { pattern: /security|identity|secure_coding|restriction|access/i, category: DocCategory.SECURITY, subcategory: "security", docType: DocType.IMPLEMENTATION_GUIDE, priority: 8, keywords: ["security", "authentication", "authorization", "sharing"] },
    { pattern: /integration|canvas|federated|connect/i, category: DocCategory.INTEGRATION, subcategory: "integration", docType: DocType.DEVELOPER_GUIDE, priority: 7, keywords: ["integration", "external", "connect"] },
    { pattern: /limits|large_data|bp|best_practice/i, category: DocCategory.BEST_PRACTICES, subcategory: "limits", docType: DocType.DEVELOPER_GUIDE, priority: 8, keywords: ["limits", "governor", "performance"] },
    { pattern: /cheatsheet|static_sf/i, category: DocCategory.BEST_PRACTICES, subcategory: "cheatsheets", docType: DocType.CHEATSHEET, priority: 8, keywords: ["cheatsheet", "quick reference"] },
    { pattern: /workbook/i, category: DocCategory.BEST_PRACTICES, subcategory: "workbooks", docType: DocType.WORKBOOK, priority: 7, keywords: ["workbook", "tutorial", "hands-on"] },
    { pattern: /release/i, category: DocCategory.RELEASE_NOTES, subcategory: "release_notes", docType: DocType.RELEASE_NOTES, priority: 6, keywords: ["release", "new feature", "what's new"] },
    { pattern: /object|data|field/i, category: DocCategory.CORE_PLATFORM, subcategory: "data_model", docType: DocType.DEVELOPER_GUIDE, priority: 8, keywords: ["object", "field", "relationship", "data model"] }
];

function categorizeDocument(fileName: string) {
    for (const pattern of DOCUMENT_PATTERNS) {
        if (pattern.pattern.test(fileName)) {
            return pattern;
        }
    }
    return {
        category: DocCategory.CORE_PLATFORM,
        subcategory: "general",
        docType: DocType.DEVELOPER_GUIDE,
        priority: 5,
        keywords: [] as string[]
    };
}

function generateTitle(fileName: string): string {
    return fileName
        .replace(/\.pdf$/i, '')
        .replace(/salesforce_/gi, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
}

/**
 * Metadata a document carries from the manifest into the index.
 *
 * The original build recorded none of this, which is why nothing in the
 * knowledge base could say which release an answer came from.
 */
interface IndexedProvenance {
    apiVersion: string | null;
    release: string | null;
    sourceUrl: string | null;
    sha256: string | null;
}

/** Remove a document and its chunks so it can be re-inserted cleanly. */
function deleteDocument(db: DatabaseSync, fileName: string): boolean {
    const existing = db.prepare("SELECT id FROM documents WHERE file_name = ?").get(fileName);
    if (existing === undefined) return false;

    // Delete chunks explicitly rather than rely on ON DELETE CASCADE, which only
    // works while foreign_keys is on.
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run(existing.id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
    return true;
}

async function processPdf(
    db: DatabaseSync,
    filePath: string,
    provenance: IndexedProvenance = { apiVersion: null, release: null, sourceUrl: null, sha256: null }
): Promise<boolean> {
    const fileName = basename(filePath);

    try {
        const local = inspectLocal(filePath);
        if (local.isLfsPointer) {
            console.log(`  ! ${fileName}: Git LFS pointer, not a PDF - run: git lfs pull`);
            return false;
        }

        const buffer = readFileSync(filePath);
        const stats = statSync(filePath);

        // Copy into a standalone Uint8Array before parsing. Node serves reads
        // under 4 KB out of a shared pool, so the Buffer is a view with a
        // non-zero byteOffset - which pdf.js ignores, making it read the wrong
        // bytes and fail with "bad XRef entry" on small PDFs.
        const data = await pdfParse(new Uint8Array(buffer));
        const text = cleanPdfText(data.text);

        if (!text || text.length < 100) {
            console.log(`  Skipping ${fileName}: No text content`);
            return false;
        }

        const { category, subcategory, docType, priority, keywords } = categorizeDocument(fileName);
        const title = generateTitle(fileName);

        // Re-indexing replaces the previous rows rather than colliding on the
        // file_name unique index. The savepoint keeps a failure from leaving
        // the document half-written.
        let chunkCount = 0;
        db.exec("SAVEPOINT document");
        try {
            deleteDocument(db, fileName);

            const inserted = db.prepare(`
                INSERT INTO documents 
                (file_name, file_path, category, subcategory, doc_type, title, keywords, api_version, last_updated, source_url, sha256, page_count, size_bytes, priority)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                fileName,
                filePath,
                category,
                subcategory,
                docType,
                title,
                JSON.stringify(keywords),
                provenance.apiVersion,
                provenance.release,
                provenance.sourceUrl,
                provenance.sha256 ?? sha256(buffer),
                data.numpages || 0,
                stats.size,
                priority
            );
            const documentId = Number(inserted.lastInsertRowid);

            const chunks = chunkText(text, { maxChunkSize: 1500, overlapSize: 150 });
            const insertChunk = db.prepare(`
                INSERT INTO chunks (document_id, chunk_index, content, content_lower, section_title)
                VALUES (?, ?, ?, ?, ?)
            `);

            chunkCount = chunks.length;
            for (const chunk of chunks) {
                if (chunk.content.length > 50) {
                    insertChunk.run(documentId, chunk.index, chunk.content, chunk.content.toLowerCase(), chunk.sectionTitle || null);
                }
            }
            db.exec("RELEASE document");
        } catch (error) {
            db.exec("ROLLBACK TO document");
            db.exec("RELEASE document");
            throw error;
        }

        const stamp = provenance.release ? ` [${provenance.release}]` : "";
        console.log(`  OK ${fileName}: ${chunkCount} chunks${stamp}`);
        return true;
    } catch (error) {
        console.log(`  FAIL ${fileName}: ${error}`);
        return false;
    }
}

function findPdfs(dir: string): string[] {
    const pdfs: string[] = [];
    if (!existsSync(dir)) return pdfs;
    
    for (const file of readdirSync(dir)) {
        const filePath = join(dir, file);
        const stat = statSync(filePath);
        
        if (stat.isDirectory()) {
            pdfs.push(...findPdfs(filePath));
        } else if (file.toLowerCase().endsWith('.pdf')) {
            pdfs.push(filePath);
        }
    }
    return pdfs;
}

const SCHEMA_DOCUMENTS = `CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT,
    doc_type TEXT NOT NULL DEFAULT 'developer_guide',
    title TEXT NOT NULL,
    description TEXT,
    keywords TEXT,
    api_version TEXT,
    last_updated TEXT,
    source_url TEXT,
    sha256 TEXT,
    page_count INTEGER,
    size_bytes INTEGER,
    priority INTEGER DEFAULT 5,
    edition REAL,
    edition_label TEXT,
    superseded_by TEXT,
    freshness REAL
)`;

const SCHEMA_CHUNKS = `CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_lower TEXT NOT NULL,
    section_title TEXT,
    page_number INTEGER,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    UNIQUE(document_id, chunk_index)
)`;

function createSchema(db: DatabaseSync): void {
    db.exec(SCHEMA_DOCUMENTS);
    db.exec(SCHEMA_CHUNKS);
    // The FTS5 index is (re)built once all chunks are in: see rebuildFtsIndex
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_subcategory ON documents(subcategory)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_priority ON documents(priority DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)`);
}

/**
 * Bring an index built before provenance tracking up to the current schema.
 * Adding columns is cheap and keeps a 520 MB database from needing a rebuild.
 */
function migrateSchema(db: DatabaseSync): void {
    const columns = new Set<string>();
    for (const row of db.prepare("PRAGMA table_info(documents)").all()) columns.add(String(row.name));

    const added = [
        ["source_url", "TEXT"], ["sha256", "TEXT"],
        ["edition", "REAL"], ["edition_label", "TEXT"], ["superseded_by", "TEXT"], ["freshness", "REAL"]
    ] as const;
    for (const [name, type] of added) {
        if (!columns.has(name)) {
            console.log(`Migrating schema: adding documents.${name}`);
            db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
        }
    }
}

/** Fill in release/URL/hash on indexed rows that predate the manifest. */
function stampProvenance(db: DatabaseSync, manifest: Manifest): number {
    const rows = db.prepare("SELECT file_name FROM documents WHERE source_url IS NULL OR api_version IS NULL").all();
    const unstamped = new Set(rows.map(r => String(r.file_name)));
    const stamp = db.prepare(
        "UPDATE documents SET api_version = COALESCE(api_version, ?), last_updated = COALESCE(last_updated, ?), source_url = ?, sha256 = COALESCE(sha256, ?) WHERE file_name = ?"
    );
    let count = 0;
    for (const doc of manifest.documents) {
        if (!unstamped.has(doc.fileName) || !doc.url) continue;
        stamp.run(doc.apiVersion ?? null, doc.release ?? null, doc.url, doc.sha256 ?? null, doc.fileName);
        count++;
    }
    return count;
}

/**
 * The release a document describes, as an API version number (Summer '12 = 25, Winter '27 = 68).
 * Static PDFs have no release in their URL and the manifest stamps them with the current
 * one, so their age comes from the server's Last-Modified date instead - except release
 * notes, whose file name says which release they describe.
 */
function editionOf(fileName: string, apiVersion: string | null, release: string | null, doc: ManifestDocument | undefined): { edition: number | null; label: string | null } {
    const releaseNotes = releaseFromFileName(fileName);
    if (releaseNotes) {
        apiVersion = releaseNotes.apiVersion;
        release = releaseNotes.name;
    } else if ((doc?.urlKind === "static" || !apiVersion) && doc?.lastModified) {
        const modified = new Date(doc.lastModified);
        if (!isNaN(modified.getTime())) {
            const month = modified.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
            return {
                edition: Number(estimatedCurrentRelease(modified).apiVersion),
                label: `as of ${month} ${modified.getUTCFullYear()} (undated PDF)`
            };
        }
    }
    if (!apiVersion || isNaN(Number(apiVersion))) return { edition: null, label: release };
    // Releases before the API existed (Winter '04) extrapolate to API <= 0: name the release only
    const api = Number(apiVersion) > 0 ? `API ${apiVersion}` : null;
    return { edition: Number(apiVersion), label: [release, api && (release ? `(${api})` : api)].filter(Boolean).join(" ") || null };
}

/** Superseded documents, keyed by file name: docs/superseded.json */
function loadSuperseded(): Map<string, string> {
    if (!existsSync(SUPERSEDED_PATH)) return new Map();
    const list = JSON.parse(readFileSync(SUPERSEDED_PATH, "utf8")).superseded as Array<{ document: string; supersededBy: string }>;
    return new Map(list.map(entry => [entry.document, entry.supersededBy]));
}

/**
 * Stamp every document with its edition, successor and freshness. Freshness is relative
 * to the newest edition in the index, so it is recomputed for all rows on every build.
 * Returns the number of rows whose values changed.
 */
function stampEditions(db: DatabaseSync, manifest: Manifest | null): number {
    const byFileName = new Map((manifest?.documents ?? []).map(doc => [doc.fileName, doc]));
    const superseded = loadSuperseded();
    const rows = db.prepare("SELECT id, file_name, api_version, last_updated, edition, edition_label, superseded_by, freshness FROM documents").all();

    const editions = rows.map(row => editionOf(row.file_name, row.api_version, row.last_updated, byFileName.get(row.file_name)));
    const newest = Math.max(...editions.map(e => e.edition ?? 0));

    const update = db.prepare("UPDATE documents SET edition = ?, edition_label = ?, superseded_by = ?, freshness = ? WHERE id = ?");
    let changed = 0;
    rows.forEach((row, i) => {
        const { edition, label } = editions[i];
        const successor = superseded.get(row.file_name) ?? null;
        const behind = edition === null ? 0 : newest - edition;
        const freshness = Math.round(
            Math.max(FRESHNESS_FLOOR, Math.pow(FRESHNESS_DECAY_PER_RELEASE, behind)) * (successor ? SUPERSEDED_FACTOR : 1) * 1000
        ) / 1000;
        if (row.edition === edition && row.edition_label === label && row.superseded_by === successor && row.freshness === freshness) return;
        update.run(edition, label, successor, freshness, row.id);
        changed++;
    });

    const unknown = [...superseded.keys()].filter(name => !rows.some(row => row.file_name === name));
    if (unknown.length) console.log(`  docs/superseded.json names documents not in the index: ${unknown.join(", ")}`);
    return changed;
}

function provenanceFor(doc: ManifestDocument | undefined): IndexedProvenance {
    return {
        apiVersion: doc?.apiVersion ?? null,
        release: doc?.release ?? null,
        sourceUrl: doc?.url ?? null,
        sha256: doc?.sha256 ?? null
    };
}

/** Load the manifest if there is one; indexing still works without it. */
function tryLoadManifest(): Manifest | null {
    if (!existsSync(MANIFEST_PATH)) return null;
    try {
        return loadManifest();
    } catch (error) {
        console.log(`Manifest unusable (${error instanceof Error ? error.message : error}); indexing without provenance.`);
        return null;
    }
}

/**
 * Documents that need (re)indexing.
 *
 * A document is stale when it has been fetched since it was last indexed, has
 * never been indexed, or is absent from the database entirely.
 */
function selectChangedDocuments(manifest: Manifest, db: DatabaseSync, filter: (id: string) => boolean): ManifestDocument[] {
    const dbBuiltAt = statSync(DB_PATH).mtime.toISOString();
    const indexed = new Map<string, string>();
    for (const row of db.prepare("SELECT file_name, sha256 FROM documents").all()) {
        indexed.set(String(row.file_name), row.sha256 === null ? "" : String(row.sha256));
    }

    return manifest.documents.filter(doc => {
        if (!filter(doc.id)) return false;
        if (!existsSync(documentPath(doc))) return false;
        // Not a PDF on disk (LFS pointer, saved error page): it will never
        // index, so do not report it as pending on every run.
        if (!inspectLocal(documentPath(doc)).isPdf) return false;

        const known = indexed.get(doc.fileName);
        if (known === undefined) return true;                                       // never indexed
        if (doc.fetchedAt && (!doc.indexedAt || doc.fetchedAt > doc.indexedAt)) return true; // fetched since indexed
        if (doc.sha256 && known && doc.sha256 !== known) return true;               // bytes drifted
        // In the index, never re-fetched: indexed by a full build that predates
        // the manifest. Current by definition; stamp it so this stops recurring.
        if (!doc.indexedAt) doc.indexedAt = dbBuiltAt;
        return false;
    });
}

async function buildIndex(): Promise<void> {
    const args = parseArgs();
    const changedOnly = args.flags.has("changed-only");
    const dryRun = args.flags.has("dry-run");
    const filter = makeFilter(args.values.get("only"));

    console.log("=".repeat(60));
    console.log(`Salesforce Documentation Index Builder${changedOnly ? " (incremental)" : ""}`);
    console.log("=".repeat(60));

    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
    }

    const manifest = tryLoadManifest();
    if (changedOnly && !manifest) {
        console.error("--changed-only needs docs/manifest.json. Run: npm run build-manifest");
        process.exit(1);
    }
    if (changedOnly && !existsSync(DB_PATH)) {
        console.error(`--changed-only needs an existing index at ${DB_PATH}. Run a full build first.`);
        process.exit(1);
    }

    // Every write goes to a copy, swapped in by rename at the end: the MCP server
    // reads the live file, and a session launched mid-build must not find an
    // empty or half-written index. Dry runs read the live file and write nothing.
    const tmpPath = `${DB_PATH}.building`;
    rmSync(tmpPath, { force: true });

    let db: DatabaseSync;
    let targets: Array<{ path: string; doc: ManifestDocument | undefined }>;

    if (changedOnly) {
        if (dryRun) {
            db = new DatabaseSync(DB_PATH, { readOnly: true });
        } else {
            copyFileSync(DB_PATH, tmpPath);
            db = openForWriting(tmpPath);
            migrateSchema(db);
            createSchema(db);
        }

        const changed = selectChangedDocuments(manifest!, db, filter);
        targets = changed.map(doc => ({ path: documentPath(doc), doc }));

        console.log(`Indexed documents:  ${db.prepare("SELECT COUNT(*) AS n FROM documents").get()!.n}`);
        console.log(`Needing reindex:    ${targets.length}`);
    } else {
        db = dryRun ? new DatabaseSync(":memory:") : openForWriting(tmpPath);
        console.log("Creating schema...");
        createSchema(db);

        console.log("\nScanning for PDFs...");
        const byFileName = new Map((manifest?.documents ?? []).map(doc => [basename(documentPath(doc)), doc]));

        // Scan the two well-known directories plus anything else the manifest
        // points at - docs/help-products was previously never indexed because
        // it is in neither of them.
        const searchDirs = new Set([PDF_DIR, RELEASE_NOTES_DIR]);
        for (const doc of manifest?.documents ?? []) searchDirs.add(join(PROJECT_ROOT, doc.dir));

        const pdfPaths = [...new Set([...searchDirs].flatMap(dir => findPdfs(dir)))];
        targets = pdfPaths
            .filter(path => filter(basename(path).replace(/\.pdf$/i, "")))
            .map(path => ({ path, doc: byFileName.get(basename(path)) }));
        console.log(`Found ${targets.length} PDF files`);
    }

    if (dryRun) {
        if (targets.length) {
            console.log("\nWould index:");
            for (const target of targets) console.log(`  ${basename(target.path)}`);
        } else {
            console.log("\nNothing to index.");
        }
        console.log("\nDry run - nothing written.");
        db.close();
        return;
    }

    if (!targets.length) {
        console.log("\nNothing to index.");
        if (changedOnly) console.log("The index is up to date with the manifest.");
        let changed = false;
        if (changedOnly && manifest) {
            const stamped = stampProvenance(db, manifest);
            if (stamped) console.log(`  stamped provenance on ${stamped} previously indexed documents`);
            changed = stamped > 0;
        }
        const restamped = stampEditions(db, manifest);
        if (restamped) {
            console.log(`  stamped edition and freshness on ${restamped} documents`);
            changed = true;
        }
        // An index built before full-text search gets one without re-parsing any PDF
        if (!hasFtsIndex(db)) {
            buildFts(db);
            changed = true;
        }
        db.close();
        if (changed) renameSync(tmpPath, DB_PATH);
        else rmSync(tmpPath, { force: true });
        if (changedOnly && manifest) saveManifest(manifest);
        return;
    }

    console.log("\nProcessing PDFs...");
    let successCount = 0;
    let failCount = 0;
    const indexedAt = new Date().toISOString();

    for (const target of targets) {
        if (await processPdf(db, target.path, provenanceFor(target.doc))) {
            successCount++;
            if (target.doc) target.doc.indexedAt = indexedAt;
        } else {
            failCount++;
        }
    }

    // Rows indexed before provenance tracking carry no release/URL/hash. The
    // manifest knows them now (sync-docs adopted validators), so stamp them in
    // place - no re-parse needed, the chunks are unaffected.
    if (changedOnly && manifest) {
        const stamped = stampProvenance(db, manifest);
        if (stamped) console.log(`  stamped provenance on ${stamped} previously indexed documents`);
    }

    if (args.flags.has("prune") && manifest) {
        const missing = manifest.documents.filter(doc => doc.indexedAt && !existsSync(documentPath(doc)));
        for (const doc of missing) {
            if (deleteDocument(db, doc.fileName)) {
                console.log(`  pruned ${doc.fileName} (PDF no longer on disk)`);
                doc.indexedAt = null;
            }
        }
    }

    const restamped = stampEditions(db, manifest);
    if (restamped) console.log(`  stamped edition and freshness on ${restamped} documents`);

    buildFts(db);

    const docCount = db.prepare("SELECT COUNT(*) AS n FROM documents").get()!.n;
    const chunkCount = db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!.n;

    db.close();

    // A full build only sees PDFs on this machine; the live index may hold more
    // (legacy editions indexed elsewhere). Never silently swap in a smaller index.
    const liveCount = !changedOnly && existsSync(DB_PATH) ? countDocuments(DB_PATH) : 0;
    if (docCount < liveCount && !args.flags.has("allow-shrink")) {
        rmSync(tmpPath, { force: true });
        console.error(`\nRefusing to replace the index: the new build has ${docCount} documents, the live index ${liveCount}.`);
        console.error("Documents whose PDF is not on this machine would be lost. The live index is unchanged.");
        console.error("Use npm run build-index -- --changed-only, or pass --allow-shrink to replace it anyway.");
        process.exit(1);
    }

    console.log("\nSaving database...");
    const sizeBytes = statSync(tmpPath).size;
    // Rename is atomic: a reader sees either the old index or the new one
    renameSync(tmpPath, DB_PATH);

    // Record what is now indexed, so the next incremental run knows.
    if (manifest) saveManifest(manifest);

    console.log("\n" + "=".repeat(60));
    console.log(changedOnly ? "Incremental Index Update Complete!" : "Index Build Complete!");
    console.log("=".repeat(60));
    console.log(`Documents ${changedOnly ? "reindexed" : "indexed"}: ${successCount}`);
    console.log(`Documents failed: ${failCount}`);
    console.log(`Documents in index: ${docCount}`);
    console.log(`Total chunks: ${chunkCount}`);
    console.log(`Database size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Database path: ${DB_PATH}`);
    console.log("Done!");
}

/**
 * Open the build copy for bulk writes. Journaling and fsync buy nothing here:
 * a crashed build leaves only the .building file, never a damaged live index.
 */
function openForWriting(path: string): DatabaseSync {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = OFF");
    db.exec("PRAGMA synchronous = OFF");
    return db;
}

function countDocuments(path: string): number {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return Number(db.prepare("SELECT COUNT(*) AS n FROM documents").get()!.n);
    } finally {
        db.close();
    }
}

function buildFts(db: DatabaseSync): void {
    console.log("\nBuilding full-text index...");
    const started = Date.now();
    rebuildFtsIndex(db);
    console.log(`  full-text index built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

buildIndex().catch(console.error);
