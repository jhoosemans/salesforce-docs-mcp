/**
 * Scan Salesforce's documentation CDN for new and updated PDFs.
 *
 * Read-only: this never writes the manifest, never touches docs/, and never
 * downloads a PDF body. It asks the CDN for validators (ETag, Last-Modified,
 * Content-Length) and diffs them against what the manifest recorded, then tells
 * you what `npm run sync-docs` would fetch.
 *
 *   npm run check-updates
 *   npm run check-updates -- --release "Winter '27" --json data/update-report.json
 *   npm run check-updates -- --only apex,lwc --verbose
 *
 * Options:
 *   --release <name|version>  Target release (default: inferred from today's date,
 *                             then confirmed against the CDN).
 *   --only <list>             Comma-separated ids/substrings/globs to check.
 *   --kind <kind>             developer_guide | release_notes
 *   --concurrency <n>         Parallel probes (default 6).
 *   --limit <n>               Stop after n documents (smoke test).
 *   --json <path>             Write the full report as JSON.
 *   --verbose                 List every document, not just the first 20 per group.
 *   --force                   Probe even when the CDN looks unreachable.
 *
 * Exit codes: 0 nothing to sync, 3 updates available, 2 CDN unreachable, 1 error.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { makeFilter, numberOption, parseArgs } from "./lib/args.js";
import { PROJECT_ROOT, loadManifest } from "./lib/manifest.js";
import { estimatedCurrentRelease, parseRelease, Release } from "./lib/release.js";
import {
    Finding,
    NEEDS_SYNC,
    Status,
    buildQueue,
    confirmRelease,
    discoverReleaseNotes,
    scanDocuments,
    summarize
} from "./lib/scan.js";

/** How many past releases to look for undiscovered release notes in. */
const RELEASE_NOTES_LOOKBACK = 6;

function printUnreachable(reason: string | null): never {
    console.log("");
    console.log("=".repeat(64));
    console.log("Cannot reach the Salesforce documentation CDN.");
    console.log("=".repeat(64));
    console.log(`Reason: ${reason}`);
    console.log("");
    console.log("Nothing was checked, so nothing can be said about what is new or");
    console.log("changed upstream. This is a network result, not a documentation result.");
    console.log("");
    console.log("Run this from a machine with direct access to:");
    console.log("  resources.docs.salesforce.com");
    console.log("");
    console.log("Transport is curl (system trust store); a proxy is honoured via");
    console.log("the usual https_proxy environment variable.");
    console.log("");
    console.log("Use --force to probe every document anyway.");
    process.exit(2);
}

function report(findings: Finding[], target: Release, verbose: boolean): void {
    const groups: Array<{ status: Status; heading: string }> = [
        { status: "new-upstream", heading: "NEW upstream (not in the corpus)" },
        { status: "changed", heading: "CHANGED upstream (validators differ)" },
        { status: "stale-baseline", heading: "STALE (older release, or never verified)" },
        { status: "missing-locally", heading: "MISSING locally (tracked, not on disk)" },
        { status: "lfs-pointer", heading: "LFS POINTERS (run: git lfs pull)" },
        { status: "not-yet-published", heading: "NOT YET PUBLISHED (expected for the target release)" },
        { status: "frozen", heading: "FROZEN (legacy: no current edition, pinned edition still served)" },
        { status: "gone", heading: "GONE upstream (retired by Salesforce)" },
        { status: "blocked", heading: "BLOCKED (access denied - network policy, not a doc change)" },
        { status: "error", heading: "ERRORS (could not check)" }
    ];

    for (const { status, heading } of groups) {
        const matching = findings.filter(f => f.status === status);
        if (!matching.length) continue;

        console.log(`${heading}: ${matching.length}`);
        const shown = verbose ? matching : matching.slice(0, 20);
        for (const finding of shown) {
            console.log(`  ${finding.fileName.padEnd(52)} ${finding.reason}`);
        }
        if (shown.length < matching.length) {
            console.log(`  ... and ${matching.length - shown.length} more (use --verbose)`);
        }
        console.log("");
    }

    const counts = summarize(findings);
    const actionable = NEEDS_SYNC.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

    console.log("=".repeat(64));
    console.log(`Checked ${findings.length} documents against ${target.name}`);
    console.log(
        `  unchanged ${counts.unchanged ?? 0}  |  changed ${counts.changed ?? 0}  |  ` +
        `stale ${counts["stale-baseline"] ?? 0}  |  new ${counts["new-upstream"] ?? 0}  |  ` +
        `missing ${counts["missing-locally"] ?? 0}  |  frozen ${counts.frozen ?? 0}  |  gone ${counts.gone ?? 0}  |  ` +
        `blocked ${counts.blocked ?? 0}  |  errors ${counts.error ?? 0}`
    );
    console.log("=".repeat(64));

    const unreachable = (counts.blocked ?? 0) + (counts.error ?? 0);
    if (unreachable > 0) {
        console.log(`${unreachable} documents could not be checked - the results above are incomplete.`);
        if (counts.blocked) {
            console.log("A 403 means the network refused the request, not that the document changed.");
            console.log("Check from a machine with direct access to resources.docs.salesforce.com.");
        }
        console.log("");
    }

    const pointers = counts["lfs-pointer"] ?? 0;
    if (pointers > 0) {
        console.log(`${pointers} local files are Git LFS pointers, not PDFs, so their content could not be`);
        console.log("compared. Fetch them first, then re-run this check:");
        console.log("  git lfs pull");
        console.log("");
    }

    if (actionable === 0) {
        if (unreachable > 0) console.log("No updates found among the documents that could be checked.");
        else if (pointers > 0) console.log("No updates found among the documents that could be compared.");
        else console.log("Everything is up to date. Nothing to sync.");
        return;
    }

    console.log(`${actionable} documents would be fetched. Next:`);
    console.log("  npm run sync-docs -- --dry-run      # confirm the plan");
    console.log("  npm run sync-docs                   # download them");
    console.log("  npm run build-index -- --changed-only");
    process.exitCode = 3;
}

async function main(): Promise<void> {
    const args = parseArgs();
    const verbose = args.flags.has("verbose");
    const concurrency = numberOption(args, "concurrency", 6);
    const manifest = loadManifest();

    const requested = args.values.get("release");
    const estimate = requested ? parseRelease(requested) : estimatedCurrentRelease();
    if (!estimate) throw new Error(`Could not parse --release "${requested}"`);

    console.log("=".repeat(64));
    console.log("Salesforce documentation update check");
    console.log("=".repeat(64));
    console.log(`Manifest:          ${manifest.documents.length} documents`);
    console.log(`Last synced to:    ${manifest.syncedRelease?.name ?? "never synced"}`);
    console.log(`Checking against:  ${estimate.name} (v${estimate.apiVersion}, docs version ${estimate.version})`);

    const check = requested
        ? { release: estimate, confirmed: false, reachable: true, reason: null }
        : await confirmRelease(estimate);
    const target = check.release;

    if (!check.reachable && !args.flags.has("force")) printUnreachable(check.reason);

    if (check.confirmed && target.version !== estimate.version) {
        console.log(`Adjusted:          CDN is serving ${target.name}, not ${estimate.name}`);
    } else if (check.confirmed) {
        console.log(`Confirmed:         CDN is serving ${target.name}`);
    } else if (!requested) {
        console.log(`Unconfirmed:       could not confirm the release; using the date-based estimate`);
    }

    let queue = buildQueue(manifest, target, {
        filter: makeFilter(args.values.get("only")),
        kind: args.values.get("kind")
    });

    const limit = args.values.get("limit");
    if (limit) queue = queue.slice(0, Number(limit));

    console.log(`Probing:           ${queue.length} documents (concurrency ${concurrency})`);
    console.log("");

    const findings = await scanDocuments(queue, target, concurrency, (done, total) => {
        if (done % 25 === 0) process.stderr.write(`  ...${done}/${total}\r`);
    });

    // Release notes for new releases are additions, not changes - find them separately.
    if (!args.values.get("only") && args.values.get("kind") !== "developer_guide") {
        findings.push(...(await discoverReleaseNotes(manifest, target, RELEASE_NOTES_LOOKBACK)));
    }

    report(findings, target, verbose);

    const jsonPath = args.values.get("json");
    if (jsonPath) {
        const absolute = join(PROJECT_ROOT, jsonPath);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(
            absolute,
            JSON.stringify(
                {
                    checkedAt: new Date().toISOString(),
                    targetRelease: { version: target.version, name: target.name, apiVersion: target.apiVersion },
                    confirmed: check.confirmed,
                    summary: summarize(findings),
                    findings
                },
                null,
                2
            ) + "\n"
        );
        console.log(`\nReport written to ${jsonPath}`);
    }
}

main().catch(err => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
