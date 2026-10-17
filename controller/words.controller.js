const Vocab = require("../models/vocabulary");
const SynonymsModel = require("../models/synonyms");
const Users = require("../models/users");

const { isValidId, isNonEmptyValue, sendError, handleError } = require("../utils/helper");
const { normalizeWord, cleanStr, cleanList } = require("../utils/text");
const { generateWordInfo } = require("../utils/gemini");
const { loadVocab } = require("../utils/vocab_data");
const { MIN_IMAGES, extractUrls, findWordImages } = require("../utils/tavily");

// English word or short phrase only (letters, spaces, hyphen, apostrophe).
const WORD_REGEX = /^[A-Za-z][A-Za-z\s'’-]{0,59}$/;

// The logged-in user always comes from the auth middleware (req.user), never from the
// request body - otherwise any user could read or change another user's data.

// -------------------- Get Vocabulary --------------------

const get_vocab = async (req, res) => {
    try {
        const weak = new Set((req.user.week_words || []).map(normalizeWord));
        const words = await loadVocab(req.user._id);

        return res.status(200).json({
            success: true,
            message: "Vocabulary retrieved successfully",
            data: words.map((w) => ({ ...w, is_weak: weak.has(normalizeWord(w.word)) })),
            weak_words: [...weak],
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- Add Vocabulary --------------------
// The user only sends `word`. Gemini fills in meaning (EN + AR), examples, category,
// synonyms and antonyms. meaning / example / category / image may still be sent manually.

const add_vocab = async (req, res) => {
    try {
        const userId = String(req.user._id);
        const rawWord = cleanStr(req.body?.word, 80);

        if (!rawWord) return sendError(res, 400, "word is required", "WORD_REQUIRED");
        if (!WORD_REGEX.test(rawWord)) {
            return sendError(res, 400, "word must be an English word or short phrase", "WORD_INVALID");
        }

        const existing = await Vocab.find({ user_id: userId }).select("word").lean();
        const taken = new Set(existing.map((v) => normalizeWord(v.word)));
        if (taken.has(normalizeWord(rawWord))) {
            return sendError(res, 409, "Word already added", "DUPLICATE");
        }

        const manual = {
            meaning: cleanStr(req.body?.meaning),
            example: cleanStr(req.body?.example),
            category: cleanStr(req.body?.category, 40),
        };
        const manualComplete = manual.meaning && manual.example && manual.category;

        let info = null;
        if (!manualComplete) {
            try {
                info = await generateWordInfo(rawWord);
            } catch (e) {
                console.error("[add_vocab] Gemini failed:", e.message);
                return sendError(res, 503, "AI service is unavailable, try again later", "AI_UNAVAILABLE");
            }
            if (!info.valid) {
                return sendError(res, 422, "This does not look like an English word", "NOT_A_WORD");
            }
            // The AI may have fixed a spelling mistake: check again with the final spelling.
            if (taken.has(normalizeWord(info.word))) {
                return sendError(res, 409, `Word already added as "${info.word}"`, "DUPLICATE");
            }
        }

        const word = info ? info.word : rawWord;
        const meaning = manual.meaning || info.meaning;

        // Pictures: Tavily searches for them. A failure never blocks adding the word -
        // the user can retry with POST /api/vocab_images.
        let images = [];
        try {
            images = await findWordImages(word, meaning);
        } catch (e) {
            console.error("[add_vocab] Tavily failed:", e.message);
        }
        // An image link sent by the user (if any) goes first.
        images = [...new Set([...extractUrls([cleanStr(req.body?.image, 1000)]), ...images])];

        const created = await Vocab.create({
            user_id: userId,
            word,
            image: images[0],
            images,
            meaning,
            meaning_ar: info?.meaning_ar || "",
            example: manual.example || info.example,
            examples: info?.examples || [manual.example],
            category: manual.category || info.category,
            part_of_speech: info?.part_of_speech || "",
            source: info ? "ai" : "manual",
        });

        const synonyms = info?.synonyms || [];
        const antonyms = info?.antonyms || [];
        if (synonyms.length || antonyms.length) {
            await SynonymsModel.findOneAndUpdate(
                { user_id: userId, word_key: normalizeWord(word) },
                { $set: { word, synonyms, antonyms } },
                { upsert: true },
            );
        }

        return res.status(201).json({
            success: true,
            message: "Vocabulary added successfully",
            images_ok: images.length >= MIN_IMAGES,
            data: { ...created.toObject(), synonyms, antonyms, is_weak: false },
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- Refresh pictures --------------------
// body: { vocab_id } - searches Tavily again and replaces the word's pictures.

const refresh_images = async (req, res) => {
    try {
        const vocab_id = req.body?.vocab_id;
        if (!vocab_id) return sendError(res, 400, "vocab_id is required", "FIELD_REQUIRED");
        if (!isValidId(vocab_id)) return sendError(res, 400, "Invalid ID", "INVALID_ID");

        const vocab = await Vocab.findOne({ _id: vocab_id, user_id: String(req.user._id) });
        if (!vocab) return sendError(res, 404, "Vocabulary not found for this user", "NOT_FOUND");

        let images;
        try {
            images = await findWordImages(vocab.word, vocab.meaning);
        } catch (e) {
            console.error("[refresh_images] Tavily failed:", e.message);
            return sendError(res, 503, "Image search is unavailable, try again later", "IMAGES_UNAVAILABLE");
        }
        if (!images.length) return sendError(res, 404, "No images found for this word", "NO_IMAGES");

        vocab.images = images;
        vocab.image = images[0];
        await vocab.save();

        return res.status(200).json({
            success: true,
            message: "Images updated successfully",
            images_ok: images.length >= MIN_IMAGES,
            data: { _id: vocab._id, images },
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- Get Synonyms --------------------

const get_synonyms = async (req, res) => {
    try {
        const all = await SynonymsModel.find({ user_id: String(req.user._id) }).lean();

        return res.status(200).json({
            success: true,
            message: "Synonyms retrieved successfully",
            data: all,
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- Add Synonyms (manual) --------------------

const add_synonmyms = async (req, res) => {
    try {
        const { word, synonyms: synonymValues, antonyms: antonymValues } = req.body || {};

        for (const [field, value] of Object.entries({ word, synonyms: synonymValues, antonyms: antonymValues })) {
            if (!isNonEmptyValue(value)) return sendError(res, 400, `${field} is required`, "FIELD_REQUIRED");
        }

        const cleanWord = cleanStr(word, 80);
        const saved = await SynonymsModel.findOneAndUpdate(
            { user_id: String(req.user._id), word_key: normalizeWord(cleanWord) },
            { $set: { word: cleanWord, synonyms: cleanList(synonymValues), antonyms: cleanList(antonymValues) } },
            { upsert: true, new: true },
        );

        return res.status(201).json({
            success: true,
            message: "Synonyms added successfully",
            data: saved,
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- Delete Vocabulary --------------------

const DEL_vocab = async (req, res) => {
    try {
        const vocab_id = req.body?.vocab_id || req.query?.vocab_id;

        if (!vocab_id) return sendError(res, 400, "vocab_id is required", "FIELD_REQUIRED");
        if (!isValidId(vocab_id)) return sendError(res, 400, "Invalid ID", "INVALID_ID");

        const userId = String(req.user._id);
        const deleted = await Vocab.findOneAndDelete({ _id: vocab_id, user_id: userId });

        if (!deleted) return sendError(res, 404, "Vocabulary not found for this user", "NOT_FOUND");

        // Clean up everything that belonged to this word.
        const key = normalizeWord(deleted.word);
        await Promise.all([
            SynonymsModel.deleteMany({ user_id: userId, word_key: key }),
            Users.updateOne({ _id: req.user._id }, { $pull: { week_words: key } }),
        ]);

        return res.status(200).json({
            success: true,
            message: "Vocabulary deleted successfully",
            data: deleted,
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- Delete Synonyms --------------------

const DEL_synonym = async (req, res) => {
    try {
        const synonym_id = req.body?.synonym_id || req.query?.synonym_id;

        if (!synonym_id) return sendError(res, 400, "synonym_id is required", "FIELD_REQUIRED");
        if (!isValidId(synonym_id)) return sendError(res, 400, "Invalid ID", "INVALID_ID");

        const deleted = await SynonymsModel.findOneAndDelete({
            _id: synonym_id,
            user_id: String(req.user._id),
        });

        if (!deleted) return sendError(res, 404, "Synonyms record not found for this user", "NOT_FOUND");

        return res.status(200).json({
            success: true,
            message: "Synonyms deleted successfully",
            data: deleted,
        });
    } catch (error) {
        return handleError(res, error);
    }
};

module.exports = { get_vocab, add_vocab, refresh_images, get_synonyms, add_synonmyms, DEL_vocab, DEL_synonym };