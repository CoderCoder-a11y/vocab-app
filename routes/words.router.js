const express = require("express");

const router = express.Router();

const vocab = require("../controller/words.controller");

const auth = require("../middleware/auth");

const { createRateLimiter, authenticatedUserKey } = require("../utils/rate_limit_store");

// add_vocab calls Gemini, so each user gets a limited number per window.
const aiLimiter = createRateLimiter({
    prefix: "add_vocab",
    windowMs: 10 * 60 * 1000,
    limit: 30,
    keyGenerator: authenticatedUserKey,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMIT", message: "Too many requests. Please try again later." },
});

router.get("/api/get_vocab", auth, vocab.get_vocab);

router.post("/api/vocab_images", auth, aiLimiter, vocab.refresh_images);

router.get("/api/get_synonyms", auth, vocab.get_synonyms);

router.post("/api/add_vocab", auth, aiLimiter, vocab.add_vocab);

router.post("/api/add_synonmyms", auth, vocab.add_synonmyms);

router.delete("/api/DEL_vocab", auth, vocab.DEL_vocab);

router.delete("/api/DEL_synonym", auth, vocab.DEL_synonym);

module.exports = router;