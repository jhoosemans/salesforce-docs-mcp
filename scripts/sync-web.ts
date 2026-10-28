#!/usr/bin/env node
/**
 * Download the guides read as web pages (scripts/lib/web-guides.ts) and record what changed.
 * Every page is downloaded: the site does not answer conditional requests. A guide whose
 * content hash changed gets a new fetchedAt; build-index --changed-only then re-indexes it.
 *
 *   npm run sync-web -- --dry-run
 *   npm run sync-web
 *   npm run sync-web -- --only apexref
 *
 * Options:
 *   --dry-run          List the guides and page counts; download nothing.
 *   --only <list>      Guide ids (lwc, apexcode, apexref) or index file names.
 *   --concurrency <n>  Parallel page downloads (default 4; all share one rate limit).
 *
 * Exit codes: 0 done (failed pages keep their previous copy and are listed), 1 a guide could not
 * be listed at all. A few failed pages must not stop update-docs from re-indexing the rest.
 */

import { makeFilter, numberOption, parseArgs } from "./lib/args.js";
import { estimatedCurrentRelease } from "./lib/release.js";
import { confirmRelease } from "./lib/scan.js";
import { WEB_GUIDES, loadWebGuides, syncWebGuide } from "./lib/web-guides.js";

async function main(): Promise<void> {
    const args = parseArgs();
    const filter = makeFilter(args.values.get("only"));
    const concurrency = numberOption(args, "concurrency", 4);
    const guides = WEB_GUIDES.filter(guide => filter(guide.id) || filter(guide.fileName));

    // The LWC guide carries no release of its own; it is recorded at the release being served
    const { release: target } = await confirmRelease(estimatedCurrentRelease());

    if (args.flags.has("dry-run")) {
        const state = loadWebGuides();
        for (const guide of guides) {
            const listing = await guide.list();
            const recorded = state.guides[guide.id];
            console.log(`${guide.id.padEnd(9)} ${String(listing.pages.length).padStart(5)} pages  ${listing.release ?? target.name}` +
                `  (recorded: ${recorded ? `${recorded.pageCount} pages, ${recorded.release}` : "never synced"})`);
        }
        console.log("\nDry run - nothing downloaded.");
        return;
    }

    let failures = 0;
    let unlisted = 0;
    for (const guide of guides) {
        const started = Date.now();
        let result;
        try {
            result = await syncWebGuide(guide, target, concurrency, line => console.log(line));
        } catch (error) {
            console.log(`${guide.id}: could not list the guide - ${error instanceof Error ? error.message : error}; nothing changed`);
            unlisted++;
            continue;
        }
        failures += result.failed.length;
        console.log(`${guide.id}: ${result.pages} pages, ${result.changedPages} changed, ${result.failed.length} failed` +
            `${result.contentChanged ? " - will be re-indexed" : " - content unchanged"} (${Math.round((Date.now() - started) / 1000)} s)`);
        for (const failure of result.failed.slice(0, 10)) console.log(`  failed ${failure.id}: ${failure.error}`);
        if (result.blocked) console.log(`  ${guide.id}: the site rate-limited this run; re-run later to complete it`);
    }
    if (failures) console.log(`\n${failures} pages failed; their previous copies are kept. Re-run to retry.`);
    process.exitCode = unlisted ? 1 : 0;
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
