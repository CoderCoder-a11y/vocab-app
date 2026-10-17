// Loads a user's vocabulary together with its synonyms / antonyms.
const Vocab = require("../models/vocabulary");
const SynonymsModel = require("../models/synonyms");
const { normalizeWord } = require("./text");

async function loadVocab(userId) {
    const uid = String(userId);
    const [words, syns] = await Promise.all([
        Vocab.find({ user_id: uid }).sort({ createdAt: -1 }).lean(),
        SynonymsModel.find({ user_id: uid }).lean(),
    ]);

    const byWord = new Map();
    for (const s of syns) {
        const key = normalizeWord(s.word);
        const cur = byWord.get(key) || { synonyms: [], antonyms: [] };
        cur.synonyms.push(...(s.synonyms || []));
        cur.antonyms.push(...(s.antonyms || []));
        byWord.set(key, cur);
    }

    return words.map((w) => {
        const extra = byWord.get(normalizeWord(w.word)) || { synonyms: [], antonyms: [] };
        return {
            ...w,
            synonyms: [...new Set(extra.synonyms)],
            antonyms: [...new Set(extra.antonyms)],
        };
    });
}

module.exports = { loadVocab };
