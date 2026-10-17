// Run with: npm test   (no database, no Gemini key; time is fixed so results are repeatable)
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("ts-fsrs");

const f = require("../utils/fsrs_service");
const { isValidTimeZone, isValidTime, localParts, startOfLocalDay } = require("../utils/timezone");

const NOW = new Date("2026-10-17T10:00:00.000Z");

test("a new word starts as a brand new FSRS card made by the library", () => {
    const fields = f.emptyCardFields(NOW);
    const expected = lib.createEmptyCard(NOW);
    assert.equal(fields.state, lib.State.New);
    assert.equal(fields.reps, 0);
    assert.equal(fields.lapses, 0);
    assert.equal(fields.stability, expected.stability);
    assert.equal(fields.difficulty, expected.difficulty);
    assert.equal(fields.due.getTime(), NOW.getTime());
    assert.equal(fields.last_review, null);
});

test("the vocabulary model gives new words that card automatically", async () => {
    const Vocab = require("../models/vocabulary");
    const d = new Vocab({ user_id: "u1", word: "calm", meaning: "peaceful", example: "A calm sea.", category: "General" });
    await d.validate();
    assert.equal(d.state, 0);
    assert.equal(d.reps, 0);
    assert.ok(d.due instanceof Date);
    // old fields are still there
    for (const k of ["word", "meaning", "meaning_ar", "example", "examples", "category", "images", "part_of_speech", "source"]) {
        assert.ok(k in Vocab.schema.paths, k);
    }
});

test("each of the four ratings gives exactly what the FSRS library computes", () => {
    const scheduler = lib.fsrs(lib.generatorParameters({ enable_fuzz: false }));
    const card = f.toCard({}, NOW);
    const direct = scheduler.repeat(card, NOW);
    const names = { Again: lib.Rating.Again, Hard: lib.Rating.Hard, Good: lib.Rating.Good, Easy: lib.Rating.Easy };
    const dues = new Set();
    for (const [name, value] of Object.entries(names)) {
        const r = f.applyRating(card, value, NOW);
        assert.equal(r.fields.due.getTime(), direct[value].card.due.getTime(), name);
        assert.equal(r.fields.stability, direct[value].card.stability, name);
        assert.equal(r.fields.difficulty, direct[value].card.difficulty, name);
        assert.equal(r.fields.state, direct[value].card.state, name);
        assert.equal(r.log.rating_name, name);
        dues.add(r.fields.due.getTime());
    }
    assert.equal(dues.size, 4, "the four buttons schedule four different times for a new card");
});

test("preview shows the same due time that rating will save, with Arabic labels", () => {
    const card = f.toCard({}, NOW);
    const preview = f.previewCard(card, NOW);
    assert.deepEqual(Object.keys(preview), ["Again", "Hard", "Good", "Easy"]);
    for (const name of f.RATING_NAMES) {
        const r = f.applyRating(card, f.parseRating(name).value, NOW);
        assert.equal(preview[name].due, r.fields.due.toISOString());
    }
    assert.equal(preview.Good.label, "بعد 10 دقائق");
    assert.match(preview.Easy.label, /^بعد \d+ أيام$/);
});

test("a reviewed card keeps its state and the scheduling reacts to the answer", () => {
    let card = f.toCard({}, NOW);
    card = f.applyRating(card, lib.Rating.Easy, NOW).card;              // New -> Review
    assert.equal(card.state, lib.State.Review);
    const later = new Date(card.due.getTime());
    const stored = f.fromCard(card);
    const back = f.toCard(stored, later);                               // Mongo -> card round trip
    assert.deepEqual(f.fromCard(back), stored);
    const good = f.applyRating(back, lib.Rating.Good, later);
    const again = f.applyRating(back, lib.Rating.Again, later);
    assert.ok(good.fields.scheduled_days > back.scheduled_days);
    assert.equal(again.fields.state, lib.State.Relearning);
    assert.equal(again.fields.lapses, 1);
    assert.ok(again.fields.due < good.fields.due);
});

test("old words without FSRS fields are read as new cards", () => {
    const legacy = { _id: "x", user_id: "u", word: "old", meaning: "m", example: "e", category: "c" };
    const card = f.toCard(legacy, NOW);
    assert.equal(card.state, lib.State.New);
    assert.equal(card.reps, 0);
    assert.doesNotThrow(() => f.applyRating(card, lib.Rating.Good, NOW));
    // corrupted values fall back to a new card instead of crashing
    assert.equal(f.toCard({ state: 9 }, NOW).state, lib.State.New);
});

test("rating names are strict", () => {
    assert.equal(f.parseRating("good").name, "Good");
    assert.equal(f.parseRating(" EASY ").value, lib.Rating.Easy);
    for (const bad of [3, "5", "Perfect", "", null, undefined, {}, ["Good"], "Manual", "0"]) assert.equal(f.parseRating(bad), null, String(bad));
});

test("Arabic interval labels", () => {
    const at = (ms) => f.intervalLabel(new Date(NOW.getTime() + ms), NOW);
    const m = 60000, h = 3600000, d = 86400000;
    assert.equal(at(30 * 1000), "بعد أقل من دقيقة");
    assert.equal(at(m), "بعد دقيقة");
    assert.equal(at(10 * m), "بعد 10 دقائق");
    assert.equal(at(2 * h), "بعد ساعتين");
    assert.equal(at(d), "غدًا");
    assert.equal(at(2 * d), "بعد يومين");
    assert.equal(at(4 * d), "بعد 4 أيام");
    assert.equal(at(15 * d), "بعد 15 يومًا");
    assert.equal(at(60 * d), "بعد شهرين");
});

test("time zone validation and local day boundaries", () => {
    assert.ok(isValidTimeZone("Africa/Cairo"));
    assert.ok(isValidTimeZone("UTC"));
    for (const bad of ["Mars/Base", "", null, 5, "x".repeat(80), "Cairo"]) assert.equal(isValidTimeZone(bad), false, String(bad));
    assert.ok(isValidTime("07:30") && isValidTime("23:59"));
    for (const bad of ["24:00", "7:30", "12:60", "", null]) assert.equal(isValidTime(bad), false, String(bad));

    const p = localParts(new Date("2026-01-15T22:30:00Z"), "Africa/Cairo");   // UTC+2 in winter
    assert.equal(p.dateKey, "2026-01-16");
    assert.equal(p.timeKey, "00:30");
    assert.equal(startOfLocalDay(new Date("2026-01-15T22:30:00Z"), "Africa/Cairo").toISOString(), "2026-01-15T22:00:00.000Z");
    assert.equal(startOfLocalDay(NOW, "UTC").toISOString(), "2026-10-17T00:00:00.000Z");
});
