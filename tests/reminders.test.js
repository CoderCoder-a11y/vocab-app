// Reminder settings, subscriptions and the daily runner (no MongoDB, no real push service).
const test = require("node:test");
const assert = require("node:assert/strict");

const { HttpError, createReviewService } = require("../utils/review_service");
const { createReminderService, createReminderRunner, reminderText, pushConfig, MAX_FAILURES } = require("../utils/reminder_service");
const { emptyCardFields } = require("../utils/fsrs_service");
const { createMemoryStore } = require("./helpers/memory_store");

const silent = { log() {}, warn() {}, error() {} };
const CFG = { configured: true, publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" };
const SUB = { endpoint: "https://push.example.com/abc", keys: { p256dh: "p256dh-key", auth: "auth-key" } };
const fails = (p, status, code) => assert.rejects(p, (e) => e instanceof HttpError && e.status === status && e.code === code, `${status} ${code}`);

function setup(startIso = "2026-10-17T17:00:00.000Z") {      // 20:00 in Cairo (UTC+3 in October)
    const store = createMemoryStore();
    const clock = { now: new Date(startIso) };
    const reviewService = createReviewService({ store, clock: () => new Date(clock.now), logger: silent });
    const reminders = createReminderService({ store, config: CFG });
    const sent = [];
    const send = async (sub, payload) => { sent.push({ sub, payload }); };
    const runner = (over = {}) => createReminderRunner({ store, reviewService, send, clock: () => new Date(clock.now), logger: silent, ...over });
    for (let i = 0; i < 3; i++) store.addVocab({ user_id: "u1", word: `w${i}`, meaning: "m", example: "e", category: "c", ...emptyCardFields(clock.now) });
    return { store, clock, reminders, runner, sent, reviewService };
}

async function enable(reminders, extra = {}) {
    await reminders.subscribe("u1", { subscription: SUB, timezone: "Africa/Cairo" }, "UA");
    return reminders.updateSettings("u1", { enabled: true, time: "20:00", timezone: "Africa/Cairo", ...extra });
}

test("time zone and time are validated", async () => {
    const { reminders } = setup();
    await fails(reminders.updateSettings("u1", { timezone: "Mars/Olympus" }), 400, "INVALID_TIMEZONE");
    await fails(reminders.updateSettings("u1", { timezone: 5 }), 400, "INVALID_TIMEZONE");
    await fails(reminders.updateSettings("u1", { time: "25:00" }), 400, "INVALID_TIME");
    await fails(reminders.updateSettings("u1", { time: "8:00" }), 400, "INVALID_TIME");
    await fails(reminders.updateSettings("u1", { enabled: "yes" }), 400, "INVALID_ENABLED");
    await fails(reminders.updateSettings("u1", {}), 400, "FIELD_REQUIRED");
    const ok = await reminders.updateSettings("u1", { timezone: "Africa/Cairo", time: "07:45" });
    assert.equal(ok.timezone, "Africa/Cairo");
    assert.equal(ok.time, "07:45");
    assert.equal(ok.enabled, false);
});

test("a reminder cannot be switched on without a subscribed device or VAPID keys", async () => {
    const { reminders, store } = setup();
    await fails(reminders.updateSettings("u1", { enabled: true }), 409, "NO_SUBSCRIPTION");
    const noPush = createReminderService({ store, config: { configured: false } });
    await fails(noPush.updateSettings("u1", { enabled: true }), 503, "PUSH_NOT_CONFIGURED");
    await fails(noPush.subscribe("u1", { subscription: SUB }), 503, "PUSH_NOT_CONFIGURED");
    const view = await noPush.getSettings("u1");
    assert.equal(view.push_configured, false);
    assert.equal(view.vapid_public_key, null);
});

test("subscription input is validated and the private key is never returned", async () => {
    const { reminders } = setup();
    for (const subscription of [null, {}, { endpoint: "http://insecure.example/x", keys: SUB.keys }, { endpoint: "not a url", keys: SUB.keys },
        { endpoint: SUB.endpoint }, { endpoint: SUB.endpoint, keys: { p256dh: "a" } }, { endpoint: "https://x.com/" + "a".repeat(3000), keys: SUB.keys }]) {
        await fails(reminders.subscribe("u1", { subscription }), 400, "INVALID_SUBSCRIPTION");
    }
    const view = await reminders.subscribe("u1", { subscription: SUB });
    assert.equal(view.subscriptions, 1);
    assert.equal(view.vapid_public_key, "pub");
    assert.ok(!JSON.stringify(view).includes("priv"));
});

test("unsubscribing the last device turns the reminder off", async () => {
    const { reminders } = setup();
    assert.equal((await enable(reminders)).enabled, true);
    const view = await reminders.unsubscribe("u1", { endpoint: SUB.endpoint });
    assert.equal(view.subscriptions, 0);
    assert.equal(view.enabled, false);
    await fails(reminders.unsubscribe("u1", {}), 400, "FIELD_REQUIRED");
});

test("the reminder is sent at the user's local time, with the due count", async () => {
    const { reminders, runner, sent, clock, store } = setup("2026-10-17T16:30:00.000Z"); // 19:30 in Cairo
    await enable(reminders);
    const r = runner();
    await r.tick();
    assert.equal(sent.length, 0, "too early");

    clock.now = new Date("2026-10-17T17:00:00.000Z");                                      // 20:00 in Cairo
    await r.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.url, "/#review");
    assert.match(sent[0].payload.body, /3 كلمة محتاجة مراجعة|3 كلمة جديدة جاهزة/);
    assert.equal(sent[0].sub.endpoint, SUB.endpoint);
    assert.equal(store.db.settings[0].last_reminder_date, "2026-10-17");
});

test("the same day's reminder is never sent twice, even with several processes", async () => {
    const { reminders, runner, sent, clock } = setup();
    await enable(reminders);
    const processes = [runner(), runner(), runner()];                                       // like 3 PM2 workers
    await Promise.all(processes.map((p) => p.tick()));
    await Promise.all(processes.map((p) => p.tick()));
    assert.equal(sent.length, 1);

    clock.now = new Date("2026-10-17T18:30:00.000Z");                                       // later the same day
    await Promise.all(processes.map((p) => p.tick()));
    assert.equal(sent.length, 1);

    clock.now = new Date("2026-10-18T17:00:00.000Z");                                       // next day
    await Promise.all(processes.map((p) => p.tick()));
    assert.equal(sent.length, 2);
});

test("a reminder that is far past its time is skipped instead of arriving at night", async () => {
    const { reminders, runner, sent, clock } = setup("2026-10-17T22:30:00.000Z");           // 01:30 local, 5.5h late
    await enable(reminders);
    await runner().tick();
    assert.equal(sent.length, 0);
    clock.now = new Date("2026-10-17T18:10:00.000Z");                                       // 21:10, inside the 2h window
    await runner().tick();
    assert.equal(sent.length, 1);
});

test("different time zones fire at their own local time", async () => {
    const { reminders, runner, sent, clock, store } = setup("2026-10-17T12:00:00.000Z");
    store.addVocab({ user_id: "u2", word: "x", meaning: "m", example: "e", category: "c", ...emptyCardFields(clock.now) });
    await enable(reminders);                                                                // Cairo 20:00 (=17:00Z)
    await reminders.subscribe("u2", { subscription: { ...SUB, endpoint: "https://push.example.com/u2" } });
    await reminders.updateSettings("u2", { enabled: true, time: "08:00", timezone: "America/New_York" }); // 12:00Z = 08:00 EDT
    await runner().tick();
    assert.deepEqual(sent.map((s) => s.sub.endpoint), ["https://push.example.com/u2"]);
});

test("nothing to review means no notification", async () => {
    const { reminders, runner, sent, store } = setup();
    store.db.vocab = [];
    await enable(reminders);
    await runner().tick();
    assert.equal(sent.length, 0);
});

test("a disabled reminder sends nothing", async () => {
    const { reminders, runner, sent } = setup();
    await enable(reminders);
    await reminders.updateSettings("u1", { enabled: false });
    await runner().tick();
    assert.equal(sent.length, 0);
});

test("expired subscriptions (404/410) are removed", async () => {
    const { reminders, store, runner } = setup();
    await enable(reminders);
    const gone = createReminderRunner({
        store, reviewService: createReviewService({ store, clock: () => new Date("2026-10-17T17:00:00.000Z"), logger: silent }),
        send: async () => { const e = new Error("gone"); e.statusCode = 410; throw e; },
        clock: () => new Date("2026-10-17T17:00:00.000Z"), logger: silent,
    });
    await gone.tick();
    assert.equal(store.db.subs.length, 0);
    assert.ok(runner);
});

test("temporary failures are retried on the next check and bad subscriptions are dropped after many", async () => {
    const { reminders, store, clock } = setup();
    await enable(reminders);
    let calls = 0;
    const flaky = createReminderRunner({
        store, reviewService: createReviewService({ store, clock: () => new Date(clock.now), logger: silent }),
        send: async () => { calls++; const e = new Error("timeout"); e.statusCode = 503; throw e; },
        clock: () => new Date(clock.now), logger: silent,
    });
    await flaky.tick();
    await flaky.tick();                                  // claim was released, so it tries again
    assert.equal(calls, 2);
    assert.equal(store.db.subs[0].failures, 2);
    for (let i = 0; i < MAX_FAILURES; i++) await flaky.tick();
    assert.equal(store.db.subs.length, 0);
});

test("missing VAPID keys only disable push", () => {
    assert.equal(pushConfig({}).configured, false);
    assert.equal(pushConfig({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" }).configured, false);
    assert.equal(pushConfig({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "mailto:x@y.z" }).configured, true);
    assert.match(reminderText(5, 0), /5 كلمة محتاجة مراجعة/);
});
