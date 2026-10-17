// Existing features keep working after the FSRS changes (everything loads, old fields/routes are intact).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.NODE_ENV = "test";

test("all routers and controllers still load", () => {
    for (const f of ["register", "log_in", "log_out", "auth_me", "words", "test", "review"]) {
        assert.doesNotThrow(() => require(`../routes/${f}.router`), f);
    }
});

function routesOf(router) {
    return router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

test("old word and test routes are unchanged; new review routes exist and require auth", () => {
    const words = routesOf(require("../routes/words.router"));
    for (const r of ["GET /api/get_vocab", "POST /api/add_vocab", "DELETE /api/DEL_vocab", "POST /api/vocab_images", "GET /api/get_synonyms"]) assert.ok(words.includes(r), r);
    const tests = routesOf(require("../routes/test.router"));
    for (const r of ["GET /api/tests", "POST /api/test", "POST /api/test/answers", "GET /api/test/:id"]) assert.ok(tests.includes(r), r);
    const review = require("../routes/review.router");
    const rr = routesOf(review);
    for (const r of ["GET /api/review/summary", "GET /api/review/due", "POST /api/review/:vocabId/rate", "GET /api/review/history",
        "POST /api/reminders/subscribe", "POST /api/reminders/unsubscribe", "PUT /api/reminders/settings", "GET /api/reminders/settings"]) assert.ok(rr.includes(r), r);
    const auth = require("../middleware/auth");
    for (const layer of review.stack.filter((l) => l.route)) {
        assert.ok(layer.route.stack.some((s) => s.handle === auth), `${layer.route.path} must use auth`);
    }
});

test("the test model, user week_words and vocabulary fields are untouched", () => {
    assert.ok("week_words" in require("../models/users").schema.paths);
    const tests = require("../models/tests").schema.paths;
    for (const k of ["mode", "questions", "answers", "score", "status"]) assert.ok(k in tests, k);
    const vocab = require("../models/vocabulary").schema.paths;
    for (const k of ["user_id", "word", "meaning", "meaning_ar", "example", "examples", "category", "images", "image", "part_of_speech", "source"]) assert.ok(k in vocab, k);
    for (const k of ["due", "stability", "difficulty", "elapsed_days", "scheduled_days", "reps", "lapses", "state", "last_review"]) assert.ok(k in vocab, k);
});

test("indexes for due queries and review history exist", () => {
    const has = (schema, keys) => schema.indexes().some(([k]) => JSON.stringify(k) === JSON.stringify(keys));
    assert.ok(has(require("../models/vocabulary").schema, { user_id: 1, state: 1, due: 1 }));
    const logs = require("../models/review_logs").schema;
    assert.ok(has(logs, { user_id: 1, review: -1 }));
    assert.ok(has(logs, { user_id: 1, vocab_id: 1, review: -1 }));
    assert.ok(logs.indexes().some(([k, o]) => k.request_id === 1 && o.unique));
});

test("no secrets are shipped to the browser", () => {
    const pub = path.join(__dirname, "..", "public");
    for (const f of fs.readdirSync(pub)) {
        const txt = fs.readFileSync(path.join(pub, f), "utf8");
        assert.ok(!/VAPID_PRIVATE_KEY|GEMINI_API_KEY|TAVILY_API_KEY|JWT_SECRET/.test(txt), f);
    }
});

test("the service worker file is served from the web root", () => {
    const sw = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
    assert.match(sw, /addEventListener\(\s*["']push["']/);
    assert.match(sw, /notificationclick/);
});
