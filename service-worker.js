const APP_URL = "/iqos/";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Можно следующий стик", {
      body: data.body || "Прошел выбранный интервал.",
      badge: "apple-touch-icon.png",
      icon: "icon-512.png",
      tag: "stick-control-ready",
      data: { url: data.url || APP_URL }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || APP_URL, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    for (const client of windows) {
      if (client.url.startsWith(targetUrl) && "focus" in client) return client.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
