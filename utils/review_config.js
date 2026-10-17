// Central place for review / FSRS settings so nothing is hard-coded in controllers.
const num = (v, fallback, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

module.exports = {
    // New words introduced per (user-local) day. Each user can change it.
    DEFAULT_NEW_PER_DAY: num(process.env.REVIEW_DEFAULT_NEW_PER_DAY, 20, 0, 500),
    MAX_NEW_PER_DAY: 500,
    // Max cards returned for one review session.
    DEFAULT_SESSION_LIMIT: num(process.env.REVIEW_SESSION_LIMIT, 50, 1, 200),
    MAX_SESSION_LIMIT: 200,
    // FSRS desired retention (0.9 = aim to remember 90% of the cards when they are due).
    REQUEST_RETENTION: num(process.env.FSRS_REQUEST_RETENTION, 0.9, 0.7, 0.97),
};
