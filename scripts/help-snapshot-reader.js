/**
 * Read a branch of Salesforce Help in a browser, for scripts/import-help-snapshot.ts.
 * Not run by node: paste or execute it in a help.salesforce.com article page (Claude Code's
 * built-in browser, javascript tool), with the branch's table of contents open.
 *
 *   1. helpListBranch("Single Sign-On")      expands that table-of-contents entry, returns its articles
 *   2. helpAddArticles([[title, id], ...])    optional: articles from elsewhere in Help
 *   3. helpStart()                            reads each article in a hidden frame, one at a time
 *   4. helpProgress()                         { ok, errors, left }; poll until left is 0
 *   5. helpExport()                           JSON of every article in table-of-contents order
 *
 * Pace: one article at a time with a 2.5 s pause, about 7 s each.
 * The article body is Help's .slds-text-longform element (2026-10-28).
 */

const helpDeep = root => {
    const all = [];
    const walk = node => {
        if (!node) return;
        if (node.shadowRoot) walk(node.shadowRoot);
        for (const child of node.children || []) { all.push(child); walk(child); }
    };
    walk(root);
    return all;
};
// A hidden browser pane throttles page timers to about one a minute; a worker's timers are not
// throttled that way (measured 2026-10-28: 45 s per article -> 7 s)
const helpSleep = (() => {
    const worker = new Worker(URL.createObjectURL(new Blob(["onmessage = e => setTimeout(() => postMessage(e.data), e.data.ms)"], { type: "text/javascript" })));
    const pending = new Map();
    let next = 0;
    worker.onmessage = e => { pending.get(e.data.n)(); pending.delete(e.data.n); };
    return ms => new Promise(resolve => { const n = ++next; pending.set(n, resolve); worker.postMessage({ n, ms }); });
})();

window.helpListBranch = async title => {
    const root = () => helpDeep(document.body).find(e => e.tagName === "LI" && e.getAttribute("title") === title && e.getAttribute("aria-level"));
    let branch = root();
    if (!branch) throw new Error(`table-of-contents entry "${title}" not found`);
    for (let round = 0; round < 12; round++) {
        const closed = [...branch.querySelectorAll('button[aria-expanded="false"]')].filter(b => !b.disabled);
        if (!closed.length) break;
        for (const button of closed) { button.click(); await helpSleep(700); }
        await helpSleep(1500);
        branch = root();
    }
    const id = li => (li.querySelector(":scope > div a")?.getAttribute("href") || "").match(/id=([^&]+)/)?.[1];
    window.__helpList = [
        { title, id: id(branch), level: Number(branch.getAttribute("aria-level")), group: "branch" },
        ...[...branch.querySelectorAll("li[aria-level]")].map(li => ({ title: li.getAttribute("title"), id: id(li), level: Number(li.getAttribute("aria-level")), group: "branch" }))
    ].filter(item => item.id);
    window.__help = window.__help || {};
    return window.__helpList.map(item => [item.level, item.title, item.id]);
};

window.helpAddArticles = pairs => {
    for (const [title, id] of pairs) window.__helpList.push({ title, id, level: 0, group: "related" });
    return window.__helpList.length;
};

const helpRead = async id => {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:-5000px;width:1200px;height:900px";
    frame.src = `/s/articleView?id=${id}&language=en_US&type=5`;
    document.body.appendChild(frame);
    const started = Date.now();
    let last = -1, stable = 0, body = null;
    try {
        while (Date.now() - started < 30000) {
            await helpSleep(800);
            body = helpDeep(frame.contentDocument.body).find(e => e.tagName === "H1" && e.parentElement?.classList.contains("slds-text-longform"))?.parentElement;
            const length = body ? body.innerHTML.length : 0;
            if (length > 0 && length === last) { if (++stable >= 2) break; } else stable = 0;
            last = length;
        }
        return body ? { title: body.querySelector("h1").innerText.trim(), html: body.innerHTML } : { error: "no article body" };
    } catch (error) {
        return { error: String(error) };
    } finally {
        frame.remove();
    }
};

window.helpStart = () => {
    if (window.__helpRunning === true) return "already running";
    window.__helpRunning = true;
    (async () => {
        for (const item of window.__helpList) {
            if (window.__help[item.id] && !window.__help[item.id].error) continue;
            const result = await helpRead(item.id);
            window.__help[item.id] = { ...result, id: item.id, listTitle: item.title, level: item.level, group: item.group, url: `https://help.salesforce.com/s/articleView?id=${item.id}&type=5`, savedAt: new Date().toISOString() };
            await helpSleep(2500);
        }
        window.__helpRunning = "finished";
    })();
    return "started";
};

window.helpProgress = () => {
    const read = Object.values(window.__help || {});
    return {
        running: window.__helpRunning,
        ok: read.filter(a => !a.error).length,
        errors: read.filter(a => a.error).map(a => `${a.id}: ${a.error}`),
        left: window.__helpList.filter(item => !window.__help[item.id] || window.__help[item.id].error).length
    };
};

window.helpExport = () => JSON.stringify(window.__helpList.map(item => window.__help[item.id]).filter(a => a && !a.error));
