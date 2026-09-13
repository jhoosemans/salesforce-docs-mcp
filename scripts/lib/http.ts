/**
 * HTTP helpers for probing and downloading Salesforce documentation.
 *
 * Everything here is conditional-request aware: we ask the CDN whether a PDF
 * changed before spending bandwidth on it. resources.docs.salesforce.com serves
 * ETag, Last-Modified and Content-Length on both HEAD and GET, which is what
 * makes incremental sync possible at all.
 *
 * Transport is `curl`, not Node's fetch. Node's bundled CA store rejects the
 * CDN's certificate chain (UNABLE_TO_VERIFY_LEAF_SIGNATURE - verified
 * 2026-08-31 and again 2026-09-13), while curl uses the macOS system trust
 * store, which accepts it. Keeping the transport in one place means nothing
 * above this file needs to know.
 */

import { execFile } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
    url: string;
    ok: boolean;
    status: number;
    etag: string | null;
    lastModified: string | null;
    contentLength: number | null;
    contentType: string | null;
    /** Set when the request failed outright (DNS, TLS, proxy denial, timeout). */
    error: string | null;
}

export interface FetchOptions {
    timeoutMs?: number;
    retries?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;

const USER_AGENT =
    "salesforce-docs-mcp/1.0 (documentation sync; +https://github.com/jhoosemans/salesforce-docs-mcp)";

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Retry only on transport errors and 5xx/429 - never on a 403/404. */
function isRetryable(status: number | null, error: string | null): boolean {
    if (error) return !/egress|blocked by|policy|SSL|certificate/i.test(error);
    if (status === null) return true;
    return status === 429 || (status >= 500 && status < 600);
}

interface RawResponse {
    status: number;
    headers: Map<string, string>;
    /** Body bytes when requested, otherwise null. */
    body: Buffer | null;
}

interface RawRequest {
    method: "HEAD" | "GET";
    headers?: Record<string, string>;
    wantBody: boolean;
}

/** Parse the last response block of a `curl -D` header dump (after redirects). */
function parseHeaderDump(dump: string): { status: number; headers: Map<string, string> } {
    const blocks = dump
        .split(/\r?\n\r?\n/)
        .map(b => b.trim())
        .filter(Boolean);
    const last = blocks[blocks.length - 1] ?? "";
    const lines = last.split(/\r?\n/);
    const status = Number(lines[0]?.match(/^HTTP\/\S+\s+(\d{3})/)?.[1] ?? 0);
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
        const idx = line.indexOf(":");
        if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
    }
    return { status, headers };
}

async function curlOnce(url: string, req: RawRequest, timeoutMs: number): Promise<RawResponse> {
    const dir = mkdtempSync(join(tmpdir(), "sfdocs-"));
    const headerFile = join(dir, "headers");
    const bodyFile = join(dir, "body");
    const args = [
        "--silent",
        "--show-error",
        "--location",
        "--max-time", String(Math.ceil(timeoutMs / 1000)),
        "--user-agent", USER_AGENT,
        "--dump-header", headerFile,
        "--output", req.wantBody ? bodyFile : "/dev/null"
    ];
    if (req.method === "HEAD") args.push("--head");
    for (const [name, value] of Object.entries(req.headers ?? {})) args.push("--header", `${name}: ${value}`);
    args.push(url);

    try {
        await execFileAsync("curl", args, { maxBuffer: 1024 * 1024 });
        const { status, headers } = parseHeaderDump(existsSync(headerFile) ? readFileSync(headerFile, "utf8") : "");
        const body = req.wantBody && existsSync(bodyFile) ? readFileSync(bodyFile) : null;
        return { status, headers, body };
    } catch (err) {
        // curl exits non-zero on transport failures; its stderr is the useful part.
        const e = err as { stderr?: string; message?: string };
        const detail = (e.stderr ?? e.message ?? String(err)).trim().split("\n").pop() ?? "curl failed";
        throw new Error(detail.replace(/^curl:\s*/, ""));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

async function request(
    url: string,
    req: RawRequest,
    options: FetchOptions
): Promise<{ response: RawResponse | null; error: string | null }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options.retries ?? DEFAULT_RETRIES;

    let lastError: string | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            // Exponential backoff: 2s, 4s, 8s.
            await sleep(2000 * 2 ** (attempt - 1));
        }

        try {
            const response = await curlOnce(url, req, timeoutMs);
            const ok = response.status >= 200 && response.status < 300;
            if (!ok && isRetryable(response.status, null) && attempt < retries) {
                lastError = `HTTP ${response.status}`;
                continue;
            }
            return { response, error: null };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (!isRetryable(null, lastError) || attempt === retries) {
                return { response: null, error: lastError };
            }
        }
    }

    return { response: null, error: lastError };
}

/**
 * Ask the CDN about a PDF without downloading it.
 *
 * Some Salesforce doc paths reject HEAD, so we fall back to a one-byte ranged
 * GET, which returns the same validators.
 */
export async function probe(url: string, options: FetchOptions = {}): Promise<ProbeResult> {
    const base: ProbeResult = {
        url,
        ok: false,
        status: 0,
        etag: null,
        lastModified: null,
        contentLength: null,
        contentType: null,
        error: null
    };

    let { response, error } = await request(url, { method: "HEAD", wantBody: false }, options);

    if (response && (response.status === 403 || response.status === 405)) {
        ({ response, error } = await request(
            url,
            { method: "GET", headers: { Range: "bytes=0-0" }, wantBody: false },
            options
        ));
    }

    if (!response) {
        return { ...base, error: error ?? "request failed" };
    }

    // A ranged GET answers 206 and reports the slice length, not the file size.
    const isPartial = response.status === 206;
    const contentRange = response.headers.get("content-range");
    const totalFromRange = contentRange?.match(/\/(\d+)$/)?.[1];
    const rawLength = response.headers.get("content-length");

    return {
        url,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        etag: normalizeEtag(response.headers.get("etag") ?? null),
        lastModified: response.headers.get("last-modified") ?? null,
        contentLength: isPartial
            ? totalFromRange
                ? Number(totalFromRange)
                : null
            : rawLength
              ? Number(rawLength)
              : null,
        contentType: response.headers.get("content-type") ?? null,
        error: null
    };
}

/** Strip weak-validator prefixes and quotes so stored ETags compare cleanly. */
export function normalizeEtag(etag: string | null): string | null {
    if (!etag) return null;
    return etag.replace(/^W\//, "").replace(/^"|"$/g, "") || null;
}

export interface DownloadResult {
    ok: boolean;
    status: number;
    bytes: Buffer | null;
    etag: string | null;
    lastModified: string | null;
    sha256: string | null;
    error: string | null;
}

/**
 * Download a PDF into memory and hash it.
 *
 * The caller validates and writes; keeping the write out of here means a failed
 * download can never truncate the copy already on disk.
 */
export async function download(url: string, options: FetchOptions = {}): Promise<DownloadResult> {
    const { response, error } = await request(url, { method: "GET", wantBody: true }, options);

    if (!response) {
        return { ok: false, status: 0, bytes: null, etag: null, lastModified: null, sha256: null, error };
    }
    const ok = response.status >= 200 && response.status < 300;
    if (!ok || !response.body) {
        return {
            ok: false,
            status: response.status,
            bytes: null,
            etag: null,
            lastModified: null,
            sha256: null,
            error: `HTTP ${response.status}`
        };
    }

    const bytes = response.body;

    return {
        ok: true,
        status: response.status,
        bytes,
        etag: normalizeEtag(response.headers.get("etag") ?? null),
        lastModified: response.headers.get("last-modified") ?? null,
        sha256: sha256(bytes),
        error: null
    };
}

export function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** A real PDF starts with %PDF- and is bigger than any error page we've seen. */
export function looksLikePdf(bytes: Buffer): boolean {
    return bytes.length > 1024 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });

    await Promise.all(runners);
    return results;
}
