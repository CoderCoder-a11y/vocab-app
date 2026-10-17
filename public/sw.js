/* مفردات – Service Worker: بيستقبل إشعارات التذكير اليومي حتى لو الموقع مقفول.
   مفيش كاش هنا عن قصد، عشان الملفات تتحدّث دايمًا. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "مفردات – وقت المراجعة";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "عندك كلمات محتاجة مراجعة. افتح قسم المراجعة وابدأ.",
      tag: data.tag || "daily-review",
      lang: "ar",
      dir: "rtl",
      data: { url: data.url || "/#review" },
    }),
  );
});

// Clicking the notification opens the app on the review tab (reusing an open tab when there is one).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/#review";
  let target = new URL("/#review", self.location.origin).href;
  try {
    const u = new URL(raw, self.location.origin);
    if (u.origin === self.location.origin) target = u.href;
  } catch (_) { /* keep default */ }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.postMessage({ type: "open-review" });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
