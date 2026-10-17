const crypto = require("node:crypto");

// Lower-case, trim and collapse spaces: the canonical form of a word.
const normalizeWord = (v) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// Same, but also ignores quotes / end punctuation (used to grade typed answers).
const normalizeAnswer = (v) =>
    normalizeWord(v).replace(/^["“”']+/, "").replace(/[.!?,;:"“”']+$/, "");

const cleanStr = (v, max = 300) =>
    typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";

function cleanList(v, { max = 8, maxLen = 60 } = {}) {
    if (!Array.isArray(v)) return [];
    const seen = new Set();
    const out = [];
    for (const item of v) {
        const s = cleanStr(item, maxLen);
        const k = normalizeWord(s);
        if (s && !seen.has(k)) {
            seen.add(k);
            out.push(s);
            if (out.length >= max) break;
        }
    }
    return out;
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = { normalizeWord, normalizeAnswer, cleanStr, cleanList, shuffle, escapeRegExp };
