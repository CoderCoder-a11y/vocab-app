const Tests = require("../models/tests");
const Users = require("../models/users");

const { isValidId, sendError, handleError } = require("../utils/helper");
const { normalizeWord, cleanStr, shuffle } = require("../utils/text");
const { loadVocab } = require("../utils/vocab_data");
const { buildQuestions, isCorrectAnswer, publicQuestion, buildResult } = require("../utils/test_builder");

const MODES = ["weak", "all", "words"];
const DEFAULT_COUNT = 10;
const MAX_COUNT = 30;

const publicTest = (t) => ({
    id: String(t._id),
    mode: t.mode,
    status: t.status,
    total: t.total,
    created_at: t.createdAt,
    questions: t.questions.map(publicQuestion),
});

// -------------------- POST /api/test  (create a test) --------------------
// body: { mode: "weak" | "all" | "words", count?: 1..30, words?: ["word", ...] }
//   weak  -> the words in the user's week_words array (their weak points)
//   all   -> a random sample of all the user's saved words
//   words -> the specific words listed in `words`

const create_test = async (req, res) => {
    try {
        const userId = String(req.user._id);
        const mode = req.body?.mode ?? "all";
        if (!MODES.includes(mode)) return sendError(res, 400, `mode must be one of: ${MODES.join(", ")}`, "INVALID_MODE");

        const parsed = Number.parseInt(req.body?.count ?? DEFAULT_COUNT, 10);
        const count = Math.min(Math.max(Number.isNaN(parsed) ? DEFAULT_COUNT : parsed, 1), MAX_COUNT);

        const allVocab = await loadVocab(userId);
        if (!allVocab.length) return sendError(res, 400, "Add some words first", "NO_WORDS");

        let pool;
        if (mode === "weak") {
            const weak = new Set((req.user.week_words || []).map(normalizeWord));
            pool = allVocab.filter((v) => weak.has(normalizeWord(v.word)));
            if (!pool.length) return sendError(res, 400, "You have no weak words yet. Take a normal test first", "NO_WEAK_WORDS");
        } else if (mode === "words") {
            const wanted = Array.isArray(req.body?.words) ? req.body.words.slice(0, 100) : [];
            const keys = new Set(wanted.map(normalizeWord).filter(Boolean));
            pool = allVocab.filter((v) => keys.has(normalizeWord(v.word)));
            if (!pool.length) return sendError(res, 400, "None of the given words are in your vocabulary", "NO_WORDS");
        } else {
            pool = allVocab;
        }

        const picked = shuffle(pool).slice(0, count);
        const { questions, ai_used } = await buildQuestions(picked, allVocab);
        if (!questions.length) return sendError(res, 422, "Could not build questions for these words", "NO_QUESTIONS");

        const test = await Tests.create({
            user_id: userId,
            mode,
            source_words: picked.map((v) => v.word),
            questions,
            total: questions.length,
            ai_generated: ai_used,
        });

        return res.status(201).json({
            success: true,
            message: "Test created successfully",
            data: { ...publicTest(test), ai_generated: ai_used },
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// Loads a test owned by the current user, or sends the error and returns null.
async function ownedTest(req, res) {
    const id = req.params.id ?? req.body?.test_id;
    if (!isValidId(id)) {
        sendError(res, 400, "Invalid test id", "INVALID_ID");
        return null;
    }
    const test = await Tests.findOne({ _id: id, user_id: String(req.user._id) });
    if (!test) sendError(res, 404, "Test not found", "NOT_FOUND");
    return test;
}

// -------------------- GET /api/test/:id --------------------
// Pending test  -> questions only (no correct answers).
// Submitted test -> questions + the user's answers + the correct answers.

const get_test = async (req, res) => {
    try {
        const test = await ownedTest(req, res);
        if (!test) return;

        const data = publicTest(test);
        if (test.status === "submitted") data.result = buildResult(test);

        return res.status(200).json({ success: true, message: "Test retrieved successfully", data });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- POST /api/test/answers --------------------
// body: { test_id, answers: [{ question_id, selected }] }
// Grades the test once, adds every wrongly answered word to the user's week_words array,
// and returns the user's answers next to the correct answers.

const submit_answers = async (req, res) => {
    try {
        const answers = req.body?.answers;
        if (!Array.isArray(answers) || answers.length > 200) {
            return sendError(res, 400, "answers must be an array", "FIELD_REQUIRED");
        }

        const test = await ownedTest(req, res);
        if (!test) return;
        if (test.status === "submitted") return sendError(res, 409, "Test already submitted", "ALREADY_SUBMITTED");

        const selectedById = new Map();
        for (const a of answers) {
            if (a && typeof a.question_id === "string") selectedById.set(a.question_id, cleanStr(a.selected, 300));
        }

        // A question that was left blank counts as wrong.
        const graded = test.questions.map((q) => {
            const selected = selectedById.has(String(q._id)) ? selectedById.get(String(q._id)) : null;
            return { question_id: String(q._id), selected: selected || null, is_correct: isCorrectAnswer(q, selected) };
        });
        const score = graded.filter((g) => g.is_correct).length;

        // Only the first submit wins, even if two requests arrive together.
        const updated = await Tests.findOneAndUpdate(
            { _id: test._id, user_id: test.user_id, status: "pending" },
            { $set: { answers: graded, score, status: "submitted", submitted_at: new Date() } },
            { new: true },
        );
        if (!updated) return sendError(res, 409, "Test already submitted", "ALREADY_SUBMITTED");

        // Wrong answers -> weak words.
        const wrongWords = [...new Set(
            test.questions.filter((q, i) => !graded[i].is_correct).map((q) => normalizeWord(q.word)),
        )];
        const alreadyWeak = new Set((req.user.week_words || []).map(normalizeWord));
        const newWeak = wrongWords.filter((w) => !alreadyWeak.has(w));

        if (wrongWords.length) {
            await Users.updateOne({ _id: req.user._id }, { $addToSet: { week_words: { $each: wrongWords } } });
        }

        return res.status(200).json({
            success: true,
            message: "Answers submitted successfully",
            data: buildResult(updated, { new_weak_words: newWeak }),
        });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- GET /api/test/:id/answers --------------------
// Re-read the user's answers and the correct answers of a submitted test.

const get_test_answers = async (req, res) => {
    try {
        const test = await ownedTest(req, res);
        if (!test) return;
        if (test.status !== "submitted") return sendError(res, 409, "Submit the test first", "NOT_SUBMITTED");

        return res.status(200).json({ success: true, message: "Answers retrieved successfully", data: buildResult(test) });
    } catch (error) {
        return handleError(res, error);
    }
};

// -------------------- GET /api/tests --------------------

const list_tests = async (req, res) => {
    try {
        const tests = await Tests.find({ user_id: String(req.user._id) })
            .sort({ createdAt: -1 })
            .limit(50)
            .select("mode status total score createdAt submitted_at")
            .lean();

        return res.status(200).json({
            success: true,
            message: "Tests retrieved successfully",
            data: tests.map((t) => ({
                id: String(t._id),
                mode: t.mode,
                status: t.status,
                total: t.total,
                score: t.status === "submitted" ? t.score : null,
                created_at: t.createdAt,
                submitted_at: t.submitted_at || null,
            })),
        });
    } catch (error) {
        return handleError(res, error);
    }
};

module.exports = { create_test, get_test, submit_answers, get_test_answers, list_tests };
