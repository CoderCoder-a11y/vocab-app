// Finds pictures for a vocabulary word through the Tavily search API.
//
// Env:
//   TAVILY_API_KEY   required
//   TAVILY_API_BASE  optional, only for tests / proxies

const MIN_IMAGES = 3;
const MAX_IMAGES = 6;

class TavilyError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "TavilyError";
        this.code = code;
    }
}

const apiBase = () => process.env.TAVILY_API_BASE || "https://api.tavily.com";

// Tavily returns images as plain URLs or as { url, description } objects.
// Keep only clean https image links, without duplicates.
function extractUrls(images) {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(images) ? images : []) {
        const raw = typeof item === "string" ? item : item?.url;
        if (typeof raw !== "string" || raw.length > 1000) continue;
        let u;
        try { u = new URL(raw.trim()); } catch (_) { continue; }
        if (u.protocol !== "https:") continue;
        if (/\.svg$/i.test(u.pathname)) continue;
        if (seen.has(u.href)) continue;
        seen.add(u.href);
        out.push(u.href);
    }
    return out;
}

async function searchImages(query) {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new TavilyError("TAVILY_API_KEY is not set", "NO_KEY");

    let res;
    try {
        res = await fetch(`${apiBase()}/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ query, search_depth: "basic", include_images: true, max_results: 5 }),
            signal: AbortSignal.timeout(20000),
        });
    } catch (e) {
        throw new TavilyError(`Tavily request failed: ${e.message}`, "NETWORK");
    }

    if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new TavilyError(`Tavily HTTP ${res.status}: ${detail}`, `HTTP_${res.status}`);
    }

    const data = await res.json().catch(() => ({}));
    return extractUrls(data.images);
}

// Returns up to MAX_IMAGES urls (at least MIN_IMAGES when Tavily has them).
// Tries a few different queries until it has enough pictures.
async function findWordImages(word, meaning = "") {
    const hint = String(meaning).split(/\s+/).slice(0, 6).join(" ");
    const queries = [`${word} ${hint}`.trim(), `${word} photo`, `${word} picture illustration`];

    let urls = [];
    let lastError;
    for (const q of queries) {
        try {
            const found = await searchImages(q);
            urls = [...new Set([...urls, ...found])];
        } catch (e) {
            if (e.code === "NO_KEY") throw e;
            lastError = e;
            console.error("[tavily]", e.message);
        }
        if (urls.length >= MIN_IMAGES) break;
    }

    if (!urls.length && lastError) throw lastError;
    return urls.slice(0, MAX_IMAGES);
}

module.exports = { MIN_IMAGES, MAX_IMAGES, TavilyError, extractUrls, findWordImages };