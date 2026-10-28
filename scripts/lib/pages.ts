/**
 * Turn fetched documentation pages (atlas HTML or Markdown) into titled sections of plain text.
 * No HTML parser dependency: atlas pages are regular, generated markup.
 */

export interface PageSection {
    /** "Database Class › getDeleted(sObjectType, startDate, endDate)" */
    title: string;
    /** The section's own heading, null for the page's lead section */
    heading: string | null;
    text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", trade: "™", reg: "®", copy: "©" };

export function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
        if (code[0] === "#") {
            const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : match;
        }
        return ENTITIES[code.toLowerCase()] ?? match;
    });
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "");

/**
 * Atlas HTML to Markdown-like text: h1-h3 become "#" headings (section boundaries),
 * h4 stays a bold line inside its section, <pre> becomes a fenced code block,
 * table rows become "a | b" lines.
 */
export function htmlToText(html: string): string {
    const blocks: string[] = [];
    let text = html
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        // Code first, so its whitespace survives the collapsing below
        .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => {
            blocks.push("```\n" + decodeEntities(stripTags(code)).replace(/\s+$/, "") + "\n```");
            return `\n\u0000${blocks.length - 1}\u0000\n`;
        })
        .replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) =>
            `\n${"#".repeat(Number(level))} ${stripTags(inner).replace(/\s+/g, " ").trim()}\n`)
        .replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, inner: string) => `\n**${stripTags(inner).replace(/\s+/g, " ").trim()}**\n`)
        .replace(/<\/(td|th)>\s*/gi, " | ")
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?(p|div|tr|table|thead|tbody|ul|ol|dl|dt|dd|section|li)\b[^>]*>/gi, "\n");

    text = decodeEntities(stripTags(text))
        .split("\n")
        .map(line => line.replace(/[ \t]+/g, " ").replace(/\s*\|\s*$/, "").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");

    return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)]).trim();
}

/** Markdown pages: drop the "See Also" link list and reduce links to their text. */
export function cleanMarkdown(markdown: string): string {
    return markdown
        .replace(/\n\*\*See Also\*\*[\s\S]*$/, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Split page text on its #-headings outside code fences. The first heading usually
 * repeats the page title; later ones become "Page title › Heading".
 */
export function splitSections(pageTitle: string, text: string): PageSection[] {
    const sections: PageSection[] = [];
    let heading: string | null = null;
    let lines: string[] = [];
    let inFence = false;

    const flush = () => {
        const body = lines.join("\n").trim();
        if (body.length > 0) {
            const title = !heading || heading === pageTitle ? pageTitle : `${pageTitle} › ${heading}`;
            sections.push({ title, heading: heading === pageTitle ? null : heading, text: body });
        }
        lines = [];
    };

    for (const line of text.split("\n")) {
        if (line.startsWith("```")) inFence = !inFence;
        const match = !inFence && line.match(/^#{1,3}\s+(.+)$/);
        if (match) {
            flush();
            heading = match[1].trim();
            continue;
        }
        lines.push(line);
    }
    flush();
    return sections;
}
