/**
 * Download the documents that check-updates flagged, and record what we got.
 *
 * Unlike the legacy PowerShell downloaders, this never skips a file just
 * because it already exists - that bug is why the corpus sat three releases
 * behind while every re-run reported "skipped, already exists".
 *
 * Safety properties:
 *   - the existing PDF is replaced only after the new bytes are validated,
 *   - every download is hashed and its ETag recorded, so the next check is a
 *     cheap validator comparison rather than another guess,
 *   - the manifest is written atomically after each batch, so an interrupted
 *     run resumes instead of restarting.
 *
 *   npm run sync-docs -- --dry-run
 *   npm run sync-docs
 *   npm run sync-docs -- --only apex --release "Winter '27"
 *
 * Options:
 *   --dry-run                 Show what would be downloaded; write nothing.
 *   --release <name|version>  Target release (default: confirmed from the CDN).
 *   --only <list>             Comma-separated ids/substrings/globs.
 *   --kind <kind>             developer_guide | release_notes
 *   --skip-stale              Leave documents flagged "stale-baseline" alone.
 *                             On a corpus that predates change tracking that is
 *                             everything, so the default is to fetch them; the
 *                             dry run shows the total before anything is written.
 *   --concurrency <n>         Parallel downloads (default 3).
 *   --limit <n>               Stop after n documents.
 *   --force                   Proceed even when the CDN looks unreachable.
 */

import { mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { makeFilter, numberOption, parseArgs } from "./lib/args.js";
import { download, looksLikePdf, mapWithConcurrency, sha256 } from "./lib/http.js";
import { inspectLocal, readFileBytes } from "./lib/local.js";
import {
    Manifest,
    ManifestDocument,
    canonicalUrl,
    documentPath,
    findDocument,
    loadManifest,
    saveManifest,
    upstreamUrl
} from "./lib/manifest.js";
import {
    estimatedCurrentRelease,
    parseRelease,
    Release,
    releaseForVersion,
    releaseFromFileName
} from "./lib/release.js";
import {
    Finding,
    actionableFindings,
    adoptableFindings,
    buildQueue,
    confirmRelease,
    discoverReleaseNotes,
    scanDocuments
} from "./lib/scan.js";

interface SyncOutcome {
    fileName: string;
    ok: boolean;
    bytes: number;
    reason: string;
}

/**
 * Write the PDF only once it has been validated.
 *
 * Salesforce's CDN answers 200 with an HTML error page for some retired docs,
 * so a status check alone is not enough - we look at the bytes.
 */
function writeValidatedPdf(path: string, bytes: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.download`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
}

/**
 * Turn a finding into the manifest entry it should update.
 *
 * Release notes discovered upstream have no manifest entry yet, so one is
 * created here with the URL the discovery probe actually succeeded on.
 */
function resolveDocument(manifest: Manifest, finding: Finding, target: Release): ManifestDocument {
    const existing = findDocument(manifest, finding.fileName);
    if (existing) return existing;

    const created: ManifestDocument = {
        id: finding.id,
        fileName: finding.fileName,
        dir: finding.kind === "release_notes" ? "docs/release-notes" : "docs/pdfs",
        title: finding.fileName.replace(/\.pdf$/i, "").replace(/_/g, " "),
        url: finding.checkedUrl ?? canonicalUrl(finding.id),
        urlSource: "confirmed",
        urlKind: finding.kind === "release_notes" ? "static" : "latest",
        kind: finding.kind,
        pinnedVersion: null,
        release: null,
        apiVersion: null,
        etag: null,
        lastModified: null,
        sizeBytes: null,
        sha256: null,
        fetchedAt: null,
        indexedAt: null
    };
    manifest.documents.push(created);
    return created;
}

async function main(): Promise<void> {
    const args = parseArgs();
    const dryRun = args.flags.has("dry-run");
    const concurrency = numberOption(args, "concurrency", 3);
    const manifest = loadManifest();

    const requested = args.values.get("release");
    const estimate = requested ? parseRelease(requested) : estimatedCurrentRelease();
    if (!estimate) throw new Error(`Could not parse --release "${requested}"`);

    console.log("=".repeat(64));
    console.log(dryRun ? "Sync plan (dry run - nothing will be written)" : "Syncing Salesforce documentation");
    console.log("=".repeat(64));

    const check = requested
        ? { release: estimate, confirmed: false, reachable: true, reason: null }
        : await confirmRelease(estimate);
    const target = check.release;

    if (!check.reachable && !args.flags.has("force")) {
        console.error(`\nCannot reach the documentation CDN: ${check.reason}`);
        console.error("Nothing was downloaded. Run this from a machine with direct access to");
        console.error("resources.docs.salesforce.com, or pass --force to try anyway.");
        process.exit(2);
    }

    console.log(`Target release:    ${target.name} (v${target.apiVersion}, docs version ${target.version})`);

    let queue = buildQueue(manifest, target, {
        filter: makeFilter(args.values.get("only")),
        kind: args.values.get("kind")
    });
    const limit = args.values.get("limit");
    if (limit) queue = queue.slice(0, Number(limit));

    console.log(`Scanning:          ${queue.length} documents`);
    const findings = await scanDocuments(queue, target, Math.max(concurrency, 4));

    if (!args.values.get("only") && args.values.get("kind") !== "developer_guide") {
        findings.push(...(await discoverReleaseNotes(manifest, target, 6)));
    }

    let planned = actionableFindings(findings);
    const adoptable = adoptableFindings(findings, manifest);

    // "stale-baseline" is the entire pre-tracking corpus. Bringing it to the
    // current release is the point of the first run; --skip-stale opts out.
    if (args.flags.has("skip-stale")) {
        const stale = planned.filter(f => f.status === "stale-baseline").length;
        planned = planned.filter(f => f.status !== "stale-baseline");
        if (stale > 0) console.log(`Skipping:          ${stale} stale-baseline documents (--skip-stale)`);
    }

    const plannedBytes = planned.reduce((sum, f) => sum + (f.upstream.sizeBytes ?? 0), 0);
    console.log(`To download:       ${planned.length} documents, ${(plannedBytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`To adopt:          ${adoptable.length} documents already current - record validators, no download`);
    console.log("");

    if (!planned.length && !adoptable.length) {
        console.log("Nothing to do.");
        return;
    }

    if (dryRun && !planned.length) {
        console.log("Dry run - nothing written. Re-run without --dry-run to record validators.");
        return;
    }

    for (const finding of planned) {
        const existing = findDocument(manifest, finding.fileName);
        const destination = existing?.dir ?? (finding.kind === "release_notes" ? "docs/release-notes" : "docs/pdfs");
        const verb = finding.local.exists ? "replaces" : "creates";
        console.log(`  ${finding.status.padEnd(16)} ${finding.fileName.padEnd(46)} ${verb} ${destination}/`);
    }
    console.log("");

    if (dryRun) {
        console.log("Dry run - nothing written. Re-run without --dry-run to download.");
        return;
    }

    // Adopt validators for documents that are already current, so the next
    // check compares ETags instead of guessing from sizes again.
    let adopted = 0;
    for (const finding of adoptable) {
        const doc = findDocument(manifest, finding.fileName);
        if (!doc) continue;
        const path = documentPath(doc);
        doc.etag = finding.upstream.etag;
        doc.lastModified = finding.upstream.lastModified;
        doc.sizeBytes = finding.upstream.sizeBytes;
        doc.sha256 = sha256(readFileBytes(path));
        if (finding.checkedUrl) {
            doc.url = finding.checkedUrl;
            doc.urlSource = "confirmed";
        }
        // Bytes identical to the edition probed = the local copy *is* that
        // edition. Release notes keep their own release; a frozen document
        // matched its pinned edition, which the URL names.
        const pinned = finding.checkedUrl?.match(/\/(\d{3})\/latest\//);
        const release =
            releaseFromFileName(doc.fileName) ??
            (pinned ? releaseForVersion(Number(pinned[1])) : finding.status === "unchanged" ? target : null);
        if (release) {
            doc.release = release.name;
            doc.apiVersion = release.apiVersion;
        }
        adopted++;
    }
    if (adopted) {
        saveManifest(manifest);
        console.log(`Adopted validators for ${adopted} documents.`);
    }
    if (!planned.length) {
        console.log("Nothing to download.");
        return;
    }

    let completed = 0;
    // Persist validators as we go, so an interrupted run resumes rather than
    // re-downloading everything it already fetched.
    const checkpoint = () => { if (completed % 10 === 0) saveManifest(manifest); };
    process.once("SIGINT", () => { saveManifest(manifest); process.exit(130); });

    const outcomes = await mapWithConcurrency(planned, concurrency, async finding => {
        const doc = resolveDocument(manifest, finding, target);
        const url = finding.checkedUrl ?? upstreamUrl(doc, target.version);

        if (!url) {
            return { fileName: finding.fileName, ok: false, bytes: 0, reason: "no source URL" } satisfies SyncOutcome;
        }

        const result = await download(url, { retries: 3 });
        completed++;
        process.stderr.write(`  ...${completed}/${planned.length}\r`);
        checkpoint();

        if (!result.ok || !result.bytes) {
            return {
                fileName: finding.fileName,
                ok: false,
                bytes: 0,
                reason: result.error ?? `HTTP ${result.status}`
            } satisfies SyncOutcome;
        }

        // Guard against an error page served with a 200.
        if (!looksLikePdf(result.bytes)) {
            return {
                fileName: finding.fileName,
                ok: false,
                bytes: result.bytes.length,
                reason: `not a PDF (${result.bytes.length} bytes) - existing copy left untouched`
            } satisfies SyncOutcome;
        }

        // Identical bytes: record the validators but leave the file (and its
        // mtime, and the git working tree) alone.
        const unchanged = doc.sha256 === result.sha256 && inspectLocal(documentPath(doc)).exists;
        if (!unchanged) writeValidatedPdf(documentPath(doc), result.bytes);

        // Record what we got, so the next check is a validator comparison.
        //
        // A release-notes document belongs to its own release regardless of when
        // we fetched it; a developer guide belongs to the release it was served
        // from, which the version-pinned path names explicitly when present.
        const pinned = url.match(/\/(\d{3})\/latest\//);
        const release =
            releaseFromFileName(doc.fileName) ??
            (pinned ? releaseForVersion(Number(pinned[1])) : target);

        doc.url = url;
        doc.urlSource = "confirmed";
        doc.release = release.name;
        doc.apiVersion = release.apiVersion;
        doc.etag = result.etag;
        doc.lastModified = result.lastModified;
        doc.sizeBytes = result.bytes.length;
        doc.sha256 = result.sha256;
        doc.fetchedAt = new Date().toISOString();
        // The bytes changed, so whatever is in the search index is now stale.
        doc.indexedAt = null;

        return {
            fileName: finding.fileName,
            ok: true,
            bytes: result.bytes.length,
            reason: unchanged
                ? "identical bytes - file left as is, validators recorded"
                : `${(result.bytes.length / 1024 / 1024).toFixed(2)} MB -> ${doc.dir}/`
        } satisfies SyncOutcome;
    });

    const succeeded = outcomes.filter(o => o.ok);
    const failed = outcomes.filter(o => !o.ok);

    manifest.generatedAt = new Date().toISOString();
    if (succeeded.length) {
        manifest.syncedRelease = { version: target.version, name: target.name, apiVersion: target.apiVersion };
    }
    manifest.confirmedCurrentRelease = check.confirmed
        ? { version: target.version, name: target.name, checkedAt: new Date().toISOString() }
        : manifest.confirmedCurrentRelease;
    saveManifest(manifest);

    const totalBytes = succeeded.reduce((sum, o) => sum + o.bytes, 0);

    console.log("");
    console.log("=".repeat(64));
    console.log(`Downloaded ${succeeded.length} documents (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    if (failed.length) {
        console.log(`Failed ${failed.length}:`);
        for (const outcome of failed) console.log(`  ${outcome.fileName.padEnd(50)} ${outcome.reason}`);
    }
    console.log("=".repeat(64));
    console.log("Manifest updated. Next:");
    console.log("  npm run build-index -- --changed-only");
}

main().catch(err => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
