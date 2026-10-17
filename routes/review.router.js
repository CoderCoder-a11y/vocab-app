const express = require("express");

const router = express.Router();

const review = require("../controller/review.controller");

const auth = require("../middleware/auth");

const { createRateLimiter, authenticatedUserKey } = require("../utils/rate_limit_store");

// Generous limit: one rating per card, but it stops runaway scripts.
const rateLimiter = createRateLimiter({
    prefix: "review_rate",
    windowMs: 60 * 1000,
    limit: 120,
    keyGenerator: authenticatedUserKey,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMIT", message: "Too many requests. Please try again later." },
});

router.get("/api/review/summary", auth, review.summary);

router.get("/api/review/due", auth, review.due);

router.post("/api/review/:vocabId/rate", auth, rateLimiter, review.rate);

router.get("/api/review/history", auth, review.history);

router.get("/api/review/settings", auth, review.get_settings);

router.put("/api/review/settings", auth, review.update_settings);

// ---- daily reminders (Web Push) ----
router.get("/api/reminders/settings", auth, review.reminder_settings);

router.put("/api/reminders/settings", auth, review.reminder_update);

router.post("/api/reminders/subscribe", auth, review.reminder_subscribe);

router.post("/api/reminders/unsubscribe", auth, review.reminder_unsubscribe);

module.exports = router;
