/**
 * The documentation manifest: one source of truth for what the knowledge base
 * contains, where each document came from, and which release it was captured at.
 *
 * Replaces the four overlapping metadata JSONs in docs/metadata/, which were
 * produced by separate PowerShell runs and disagree with each other.
 *
 * check-updates.ts reads it (never writes). sync-docs.ts and build-index.ts
 * write back the state fields as documents are fetched and indexed.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname_, "..", "..");
/** Overridable via SFDOCS_MANIFEST so the pipeline can be tested in isolation. */
export const MANIFEST_PATH = process.env.SFDOCS_MANIFEST
    ? join(PROJECT_ROOT, process.env.SFDOCS_MANIFEST)
    : join(PROJECT_ROOT, "docs", "manifest.json");

export type DocKind = "developer_guide" | "release_notes";

/**
 * How the source URL behaves, which decides how we check it for changes:
 *  - "latest": unversioned /sfdc/pdf/x.pdf - always serves the current release,
 *    so the bytes behind it change every release. These need ETag checks.
 *  - "pinned": /258/latest/... - frozen at that release. Only changes if we
 *    deliberately move the pin to a newer release.
 *  - "static": /rel1/... - hand-published assets (release notes, Buddy Media,
 *    Radian6). Stable, but new ones appear each release.
 */
export type UrlKind = "latest" | "pinned" | "static";

/** Provenance of a document's source URL. */
export type UrlSource = "script" | "metadata" | "inferred" | "confirmed" | null;

/**
 * Origin serving the documentation PDFs.
 *
 * Overridable via SFDOCS_ORIGIN so the sync pipeline can be exercised against a
 * local fixture server without touching Salesforce's CDN.
 */
export const DOCS_ORIGIN = (process.env.SFDOCS_ORIGIN ?? "https://resources.docs.salesforce.com").replace(/\/$/, "");

/**
 * Identity URL for a developer guide we have no recorded source for.
 *
 * The unversioned /sfdc/pdf/ path itself answers 404 on the CDN today
 * (verified 2026-09-13) - it is kept only as a stable *shape* that
 * `upstreamUrl()` rebases onto a concrete release before anything is probed.
 */
export function canonicalUrl(id: string): string {
    return `${DOCS_ORIGIN}/sfdc/pdf/${id}.pdf`;
}

export interface ManifestDocument {
    /** Stable key, derived from the PDF basename. */
    id: string;
    fileName: string;
    /** Directory under the project root, e.g. "docs/pdfs". */
    dir: string;
    title: string;
    /** Source URL, or null for a document whose origin we could not recover. */
    url: string | null;
    /**
     * Where the URL came from. "inferred" means we applied Salesforce's
     * canonical /sfdc/pdf/{id}.pdf pattern because no recorded source existed -
     * it is a good guess, not a fact, and the first successful probe promotes
     * it to "confirmed".
     */
    urlSource: UrlSource;
    urlKind: UrlKind;
    kind: DocKind;
    /** Release the pinned URL points at, when urlKind is "pinned". */
    pinnedVersion: number | null;

    // --- Captured state. Null until sync-docs/build-index fill it in. ---
    /** Release name of the local copy, e.g. "Winter '26". */
    release: string | null;
    /** API version of the local copy, e.g. "65.0". */
    apiVersion: string | null;
    etag: string | null;
    lastModified: string | null;
    sizeBytes: number | null;
    sha256: string | null;
    /** ISO timestamp of the last successful download. */
    fetchedAt: string | null;
    /** ISO timestamp of the last time this document's chunks were rebuilt. */
    indexedAt: string | null;
}

export interface Manifest {
    schemaVersion: number;
    generatedAt: string;
    /** Release the corpus as a whole was last synced to. */
    syncedRelease: { version: number; name: string; apiVersion: string } | null;
    /** Last release check-updates confirmed as live over HTTP. */
    confirmedCurrentRelease: { version: number; name: string; checkedAt: string } | null;
    documents: ManifestDocument[];
}

export const SCHEMA_VERSION = 1;

export function loadManifest(path: string = MANIFEST_PATH): Manifest {
    if (!existsSync(path)) {
        throw new Error(
            `Manifest not found at ${path}\n` +
            `Bootstrap it first:  npm run build-manifest`
        );
    }
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (manifest.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
            `Manifest schema version ${manifest.schemaVersion} is not supported ` +
            `(expected ${SCHEMA_VERSION}). Re-run: npm run build-manifest`
        );
    }
    return manifest;
}

/** Write atomically - a half-written manifest would strand the whole corpus. */
export function saveManifest(manifest: Manifest, path: string = MANIFEST_PATH): void {
    manifest.documents.sort((a, b) => a.fileName.localeCompare(b.fileName));
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
}

export function documentPath(doc: ManifestDocument): string {
    return join(PROJECT_ROOT, doc.dir, doc.fileName);
}

export function findDocument(manifest: Manifest, idOrFileName: string): ManifestDocument | undefined {
    const needle = idOrFileName.replace(/\.pdf$/i, "");
    return manifest.documents.find(d => d.id === needle || d.fileName === idOrFileName);
}

/** Derive a stable id from a PDF basename. */
export function idFromFileName(fileName: string): string {
    return fileName.replace(/\.pdf$/i, "");
}

/** Human-readable title, matching the convention in build-index.ts. */
export function titleFromFileName(fileName: string): string {
    return fileName
        .replace(/\.pdf$/i, "")
        .replace(/salesforce_/gi, "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
}

/** Classify a source URL so we know how to check it for changes. */
export function classifyUrl(url: string | null): { urlKind: UrlKind; pinnedVersion: number | null } {
    if (!url) return { urlKind: "static", pinnedVersion: null };
    const pinned = url.match(/salesforce\.com\/(\d{3})\//);
    if (pinned) return { urlKind: "pinned", pinnedVersion: Number(pinned[1]) };
    if (/salesforce\.com\/(rel1|servicesdk)\//.test(url)) return { urlKind: "static", pinnedVersion: null };
    return { urlKind: "latest", pinnedVersion: null };
}

/**
 * The URL to probe when asking "is there a newer edition of this document?".
 *
 * This is deliberately not the same as `doc.url`. `doc.url` records where the
 * local copy came from - often a version-pinned path like /172/latest/... which
 * is frozen forever, or the unversioned /sfdc/pdf/... form that the CDN no
 * longer serves at all. Either way, re-checking it says nothing about whether
 * a newer edition exists.
 *
 * Every /sfdc/pdf/ document is addressable as
 *   /{docsVersion}/latest/en-us/sfdc/pdf/{file}.pdf
 * with distinct bytes and ETags per release (verified against 258/262/264 on
 * 2026-09-13), so developer guides are rewritten onto the target release.
 * Release notes and hand-published /rel1/ assets keep their own URL: a new
 * release means a new release-notes document, not a changed one.
 */
export function upstreamUrl(doc: ManifestDocument, targetVersion: number): string | null {
    if (!doc.url) return null;
    if (doc.kind === "release_notes") return doc.url;

    // Only the /sfdc/pdf/ family is version-addressable.
    const base = doc.url.match(/\/sfdc\/pdf\/([^/]+\.pdf)$/i);
    if (!base) return doc.url;

    return `${DOCS_ORIGIN}/${targetVersion}/latest/en-us/sfdc/pdf/${base[1]}`;
}


/**
 * The frozen edition a legacy document was captured from, when its source URL
 * is version-pinned. Used to tell "retired" apart from "not in this release":
 * if the target release answers 404 but the pinned edition still serves, the
 * document is frozen, not gone.
 */
export function pinnedUrl(doc: ManifestDocument): string | null {
    return doc.urlKind === "pinned" && doc.url ? doc.url : null;
}
