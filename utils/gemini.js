// Thin Gemini client (plain REST, no SDK) + the "word -> full vocabulary card" generator.
//
// Env:
//   GEMINI_API_KEY         required
//   GEMINI_MODEL           default gemini-3.5-flash
//   GEMINI_FALLBACK_MODEL  default gemini-2.5-flash (tried if the main model fails)
//   GEMINI_API_BASE        optional, only for tests / proxies

const { cleanStr, cleanList } = require("./text");

class GeminiError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "GeminiError";
        this.code = code;
    }
}

const apiBase = () =>
    process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta/models";

const modelList = () =>
    [process.env.GEMINI_MODEL || "gemini-3.5-flash", process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite"]
        .filter((m, i, a) => m && a.indexOf(m) === i);

function parseJson(text) {
    const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
        return JSON.parse(cleaned);
    } catch (_) {
        throw new GeminiError("Gemini returned invalid JSON", "BAD_JSON");
    }
}

async function callModel(model, key, body, timeoutMs) {
    let res;
    try {
        res = await fetch(`${apiBase()}/${encodeURIComponent(model)}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        throw new GeminiError(`Gemini ${model} request failed: ${e.message}`, "NETWORK");
    }

    if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new GeminiError(`Gemini ${model} HTTP ${res.status}: ${detail}`, `HTTP_${res.status}`);
    }

    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) throw new GeminiError(`Gemini ${model} returned an empty response`, "EMPTY");
    return text;
}

// Returns parsed JSON that follows `schema`. Tries each configured model in turn.
async function generateJson({ system, prompt, schema, temperature = 0.7, timeoutMs = 45000 }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new GeminiError("GEMINI_API_KEY is not set", "NO_KEY");

    const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature },
    };

    let lastError;
    for (const model of modelList()) {
        try {
            return parseJson(await callModel(model, key, body, timeoutMs));
        } catch (e) {
            lastError = e;
            console.error("[gemini]", e.message);
        }
    }
    throw lastError;
}

// ---------------------------------------------------------------- word card

const STR = { type: "STRING" };
const STR_LIST = { type: "ARRAY", items: { type: "STRING" } };

const WORD_SCHEMA = {
    type: "OBJECT",
    properties: {
        valid: { type: "BOOLEAN" },
        word: STR,
        part_of_speech: STR,
        category: STR,
        meaning_en: STR,
        meaning_ar: STR,
        examples: STR_LIST,
        synonyms: STR_LIST,
        antonyms: STR_LIST,
    },
    required: ["valid", "word", "part_of_speech", "category", "meaning_en", "meaning_ar", "examples", "synonyms", "antonyms"],
};

const WORD_SYSTEM = `You are an English vocabulary tutor for Arabic-speaking learners (levels A2-B2).
Given one English word or short phrase, produce a complete study card.
Rules:
- If the input is not a real English word/phrase, set valid=false and leave the other fields empty.
- If it is a misspelling of a real word, fix it in "word" and describe the corrected word.
- meaning_en: one simple English definition, at most 20 words.
- meaning_ar: a short, natural Arabic meaning.
- category: ONE topic label in English, e.g. Business, Travel, Emotions, Daily life, Education, Health, Technology, Science, Nature, General.
- examples: exactly 3 natural sentences that contain the word in its exact written form (same spelling).
- synonyms: 3 to 6 words of the same part of speech. antonyms: up to 5, or an empty array when none exist.
- Everything except meaning_ar must be in English.`;

async function generateWordInfo(word) {
    const raw = await generateJson({
        system: WORD_SYSTEM,
        prompt: `Input: ${JSON.stringify(word)}`,
        schema: WORD_SCHEMA,
        temperature: 0.4,
    });

    if (!raw || raw.valid !== true) return { valid: false };

    const examples = cleanList(raw.examples, { max: 3, maxLen: 250 });
    const info = {
        valid: true,
        word: cleanStr(raw.word, 60) || word,
        part_of_speech: cleanStr(raw.part_of_speech, 30),
        category: cleanStr(raw.category, 40) || "General",
        meaning: cleanStr(raw.meaning_en, 300),
        meaning_ar: cleanStr(raw.meaning_ar, 200),
        example: examples[0] || "",
        examples,
        synonyms: cleanList(raw.synonyms, { max: 6 }),
        antonyms: cleanList(raw.antonyms, { max: 5 }),
    };

    if (!info.meaning || !info.example) throw new GeminiError("Incomplete word card", "INCOMPLETE");
    return info;
}

module.exports = { GeminiError, generateJson, generateWordInfo };
