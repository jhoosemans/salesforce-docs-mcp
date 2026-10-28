/**
 * Database query functions for search and retrieval
 * Search runs on the FTS5 index (src/db/fts.ts), ranked by BM25 and document priority,
 * within the category that intent detection picks
 */

import { getDatabase } from "./database.js";
import { 
    DocumentMetadata, 
    SearchResult, 
    SearchOptions, 
    DocCategory 
} from "../types.js";
import { LRUCache } from "lru-cache";
import { detectIntent, describeIntent } from "../utils/intent.js";
import { FTS_TABLE, hasFtsIndex, toFtsQuery } from "./fts.js";

// Search result cache
const searchCache = new LRUCache<string, SearchResult[]>({
    max: 500,
    ttl: 1000 * 60 * 5, // 5 minutes
});

// Maximum query length for security
const MAX_QUERY_LENGTH = 500;

/**
 * Sanitize search query
 */
function sanitizeQuery(query: string): string {
    if (query.length > MAX_QUERY_LENGTH) {
        query = query.substring(0, MAX_QUERY_LENGTH);
    }
    return query
        .replace(/[<>]/g, '')
        .replace(/[\x00-\x1f]/g, '')
        .trim();
}

/**
 * Document priority (1-10) as a multiplier on BM25: priority 10 counts 1.25x, 5 counts 1x.
 * Freshness (0.09-1, stamped by build-index) pushes old and superseded documents down.
 * BM25 is negative (more negative = better), so a larger multiplier ranks higher.
 */
const PRIORITY_FACTOR = `(1 + (d.priority - 5) * 0.05)`;
const RANK_BY_RELEVANCE = `bm25(${FTS_TABLE}) * ${PRIORITY_FACTOR}`;
const RANK_WITH_FRESHNESS = `${RANK_BY_RELEVANCE} * COALESCE(d.freshness, 1)`;

// "Spring '22", "summer 24", "Winter_27": the question is about that release, so
// its age must not count against it
const NAMED_RELEASE = /\b(spring|summer|winter)[\s_'’]*\d{2}\b/i;

// Below this freshness (about 7 releases behind, or superseded) an every-term match no longer
// wins outright; it competes with any-term matches at ALL_TERMS_BONUS times its rank.
// Measured 2026-10-27: test-search 348 -> 351; bonus 1.5-3 makes no difference.
const STALE_FRESHNESS = 0.5;
const ALL_TERMS_BONUS = 2;

let ftsChecked = false;
let hasFreshness = false;

/**
 * Search documents using intent-based filtering over the full-text index
 * 
 * Strategy:
 * 1. Detect intent from query (e.g., "apex trigger" → Apex Development)
 * 2. If high/medium confidence and no explicit filter provided, auto-filter to relevant subcategory
 * 3. Within that scope, take chunks containing every term; top up with chunks containing any term
 * 4. If too few results, fall back to broader search
 */
export async function searchDocuments(
    query: string,
    options: SearchOptions = {}
): Promise<SearchResult[]> {
    const db = await getDatabase();
    if (!ftsChecked) {
        if (!hasFtsIndex(db)) {
            throw new Error("Search failed: the index has no full-text index yet. Run: npm run build-index -- --changed-only");
        }
        hasFreshness = db.prepare(`SELECT 1 FROM pragma_table_info('documents') WHERE name = 'freshness'`).get() !== undefined;
        ftsChecked = true;
    }
    const sanitizedQuery = sanitizeQuery(query);
    
    // Detect intent from query
    const intent = detectIntent(sanitizedQuery);
    const intentDescription = describeIntent(intent);
    
    // Determine effective filters: user-provided > intent-detected
    let effectiveCategory = options.category;
    let effectiveSubcategory = options.subcategory;
    let usedIntentFilter = false;
    
    // A question naming a release ("Spring '22") is about what changed in it: search the
    // release notes first. Otherwise apply intent-based filtering if confidence is sufficient
    const namesRelease = NAMED_RELEASE.test(sanitizedQuery);
    if (!options.category && !options.subcategory && namesRelease) {
        effectiveCategory = DocCategory.RELEASE_NOTES;
        usedIntentFilter = true;
    } else if (!options.category && !options.subcategory && intent.confidence !== 'low' && intent.subcategory) {
        effectiveSubcategory = intent.subcategory;
        effectiveCategory = intent.category as DocCategory;
        usedIntentFilter = true;
    }
    
    // Check cache (include effective filters in cache key)
    const cacheKey = JSON.stringify({ 
        query: sanitizedQuery, 
        options,
        effectiveCategory,
        effectiveSubcategory
    });
    const cached = searchCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    
    const maxResults = options.maxResults || 5;
    const ftsQuery = toFtsQuery(sanitizedQuery);
    const rankExpression = hasFreshness && !namesRelease ? RANK_WITH_FRESHNESS : RANK_BY_RELEVANCE;
    const editionColumns = hasFreshness ? `d.edition, d.edition_label, d.superseded_by, d.freshness` : `NULL AS edition, NULL AS edition_label, NULL AS superseded_by, NULL AS freshness`;
    
    if (!ftsQuery) {
        return [];
    }
    
    /**
     * Run one FTS5 match with the given filters, best first
     */
    const runMatch = (
        match: string,
        category: string | undefined,
        subcategory: string | undefined
    ): any[] => {
        const params: any[] = [match];
        let sql = `
            SELECT 
                c.id AS chunk_id, d.id, d.file_name, d.file_path, d.category, d.subcategory,
                d.doc_type, d.title, d.description, d.keywords, d.api_version, d.priority, ${editionColumns},
                c.content, c.section_title, c.page_number,
                ${rankExpression} AS rank
            FROM ${FTS_TABLE}
            JOIN chunks c ON c.id = ${FTS_TABLE}.rowid
            JOIN documents d ON c.document_id = d.id
            WHERE ${FTS_TABLE} MATCH ?
        `;
        
        if (category) {
            sql += ` AND d.category = ?`;
            params.push(category);
        }
        if (subcategory) {
            sql += ` AND d.subcategory = ?`;
            params.push(subcategory);
        }
        if (options.documentId !== undefined) {
            sql += ` AND d.id = ?`;
            params.push(options.documentId);
        }
        
        sql += ` ORDER BY rank LIMIT ?`;
        params.push(maxResults);
        
        return db.prepare(sql).all(...params);
    };
    
    /**
     * Search with given filters and return scored results
     */
    const executeSearch = (
        category: string | undefined, 
        subcategory: string | undefined
    ): SearchResult[] => {
        // Chunks with every term first; any-term matches fill the remaining places.
        // When an every-term chunk comes from an old or superseded document, rank both
        // sets together instead, so a current document matching most terms can win.
        let rows = runMatch(ftsQuery.all, category, subcategory);
        const stale = rows.some(row => (row.freshness ?? 1) < STALE_FRESHNESS);
        if (ftsQuery.terms.length > 1 && (rows.length < maxResults || stale)) {
            const seen = new Set(rows.map(row => row.chunk_id));
            const others = runMatch(ftsQuery.any, category, subcategory).filter(row => !seen.has(row.chunk_id));
            if (stale) {
                rows = [...rows.map(row => ({ ...row, rank: row.rank * ALL_TERMS_BONUS })), ...others]
                    .sort((x, y) => x.rank - y.rank)
                    .slice(0, maxResults);
            } else {
                rows.push(...others.slice(0, maxResults - rows.length));
            }
        }
        
        return rows.map((row) => {
            const content = (row.content as string) || '';
            const contentLower = content.toLowerCase();
            const priority = (row.priority as number) || 1;
            
            // Match density: what fraction of search terms appear in this chunk
            const matchCount = ftsQuery.terms.filter(term => term.split(' ').every(part => contentLower.includes(part))).length;
            const matchDensity = matchCount / ftsQuery.terms.length;
            
            return {
                document: {
                    id: row.id as number,
                    fileName: row.file_name as string,
                    filePath: row.file_path as string,
                    category: row.category as DocCategory,
                    subcategory: row.subcategory as string,
                    docType: row.doc_type as any,
                    title: row.title as string,
                    description: row.description as string,
                    keywords: row.keywords ? JSON.parse(row.keywords as string) : [],
                    apiVersion: row.api_version as string,
                    priority,
                    edition: row.edition ?? undefined,
                    editionLabel: row.edition_label ?? undefined,
                    supersededBy: row.superseded_by ?? undefined
                },
                chunk: content,
                // BM25 is negative; report it as a positive "higher is better" score
                score: Math.round(-row.rank * 100) / 100,
                matchDensity,
                sectionTitle: row.section_title as string,
                highlights: extractHighlights(content, sanitizedQuery),
                detectedIntent: usedIntentFilter ? {
                    category: intent.category,
                    subcategory: intent.subcategory,
                    confidence: intent.confidence,
                    description: intentDescription
                } : undefined
            };
        });
    };
    
    try {
        // First search: with intent-based or user-provided filters
        let results = executeSearch(effectiveCategory, effectiveSubcategory);
        
        // Fallback: if intent filter yielded too few results, try broader search
        if (usedIntentFilter && results.length < maxResults) {
            // Try category-only (drop subcategory)
            const categoryResults = executeSearch(effectiveCategory, undefined);
            if (categoryResults.length > results.length) {
                results = categoryResults;
            }
            
            // If still too few, try unfiltered
            if (results.length < maxResults) {
                const unfilteredResults = executeSearch(undefined, undefined);
                if (unfilteredResults.length > results.length) {
                    results = unfilteredResults;
                }
            }
        }
        
        const topResults = results.slice(0, maxResults);
        searchCache.set(cacheKey, topResults);
        return topResults;
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Search error:", errorMessage);
        throw new Error(`Search failed: ${errorMessage}`);
    }
}

/**
 * Extract highlight snippets from content
 */
function extractHighlights(content: string, query: string): string[] {
    if (!content) return [];
    
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const highlights: string[] = [];
    const contentLower = content.toLowerCase();
    
    for (const word of words) {
        const index = contentLower.indexOf(word);
        if (index !== -1) {
            // Extract surrounding context (100 chars before and after)
            const start = Math.max(0, index - 100);
            const end = Math.min(content.length, index + word.length + 100);
            let snippet = content.substring(start, end);
            
            // Clean up snippet
            if (start > 0) snippet = '...' + snippet;
            if (end < content.length) snippet = snippet + '...';
            
            highlights.push(snippet);
            
            if (highlights.length >= 2) break;
        }
    }
    
    return highlights;
}

/**
 * Get document by filename
 */
export async function getDocumentByFileName(fileName: string): Promise<DocumentMetadata | null> {
    const db = await getDatabase();
    
    const stmtRows = db.prepare(`SELECT * FROM documents WHERE file_name LIKE ? OR file_name = ?`).all(`%${fileName}%`, fileName);
    
    if (stmtRows.length === 0) {
        return null;
    }
    
    const row = stmtRows[0];
    
    const getValue = (col: string) => row[col] ?? null;
    
    return {
        id: getValue('id') as number,
        fileName: getValue('file_name') as string,
        filePath: getValue('file_path') as string,
        category: getValue('category') as DocCategory,
        subcategory: getValue('subcategory') as string,
        docType: getValue('doc_type') as any,
        title: getValue('title') as string,
        description: getValue('description') as string,
        keywords: getValue('keywords') ? JSON.parse(getValue('keywords') as string) : [],
        apiVersion: getValue('api_version') as string,
        lastUpdated: getValue('last_updated') as string,
        pageCount: getValue('page_count') as number,
        sizeBytes: getValue('size_bytes') as number,
        priority: getValue('priority') as number,
        editionLabel: getValue('edition_label') ?? undefined,
        supersededBy: getValue('superseded_by') ?? undefined
    };
}

/**
 * Get document by ID
 */
export async function getDocumentById(id: number): Promise<DocumentMetadata | null> {
    const db = await getDatabase();
    
    const stmtRows = db.prepare(`SELECT * FROM documents WHERE id = ?`).all(id);
    
    if (stmtRows.length === 0) {
        return null;
    }
    
    const row = stmtRows[0];
    
    const getValue = (col: string) => row[col] ?? null;
    
    return {
        id: getValue('id') as number,
        fileName: getValue('file_name') as string,
        filePath: getValue('file_path') as string,
        category: getValue('category') as DocCategory,
        subcategory: getValue('subcategory') as string,
        docType: getValue('doc_type') as any,
        title: getValue('title') as string,
        description: getValue('description') as string,
        keywords: getValue('keywords') ? JSON.parse(getValue('keywords') as string) : [],
        apiVersion: getValue('api_version') as string,
        lastUpdated: getValue('last_updated') as string,
        pageCount: getValue('page_count') as number,
        sizeBytes: getValue('size_bytes') as number,
        priority: getValue('priority') as number,
        editionLabel: getValue('edition_label') ?? undefined,
        supersededBy: getValue('superseded_by') ?? undefined
    };
}

/**
 * Get document content (all chunks or specific section)
 */
export async function getDocumentContent(
    documentId: number,
    section?: string
): Promise<string> {
    const db = await getDatabase();
    
    // Build parameterized query
    const params: any[] = [documentId];
    let sql = `
        SELECT content, section_title
        FROM chunks
        WHERE document_id = ?
    `;
    
    if (section) {
        sql += ` AND section_title LIKE ?`;
        params.push(`%${section}%`);
    }
    
    sql += ` ORDER BY chunk_index`;
    
    const stmtRows = db.prepare(sql).all(...params);
    
    if (stmtRows.length === 0) {
        return '';
    }
    
    return stmtRows.map(row => {
        const content = row.content as string;
        const sectionTitle = row.section_title as string;
        
        if (sectionTitle) {
            return `## ${sectionTitle}\n\n${content}`;
        }
        return content;
    }).join('\n\n');
}

/**
 * Get all categories with counts
 */
export async function getCategoryStats(): Promise<Array<{
    category: string;
    count: number;
    subcategories: Array<{ name: string; count: number }>;
}>> {
    const db = await getDatabase();
    
    const subStmt = db.prepare(`
        SELECT 
            subcategory as name,
            COUNT(*) as count
        FROM documents
        WHERE category = ?
        GROUP BY subcategory
        ORDER BY subcategory
    `);
    
    const result = db.prepare(`
        SELECT 
            category,
            COUNT(*) as count
        FROM documents
        GROUP BY category
        ORDER BY category
    `).all().map(row => ({
        category: row.category as string,
        count: row.count as number,
        subcategories: subStmt.all(row.category).map(subRow => ({
            name: subRow.name as string,
            count: subRow.count as number
        }))
    }));
    
    return result;
}

/**
 * Get documents by category
 */
export async function getDocumentsByCategory(
    category: DocCategory,
    limit: number = 20
): Promise<DocumentMetadata[]> {
    const db = await getDatabase();
    
    const stmtRows = db.prepare(`
        SELECT * FROM documents
        WHERE category = ?
        ORDER BY priority DESC, title
        LIMIT ?
    `).all(category, limit);
    
    if (stmtRows.length === 0) {
        return [];
    }
    
    return stmtRows.map(row => {
        const getValue = (col: string) => row[col] ?? null;
        
        return {
            id: getValue('id') as number,
            fileName: getValue('file_name') as string,
            filePath: getValue('file_path') as string,
            category: getValue('category') as DocCategory,
            subcategory: getValue('subcategory') as string,
            docType: getValue('doc_type') as any,
            title: getValue('title') as string,
            description: getValue('description') as string,
            keywords: getValue('keywords') ? JSON.parse(getValue('keywords') as string) : [],
            apiVersion: getValue('api_version') as string,
            lastUpdated: getValue('last_updated') as string,
            pageCount: getValue('page_count') as number,
            sizeBytes: getValue('size_bytes') as number,
            priority: getValue('priority') as number,
            editionLabel: getValue('edition_label') ?? undefined,
            supersededBy: getValue('superseded_by') ?? undefined
        };
    });
}

/**
 * Document summary for LLM browsing
 */
export interface DocumentSummary {
    id: number;
    fileName: string;
    title: string;
    description: string;
    category: string;
    subcategory: string;
    keywords: string[];
}

/**
 * Get lightweight document summaries for LLM to browse
 * This enables the LLM to understand available documentation without reading full content
 */
export async function getDocumentSummaries(
    category?: DocCategory,
    limit: number = 20
): Promise<DocumentSummary[]> {
    const db = await getDatabase();
    
    let sql = `
        SELECT id, file_name, title, description, category, subcategory, keywords
        FROM documents
    `;
    
    const params: any[] = [];
    if (category) {
        sql += ` WHERE category = ?`;
        params.push(category);
    }
    
    sql += ` ORDER BY priority DESC, title LIMIT ?`;
    params.push(limit);
    
    const rows = db.prepare(sql).all(...params);
    
    return rows.map(row => {
        const getValue = (col: string) => row[col] ?? null;
        
        return {
            id: getValue('id') as number,
            fileName: getValue('file_name') as string,
            title: (getValue('title') as string) || getValue('file_name') as string,
            description: (getValue('description') as string) || '',
            category: getValue('category') as string,
            subcategory: getValue('subcategory') as string || '',
            keywords: getValue('keywords') ? JSON.parse(getValue('keywords') as string) : []
        };
    });
}
