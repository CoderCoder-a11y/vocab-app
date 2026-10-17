// Run with: npm test   (no database and no real Gemini key needed)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
    planSlots, validateAiQuestion, buildLocal, buildQuestions, isCorrectAnswer, publicQuestion, buildResult,
} = require("../utils/test_builder");

const vocab = [
    { _id: "a1", word: "happy", meaning: "feeling pleasure", meaning_ar: "سعيد", example: "She was happy today.", synonyms: ["glad", "joyful"], antonyms: ["sad"] },
    { _id: "a2", word: "brave", meaning: "ready to face danger", meaning_ar: "شجاع", example: "He is a brave boy.", synonyms: ["bold"], antonyms: ["afraid"] },
    { _id: "a3", word: "huge", meaning: "extremely large", meaning_ar: "ضخم", example: "A huge dog ran by.", synonyms: ["enormous"], antonyms: ["tiny"] },
    { _id: "a4", word: "quiet", meaning: "making little noise", meaning_ar: "هادئ", example: "The room was quiet.", synonyms: ["silent"], antonyms: ["noisy"] },
    { _id: "a5", word: "rapid", meaning: "happening very fast", meaning_ar: "سريع", example: "A rapid change.", synonyms: ["swift"], antonyms: ["slow"] },
];

test("local questions are valid for every word and kind", () => {
    for (const v of vocab) {
        for (const slot of planSlots([v], 4)) {
            const q = buildLocal(slot, vocab);
            assert.ok(q, `${v.word}/${slot.kind}`);
            if (q.options.length) {
                assert.equal(q.options.length, 4);
                assert.ok(q.options.includes(q.correct_answer));
                assert.equal(new Set(q.options.map((o) => o.toLowerCase())).size, 4);
            }
            if (slot.kind === "sentence") {
                assert.ok(q.prompt.includes("_____"));
                assert.ok(!new RegExp(`\\b${v.word}\\b`, "i").test(q.prompt));
            }
        }
    }
});

test("typed question is used when there are too few words for distractors", () => {
    const [only] = vocab;
    const q = buildLocal({ vocab: only, kind: "meaning" }, [only]);
    assert.deepEqual(q.options, []);
    assert.equal(q.correct_answer, "happy");
});

test("AI questions that break the rules are rejected", () => {
    const slot = { vocab: vocab[0], kind: "sentence" };
    const good = { word: "happy", kind: "sentence", prompt: "She felt ___ about the news.", options: ["happy", "angry", "tired", "late"], correct_answer: "happy", explanation: "x" };
    assert.ok(validateAiQuestion(good, slot));
    assert.equal(validateAiQuestion({ ...good, prompt: "She felt happy about the news ___." }, slot), null); // leaks the answer
    assert.equal(validateAiQuestion({ ...good, correct_answer: "sad" }, slot), null);                      // answer not in options
    assert.equal(validateAiQuestion({ ...good, options: ["happy", "Happy", "x", "x"] }, slot), null);      // duplicates leave < 3
    assert.equal(validateAiQuestion({ ...good, kind: "meaning" }, slot), null);
    assert.equal(validateAiQuestion({ ...good, word: "brave" }, slot), null);
});

test("grading ignores case, spaces and end punctuation", () => {
    const q = { correct_answer: "Brave" };
    assert.ok(isCorrectAnswer(q, "  brave. "));
    assert.ok(!isCorrectAnswer(q, "bold"));
    assert.ok(!isCorrectAnswer(q, null));
});

test("public question never exposes the answer; result does", () => {
    const q = { _id: "q1", word: "happy", kind: "meaning", prompt: "What?", options: ["a", "b", "c", "d"], correct_answer: "a", explanation: "e" };
    const pub = publicQuestion(q);
    assert.equal(pub.correct_answer, undefined);
    assert.equal(pub.word, undefined);
    assert.equal(pub.explanation, undefined);

    const result = buildResult({ score: 0, total: 1, questions: [q], answers: [{ question_id: "q1", selected: "b", is_correct: false }] });
    assert.equal(result.results[0].correct_answer, "a");
    assert.equal(result.results[0].selected, "b");
});

test("buildQuestions: works with a mock Gemini, and falls back when Gemini is down", async (t) => {
    // Mock Gemini that answers the "plan" it receives with good questions for the first word only.
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const { plan } = JSON.parse(JSON.parse(body).contents[0].parts[0].text);
            const questions = plan.slice(0, 1).map((p) => ({
                word: p.word, kind: p.kind,
                prompt: `What does "${p.word}" mean?`,
                options: ["feeling pleasure", "a type of fruit", "a kind of road", "to run away"],
                correct_answer: "feeling pleasure", explanation: "شرح",
            }));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ questions }) }] } }] }));
        });
    });
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());

    process.env.GEMINI_API_KEY = "test";
    process.env.GEMINI_API_BASE = `http://127.0.0.1:${server.address().port}`;

    const ok = await buildQuestions(vocab, vocab);
    assert.equal(ok.questions.length, 5);          // 1 from AI + 4 filled locally
    assert.equal(ok.ai_used, true);
    assert.ok(ok.questions.every((q) => q.options.includes(q.correct_answer) || q.options.length === 0));

    process.env.GEMINI_API_BASE = "http://127.0.0.1:1"; // nothing listens here
    const down = await buildQuestions(vocab, vocab);
    assert.equal(down.questions.length, 5);
    assert.equal(down.ai_used, false);
});
