// Reminder settings, push subscriptions, and the daily reminder runner.
const { isValidTimeZone, isValidTime, localParts, minutesOf } = require("./timezone");
const { HttpError } = require("./review_service");

const MAX_FAILURES = 10;          // consecutive temporary failures before a subscription is dropped
const CATCHUP_MINUTES = Number(process.env.REMINDER_CATCHUP_MINUTES) > 0 ? Number(process.env.REMINDER_CATCHUP_MINUTES) : 120;

// VAPID keys come from the environment only. Missing keys just disable push, nothing else.
function pushConfig(env = process.env) {
    const publicKey = (env.VAPID_PUBLIC_KEY || "").trim();
    const privateKey = (env.VAPID_PRIVATE_KEY || "").trim();
    const subject = (env.VAPID_SUBJECT || "").trim();
    return { configured: !!(publicKey && privateKey && subject), publicKey, privateKey, subject };
}

function createReminderService({ store, config = pushConfig() }) {
    const settingsView = async (userId) => {
        const [s, subs] = await Promise.all([store.getSettings(userId), store.listSubscriptions(userId)]);
        return {
            enabled: !!(s && s.reminder_enabled),
            time: (s && s.reminder_time) || "20:00",
            timezone: (s && isValidTimeZone(s.timezone) && s.timezone) || "UTC",
            push_configured: config.configured,
            vapid_public_key: config.configured ? config.publicKey : null,   // public key only, never the private one
            subscriptions: subs.length,
        };
    };

    async function updateSettings(userId, body = {}) {
        const fields = {};
        if (body.timezone !== undefined) {
            if (!isValidTimeZone(body.timezone)) throw new HttpError(400, "Invalid time zone", "INVALID_TIMEZONE");
            fields.timezone = body.timezone;
        }
        if (body.time !== undefined) {
            if (!isValidTime(body.time)) throw new HttpError(400, "time must be HH:MM (24h)", "INVALID_TIME");
            fields.reminder_time = body.time;
        }
        if (body.enabled !== undefined) {
            if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false", "INVALID_ENABLED");
            if (body.enabled) {
                if (!config.configured) throw new HttpError(503, "Push notifications are not configured on the server", "PUSH_NOT_CONFIGURED");
                if (!(await store.listSubscriptions(userId)).length) {
                    throw new HttpError(409, "Subscribe this device to notifications first", "NO_SUBSCRIPTION");
                }
            }
            fields.reminder_enabled = body.enabled;
        }
        if (!Object.keys(fields).length) throw new HttpError(400, "Nothing to update", "FIELD_REQUIRED");
        // Changing the time or zone must let today's reminder fire again if it has not been sent yet.
        await store.upsertSettings(userId, fields);
        return settingsView(userId);
    }

    async function subscribe(userId, body = {}, userAgent = "") {
        if (!config.configured) throw new HttpError(503, "Push notifications are not configured on the server", "PUSH_NOT_CONFIGURED");
        const sub = body.subscription;
        const endpoint = sub && sub.endpoint;
        const p256dh = sub && sub.keys && sub.keys.p256dh;
        const auth = sub && sub.keys && sub.keys.auth;
        let url = null;
        try { url = typeof endpoint === "string" && endpoint.length <= 2048 ? new URL(endpoint) : null; } catch (_) { url = null; }
        if (!url || url.protocol !== "https:" || typeof p256dh !== "string" || typeof auth !== "string" || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
            throw new HttpError(400, "Invalid push subscription", "INVALID_SUBSCRIPTION");
        }
        let expiration = null;
        if (sub.expirationTime != null) {
            const d = new Date(sub.expirationTime);
            expiration = Number.isNaN(d.getTime()) ? null : d;
        }
        await store.saveSubscription(userId, {
            endpoint, keys: { p256dh, auth }, expiration_time: expiration, user_agent: String(userAgent).slice(0, 300),
        });
        if (body.timezone !== undefined && isValidTimeZone(body.timezone)) {
            await store.upsertSettings(userId, { timezone: body.timezone });
        }
        return settingsView(userId);
    }

    async function unsubscribe(userId, body = {}) {
        if (typeof body.endpoint !== "string" || !body.endpoint) throw new HttpError(400, "endpoint is required", "FIELD_REQUIRED");
        await store.deleteSubscription(userId, body.endpoint);
        // No device left -> nothing can be delivered, so the reminder is switched off too.
        if (!(await store.listSubscriptions(userId)).length) {
            const s = await store.getSettings(userId);
            if (s && s.reminder_enabled) await store.upsertSettings(userId, { reminder_enabled: false });
        }
        return settingsView(userId);
    }

    return { getSettings: settingsView, updateSettings, subscribe, unsubscribe };
}

const reminderText = (due, fresh) => {
    const parts = [];
    if (due) parts.push(`${due} كلمة محتاجة مراجعة`);
    if (fresh) parts.push(`${fresh} كلمة جديدة جاهزة`);
    return `عندك ${parts.join(" و")}. افتح قسم المراجعة وابدأ.`;
};

// Checks every enabled reminder once. Safe to run on many processes at the same time:
// the per-user per-day claim in the database lets exactly one of them send.
function createReminderRunner({ store, reviewService, send, clock = () => new Date(), logger = console, catchupMinutes = CATCHUP_MINUTES }) {
    let running = false;

    async function deliver(subs, payload) {
        let delivered = 0, transientFailures = 0;
        for (const sub of subs) {
            try {
                await send({ endpoint: sub.endpoint, keys: sub.keys }, payload);
                delivered++;
                if (sub.failures) await store.resetSubscriptionFailures(sub.endpoint);
            } catch (e) {
                if (e && (e.statusCode === 404 || e.statusCode === 410)) {
                    await store.deleteSubscriptionByEndpoint(sub.endpoint);      // expired / rejected: clean up
                } else {
                    transientFailures++;
                    const n = await store.recordSubscriptionFailure(sub.endpoint);
                    if (n >= MAX_FAILURES) await store.deleteSubscriptionByEndpoint(sub.endpoint);
                    logger.warn("[reminders] push failed:", (e && e.statusCode) || (e && e.message));
                }
            }
        }
        return { delivered, transientFailures };
    }

    async function tick() {
        if (running) return { skipped: true };
        running = true;
        const stats = { checked: 0, sent: 0 };
        try {
            const now = clock();
            const all = await store.listReminderSettings();
            for (const s of all) {
                stats.checked++;
                try {
                    if (!isValidTimeZone(s.timezone) || !isValidTime(s.reminder_time)) continue;
                    const p = localParts(now, s.timezone);
                    if (s.last_reminder_date === p.dateKey) continue;                        // already sent today
                    const late = minutesOf(p.timeKey) - minutesOf(s.reminder_time);
                    if (late < 0 || late > catchupMinutes) continue;                          // not yet / too late

                    const subs = await store.listSubscriptions(s.user_id);
                    if (!subs.length) continue;
                    if (!(await store.claimReminder(s._id, p.dateKey))) continue;            // another process won

                    const sum = await reviewService.getSummary(s.user_id, { tz: s.timezone });
                    if (!sum.due_now && !sum.new_available) continue;                         // nothing to remind about

                    const { delivered, transientFailures } = await deliver(subs, {
                        title: "مفردات – وقت المراجعة",
                        body: reminderText(sum.due_now, sum.new_available),
                        url: "/#review",
                        tag: "daily-review",
                        due: sum.due_now,
                    });
                    if (delivered) stats.sent++;
                    else if (transientFailures) await store.releaseReminder(s._id, p.dateKey); // retry on the next tick
                } catch (e) {
                    logger.error("[reminders] user failed:", e.message);
                }
            }
        } finally {
            running = false;
        }
        return stats;
    }

    return { tick };
}

module.exports = { pushConfig, createReminderService, createReminderRunner, reminderText, MAX_FAILURES };
