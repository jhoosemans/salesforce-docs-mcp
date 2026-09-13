/**
 * Bootstrap docs/manifest.json - the one source of truth for the corpus.
 *
 * Reconstructs the manifest from three sources that currently disagree:
 *   1. the URL lists inside the two legacy PowerShell downloaders (authoritative
 *      for where each PDF came from),
 *   2. the PDFs actually on disk (authoritative for what we have),
 *   3. docs/metadata/*.json (useful only for human-readable titles).
 *
 * Run once to migrate, or again after hand-editing the manifest sources.
 * Existing captured state (etag, sha256, release, ...) is preserved for any
 * document already in the manifest - re-running never loses sync history.
 *
 *   npm run build-manifest
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { releaseForVersion } from "./lib/release.js";
import {
    Manifest,
    ManifestDocument,
    UrlSource,
    canonicalUrl,
    MANIFEST_PATH,
    PROJECT_ROOT,
    SCHEMA_VERSION,
    classifyUrl,
    idFromFileName,
    saveManifest,
    titleFromFileName
} from "./lib/manifest.js";

const DEV_SCRIPT = join(PROJECT_ROOT, "scripts", "final-download-developer-docs.ps1");
const RN_SCRIPT = join(PROJECT_ROOT, "scripts", "final-download-release-notes.ps1");
const METADATA_DIR = join(PROJECT_ROOT, "docs", "metadata");

/** Directories the corpus lives in, mapped to the kind of document they hold. */
const CORPUS_DIRS: Array<{ dir: string; kind: ManifestDocument["kind"] }> = [
    { dir: "docs/pdfs", kind: "developer_guide" },
    { dir: "docs/release-notes", kind: "release_notes" },
    { dir: "docs/help-products", kind: "developer_guide" }
];

/**
 * Reproduce the filename the PowerShell downloader would have written for a URL.
 * These prefix rules exist to keep same-named PDFs from different product lines
 * from colliding in docs/pdfs.
 */
function fileNameForDevUrl(url: string): string {
    const base = url.split("/").pop()!;
    const servicesdk = url.match(/servicesdk\/(\d+)\//);
    if (servicesdk) return `servicesdk_${servicesdk[1]}_${base}`;
    if (/rel1\/buddymedia/.test(url)) return `buddymedia_${base}`;
    if (/rel1\/radian6/.test(url)) return `radian6_${base}`;
    if (/rel1\/other/.test(url)) return `other_${base}`;
    if (/rel1\/doc/.test(url)) return `static_${base}`;
    return base;
}

/** Pull the quoted URLs out of the developer-docs PowerShell array. */
function parseDevScript(): Array<{ fileName: string; url: string }> {
    if (!existsSync(DEV_SCRIPT)) return [];
    const text = readFileSync(DEV_SCRIPT, "utf8");
    const urls = text.match(/"(https:\/\/[^"]+\.pdf)"/gi) ?? [];
    return urls
        .map(quoted => quoted.slice(1, -1))
        .map(url => ({ fileName: fileNameForDevUrl(url), url }));
}

/** Pull the @{name=...; url=...} pairs out of the release-notes PowerShell array. */
function parseReleaseNotesScript(): Array<{ fileName: string; url: string }> {
    if (!existsSync(RN_SCRIPT)) return [];
    const text = readFileSync(RN_SCRIPT, "utf8");
    const entries = text.matchAll(/@\{\s*name\s*=\s*"([^"]+)"\s*;\s*url\s*=\s*"([^"]+)"\s*\}/gi);
    return [...entries].map(match => ({ fileName: `ReleaseNotes_${match[1]}.pdf`, url: match[2] }));
}

/**
 * Titles and source URLs recovered from the legacy metadata files.
 *
 * These were written by a different download run than the PowerShell scripts,
 * so they cover documents the scripts never listed - which is exactly the gap
 * we need to close before anything can be checked for updates.
 */
function loadMetadata(): Map<string, { title?: string; url?: string }> {
    const byFile = new Map<string, { title?: string; url?: string }>();
    if (!existsSync(METADATA_DIR)) return byFile;

    for (const file of readdirSync(METADATA_DIR).filter(f => f.endsWith(".json"))) {
        try {
            // These files were written by PowerShell and carry a UTF-8 BOM.
            const raw = readFileSync(join(METADATA_DIR, file), "utf8").replace(/^\uFEFF/, "");
            const parsed = JSON.parse(raw);
            for (const entry of parsed.documentation ?? []) {
                if (!entry.pdfFile) continue;
                const existing = byFile.get(entry.pdfFile) ?? {};
                if (entry.name) existing.title = entry.name;
                // Only trust URLs from entries that actually downloaded.
                if (entry.pdfUrl && entry.status === "success") existing.url = entry.pdfUrl;
                byFile.set(entry.pdfFile, existing);
            }
        } catch (err) {
            console.warn(`  ! skipping ${file}: ${err instanceof Error ? err.message : err}`);
        }
    }
    return byFile;
}

/** Every PDF actually present on disk, mapped to the directory holding it. */
function scanCorpus(): Map<string, { dir: string; kind: ManifestDocument["kind"]; sizeBytes: number }> {
    const found = new Map<string, { dir: string; kind: ManifestDocument["kind"]; sizeBytes: number }>();

    for (const { dir, kind } of CORPUS_DIRS) {
        const absolute = join(PROJECT_ROOT, dir);
        if (!existsSync(absolute)) continue;
        for (const fileName of readdirSync(absolute)) {
            if (!fileName.toLowerCase().endsWith(".pdf")) continue;
            found.set(fileName, { dir, kind, sizeBytes: statSync(join(absolute, fileName)).size });
        }
    }
    return found;
}

function buildManifest(): void {
    console.log("=".repeat(64));
    console.log("Building docs/manifest.json");
    console.log("=".repeat(64));

    // Preserve captured state across re-runs.
    const previous = new Map<string, ManifestDocument>();
    if (existsSync(MANIFEST_PATH)) {
        const old = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
        for (const doc of old.documents ?? []) previous.set(doc.fileName, doc);
        console.log(`Carrying forward state for ${previous.size} known documents`);
    }

    const metadata = loadMetadata();
    const onDisk = scanCorpus();
    console.log(`PDFs on disk:        ${onDisk.size}`);

    const sources = new Map<string, { url: string; kind: ManifestDocument["kind"] }>();
    for (const { fileName, url } of parseDevScript()) {
        sources.set(fileName, { url, kind: "developer_guide" });
    }
    for (const { fileName, url } of parseReleaseNotesScript()) {
        sources.set(fileName, { url, kind: "release_notes" });
    }
    console.log(`URLs in PS scripts:  ${sources.size}`);
    console.log(`URLs in metadata:    ${[...metadata.values()].filter(m => m.url).length}`);

    const fileNames = new Set([...onDisk.keys(), ...sources.keys()]);
    const documents: ManifestDocument[] = [];

    let missingLocally = 0;
    const urlProvenance: Record<string, number> = {};

    for (const fileName of fileNames) {
        const source = sources.get(fileName);
        const local = onDisk.get(fileName);
        const carried = previous.get(fileName);
        const meta = metadata.get(fileName);

        if (!local) missingLocally++;

        const kind: ManifestDocument["kind"] =
            local?.kind ?? source?.kind ?? (/^ReleaseNotes_/i.test(fileName) ? "release_notes" : "developer_guide");
        const dir = local?.dir ?? (kind === "release_notes" ? "docs/release-notes" : "docs/pdfs");
        const id = idFromFileName(fileName);

        // Prefer a recorded URL over a guess, and never downgrade one we have
        // already confirmed over the wire.
        let url: string | null;
        let urlSource: UrlSource;
        if (carried?.urlSource === "confirmed" && carried.url) {
            url = carried.url;
            urlSource = "confirmed";
        } else if (source) {
            url = source.url;
            urlSource = "script";
        } else if (meta?.url) {
            url = meta.url;
            urlSource = "metadata";
        } else if (carried?.url) {
            url = carried.url;
            urlSource = carried.urlSource ?? "metadata";
        } else if (kind === "developer_guide") {
            // Salesforce publishes every current developer guide at this path.
            // check-updates verifies it and promotes it to "confirmed".
            url = canonicalUrl(id);
            urlSource = "inferred";
        } else {
            url = null;
            urlSource = null;
        }

        urlProvenance[urlSource ?? "none"] = (urlProvenance[urlSource ?? "none"] ?? 0) + 1;
        const { urlKind, pinnedVersion } = classifyUrl(url);

        // A version-pinned URL tells us which release the local copy came from.
        // That is the only provenance the original download runs left behind,
        // so recover it here rather than starting from "unknown".
        let release = carried?.release ?? null;
        let apiVersion = carried?.apiVersion ?? null;
        if (!release && local && pinnedVersion) {
            const pinned = releaseForVersion(pinnedVersion);
            release = pinned.name;
            apiVersion = pinned.apiVersion;
        }

        documents.push({
            id,
            fileName,
            dir,
            title: meta?.title ?? carried?.title ?? titleFromFileName(fileName),
            url,
            urlSource,
            urlKind,
            kind,
            pinnedVersion,
            release,
            apiVersion,
            etag: carried?.etag ?? null,
            lastModified: carried?.lastModified ?? null,
            sizeBytes: carried?.sizeBytes ?? null,
            sha256: carried?.sha256 ?? null,
            fetchedAt: carried?.fetchedAt ?? null,
            indexedAt: carried?.indexedAt ?? null
        });
    }

    const manifest: Manifest = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        syncedRelease: null,
        confirmedCurrentRelease: null,
        documents
    };

    saveManifest(manifest);

    const byUrlKind = documents.reduce<Record<string, number>>((acc, doc) => {
        acc[doc.urlKind] = (acc[doc.urlKind] ?? 0) + 1;
        return acc;
    }, {});

    console.log("");
    console.log(`Documents in manifest: ${documents.length}`);
    console.log(`  tracked as "latest": ${byUrlKind.latest ?? 0}  (content changes every release)`);
    console.log(`  pinned to a version: ${byUrlKind.pinned ?? 0}  (frozen unless the pin moves)`);
    console.log(`  static/hand-published: ${byUrlKind.static ?? 0}`);
    console.log(`  listed but not on disk: ${missingLocally}`);
    console.log("");
    console.log("Source URL provenance:");
    for (const [provenance, count] of Object.entries(urlProvenance).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${provenance.padEnd(10)} ${count}`);
    }
    console.log("");
    console.log(`Wrote ${MANIFEST_PATH}`);
    console.log("Next:  npm run check-updates");
}

buildManifest();
