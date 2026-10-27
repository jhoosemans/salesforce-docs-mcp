/**
 * Database initialization and connection management
 * Uses node:sqlite (built into Node) and reads the index from disk; nothing is loaded into memory
 */

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdirSync } from "fs";
import { rebuildFtsIndex } from "./fts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database path - relative to project root
const PROJECT_ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const DB_PATH = join(DATA_DIR, "salesforce-docs.db");

let db: DatabaseSync | null = null;

/**
 * Get or create database connection.
 * An existing index opens read-only: the server never writes it, build-index replaces it.
 */
export async function getDatabase(): Promise<DatabaseSync> {
    if (!db) {
        // Ensure data directory exists
        if (!existsSync(DATA_DIR)) {
            mkdirSync(DATA_DIR, { recursive: true });
        }
        db = existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : new DatabaseSync(DB_PATH);
    }
    return db;
}

/**
 * Initialize database schema
 */
export async function initializeDatabase(): Promise<void> {
    const existing = (await getDatabase()).prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='documents'
    `).get();

    if (existing) {
        console.error("Database already initialized");
        return;
    }

    console.error("Initializing database schema...");

    // The file may exist but be empty, in which case it was opened read-only
    closeDatabase();
    db = new DatabaseSync(DB_PATH);

    // Create main documents table
    db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
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
            page_count INTEGER,
            size_bytes INTEGER,
            priority INTEGER DEFAULT 5 CHECK(priority >= 1 AND priority <= 10)
        )
    `);

    // Create document chunks table
    db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            content_lower TEXT NOT NULL,
            section_title TEXT,
            page_number INTEGER,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
            UNIQUE(document_id, chunk_index)
        )
    `);

    // Full-text index over chunks (empty until build-index fills chunks)
    rebuildFtsIndex(db);

    // Create indexes for common queries
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_subcategory ON documents(subcategory)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_priority ON documents(priority DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)`);

    console.error("Database schema initialized successfully");
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
    }
}

/**
 * Get database path
 */
export function getDatabasePath(): string {
    return DB_PATH;
}

/**
 * Check if database has been indexed
 */
export async function isDatabaseIndexed(): Promise<boolean> {
    try {
        const db = await getDatabase();
        const row = db.prepare("SELECT COUNT(*) as count FROM documents").get();
        return Number(row?.count ?? 0) > 0;
    } catch {
        return false;
    }
}
