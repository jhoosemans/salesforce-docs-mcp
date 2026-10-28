/**
 * Full-text index over chunks (SQLite FTS5) and translation of free-text queries into FTS5 syntax
 */

import type { DatabaseSync } from "node:sqlite";

export const FTS_TABLE = "chunks_fts";

// External-content index: the text lives once, in chunks; FTS5 stores only the index.
// porter: "updates" finds "update". unicode61 splits on punctuation, so the query
// "Database.executeBatch" becomes the phrase "database executebatch".
// search_title holds the "Page › Section" title of web-page chunks (NULL for PDF chunks, whose
// detected section titles are mostly noise such as "EDITIONS"); bm25 weights it above content.
const FTS_SCHEMA = `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
    content,
    search_title,
    content='chunks',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
)`;

/** bm25 weight of a title match relative to a body match */
export const TITLE_WEIGHT = 4;

/**
 * Create the index if missing (or recreate one from before search_title) and rebuild it from
 * chunks (seconds for the whole corpus). chunks must have the search_title column.
 */
export function rebuildFtsIndex(db: DatabaseSync): void {
    if (hasFtsIndex(db) && !hasTitleColumn(db)) db.exec(`DROP TABLE ${FTS_TABLE}`);
    db.exec(FTS_SCHEMA);
    db.exec(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES('rebuild')`);
}

export function hasTitleColumn(db: DatabaseSync): boolean {
    return db.prepare(`SELECT 1 FROM pragma_table_info('${FTS_TABLE}') WHERE name = 'search_title'`).get() !== undefined;
}

export function hasFtsIndex(db: DatabaseSync): boolean {
    return db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(FTS_TABLE) !== undefined;
}

/**
 * Words that say nothing about which chunk is relevant ("in", "it", "the" appear in nearly
 * every chunk; "salesforce" in 64%). Leave out words with meaning in Salesforce
 * (before, after, get, set, new, all).
 */
const STOPWORDS = new Set([
    'about', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'best', 'but',
    'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'if',
    'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'need', 'of', 'on', 'or', 'our',
    'please', 'should', 'so', 'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
    'these', 'they', 'this', 'those', 'to', 'us', 'use', 'using', 'want', 'was', 'way', 'we',
    'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you',
    'your', 'salesforce'
]);

export interface FtsQuery {
    /** Search terms; a multi-part term like "database executebatch" is matched as a phrase */
    terms: string[];
    /** Every term must match */
    all: string;
    /** Any term may match */
    any: string;
}

/**
 * Turn free text into an FTS5 query. Each word is reduced to its letter/digit runs and
 * quoted, so operators, wildcards and stray quotes in the input can never be FTS5 syntax.
 * Returns null when nothing searchable is left.
 */
export function toFtsQuery(query: string): FtsQuery | null {
    const all: string[] = [];
    const content: string[] = [];

    for (const word of query.toLowerCase().split(/\s+/)) {
        const parts = word.match(/[\p{L}\p{N}]+/gu);
        if (!parts) continue;
        const term = parts.join(' ');
        if (all.includes(term)) continue;
        all.push(term);
        const single = parts.length === 1;
        if (!(single && (STOPWORDS.has(term) || term.length < 2))) content.push(term);
    }

    // A query of nothing but stopwords still searches for them
    const terms = content.length > 0 ? content : all;
    if (terms.length === 0) return null;

    const quoted = terms.map(term => `"${term}"`);
    return { terms, all: quoted.join(' AND '), any: quoted.join(' OR ') };
}
