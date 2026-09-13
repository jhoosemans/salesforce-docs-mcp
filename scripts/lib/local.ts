/** Facts about the copy of a document sitting on disk. */

import { existsSync, readFileSync, statSync } from "fs";
import { openSync, readSync, closeSync } from "fs";

export interface LocalFile {
    exists: boolean;
    sizeBytes: number | null;
    /** True when the file is an unfetched Git LFS pointer rather than a PDF. */
    isLfsPointer: boolean;
    /** True when the bytes on disk start with a PDF header. */
    isPdf: boolean;
}

const LFS_MAGIC = "version https://git-lfs";

export function inspectLocal(path: string): LocalFile {
    if (!existsSync(path)) {
        return { exists: false, sizeBytes: null, isLfsPointer: false, isPdf: false };
    }

    const sizeBytes = statSync(path).size;
    const head = readHead(path, 64);

    return {
        exists: true,
        sizeBytes,
        isLfsPointer: head.startsWith(LFS_MAGIC),
        isPdf: head.startsWith("%PDF-")
    };
}

function readHead(path: string, bytes: number): string {
    const buffer = Buffer.alloc(bytes);
    const fd = openSync(path, "r");
    try {
        const read = readSync(fd, buffer, 0, bytes, 0);
        return buffer.subarray(0, read).toString("latin1");
    } finally {
        closeSync(fd);
    }
}

export function readFileBytes(path: string): Buffer {
    return readFileSync(path);
}
