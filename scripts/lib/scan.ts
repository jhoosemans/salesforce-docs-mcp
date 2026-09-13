/**
 * Shared scanning logic: decide, for each tracked document, whether Salesforce
 * is now serving something we do not have.
 *
 * Both check-updates (report only) and sync-docs (report then download) run
 * this, so the two can never disagree about what counts as an update.
 */

import { probe, mapWithConcurrency, ProbeResult } from "./http.js";
import { inspectLocal } from "./local.js";
import {
    DOCS_ORIGIN,
    Manifest,
    ManifestDocument,
    documentPath,
    pinnedUrl,
    upstreamUrl
} from "./manifest.js";
import { Release, recentReleases } from "./release.js";

/**
 * Why a document is being reported.
 *
 * "stale-baseline" is the honest answer for a document we have never probed:
 * the corpus predates any change tracking, so there are no validators to
 * compare and we can only say the local copy came from an older release.
 *
 * "frozen" is a legacy document with no edition in the target release whose
 * pinned edition still serves - it is not gone, it just stopped moving.
 *
 * "not-yet-published" is an expected document (a release's notes) that the
 * CDN does not serve yet; it is information for the reader, not an action.
 */
export type Status =
    | "new-upstream"
    | "missing-locally"
    | "changed"
    | "stale-baseline"
    | "unchanged"
    | "frozen"
    | "not-in-release"
    | "not-yet-published"
    | "gone"
    | "blocked"
    | "lfs-pointer"
    | "error";

export interface Finding {
    id: string;
    fileName: string;
    kind: ManifestDocument["kind"];
    status: Status;
    reason: string;
    checkedUrl: string | null;
    localRelease: string | null;
    targetRelease: string;
    local: { exists: boolean; sizeBytes: number | null };
    upstream: { status: number; etag: string | null; lastModified: string | null; sizeBytes: number | null };
}

export const NEEDS_SYNC: Status[] = ["new-upstream", "missing-locally", "changed", "stale-baseline"];


/**
 * Guides that have shipped in every release for years - safe canaries.
 * Verified 2026-09-13 to answer 200 at 250, 256, 258, 262 and 264. Two are
 * probed so a single retired guide cannot make a live release look absent.
 */
const CANARY_IDS = ["apex_ajax", "api_rest"];

function canaryUrls(version: number): string[] {
    return CANARY_IDS.map(id => `${DOCS_ORIGIN}/${version}/latest/en-us/sfdc/pdf/${id}.pdf`);
}

/**
 * Confirm which release the CDN is actually serving.
 *
 * The date-based estimate can be a release ahead during a rollout weekend, so
 * probe downwards until a release answers 200.
 */
export interface ReleaseCheck {
    release: Release;
    confirmed: boolean;
    /** False when the CDN could not be reached at all (DNS, TLS, proxy denial). */
    reachable: boolean;
    reason: string | null;
}

export async function confirmRelease(estimate: Release): Promise<ReleaseCheck> {
    const candidates = recentReleases(estimate, 3).reverse(); // newest first

    for (const candidate of candidates) {
        for (const url of canaryUrls(candidate.version)) {
            const result = await probe(url, { retries: 1, timeoutMs: 30_000 });

            if (result.ok) return { release: candidate, confirmed: true, reachable: true, reason: null };

            if (result.error) {
                return { release: estimate, confirmed: false, reachable: false, reason: result.error };
            }
            if (result.status === 403 || result.status === 407) {
                return {
                    release: estimate,
                    confirmed: false,
                    reachable: false,
                    reason: `HTTP ${result.status} from resources.docs.salesforce.com - the network refused the request`
                };
            }
        }
    }

    // Reachable, but no recent release answered - unusual, so carry on unconfirmed.
    return { release: estimate, confirmed: false, reachable: true, reason: "no recent release answered the canary probe" };
}

/** Decide what a probe result means for a document. */
export function classify(
    doc: ManifestDocument,
    target: Release,
    result: ProbeResult,
    fallback: ProbeResult | null
): { status: Status; reason: string } {
    const local = inspectLocal(documentPath(doc));

    if (result.error) {
        return { status: "error", reason: result.error };
    }

    const upstreamExists = result.ok;
    const pinnedStillServes = fallback?.ok ?? false;

    if (!upstreamExists && pinnedStillServes) {
        return {
            status: "frozen",
            reason: `no ${target.name} edition; pinned ${doc.release ?? "legacy"} edition still served`
        };
    }

    if (!upstreamExists) {
        // 403 is an access decision, not a statement about the document. A
        // corporate egress proxy denying CONNECT looks exactly like this, and
        // reporting it as "Salesforce retired this doc" would be a lie.
        if (result.status === 403 || result.status === 407) {
            return { status: "blocked", reason: `access denied (HTTP ${result.status}) - not a statement about the document` };
        }
        if (result.status === 404 || result.status === 410) {
            return local.exists
                ? { status: "gone", reason: `no longer published (HTTP ${result.status})` }
                : { status: "not-in-release", reason: `not published in ${target.name} (HTTP ${result.status})` };
        }
        return { status: "error", reason: `HTTP ${result.status}` };
    }

    // A 200 that is not a PDF is a retired document: the CDN redirects some
    // paths to an HTML page on architect.salesforce.com (observed 2026-09-13
    // for sharing_architecture.pdf and salesforce_visualforce_best_practices.pdf).
    if (result.contentType && !/pdf/i.test(result.contentType)) {
        const reason = `no longer a PDF - redirects to a web page (${result.contentType.split(";")[0]})`;
        return local.exists ? { status: "gone", reason } : { status: "not-in-release", reason };
    }

    // The document exists upstream somewhere. Decide against the local copy.
    if (!local.exists) {
        return doc.release || doc.fetchedAt
            ? { status: "missing-locally", reason: "tracked but absent from disk" }
            : { status: "new-upstream", reason: `published in ${target.name}, never downloaded` };
    }

    if (local.isLfsPointer) {
        return { status: "lfs-pointer", reason: "local file is an unfetched Git LFS pointer - run: git lfs pull" };
    }

    const upstream = result;

    // Best case: we have recorded validators and can compare them directly.
    if (doc.etag && upstream.etag) {
        return doc.etag === upstream.etag
            ? { status: "unchanged", reason: "ETag matches" }
            : { status: "changed", reason: `ETag changed (${doc.etag} -> ${upstream.etag})` };
    }
    if (doc.lastModified && upstream.lastModified && doc.lastModified !== upstream.lastModified) {
        return { status: "changed", reason: `Last-Modified changed (${doc.lastModified} -> ${upstream.lastModified})` };
    }
    if (doc.sha256 && doc.sizeBytes && upstream.contentLength && doc.sizeBytes !== upstream.contentLength) {
        return { status: "changed", reason: `size changed (${doc.sizeBytes} -> ${upstream.contentLength} bytes)` };
    }
    if (doc.etag && upstream.etag === null && doc.sizeBytes === upstream.contentLength) {
        return { status: "unchanged", reason: "size matches (no ETag served)" };
    }

    // No recorded validators: the corpus predates change tracking.
    if (!doc.etag && !doc.sha256) {
        // Same byte count as upstream is, for a PDF, as good as identical.
        // sync-docs adopts the validators without downloading, so the next
        // check is a real ETag comparison.
        if (local.sizeBytes !== null && upstream.contentLength !== null && local.sizeBytes === upstream.contentLength) {
            return { status: "unchanged", reason: "size matches upstream (validators adopted on next sync)" };
        }
        // A release-notes document belongs to its own release forever; only a
        // developer guide can have a newer edition in the target release.
        if (doc.kind === "developer_guide" && upstreamExists && doc.release && doc.release !== target.name) {
            return {
                status: "stale-baseline",
                reason: `local copy is ${doc.release}; ${target.name} edition is published`
            };
        }
        if (local.sizeBytes !== null && upstream.contentLength !== null) {
            return {
                status: "changed",
                reason: `size differs from upstream (${local.sizeBytes} -> ${upstream.contentLength} bytes)`
            };
        }
        return {
            status: "stale-baseline",
            reason: "never verified against upstream - no ETag recorded"
        };
    }

    return { status: "unchanged", reason: "no change detected" };
}

/**
 * Look for release-notes documents that exist upstream but not in the corpus.
 *
 * Release notes follow a strict naming pattern, so unlike developer guides they
 * can be discovered rather than guessed at.
 */
export async function discoverReleaseNotes(
    manifest: Manifest,
    target: Release,
    howMany: number
): Promise<Finding[]> {
    const known = new Set(manifest.documents.map(d => d.fileName.toLowerCase()));
    const findings: Finding[] = [];

    for (const release of recentReleases(target, howMany)) {
        const expectedFile = `ReleaseNotes_${release.season.charAt(0).toUpperCase()}${release.season.slice(1)}_${String(release.yearLabel).padStart(2, "0")}.pdf`;
        if (known.has(expectedFile.toLowerCase())) continue;

        // Recent release notes live under /rel1/, older ones under the version path.
        const candidates = [
            `${DOCS_ORIGIN}/rel1/doc/en-us/static/pdf/${release.releaseNotesFile}`,
            `${DOCS_ORIGIN}/${release.version}/latest/en-us/sfdc/pdf/${release.releaseNotesFile}`
        ];

        let found = false;
        for (const url of candidates) {
            const result = await probe(url, { retries: 1 });
            if (!result.ok) continue;
            found = true;

            findings.push({
                id: expectedFile.replace(/\.pdf$/i, ""),
                fileName: expectedFile,
                kind: "release_notes",
                status: "new-upstream",
                reason: `${release.name} release notes published, not in the corpus`,
                checkedUrl: url,
                localRelease: null,
                targetRelease: release.name,
                local: { exists: false, sizeBytes: null },
                upstream: {
                    status: result.status,
                    etag: result.etag,
                    lastModified: result.lastModified,
                    sizeBytes: result.contentLength
                }
            });
            break;
        }

        // Only the current release's notes are *expected*; older gaps are
        // simply gaps. Winter '27 developer guides went live before its release
        // notes PDF did (observed 2026-09-13), so this is a normal state.
        if (!found && release.version === target.version) {
            findings.push({
                id: expectedFile.replace(/\.pdf$/i, ""),
                fileName: expectedFile,
                kind: "release_notes",
                status: "not-yet-published",
                reason: `${release.name} release notes not served yet at ${candidates[0].replace(DOCS_ORIGIN, "")}`,
                checkedUrl: candidates[0],
                localRelease: null,
                targetRelease: release.name,
                local: { exists: false, sizeBytes: null },
                upstream: { status: 404, etag: null, lastModified: null, sizeBytes: null }
            });
        }
    }

    return findings;
}

export function summarize(findings: Finding[]): Record<Status, number> {
    return findings.reduce((acc, finding) => {
        acc[finding.status] = (acc[finding.status] ?? 0) + 1;
        return acc;
    }, {} as Record<Status, number>);
}


/** Probe every document in `queue` and classify the result. */
export async function scanDocuments(
    queue: ManifestDocument[],
    target: Release,
    concurrency: number,
    onProgress?: (done: number, total: number) => void
): Promise<Finding[]> {
    let done = 0;

    return mapWithConcurrency(queue, concurrency, async doc => {
        const primary = upstreamUrl(doc, target.version)!;
        const result = await probe(primary, { retries: 2 });

        // A 404 at the target release for a version-pinned legacy document can
        // mean "retired" or merely "stopped shipping new editions"; the pinned
        // edition settles it. (The unversioned /sfdc/pdf/ path is not consulted:
        // it answers 404 for everything - verified 2026-09-13.)
        let fallback: ProbeResult | null = null;
        const pinned = pinnedUrl(doc);
        if (!result.ok && !result.error && pinned && pinned !== primary) {
            fallback = await probe(pinned, { retries: 1 });
        }

        const { status, reason } = classify(doc, target, result, fallback);
        const local = inspectLocal(documentPath(doc));
        const upstream = result.ok ? result : (fallback ?? result);

        onProgress?.(++done, queue.length);

        return {
            id: doc.id,
            fileName: doc.fileName,
            kind: doc.kind,
            status,
            reason,
            checkedUrl: result.ok ? primary : upstream.ok ? upstream.url : primary,
            localRelease: doc.release,
            targetRelease: target.name,
            local: { exists: local.exists, sizeBytes: local.sizeBytes },
            upstream: {
                status: upstream.status,
                etag: upstream.etag,
                lastModified: upstream.lastModified,
                sizeBytes: upstream.contentLength
            }
        } satisfies Finding;
    });
}

/** Select which documents a scan says should be fetched. */
export function actionableFindings(findings: Finding[]): Finding[] {
    return findings.filter(f => NEEDS_SYNC.includes(f.status));
}

/**
 * Documents whose local copy is current but whose validators were never
 * recorded: "unchanged" by size, or "frozen" at a pinned edition. Their
 * upstream ETag/size can be written to the manifest without a download.
 */
export function adoptableFindings(findings: Finding[], manifest: Manifest): Finding[] {
    const byFile = new Map(manifest.documents.map(d => [d.fileName, d]));
    return findings.filter(f => {
        if (f.status !== "unchanged" && f.status !== "frozen") return false;
        const doc = byFile.get(f.fileName);
        return !!doc && !doc.etag && f.local.exists && f.upstream.etag !== null;
    });
}

/** Documents to probe for a given target release, applying the usual filters. */
export function buildQueue(
    manifest: Manifest,
    target: Release,
    options: { filter: (id: string) => boolean; kind?: string }
): ManifestDocument[] {
    // Version-pinned legacy documents are checked at the target release like
    // everything else: a sample on 2026-09-13 found half of the "dead" legacy
    // corpus has a current edition. Those that do not are reported "frozen".
    void target;
    return manifest.documents.filter(doc => {
        if (!options.filter(doc.id)) return false;
        if (options.kind && doc.kind !== options.kind) return false;
        if (!doc.url) return false;
        return true;
    });
}
