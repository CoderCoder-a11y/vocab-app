// Thin wrapper around the official `ts-fsrs` library (https://github.com/open-spaced-repetition/ts-fsrs).
// All FSRS maths comes from the library; this file only (1) builds the scheduler,
// (2) converts MongoDB documents <-> ts-fsrs cards, and (3) formats intervals in Arabic.
const { fsrs, generatorParameters, createEmptyCard, Rating, State, FSRSVersion } = require("ts-fsrs");
const { REQUEST_RETENTION } = require("./review_config");

const RATING_NAMES = ["Again", "Hard", "Good", "Easy"];
const RATING_VALUES = { Again: Rating.Again, Hard: Rating.Hard, Good: Rating.Good, Easy: Rating.Easy };

// Fuzz is OFF so the interval shown on a button is exactly the one saved when it is pressed.
// Parameters are the library defaults (not personalised): no optimiser has been run on the user's history.
let scheduler = null;
function getScheduler() {
    if (!scheduler) {
        scheduler = fsrs(generatorParameters({ request_retention: REQUEST_RETENTION, enable_fuzz: false }));
    }
    return scheduler;
}

// "Good" / "good" / "GOOD" -> Rating.Good ; anything else -> null (numbers are not accepted).
function parseRating(value) {
    if (typeof value !== "string") return null;
    const name = RATING_NAMES.find((n) => n.toLowerCase() === value.trim().toLowerCase());
    return name ? { name, value: RATING_VALUES[name] } : null;
}

// Card fields that are persisted on the vocabulary document.
const CARD_FIELDS = [
    "due", "stability", "difficulty", "elapsed_days", "scheduled_days",
    "learning_steps", "reps", "lapses", "state", "last_review",
];

// ts-fsrs card -> plain fields to store in MongoDB.
function fromCard(card) {
    return {
        due: new Date(card.due),
        stability: card.stability,
        difficulty: card.difficulty,
        elapsed_days: card.elapsed_days,
        scheduled_days: card.scheduled_days,
        learning_steps: card.learning_steps ?? 0,
        reps: card.reps,
        lapses: card.lapses,
        state: card.state,
        last_review: card.last_review ? new Date(card.last_review) : null,
    };
}

// A brand new card made by the library (state New, due now).
function emptyCardFields(now = new Date()) {
    return fromCard(createEmptyCard(now));
}

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const asDate = (v) => {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

// Vocabulary document (new or LEGACY without FSRS fields) -> ts-fsrs card.
function toCard(doc, now = new Date()) {
    const legacy = !doc || ![State.New, State.Learning, State.Review, State.Relearning].includes(doc.state);
    if (legacy) return createEmptyCard(now);

    const due = asDate(doc.due) || now;
    const last = doc.last_review ? asDate(doc.last_review) : null;
    return {
        due,
        stability: isFiniteNum(doc.stability) ? doc.stability : 0,
        difficulty: isFiniteNum(doc.difficulty) ? doc.difficulty : 0,
        elapsed_days: isFiniteNum(doc.elapsed_days) ? doc.elapsed_days : 0,
        scheduled_days: isFiniteNum(doc.scheduled_days) ? doc.scheduled_days : 0,
        learning_steps: isFiniteNum(doc.learning_steps) ? doc.learning_steps : 0,
        reps: isFiniteNum(doc.reps) ? doc.reps : 0,
        lapses: isFiniteNum(doc.lapses) ? doc.lapses : 0,
        state: doc.state,
        last_review: last || undefined,
    };
}

// ---- Arabic interval labels: "بعد 10 دقائق" / "غدًا" / "بعد 4 أيام" ----
function unit(n, one, two, few, many) {
    if (n === 1) return one;
    if (n === 2) return two;
    return n >= 3 && n <= 10 ? `${n} ${few}` : `${n} ${many}`;
}

function intervalLabel(due, now) {
    const ms = new Date(due).getTime() - new Date(now).getTime();
    const min = ms / 60000;
    if (min < 1) return "بعد أقل من دقيقة";
    if (min < 60) return "بعد " + unit(Math.round(min), "دقيقة", "دقيقتين", "دقائق", "دقيقة");
    const hours = min / 60;
    if (hours < 24) return "بعد " + unit(Math.round(hours), "ساعة", "ساعتين", "ساعات", "ساعة");
    const days = Math.round(hours / 24);
    if (days === 1) return "غدًا";
    if (days < 30) return "بعد " + (days === 2 ? "يومين" : days <= 10 ? `${days} أيام` : `${days} يومًا`);
    if (days < 365) return "بعد " + unit(Math.round(days / 30.4), "شهر", "شهرين", "أشهر", "شهرًا");
    return "بعد " + unit(Math.round(days / 365), "سنة", "سنتين", "سنوات", "سنة");
}

// What each of the four buttons would schedule (uses the library's repeat()).
function previewCard(card, now = new Date()) {
    const result = getScheduler().repeat(card, now);
    const out = {};
    for (const name of RATING_NAMES) {
        const item = result[RATING_VALUES[name]];
        out[name] = {
            due: item.card.due.toISOString(),
            scheduled_days: item.card.scheduled_days,
            state: item.card.state,
            label: intervalLabel(item.card.due, now),
        };
    }
    return out;
}

// Applies one rating with the library's next(). Returns the new card fields and a log record.
function applyRating(card, ratingValue, now = new Date()) {
    const { card: next, log } = getScheduler().next(card, now, ratingValue);
    const after = fromCard(next);
    return {
        card: next,
        fields: after,
        log: {
            rating: log.rating,
            rating_name: RATING_NAMES[log.rating - 1],
            review: new Date(log.review),
            state_before: log.state,
            state_after: next.state,
            due_before: new Date(log.due),
            due_after: after.due,
            scheduled_days_before: log.scheduled_days,
            scheduled_days_after: next.scheduled_days,
            elapsed_days: log.elapsed_days,
            last_elapsed_days: log.last_elapsed_days ?? 0,
            stability_before: log.stability,
            stability_after: next.stability,
            difficulty_before: log.difficulty,
            difficulty_after: next.difficulty,
            learning_steps_before: log.learning_steps ?? 0,
            learning_steps_after: next.learning_steps ?? 0,
            reps_before: card.reps,
            reps_after: next.reps,
            lapses_after: next.lapses,
        },
    };
}

module.exports = {
    RATING_NAMES, State, Rating, FSRSVersion, CARD_FIELDS,
    getScheduler, parseRating, fromCard, toCard, emptyCardFields,
    intervalLabel, previewCard, applyRating,
};
