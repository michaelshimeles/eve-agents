"use client";

import { useEffect, useState } from "react";

// Web push opt-in for proactive notifications (fired reminders and webhooks).
// Registers the service worker, reflects the current subscription, and
// toggles subscribe/unsubscribe against /api/push.

export type PushStatus = "unsupported" | "loading" | "off" | "on" | "denied";

function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key + "=".repeat((4 - (key.length % 4)) % 4);
  const raw = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function usePushNotifications(): { status: PushStatus; toggle: () => void } {
  const [status, setStatus] = useState<PushStatus>("loading");

  useEffect(() => {
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (
      !publicKey ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setStatus("unsupported");
      return;
    }
    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (subscription) setStatus("on");
        else setStatus(Notification.permission === "denied" ? "denied" : "off");
      })
      .catch(() => setStatus("unsupported"));
  }, []);

  function toggle() {
    if (status === "on") {
      void (async () => {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await fetch("/api/push", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          }).catch(() => undefined);
          await subscription.unsubscribe();
        }
        setStatus("off");
      })();
      return;
    }
    if (status !== "off" && status !== "denied") return;
    void (async () => {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        return;
      }
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyBytes(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!),
        });
        const response = await fetch("/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscription.toJSON()),
        });
        if (!response.ok) throw new Error(`Subscribe failed (${response.status})`);
        setStatus("on");
      } catch (error) {
        console.error("Push subscription failed:", error);
        // "push service not available" means the browser can't reach its
        // push backend - the app can't fix that, so explain what can.
        const message = error instanceof Error ? error.message : String(error);
        if (/push service/i.test(message)) {
          alert(
            "Your browser couldn't reach its push service, so notifications can't be enabled.\n\n" +
              "- Brave: enable Settings > Privacy and security > \"Use Google services for push messaging\", then restart the browser.\n" +
              "- Chromium without Google services (or a network blocking FCM) can't deliver web push.\n\n" +
              "Notifications work normally in Chrome, Edge, Firefox, and Safari 16+.",
          );
        }
        setStatus("off");
      }
    })();
  }

  return { status, toggle };
}
