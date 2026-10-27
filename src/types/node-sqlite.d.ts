/**
 * Type declarations for node:sqlite (built into Node since 22.13)
 * Only what this project uses; @types/node 20 predates the module.
 */

declare module "node:sqlite" {
    export type SQLInputValue = null | number | bigint | string | Uint8Array;

    export interface StatementSync {
        all(...params: SQLInputValue[]): Record<string, any>[];
        get(...params: SQLInputValue[]): Record<string, any> | undefined;
        run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    }

    export class DatabaseSync {
        constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
        exec(sql: string): void;
        prepare(sql: string): StatementSync;
        close(): void;
    }
}
