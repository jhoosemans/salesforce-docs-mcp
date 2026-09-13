/**
 * Salesforce release calendar helpers.
 *
 * Salesforce ships three releases a year and bumps the documentation version
 * by 2 each time. The season order inside a calendar year is Spring, Summer,
 * Winter - and the Winter release carries the *following* year's label:
 *
 *   248 = Spring '24    250 = Summer '24    252 = Winter '25
 *   254 = Spring '25    256 = Summer '25    258 = Winter '26
 *   260 = Spring '26    262 = Summer '26    264 = Winter '27
 *
 * The API version tracks the doc version exactly: apiVersion = docVersion / 2 - 64
 * (258 -> 65.0, 264 -> 68.0).
 */

export type Season = "spring" | "summer" | "winter";

export interface Release {
    /** Documentation path version, e.g. 258. */
    version: number;
    season: Season;
    /** Two-digit year label as Salesforce writes it, e.g. 27 for Winter '27. */
    yearLabel: number;
    /** Human name, e.g. "Winter '27". */
    name: string;
    /** API version, e.g. "68.0". */
    apiVersion: string;
    /** Release notes PDF basename, e.g. salesforce_winter27_release_notes.pdf */
    releaseNotesFile: string;
}

const SEASON_ORDER: Season[] = ["spring", "summer", "winter"];

/** Anchor the sequence on a release we have verified from the shipped corpus. */
const ANCHOR_VERSION = 258;
const ANCHOR_INDEX = seasonIndex(2025, "winter"); // Winter '26 ships in calendar 2025

function seasonIndex(calendarYear: number, season: Season): number {
    return calendarYear * 3 + SEASON_ORDER.indexOf(season);
}

function fromSeasonIndex(index: number): { calendarYear: number; season: Season } {
    const calendarYear = Math.floor(index / 3);
    return { calendarYear, season: SEASON_ORDER[index - calendarYear * 3] };
}

function titleCase(season: Season): string {
    return season.charAt(0).toUpperCase() + season.slice(1);
}

/** Build the Release descriptor for a documentation version number. */
export function releaseForVersion(version: number): Release {
    if (version % 2 !== 0) {
        throw new Error(`Salesforce doc versions are even; got ${version}`);
    }
    const index = ANCHOR_INDEX + (version - ANCHOR_VERSION) / 2;
    const { calendarYear, season } = fromSeasonIndex(index);
    // Winter carries the next calendar year's label.
    const yearLabel = (season === "winter" ? calendarYear + 1 : calendarYear) % 100;
    const yy = String(yearLabel).padStart(2, "0");

    return {
        version,
        season,
        yearLabel,
        name: `${titleCase(season)} '${yy}`,
        apiVersion: `${version / 2 - 64}.0`,
        releaseNotesFile: `salesforce_${season}${yy}_release_notes.pdf`
    };
}

/**
 * The release Salesforce is serving as "current" on a given date.
 *
 * Production rollout runs in waves, so the boundaries below are the month in
 * which each release generally becomes the one the docs site serves. This is a
 * starting guess only - `check-updates` confirms the real version over HTTP and
 * writes it back to the manifest.
 */
export function estimatedCurrentRelease(now: Date = new Date()): Release {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1; // 1-12

    let season: Season;
    if (month >= 9) season = "winter";
    else if (month >= 6) season = "summer";
    else if (month >= 2) season = "spring";
    else {
        // January still serves the previous Winter release.
        season = "winter";
        return releaseForVersion(versionFor(year - 1, season));
    }
    return releaseForVersion(versionFor(year, season));
}

/** Documentation version for a season in a given calendar year. */
export function versionFor(calendarYear: number, season: Season): number {
    return ANCHOR_VERSION + (seasonIndex(calendarYear, season) - ANCHOR_INDEX) * 2;
}

/** The n releases up to and including `release`, oldest first. */
export function recentReleases(release: Release, count: number): Release[] {
    const out: Release[] = [];
    for (let i = count - 1; i >= 0; i--) {
        out.push(releaseForVersion(release.version - i * 2));
    }
    return out;
}

/** Parse "Winter 27", "winter '27", "264" or "Winter_27" into a Release. */
export function parseRelease(input: string): Release | null {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) return releaseForVersion(Number(trimmed));

    const match = trimmed.match(/^(spring|summer|winter)[\s_'’]*(\d{2})$/i);
    if (!match) return null;

    const season = match[1].toLowerCase() as Season;
    const yearLabel = Number(match[2]);
    // Winter '27 ships in calendar 2026; Spring/Summer ship in their own year.
    const calendarYear = 2000 + (season === "winter" ? yearLabel - 1 : yearLabel);
    return releaseForVersion(versionFor(calendarYear, season));
}

/**
 * Recover the release a release-notes document belongs to from its filename.
 *
 * Release notes are per-release documents: ReleaseNotes_Spring_25.pdf is always
 * Spring '25, no matter which release we happened to download it in. Stamping
 * them with the sync target instead would make every release note claim to be
 * from the current release.
 */
export function releaseFromFileName(fileName: string): Release | null {
    const match = fileName.match(/^ReleaseNotes_(Spring|Summer|Winter)_(\d{2})\.pdf$/i);
    if (!match) return null;
    return parseRelease(`${match[1]} ${match[2]}`);
}
