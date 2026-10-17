// In-memory stand-in for utils/review_store.js, used by the tests (no MongoDB needed).
// It evaluates the SAME filter objects the real store builds (dueFilter, newFilter, versionFilter...),
// using a tiny matcher for the few Mongo operators those filters use.
const { dueFilter, newFilter, futureFilter, versionFilter } = require("../../utils/review_store");
const { normalizeWord } = require("../../utils/text");

const val = (v) => (v instanceof Date ? v.getTime() : v);

function matchField(actual, cond) {
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
        return Object.entries(cond).every(([op, arg]) => {
            switch (op) {
                case "$in": return arg.map(val).includes(val(actual));
                case "$lte": return actual !== undefined && actual !== null && val(actual) <= val(arg);
                case "$lt": return actual !== undefined && actual !== null && val(actual) < val(arg);
                case "$gte": return actual !== undefined && actual !== null && val(actual) >= val(arg);
                case "$gt": return actual !== undefined && actual !== null && val(actual) > val(arg);
                case "$ne": return val(actual) !== val(arg);
                case "$exists": return (actual !== undefined) === arg;
                default: throw new Error(`matcher: unsupported operator ${op}`);
            }
        });
    }
    return val(actual) === val(cond);
}

function matches(doc, filter) {
    return Object.entries(filter).every(([k, cond]) =>
        k === "$or" ? cond.some((f) => matches(doc, f)) : matchField(doc[k], cond));
}

const tick = () => Promise.resolve(); // lets concurrent requests interleave like real I/O

function createMemoryStore() {
    const db = { vocab: [], logs: [], settings: [], subs: [], syn: [] };
    let seq = 1;
    const newId = () => (seq++).toString(16).padStart(24, "0");
    const clone = (d) => (d ? { ...d, keys: d.keys ? { ...d.keys } : undefined } : d);

    const store = {
        db,
        addVocab(doc) { const d = { _id: newId(), createdAt: new Date(), ...doc }; db.vocab.push(d); return d; },

        async getVocab(userId, vocabId) { await tick(); return clone(db.vocab.find((v) => v._id === String(vocabId) && v.user_id === userId)) || null; },
        async listDue(userId, now, limit) {
            await tick();
            return db.vocab.filter((v) => matches(v, dueFilter(userId, now))).sort((a, b) => a.due - b.due).slice(0, limit).map(clone);
        },
        async listNew(userId, limit) {
            await tick();
            return db.vocab.filter((v) => matches(v, newFilter(userId))).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit).map(clone);
        },
        async countDue(userId, now) { return db.vocab.filter((v) => matches(v, dueFilter(userId, now))).length; },
        async countNew(userId) { return db.vocab.filter((v) => matches(v, newFilter(userId))).length; },
        async countWords(userId) { return db.vocab.filter((v) => v.user_id === userId).length; },
        async nextDue(userId, now) {
            const l = db.vocab.filter((v) => matches(v, futureFilter(userId, now))).sort((a, b) => a.due - b.due);
            return l[0] ? l[0].due : null;
        },
        async updateCard(userId, vocabId, expectedReps, fields) {
            await tick();
            const d = db.vocab.find((v) => matches(v, versionFilter(userId, String(vocabId), expectedReps)));
            if (!d) return false;
            Object.assign(d, fields);
            return true;
        },
        async getSynonyms(userId, words) {
            const keys = new Set(words.map(normalizeWord));
            const m = new Map();
            for (const s of db.syn) if (s.user_id === userId && keys.has(normalizeWord(s.word))) m.set(normalizeWord(s.word), { synonyms: s.synonyms, antonyms: s.antonyms });
            return m;
        },

        async findLog(userId, requestId) { await tick(); return clone(db.logs.find((l) => l.user_id === userId && l.request_id === requestId)) || null; },
        async insertLog(doc) {
            await tick();
            if (doc.request_id && db.logs.some((l) => l.user_id === doc.user_id && l.request_id === doc.request_id)) {
                const e = new Error("E11000 duplicate key"); e.code = 11000; throw e;
            }
            const d = { _id: newId(), ...doc };
            db.logs.push(d);
            return clone(d);
        },
        async deleteLog(id) { db.logs = db.logs.filter((l) => l._id !== id); },
        async countNewIntroducedSince(userId, since) { return db.logs.filter((l) => l.user_id === userId && l.state_before === 0 && l.review >= since).length; },
        async ratingCountsSince(userId, since) {
            const out = { Again: 0, Hard: 0, Good: 0, Easy: 0 };
            for (const l of db.logs) if (l.user_id === userId && l.review >= since) out[l.rating_name]++;
            return out;
        },
        async listLogs(userId, limit, skip) {
            return db.logs.filter((l) => l.user_id === userId).sort((a, b) => b.review - a.review).slice(skip, skip + limit).map(clone);
        },
        async countLogs(userId) { return db.logs.filter((l) => l.user_id === userId).length; },

        async getSettings(userId) { return clone(db.settings.find((s) => s.user_id === userId)) || null; },
        async upsertSettings(userId, fields) {
            let s = db.settings.find((x) => x.user_id === userId);
            if (!s) { s = { _id: newId(), user_id: userId, reminder_enabled: false, reminder_time: "20:00", timezone: "UTC", last_reminder_date: "" }; db.settings.push(s); }
            Object.assign(s, fields);
            return clone(s);
        },

        async listReminderSettings() { return db.settings.filter((s) => s.reminder_enabled).map(clone); },
        async claimReminder(id, localDate) {
            await tick();
            const s = db.settings.find((x) => x._id === id && x.reminder_enabled && x.last_reminder_date !== localDate);
            if (!s) return false;
            s.last_reminder_date = localDate;
            return true;
        },
        async releaseReminder(id, localDate) { const s = db.settings.find((x) => x._id === id && x.last_reminder_date === localDate); if (s) s.last_reminder_date = ""; },
        async listSubscriptions(userId) { return db.subs.filter((s) => s.user_id === userId).map(clone); },
        async saveSubscription(userId, sub) {
            let s = db.subs.find((x) => x.endpoint === sub.endpoint);
            if (!s) { s = { _id: newId(), failures: 0 }; db.subs.push(s); }
            Object.assign(s, { user_id: userId, ...sub, failures: 0 });
            return clone(s);
        },
        async deleteSubscription(userId, endpoint) { const n = db.subs.length; db.subs = db.subs.filter((s) => !(s.user_id === userId && s.endpoint === endpoint)); return n - db.subs.length; },
        async deleteSubscriptionByEndpoint(endpoint) { db.subs = db.subs.filter((s) => s.endpoint !== endpoint); },
        async recordSubscriptionFailure(endpoint) { const s = db.subs.find((x) => x.endpoint === endpoint); if (!s) return 0; s.failures++; return s.failures; },
        async resetSubscriptionFailures(endpoint) { const s = db.subs.find((x) => x.endpoint === endpoint); if (s) s.failures = 0; },
    };
    return store;
}

module.exports = { createMemoryStore, matches };
