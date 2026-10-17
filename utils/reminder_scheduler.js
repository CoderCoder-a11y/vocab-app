// Starts the in-process timer that sends the daily Web Push reminders.
// It needs the server process to be running: if the host sleeps, no reminder can be sent (see README).
const { createReviewService } = require("./review_service");
const { createReminderRunner, pushConfig } = require("./reminder_service");
const { createMongoStore } = require("./review_store");

const TICK_MS = 60 * 1000;

function startReminderScheduler(logger = console) {
    if ((process.env.REMINDER_SCHEDULER || "").toLowerCase() === "off") {
        logger.log("[reminders] scheduler disabled by REMINDER_SCHEDULER=off");
        return null;
    }
    const cfg = pushConfig();
    if (!cfg.configured) {
        logger.warn("[reminders] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are not set: daily reminders are disabled (reviews still work).");
        return null;
    }

    const webpush = require("web-push");
    try {
        webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
    } catch (e) {
        logger.error("[reminders] invalid VAPID settings, reminders disabled:", e.message);
        return null;
    }

    const store = createMongoStore();
    const runner = createReminderRunner({
        store,
        reviewService: createReviewService({ store }),
        send: (subscription, payload) => webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 6 * 60 * 60, urgency: "normal" }),
        logger,
    });

    const timer = setInterval(() => { runner.tick().catch((e) => logger.error("[reminders] tick failed:", e.message)); }, TICK_MS);
    timer.unref();
    logger.log("[reminders] scheduler started");
    return timer;
}

module.exports = { startReminderScheduler };
