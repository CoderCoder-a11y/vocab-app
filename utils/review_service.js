// Business logic of the review feature. It talks to the database only through `store`
// (see review_store.js), so tests can plug in an in-memory store and a fake clock.
const fsrsLib = require("./fsrs_service");
const cfg = require("./review_config");
const { isValidTimeZone, startOfLocalDay } = require("./timezone");
const { normalizeWord } = require("./text");
const { isValidId } = require("./helper");

class HttpError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const WEEK_MS = 7 * 86400000;

function clampInt(v, fallback, min, max) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

const isDup = (e) => !!e && (e.code === 11000 || e.code === 11001);

function createReviewService({ store, clock = () => new Date(), logger = console }) {
    // Zone used to decide when the user's "day" starts (for the daily new-words limit).
    async function zoneFor(userId, requested) {
        if (isValidTimeZone(requested)) return requested;
        const s = await store.getSettings(userId);
        return s && isValidTimeZone(s.timezone) ? s.timezone : "UTC";
    }

    const dailyLimitOf = (settings) =>
        settings && Number.isInteger(settings.daily_new_limit) ? settings.daily_new_limit : cfg.DEFAULT_NEW_PER_DAY;

    // How many NEW words may still be introduced today.
    async function newBudget(userId, settings, tz, now) {
        const limit = dailyLimitOf(settings);
        const introduced = await store.countNewIntroducedSince(userId, startOfLocalDay(now, tz));
        return { limit, introduced, remaining: Math.max(0, limit - introduced) };
    }

    // ---------------- summary ----------------
    async function getSummary(userId, { tz } = {}) {
        const now = clock();
        const zone = await zoneFor(userId, tz);
        const settings = await store.getSettings(userId);
        const budget = await newBudget(userId, settings, zone, now);
        const dayStart = startOfLocalDay(now, zone);

        const [dueNow, totalNew, totalWords, nextDue, today, week] = await Promise.all([
            store.countDue(userId, now),
            store.countNew(userId),
            store.countWords(userId),
            store.nextDue(userId, now),
            store.ratingCountsSince(userId, dayStart),
            store.ratingCountsSince(userId, new Date(now.getTime() - WEEK_MS)),
        ]);
        const sum = (c) => c.Again + c.Hard + c.Good + c.Easy;
        const rate = (c) => (sum(c) ? Math.round(((sum(c) - c.Again) / sum(c)) * 1000) / 10 : null);

        return {
            total_words: totalWords,
            due_now: dueNow,                                   // only cards whose due time has passed
            new_total: totalNew,                               // words never reviewed
            new_available: Math.min(totalNew, budget.remaining),
            daily_new_limit: budget.limit,
            new_introduced_today: budget.introduced,
            next_due: nextDue ? new Date(nextDue).toISOString() : null,
            reviewed_today: sum(today),
            today,
            last_7_days: { reviews: sum(week), ...week, success_rate: rate(week) }, // success = not "Again"
            session_limit: cfg.DEFAULT_SESSION_LIMIT,
        };
    }

    // ---------------- queue for one session ----------------
    async function getDueSession(userId, { limit, tz } = {}) {
        const now = clock();
        const zone = await zoneFor(userId, tz);
        const settings = await store.getSettings(userId);
        const max = clampInt(limit, cfg.DEFAULT_SESSION_LIMIT, 1, cfg.MAX_SESSION_LIMIT);

        const due = await store.listDue(userId, now, max);                 // due cards first
        const budget = await newBudget(userId, settings, zone, now);
        const room = Math.min(budget.remaining, max - due.length);
        const fresh = room > 0 ? await store.listNew(userId, room) : [];

        const docs = [...due, ...fresh];
        const syn = docs.length ? await store.getSynonyms(userId, docs.map((d) => d.word)) : new Map();

        const cards = docs.map((d) => {
            const card = fsrsLib.toCard(d, now);
            const extra = syn.get(normalizeWord(d.word)) || { synonyms: [], antonyms: [] };
            return {
                _id: String(d._id),
                word: d.word,
                part_of_speech: d.part_of_speech || "",
                meaning: d.meaning,
                meaning_ar: d.meaning_ar || "",
                example: d.example,
                examples: d.examples || [],
                category: d.category,
                image: d.image,
                images: d.images || [],
                synonyms: [...new Set(extra.synonyms)],
                antonyms: [...new Set(extra.antonyms)],
                is_new: card.state === fsrsLib.State.New,
                state: card.state,
                reps: card.reps,
                lapses: card.lapses,
                preview: fsrsLib.previewCard(card, now),
            };
        });

        return {
            cards,
            counts: { due: due.length, new: fresh.length, total: cards.length },
            limit: max,
            generated_at: now.toISOString(),
        };
    }

    // ---------------- rate one card ----------------
    function responseFor(vocabId, log, replayed) {
        return {
            vocab_id: String(vocabId),
            rating: log.rating_name,
            due: new Date(log.due_after).toISOString(),
            scheduled_days: log.scheduled_days_after,
            state: log.state_after,
            reviewed_at: new Date(log.review).toISOString(),
            replayed,
        };
    }

    // Fields of the card as they were after `log` (used to repair a half-finished earlier attempt).
    function fieldsFromLog(log, current) {
        return {
            due: log.due_after, stability: log.stability_after, difficulty: log.difficulty_after,
            elapsed_days: log.elapsed_days, scheduled_days: log.scheduled_days_after,
            learning_steps: log.learning_steps_after, reps: log.reps_after, lapses: log.lapses_after,
            state: log.state_after, last_review: log.review,
        };
    }

    async function replay(userId, vocabId, log) {
        if (String(log.vocab_id) !== String(vocabId)) {
            throw new HttpError(409, "request_id was already used for another word", "REQUEST_ID_REUSED");
        }
        // If the earlier attempt saved the log but crashed before saving the card, finish it now.
        const doc = await store.getVocab(userId, vocabId);
        if (doc && (doc.reps || 0) === log.reps_before) {
            await store.updateCard(userId, vocabId, log.reps_before, fieldsFromLog(log, doc));
        }
        return responseFor(vocabId, log, true);
    }

    async function rate(userId, vocabId, body = {}) {
        if (!isValidId(vocabId)) throw new HttpError(400, "Invalid ID", "INVALID_ID");
        const rating = fsrsLib.parseRating(body.rating);
        if (!rating) throw new HttpError(400, "rating must be one of Again, Hard, Good, Easy", "INVALID_RATING");

        let requestId;
        if (body.request_id !== undefined && body.request_id !== null) {
            if (typeof body.request_id !== "string" || !REQUEST_ID_RE.test(body.request_id)) {
                throw new HttpError(400, "Invalid request_id", "INVALID_REQUEST_ID");
            }
            requestId = body.request_id;
        }

        // Same press sent twice (double click / network retry): answer with the stored result.
        if (requestId) {
            const prior = await store.findLog(userId, requestId);
            if (prior) return replay(userId, vocabId, prior);
        }

        const doc = await store.getVocab(userId, vocabId);          // also checks the word belongs to this user
        if (!doc) throw new HttpError(404, "Vocabulary not found for this user", "NOT_FOUND");

        const now = clock();
        const card = fsrsLib.toCard(doc, now);
        if (card.state !== fsrsLib.State.New && card.due.getTime() > now.getTime()) {
            throw new HttpError(409, "This card is not due yet", "NOT_DUE");
        }

        const result = fsrsLib.applyRating(card, rating.value, now);   // library next()
        const logDoc = {
            user_id: userId, vocab_id: String(doc._id), word: doc.word,
            ...result.log,
            request_id: requestId,
            fsrs_version: fsrsLib.FSRSVersion,
            request_retention: cfg.REQUEST_RETENTION,
        };

        let saved;
        try {
            saved = await store.insertLog(logDoc);
        } catch (e) {
            if (isDup(e) && requestId) {                                // lost a race with the same request
                const prior = await store.findLog(userId, requestId);
                if (prior) return replay(userId, vocabId, prior);
            }
            throw e;
        }

        let ok;
        try {
            ok = await store.updateCard(userId, vocabId, card.reps, result.fields);
        } catch (e) {
            await store.deleteLog(saved._id).catch(() => {});
            throw e;
        }
        if (!ok) {                                                      // card changed in the meantime
            await store.deleteLog(saved._id).catch(() => {});
            throw new HttpError(409, "Card was changed by another request, reload and try again", "CONFLICT");
        }
        return responseFor(vocabId, saved, false);
    }

    // ---------------- history ----------------
    async function getHistory(userId, { limit, skip } = {}) {
        const lim = clampInt(limit, 50, 1, 200);
        const sk = clampInt(skip, 0, 0, 100000);
        const [rows, total] = await Promise.all([store.listLogs(userId, lim, sk), store.countLogs(userId)]);
        return {
            total,
            data: rows.map((r) => ({
                id: String(r._id), vocab_id: r.vocab_id, word: r.word, rating: r.rating_name,
                reviewed_at: new Date(r.review).toISOString(),
                state_before: r.state_before, state_after: r.state_after,
                due_before: r.due_before ? new Date(r.due_before).toISOString() : null,
                due_after: new Date(r.due_after).toISOString(),
                scheduled_days_before: r.scheduled_days_before, scheduled_days_after: r.scheduled_days_after,
            })),
        };
    }

    // ---------------- settings (review limits) ----------------
    async function getReviewSettings(userId) {
        const s = await store.getSettings(userId);
        return { daily_new_limit: dailyLimitOf(s), default_daily_new_limit: cfg.DEFAULT_NEW_PER_DAY, max_daily_new_limit: cfg.MAX_NEW_PER_DAY };
    }

    async function updateReviewSettings(userId, body = {}) {
        const n = body.daily_new_limit;
        if (!Number.isInteger(n) || n < 0 || n > cfg.MAX_NEW_PER_DAY) {
            throw new HttpError(400, `daily_new_limit must be an integer from 0 to ${cfg.MAX_NEW_PER_DAY}`, "INVALID_LIMIT");
        }
        await store.upsertSettings(userId, { daily_new_limit: n });
        return getReviewSettings(userId);
    }

    return { getSummary, getDueSession, rate, getHistory, getReviewSettings, updateReviewSettings };
}

module.exports = { createReviewService, HttpError };
