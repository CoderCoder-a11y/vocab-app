// Builds test questions for a set of vocabulary words.
//
//   1. Gemini writes the questions (grounded in the user's own saved data).
//   2. Every AI question is validated; anything malformed is rejected.
//   3. Slots the AI did not fill validly are built locally from the saved data,
//      so a test can still be created when Gemini is down or misbehaves.
//
// A "vocab" item here is a record from utils/vocab_data.js:
//   { _id, word, meaning, meaning_ar, example, part_of_speech, synonyms[], antonyms[] }

const { generateJson } = require("./gemini");
const { normalizeWord, normalizeAnswer, cleanStr, shuffle, escapeRegExp } = require("./text");

const KINDS = ["meaning", "sentence", "synonym", "antonym"];
const BLANK = "_____";

// ---------------------------------------------------------------- planning

const blankRegex = (word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
const hasUsableExample = (v) => typeof v.example === "string" && blankRegex(v.word).test(v.example);

function availableKinds(v) {
    const kinds = ["meaning"];
    if (hasUsableExample(v)) kinds.push("sentence");
    if (v.synonyms?.length) kinds.push("synonym");
    if (v.antonyms?.length) kinds.push("antonym");
    return kinds;
}

// One slot = one question. Few words => 2 questions each, so a short test is still useful.
function planSlots(vocabList, perWord) {
    const slots = [];
    vocabList.forEach((v, i) => {
        const kinds = availableKinds(v);
        for (let s = 0; s < perWord && s < kinds.length; s++) {
            slots.push({ vocab: v, kind: kinds[(i + s) % kinds.length] });
        }
    });
    return slots;
}

// ---------------------------------------------------------------- AI part

const QUESTIONS_SCHEMA = {
    type: "OBJECT",
    properties: {
        questions: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    word: { type: "STRING" },
                    kind: { type: "STRING" },
                    prompt: { type: "STRING" },
                    options: { type: "ARRAY", items: { type: "STRING" } },
                    correct_answer: { type: "STRING" },
                    explanation: { type: "STRING" },
                },
                required: ["word", "kind", "prompt", "options", "correct_answer", "explanation"],
            },
        },
    },
    required: ["questions"],
};

const QUESTIONS_SYSTEM = `You write multiple-choice vocabulary quizzes for Arabic-speaking English learners (A2-B2).
You get a plan: a list of {word, kind} items plus the learner's saved data for each word. Write exactly ONE question per plan item, in the same order.
Question kinds:
- meaning: prompt is: What does "<word>" mean?  Options are 4 short English definitions; one is correct.
- sentence: prompt is ONE natural English sentence where the target word is replaced by ${BLANK}. Options are 4 single words/phrases that could look plausible; only the target word fits. Never write the target word in the prompt.
- synonym: prompt is: Which word is closest in meaning to "<word>"?  Options are 4 words; exactly one is a true synonym.
- antonym: prompt is: Which word is the opposite of "<word>"?  Options are 4 words; exactly one is a true antonym.
Rules:
- Exactly 4 distinct options per question, and correct_answer must be copied exactly from the options.
- Wrong options must be believable but clearly wrong. Prefer other words from the learner's list as distractors when they fit.
- Do not always put the correct answer in the same position.
- explanation: one short sentence in simple Arabic explaining why the answer is right (keep English words in English).
- "word" must be copied exactly from the plan.`;

function describeVocab(v) {
    return {
        word: v.word,
        part_of_speech: v.part_of_speech || undefined,
        meaning: cleanStr(v.meaning, 200),
        meaning_ar: cleanStr(v.meaning_ar, 120) || undefined,
        example: cleanStr(v.example, 250),
        synonyms: (v.synonyms || []).slice(0, 6),
        antonyms: (v.antonyms || []).slice(0, 6),
    };
}

// Returns a finished question object, or null if the AI item is unusable.
function validateAiQuestion(raw, slot) {
    if (!raw || typeof raw !== "object") return null;

    const prompt = cleanStr(raw.prompt, 400);
    if (prompt.length < 8) return null;
    if (raw.kind !== slot.kind) return null;
    if (normalizeWord(raw.word) !== normalizeWord(slot.vocab.word)) return null;

    // Distinct, non-empty options.
    const seen = new Set();
    const options = [];
    for (const o of Array.isArray(raw.options) ? raw.options : []) {
        const s = cleanStr(o, 200);
        const k = normalizeAnswer(s);
        if (s && !seen.has(k)) {
            seen.add(k);
            options.push(s);
        }
    }
    if (options.length < 3) return null;

    const correctKey = normalizeAnswer(raw.correct_answer);
    const correct = options.find((o) => normalizeAnswer(o) === correctKey);
    if (!correct) return null;

    const wordKey = normalizeAnswer(slot.vocab.word);
    if (slot.kind === "sentence") {
        if (!prompt.includes("___")) return null;
        if (blankRegex(slot.vocab.word).test(prompt)) return null; // would leak the answer
        if (normalizeAnswer(correct) !== wordKey) return null;
    }
    if ((slot.kind === "synonym" || slot.kind === "antonym") && normalizeAnswer(correct) === wordKey) return null;

    // Keep the correct option and at most 3 others.
    const others = shuffle(options.filter((o) => o !== correct)).slice(0, 3);

    return {
        word: slot.vocab.word,
        vocab_id: String(slot.vocab._id),
        kind: slot.kind,
        prompt,
        options: shuffle([correct, ...others]),
        correct_answer: correct,
        explanation: cleanStr(raw.explanation, 300),
    };
}

async function generateWithAI(slots, allVocab) {
    const plan = slots.map((s) => ({ word: s.vocab.word, kind: s.kind }));
    const involved = [...new Map(slots.map((s) => [String(s.vocab._id), s.vocab])).values()];
    const otherWords = allVocab
        .filter((v) => !involved.includes(v))
        .slice(0, 20)
        .map((v) => v.word);

    const data = await generateJson({
        system: QUESTIONS_SYSTEM,
        prompt: JSON.stringify({ plan, words: involved.map(describeVocab), other_words_for_distractors: otherWords }),
        schema: QUESTIONS_SCHEMA,
        temperature: 0.8,
        timeoutMs: 60000,
    });

    const items = Array.isArray(data?.questions) ? data.questions : [];
    const used = new Set();

    // Match each slot to the first unused AI item that passes validation.
    return slots.map((slot) => {
        for (let i = 0; i < items.length; i++) {
            if (used.has(i)) continue;
            const q = validateAiQuestion(items[i], slot);
            if (q) {
                used.add(i);
                return q;
            }
        }
        return null;
    });
}

// ---------------------------------------------------------------- local fallback

function pickDistractors(correct, pool, n = 3, preferred = []) {
    const exclude = new Set([normalizeAnswer(correct)]);
    const out = [];
    for (const c of [...shuffle(preferred).slice(0, 1), ...shuffle(pool)]) {
        const k = normalizeAnswer(c);
        if (c && !exclude.has(k)) {
            exclude.add(k);
            out.push(c);
            if (out.length === n) break;
        }
    }
    return out;
}

function buildLocal(slot, allVocab) {
    const v = slot.vocab;
    const others = allVocab.filter((o) => String(o._id) !== String(v._id));
    const base = { word: v.word, vocab_id: String(v._id), kind: slot.kind };
    const mcq = (prompt, correct, distractors, explanation) =>
        distractors.length >= 3
            ? { ...base, prompt, options: shuffle([correct, ...distractors]), correct_answer: correct, explanation }
            : null;

    switch (slot.kind) {
        case "meaning": {
            const q = mcq(
                `What does "${v.word}" mean?`,
                v.meaning,
                pickDistractors(v.meaning, others.map((o) => o.meaning)),
                v.meaning_ar ? `${v.word} = ${v.meaning_ar}` : "",
            );
            return q || {
                ...base,
                prompt: `Type the word that matches this meaning: "${v.meaning}"`,
                options: [],
                correct_answer: v.word,
                explanation: v.meaning_ar ? `${v.word} = ${v.meaning_ar}` : "",
            };
        }
        case "sentence": {
            const match = v.example.match(blankRegex(v.word));
            const prompt = v.example.replace(blankRegex(v.word), BLANK);
            const answer = match[0];
            const own = new Set((v.synonyms || []).map(normalizeAnswer)); // a synonym could also fit the blank
            const pool = others.flatMap((o) => [o.word, ...(o.synonyms || [])]).filter((p) => !own.has(normalizeAnswer(p)));
            const q = mcq(prompt, answer, pickDistractors(answer, pool), `الكلمة المناسبة هي ${answer}.`);
            return q || { ...base, prompt, options: [], correct_answer: answer, explanation: `الكلمة المناسبة هي ${answer}.` };
        }
        case "synonym": {
            const correct = shuffle(v.synonyms)[0];
            const pool = others.flatMap((o) => [o.word, ...(o.antonyms || [])]);
            const bad = new Set([...v.synonyms, v.word].map(normalizeAnswer));
            return mcq(
                `Which word is closest in meaning to "${v.word}"?`,
                correct,
                pickDistractors(correct, pool.filter((p) => !bad.has(normalizeAnswer(p))), 3, v.antonyms || []),
                `${correct} مرادف لـ ${v.word}.`,
            );
        }
        case "antonym": {
            const correct = shuffle(v.antonyms)[0];
            const pool = others.flatMap((o) => [o.word, ...(o.synonyms || [])]);
            const bad = new Set([...v.antonyms, v.word].map(normalizeAnswer));
            return mcq(
                `Which word is the opposite of "${v.word}"?`,
                correct,
                pickDistractors(correct, pool.filter((p) => !bad.has(normalizeAnswer(p))), 3, v.synonyms || []),
                `${correct} عكس ${v.word}.`,
            );
        }
        default:
            return null;
    }
}

// ---------------------------------------------------------------- public API

// Returns { questions, ai_used }. `vocabList` = words to test, `allVocab` = the user's whole list.
async function buildQuestions(vocabList, allVocab) {
    const slots = planSlots(vocabList, vocabList.length < 5 ? 2 : 1);

    let aiResults = slots.map(() => null);
    try {
        aiResults = await generateWithAI(slots, allVocab);
    } catch (e) {
        console.error("[test_builder] AI generation failed, using local questions:", e.message);
    }

    let aiUsed = false;
    const questions = [];
    slots.forEach((slot, i) => {
        let q = aiResults[i];
        if (q) aiUsed = true;
        else q = buildLocal(slot, allVocab);
        if (q) questions.push(q);
    });

    return { questions, ai_used: aiUsed };
}

// ---------------------------------------------------------------- grading / shaping

const isCorrectAnswer = (question, selected) =>
    typeof selected === "string" && normalizeAnswer(selected) === normalizeAnswer(question.correct_answer);

// What the client may see before the test is submitted: no answers, no explanation, no word.
const publicQuestion = (q) => ({
    id: String(q._id),
    kind: q.kind,
    prompt: q.prompt,
    options: q.options,
    input: q.options.length ? "choice" : "text",
});

function buildResult(test, extra = {}) {
    const answerById = new Map((test.answers || []).map((a) => [String(a.question_id), a]));
    const results = test.questions.map((q) => {
        const a = answerById.get(String(q._id));
        return {
            question_id: String(q._id),
            word: q.word,
            kind: q.kind,
            prompt: q.prompt,
            options: q.options,
            selected: a ? a.selected : null,
            correct_answer: q.correct_answer,
            is_correct: a ? a.is_correct : false,
            explanation: q.explanation,
        };
    });

    return {
        score: test.score,
        total: test.total,
        percentage: test.total ? Math.round((test.score / test.total) * 100) : 0,
        results,
        ...extra,
    };
}

module.exports = {
    KINDS,
    planSlots,
    validateAiQuestion,
    buildLocal,
    buildQuestions,
    isCorrectAnswer,
    publicQuestion,
    buildResult,
};
