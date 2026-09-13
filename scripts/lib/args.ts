/** Minimal argv parsing - no dependency needed for a handful of flags. */

export interface ParsedArgs {
    flags: Set<string>;
    values: Map<string, string>;
    positional: string[];
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
    const flags = new Set<string>();
    const values = new Map<string, string>();
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            positional.push(arg);
            continue;
        }

        const [name, inlineValue] = arg.slice(2).split(/=(.*)/s);
        if (inlineValue !== undefined) {
            values.set(name, inlineValue);
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
            values.set(name, argv[++i]);
        } else {
            flags.add(name);
        }
    }

    return { flags, values, positional };
}

export function numberOption(args: ParsedArgs, name: string, fallback: number): number {
    const raw = args.values.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--${name} expects a positive number, got "${raw}"`);
    }
    return parsed;
}

/** Match an id against a comma-separated list of substrings or * globs. */
export function makeFilter(pattern: string | undefined): (id: string) => boolean {
    if (!pattern) return () => true;

    const matchers = pattern.split(",").map(part => {
        const trimmed = part.trim();
        if (trimmed.includes("*")) {
            const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
            return (id: string) => new RegExp(`^${escaped}$`, "i").test(id);
        }
        return (id: string) => id.toLowerCase().includes(trimmed.toLowerCase());
    });

    return (id: string) => matchers.some(match => match(id));
}
