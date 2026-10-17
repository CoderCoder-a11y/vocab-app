const express = require("express");

const router = express.Router();

const tests = require("../controller/test.controller");

const auth = require("../middleware/auth");

const { createRateLimiter, authenticatedUserKey } = require("../utils/rate_limit_store");

// Creating a test calls Gemini, so each user gets a limited number per window.
const createLimiter = createRateLimiter({
    prefix: "create_test",
    windowMs: 10 * 60 * 1000,
    limit: 20,
    keyGenerator: authenticatedUserKey,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMIT", message: "Too many requests. Please try again later." },
});

router.get("/api/tests", auth, tests.list_tests);                 // history

router.post("/api/test", auth, createLimiter, tests.create_test); // create a test

router.post("/api/test/answers", auth, tests.submit_answers);     // submit answers -> user's vs correct answers

router.get("/api/test/:id/answers", auth, tests.get_test_answers);

router.get("/api/test/:id", auth, tests.get_test);                // get one test

module.exports = router;
