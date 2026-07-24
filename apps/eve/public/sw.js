// Service worker for proactive notifications: fired reminders and webhooks
// arrive as web push events even when the app is closed.

self.addEventListener("push", (event) => {
  // Generic fallback only: real pushes carry the agent's name in the payload.
  let payload = { title: "Assistant", body: "" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    payload.body = event.data ? event.data.text() : "";
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: "eve-proactive",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => "focus" in client);
      if (existing) return existing.focus();
      return self.clients.openWindow("/");
    }),
  );
});
