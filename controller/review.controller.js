const { createReviewService, HttpError } = require("../utils/review_service");
const { createReminderService } = require("../utils/reminder_service");
const { createMongoStore } = require("../utils/review_store");
const { sendError, handleError } = require("../utils/helper");

// The user always comes from the auth middleware (req.user), never from the request body or query.
const store = createMongoStore();
const service = createReviewService({ store });
const reminders = createReminderService({ store });

const fail = (res, error) =>
    error instanceof HttpError ? sendError(res, error.status, error.message, error.code) : handleError(res, error);

const uid = (req) => String(req.user._id);
const ok = (res, message, data, status = 200) => res.status(status).json({ success: true, message, data });

const summary = async (req, res) => {
    try { return ok(res, "Review summary", await service.getSummary(uid(req), { tz: req.query.tz })); }
    catch (e) { return fail(res, e); }
};

const due = async (req, res) => {
    try { return ok(res, "Cards ready for review", await service.getDueSession(uid(req), { limit: req.query.limit, tz: req.query.tz })); }
    catch (e) { return fail(res, e); }
};

const rate = async (req, res) => {
    try {
        // Only `rating` and `request_id` are read: due date / stability / difficulty from the browser are ignored.
        const data = await service.rate(uid(req), req.params.vocabId, { rating: req.body?.rating, request_id: req.body?.request_id });
        return ok(res, data.replayed ? "Review was already saved" : "Review saved", data);
    } catch (e) { return fail(res, e); }
};

const history = async (req, res) => {
    try {
        const r = await service.getHistory(uid(req), { limit: req.query.limit, skip: req.query.skip });
        return res.status(200).json({ success: true, message: "Review history", total: r.total, data: r.data });
    } catch (e) { return fail(res, e); }
};

const get_settings = async (req, res) => {
    try { return ok(res, "Review settings", await service.getReviewSettings(uid(req))); }
    catch (e) { return fail(res, e); }
};

const update_settings = async (req, res) => {
    try { return ok(res, "Review settings saved", await service.updateReviewSettings(uid(req), req.body)); }
    catch (e) { return fail(res, e); }
};

// ---- reminders ----
const reminder_settings = async (req, res) => {
    try { return ok(res, "Reminder settings", await reminders.getSettings(uid(req))); }
    catch (e) { return fail(res, e); }
};
const reminder_update = async (req, res) => {
    try { return ok(res, "Reminder settings saved", await reminders.updateSettings(uid(req), req.body)); }
    catch (e) { return fail(res, e); }
};
const reminder_subscribe = async (req, res) => {
    try { return ok(res, "Subscribed", await reminders.subscribe(uid(req), req.body, req.get("user-agent")), 201); }
    catch (e) { return fail(res, e); }
};
const reminder_unsubscribe = async (req, res) => {
    try { return ok(res, "Unsubscribed", await reminders.unsubscribe(uid(req), req.body)); }
    catch (e) { return fail(res, e); }
};

module.exports = {
    summary, due, rate, history, get_settings, update_settings,
    reminder_settings, reminder_update, reminder_subscribe, reminder_unsubscribe,
};
