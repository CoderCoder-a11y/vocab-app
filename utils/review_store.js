// MongoDB access for the review feature. Kept separate from the business logic
// (review_service.js) so the logic can be tested without a database.
const Vocab = require("../models/vocabulary");
const ReviewLog = require("../models/review_logs");
const Settings = require("../models/review_settings");
const Subscriptions = require("../models/push_subscriptions");
const SynonymsModel = require("../models/synonyms");
const { normalizeWord } = require("./text");

const NEW = 0;
const IN_PROGRESS = [1, 2, 3]; // Learning, Review, Relearning

// ---- filters (exported so tests can check them) ----
const dueFilter = (userId, now) => ({ user_id: userId, state: { $in: IN_PROGRESS }, due: { $lte: now } });
// Words saved before FSRS was added have no `state` at all: they count as new.
const newFilter = (userId) => ({ user_id: userId, $or: [{ state: NEW }, { state: { $exists: false } }] });
const futureFilter = (userId, now) => ({ user_id: userId, state: { $in: IN_PROGRESS }, due: { $gt: now } });
const versionFilter = (userId, vocabId, expectedReps) => ({
    _id: vocabId,
    user_id: userId,
    $or: expectedReps ? [{ reps: expectedReps }] : [{ reps: 0 }, { reps: { $exists: false } }],
});

const isDuplicateKey = (e) => !!e && (e.code === 11000 || e.code === 11001);

function createMongoStore() {
    return {
        // ---- vocabulary / cards ----
        getVocab: (userId, vocabId) => Vocab.findOne({ _id: vocabId, user_id: userId }).lean(),
        listDue: (userId, now, limit) => Vocab.find(dueFilter(userId, now)).sort({ due: 1 }).limit(limit).lean(),
        listNew: (userId, limit) => Vocab.find(newFilter(userId)).sort({ createdAt: 1 }).limit(limit).lean(),
        countDue: (userId, now) => Vocab.countDocuments(dueFilter(userId, now)),
        countNew: (userId) => Vocab.countDocuments(newFilter(userId)),
        countWords: (userId) => Vocab.countDocuments({ user_id: userId }),
        async nextDue(userId, now) {
            const w = await Vocab.findOne(futureFilter(userId, now)).sort({ due: 1 }).select("due").lean();
            return w ? w.due : null;
        },
        // Saves the new card state only if nobody changed the card since it was read.
        async updateCard(userId, vocabId, expectedReps, fields) {
            const r = await Vocab.updateOne(versionFilter(userId, vocabId, expectedReps), { $set: fields });
            return r.matchedCount === 1;
        },
        async getSynonyms(userId, words) {
            const keys = words.map(normalizeWord);
            const rows = await SynonymsModel.find({ user_id: userId, word_key: { $in: keys } }).lean();
            const map = new Map();
            for (const s of rows) {
                const cur = map.get(normalizeWord(s.word)) || { synonyms: [], antonyms: [] };
                cur.synonyms.push(...(s.synonyms || []));
                cur.antonyms.push(...(s.antonyms || []));
                map.set(normalizeWord(s.word), cur);
            }
            return map;
        },

        // ---- review logs ----
        findLog: (userId, requestId) => ReviewLog.findOne({ user_id: userId, request_id: requestId }).lean(),
        async insertLog(doc) {
            const created = await ReviewLog.create(doc);
            return created.toObject();
        },
        async deleteLog(id) { await ReviewLog.deleteOne({ _id: id }); },
        countNewIntroducedSince: (userId, since) =>
            ReviewLog.countDocuments({ user_id: userId, state_before: NEW, review: { $gte: since } }),
        async ratingCountsSince(userId, since) {
            const rows = await ReviewLog.aggregate([
                { $match: { user_id: userId, review: { $gte: since } } },
                { $group: { _id: "$rating_name", n: { $sum: 1 } } },
            ]);
            const out = { Again: 0, Hard: 0, Good: 0, Easy: 0 };
            for (const r of rows) if (r._id in out) out[r._id] = r.n;
            return out;
        },
        listLogs: (userId, limit, skip) => ReviewLog.find({ user_id: userId }).sort({ review: -1, _id: -1 }).skip(skip).limit(limit).lean(),
        countLogs: (userId) => ReviewLog.countDocuments({ user_id: userId }),

        // ---- settings ----
        getSettings: (userId) => Settings.findOne({ user_id: userId }).lean(),
        upsertSettings: (userId, fields) =>
            Settings.findOneAndUpdate({ user_id: userId }, { $set: fields, $setOnInsert: { user_id: userId } }, { upsert: true, new: true, runValidators: true }).lean(),

        // ---- reminders / push ----
        listReminderSettings: () => Settings.find({ reminder_enabled: true }).lean(),
        // Atomic claim: only ONE process/instance gets `true` for a given user + local date.
        async claimReminder(settingsId, localDate) {
            const r = await Settings.updateOne(
                { _id: settingsId, reminder_enabled: true, last_reminder_date: { $ne: localDate } },
                { $set: { last_reminder_date: localDate } },
            );
            return r.modifiedCount === 1;
        },
        async releaseReminder(settingsId, localDate) {
            await Settings.updateOne({ _id: settingsId, last_reminder_date: localDate }, { $set: { last_reminder_date: "" } });
        },
        listSubscriptions: (userId) => Subscriptions.find({ user_id: userId }).lean(),
        async saveSubscription(userId, sub) {
            return Subscriptions.findOneAndUpdate(
                { endpoint: sub.endpoint },
                { $set: { user_id: userId, keys: sub.keys, expiration_time: sub.expiration_time, user_agent: sub.user_agent, failures: 0 } },
                { upsert: true, new: true, runValidators: true },
            ).lean();
        },
        async deleteSubscription(userId, endpoint) {
            const r = await Subscriptions.deleteOne({ user_id: userId, endpoint });
            return r.deletedCount;
        },
        async deleteSubscriptionByEndpoint(endpoint) { await Subscriptions.deleteOne({ endpoint }); },
        async deleteUserSubscriptions(userId) { await Subscriptions.deleteMany({ user_id: userId }); },
        async recordSubscriptionFailure(endpoint) {
            const s = await Subscriptions.findOneAndUpdate({ endpoint }, { $inc: { failures: 1 } }, { new: true }).lean();
            return s ? s.failures : 0;
        },
        async resetSubscriptionFailures(endpoint) { await Subscriptions.updateOne({ endpoint }, { $set: { failures: 0 } }); },
    };
}

module.exports = { createMongoStore, dueFilter, newFilter, futureFilter, versionFilter, isDuplicateKey };
