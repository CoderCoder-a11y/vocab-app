// Review logic against an in-memory store and a fake clock (no MongoDB).
const test = require("node:test");
const assert = require("node:assert/strict");

const { createReviewService, HttpError } = require("../utils/review_service");
const { emptyCardFields, applyRating, toCard, Rating } = require("../utils/fsrs_service");
const { createMemoryStore } = require("./helpers/memory_store");

const T0 = new Date("2026-10-17T10:00:00.000Z");
const silent = { log() {}, warn() {}, error() {} };

function setup() {
    const store = createMemoryStore();
    const clock = { now: new Date(T0) };
    const svc = createReviewService({ store, clock: () => new Date(clock.now), logger: silent });
    const word = (user, word, extra = {}) => store.addVocab({ user_id: user, word, meaning: `${word} meaning`, meaning_ar: "معنى", example: `A ${word}.`, category: "General", ...extra });
    const legacy = (user, w) => word(user, w);                                  // no FSRS fields at all
    const fresh = (user, w) => word(user, w, emptyCardFields(clock.now));       // has a New card
    return { store, clock, svc, legacy, fresh };
}
const fails = async (p, status, code) => {
    await assert.rejects(p, (e) => e instanceof HttpError && e.status === status && e.code === code, `${status} ${code}`);
};
let n = 0;
const rid = () => `req-${String(++n).padStart(6, "0")}-abcdef`;

test("legacy words (no FSRS state) are offered as new cards and can be rated", async () => {
    const { svc, store, legacy } = setup();
    const w = legacy("u1", "alpha");
    const s = await svc.getDueSession("u1");
    assert.equal(s.cards.length, 1);
    assert.equal(s.cards[0].is_new, true);
    assert.equal(s.cards[0].word, "alpha");

    const r = await svc.rate("u1", w._id, { rating: "Good", request_id: rid() });
    assert.equal(r.rating, "Good");
    const saved = (await store.getVocab("u1", w._id));
    assert.equal(saved.state, 1);                    // Learning
    assert.equal(saved.reps, 1);
});

test("rating changes the due date and saves the new state, and writes a log", async () => {
    const { svc, store, fresh, clock } = setup();
    const w = fresh("u1", "beta");
    const before = (await store.getVocab("u1", w._id)).due;
    const r = await svc.rate("u1", w._id, { rating: "Easy", request_id: rid() });
    const after = await store.getVocab("u1", w._id);
    assert.ok(after.due > before);
    assert.equal(after.state, 2);                    // Review
    assert.equal(after.last_review.getTime(), clock.now.getTime());
    assert.equal(new Date(r.due).getTime(), after.due.getTime());
    assert.equal(store.db.logs.length, 1);
    const log = store.db.logs[0];
    assert.equal(log.rating_name, "Easy");
    assert.equal(log.state_before, 0);
    assert.equal(log.state_after, 2);
    assert.equal(log.due_before.getTime(), before.getTime());
    assert.equal(log.due_after.getTime(), after.due.getTime());
    assert.equal(log.user_id, "u1");
});

test("all four ratings lead to different schedules for the same card", async () => {
    const dues = {};
    for (const rating of ["Again", "Hard", "Good", "Easy"]) {
        const { svc, store, fresh } = setup();
        const w = fresh("u1", "gamma");
        await svc.rate("u1", w._id, { rating, request_id: rid() });
        dues[rating] = (await store.getVocab("u1", w._id)).due.getTime();
    }
    assert.equal(new Set(Object.values(dues)).size, 4);
});

test("cards that are not due yet are not in the due list or the summary count", async () => {
    const { svc, store, fresh, clock } = setup();
    const a = fresh("u1", "dueword");
    const b = fresh("u1", "futureword");
    await svc.rate("u1", a._id, { rating: "Again", request_id: rid() });   // back in 1 minute
    await svc.rate("u1", b._id, { rating: "Easy", request_id: rid() });    // in 8 days

    let sum = await svc.getSummary("u1");
    assert.equal(sum.due_now, 0);
    assert.equal(sum.reviewed_today, 2);
    assert.ok(sum.next_due);
    assert.equal((await svc.getDueSession("u1")).cards.length, 0);

    clock.now = new Date(T0.getTime() + 2 * 60000);                         // 2 minutes later
    sum = await svc.getSummary("u1");
    assert.equal(sum.due_now, 1);
    const s = await svc.getDueSession("u1");
    assert.deepEqual(s.cards.map((c) => c.word), ["dueword"]);
    assert.equal(s.cards[0].is_new, false);

    clock.now = new Date(T0.getTime() + 9 * 86400000);
    assert.equal((await svc.getSummary("u1")).due_now, 2);
    assert.equal(store.db.logs.length, 2);
});

test("a user cannot see or rate another user's words", async () => {
    const { svc, store, fresh } = setup();
    const theirs = fresh("u2", "secret");
    fresh("u1", "mine");
    const s = await svc.getDueSession("u1");
    assert.deepEqual(s.cards.map((c) => c.word), ["mine"]);
    await fails(svc.rate("u1", theirs._id, { rating: "Good", request_id: rid() }), 404, "NOT_FOUND");
    const untouched = await store.getVocab("u2", theirs._id);
    assert.equal(untouched.state, 0);
    assert.equal(store.db.logs.length, 0);
});

test("invalid ratings, word ids and request ids are rejected", async () => {
    const { svc, store, fresh } = setup();
    const w = fresh("u1", "delta");
    for (const rating of [undefined, null, "", "Perfect", 3, "3", "Good!", ["Good"], { a: 1 }]) {
        await fails(svc.rate("u1", w._id, { rating, request_id: rid() }), 400, "INVALID_RATING");
    }
    for (const id of ["abc", "", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", null, undefined, {}]) {
        await fails(svc.rate("u1", id, { rating: "Good" }), 400, "INVALID_ID");
    }
    for (const request_id of ["short", "has space in it!!", 12345678, "x".repeat(200)]) {
        await fails(svc.rate("u1", w._id, { rating: "Good", request_id }), 400, "INVALID_REQUEST_ID");
    }
    await fails(svc.rate("u1", "0".repeat(23) + "f", { rating: "Good" }), 404, "NOT_FOUND");
    assert.equal(store.db.logs.length, 0);
    assert.equal((await store.getVocab("u1", w._id)).state, 0);
});

test("the browser cannot choose the schedule: extra fields are ignored", async () => {
    const { svc, store, fresh } = setup();
    const w = fresh("u1", "epsilon");
    await svc.rate("u1", w._id, { rating: "Again", request_id: rid(), due: "2099-01-01", stability: 9999, difficulty: 1, state: 2 });
    const saved = await store.getVocab("u1", w._id);
    const expected = applyRating(toCard({ ...emptyCardFields(T0) }, T0), Rating.Again, T0).fields;
    assert.equal(saved.due.getTime(), expected.due.getTime());
    assert.equal(saved.stability, expected.stability);
});

test("the same request sent many times creates one review log", async () => {
    const { svc, store, fresh } = setup();
    const w = fresh("u1", "zeta");
    const id = rid();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => svc.rate("u1", w._id, { rating: "Good", request_id: id })));
    assert.equal(store.db.logs.length, 1);
    assert.equal((await store.getVocab("u1", w._id)).reps, 1);
    assert.ok(new Set(results.map((r) => r.due)).size === 1);
    assert.equal(results.filter((r) => !r.replayed).length, 1);

    const again = await svc.rate("u1", w._id, { rating: "Good", request_id: id });  // later retry
    assert.equal(again.replayed, true);
    assert.equal(store.db.logs.length, 1);
    assert.equal((await store.getVocab("u1", w._id)).reps, 1);
    await fails(svc.rate("u1", fresh("u1", "other")._id, { rating: "Good", request_id: id }), 409, "REQUEST_ID_REUSED");
});

test("a second, different press on a card that was just rated is refused", async () => {
    const { svc, store, fresh } = setup();
    const w = fresh("u1", "eta");
    await svc.rate("u1", w._id, { rating: "Good", request_id: rid() });
    await fails(svc.rate("u1", w._id, { rating: "Easy", request_id: rid() }), 409, "NOT_DUE");
    await fails(svc.rate("u1", w._id, { rating: "Easy" }), 409, "NOT_DUE");
    assert.equal(store.db.logs.length, 1);
});

test("two different requests racing on one card: only one is saved", async () => {
    const { svc, store, fresh } = setup();
    const w = fresh("u1", "theta");
    const out = await Promise.allSettled([
        svc.rate("u1", w._id, { rating: "Good", request_id: rid() }),
        svc.rate("u1", w._id, { rating: "Hard", request_id: rid() }),
    ]);
    assert.equal(out.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(out.find((o) => o.status === "rejected").reason.code, "CONFLICT");
    assert.equal(store.db.logs.length, 1);
    assert.equal((await store.getVocab("u1", w._id)).reps, 1);
});

test("a failed card update leaves no review log behind (and nothing is reported as saved)", async () => {
    const { svc, store, fresh } = setup();
    const w = fresh("u1", "iota");
    store.updateCard = async () => { throw new Error("db down"); };
    await assert.rejects(svc.rate("u1", w._id, { rating: "Good", request_id: rid() }), /db down/);
    assert.equal(store.db.logs.length, 0);
});

test("a half-finished earlier attempt is completed when the same request is retried", async () => {
    const { svc, store, fresh } = setup();
    const w = fresh("u1", "kappa");
    const id = rid();
    const realUpdate = store.updateCard;
    store.updateCard = async () => { throw new Error("crash after log insert"); };
    // simulate the crash AFTER the log was stored: keep the log
    store.deleteLog = async () => {};
    await assert.rejects(svc.rate("u1", w._id, { rating: "Good", request_id: id }));
    assert.equal(store.db.logs.length, 1);
    assert.equal((await store.getVocab("u1", w._id)).reps || 0, 0);

    store.updateCard = realUpdate;
    const r = await svc.rate("u1", w._id, { rating: "Good", request_id: id });
    assert.equal(r.replayed, true);
    assert.equal((await store.getVocab("u1", w._id)).reps, 1);
    assert.equal(store.db.logs.length, 1);
});

test("daily new-word limit: new words are capped, due cards are separate", async () => {
    const { svc, fresh, clock } = setup();
    for (let i = 0; i < 5; i++) fresh("u1", `word${i}`);
    await svc.updateReviewSettings("u1", { daily_new_limit: 2 });

    let s = await svc.getDueSession("u1");
    assert.equal(s.cards.length, 2);
    assert.equal(s.counts.new, 2);
    let sum = await svc.getSummary("u1");
    assert.equal(sum.new_total, 5);
    assert.equal(sum.new_available, 2);

    await svc.rate("u1", s.cards[0]._id, { rating: "Easy", request_id: rid() });
    await svc.rate("u1", s.cards[1]._id, { rating: "Easy", request_id: rid() });
    s = await svc.getDueSession("u1");
    assert.equal(s.cards.length, 0, "limit reached for today");
    sum = await svc.getSummary("u1");
    assert.equal(sum.new_available, 0);
    assert.equal(sum.new_introduced_today, 2);

    clock.now = new Date(T0.getTime() + 24 * 3600000);                       // next day
    s = await svc.getDueSession("u1");
    assert.equal(s.counts.new, 2);
    assert.equal(s.counts.due, 0);
});

test("settings: invalid limits and defaults", async () => {
    const { svc } = setup();
    assert.equal((await svc.getReviewSettings("u1")).daily_new_limit, 20);
    for (const bad of [-1, 501, 1.5, "10", null, undefined]) await fails(svc.updateReviewSettings("u1", { daily_new_limit: bad }), 400, "INVALID_LIMIT");
    assert.equal((await svc.updateReviewSettings("u1", { daily_new_limit: 0 })).daily_new_limit, 0);
});

test("session limit, history order/limit, and statistics from real logs", async () => {
    const { svc, fresh, clock } = setup();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(fresh("u1", `w${i}`)._id);
    assert.equal((await svc.getDueSession("u1", { limit: 3 })).cards.length, 3);
    assert.equal((await svc.getDueSession("u1", { limit: "abc" })).cards.length, 6);

    const ratings = ["Again", "Good", "Good", "Easy", "Hard", "Good"];
    for (let i = 0; i < 6; i++) {
        clock.now = new Date(T0.getTime() + i * 1000);
        await svc.rate("u1", ids[i], { rating: ratings[i], request_id: rid() });
    }
    const h = await svc.getHistory("u1", { limit: 4 });
    assert.equal(h.total, 6);
    assert.equal(h.data.length, 4);
    assert.equal(h.data[0].word, "w5");                                      // newest first
    assert.ok(h.data[0].reviewed_at >= h.data[3].reviewed_at);

    const sum = await svc.getSummary("u1");
    assert.equal(sum.reviewed_today, 6);
    assert.deepEqual(sum.today, { Again: 1, Hard: 1, Good: 3, Easy: 1 });
    assert.equal(sum.last_7_days.success_rate, 83.3);                        // 5 of 6 were not "Again"
});

test("opening a card is not a review: nothing is written until a rating", async () => {
    const { svc, store, fresh } = setup();
    fresh("u1", "lambda");
    await svc.getDueSession("u1");
    await svc.getSummary("u1");
    assert.equal(store.db.logs.length, 0);
    assert.equal((await svc.getSummary("u1")).reviewed_today, 0);
});
