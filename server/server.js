const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const webpush = require("web-push");

const PORT = Number(process.env.PORT || 8791);
const DATA_DIR = process.env.DATA_DIR || "/var/lib/iqos-push";
const VAPID_FILE = path.join(DATA_DIR, "vapid.json");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "subscriptions.json");
const REMINDERS_FILE = path.join(DATA_DIR, "reminders.json");
const MAX_BODY_BYTES = 1024 * 64;
const MAX_DELAY_MS = 1000 * 60 * 60 * 24 * 14;

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function getVapidKeys() {
  const existing = readJson(VAPID_FILE, null);
  if (existing?.publicKey && existing?.privateKey) return existing;
  const keys = webpush.generateVAPIDKeys();
  writeJson(VAPID_FILE, keys);
  return keys;
}

const vapid = getVapidKeys();
webpush.setVapidDetails("mailto:admin@grabovsky.ru", vapid.publicKey, vapid.privateKey);

let subscriptions = readJson(SUBSCRIPTIONS_FILE, {});
let reminders = readJson(REMINDERS_FILE, []);

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function validSubscription(subscription) {
  return subscription
    && typeof subscription.endpoint === "string"
    && subscription.keys
    && typeof subscription.keys.p256dh === "string"
    && typeof subscription.keys.auth === "string";
}

function persist() {
  writeJson(SUBSCRIPTIONS_FILE, subscriptions);
  writeJson(REMINDERS_FILE, reminders);
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  if (req.method === "GET" && req.url === "/vapid-public-key") {
    return sendJson(res, 200, { publicKey: vapid.publicKey });
  }

  if (req.method === "POST" && req.url === "/subscribe") {
    const body = await readBody(req);
    if (!validSubscription(body.subscription)) return sendJson(res, 400, { error: "bad subscription" });
    subscriptions[body.subscription.endpoint] = body.subscription;
    persist();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/schedule") {
    const body = await readBody(req);
    if (!validSubscription(body.subscription)) return sendJson(res, 400, { error: "bad subscription" });

    const unlockAt = Number(body.unlockAt);
    const delay = unlockAt - Date.now();
    if (!Number.isFinite(unlockAt) || delay <= 0 || delay > MAX_DELAY_MS) {
      return sendJson(res, 400, { error: "bad unlockAt" });
    }

    const endpoint = body.subscription.endpoint;
    subscriptions[endpoint] = body.subscription;
    reminders = reminders.filter((item) => item.endpoint !== endpoint);
    reminders.push({
      id: crypto.randomUUID(),
      endpoint,
      intervalMinutes: Number(body.intervalMinutes) || null,
      unlockAt,
      createdAt: Date.now()
    });
    persist();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/test") {
    const body = await readBody(req);
    if (!validSubscription(body.subscription)) return sendJson(res, 400, { error: "bad subscription" });

    const subscription = body.subscription;
    subscriptions[subscription.endpoint] = subscription;
    persist();

    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        body: "Проверка уведомлений работает.",
        title: "Stick Control",
        url: "/iqos/"
      }));
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) delete subscriptions[subscription.endpoint];
      persist();
      console.error("test push failed", error.statusCode || error.message);
      return sendJson(res, 502, { error: "push failed" });
    }
  }

  return sendJson(res, 404, { error: "not found" });
}

async function sendDueReminders() {
  const due = reminders.filter((item) => item.unlockAt <= Date.now());
  if (!due.length) return;

  reminders = reminders.filter((item) => item.unlockAt > Date.now());
  for (const reminder of due) {
    const subscription = subscriptions[reminder.endpoint];
    if (!subscription) continue;
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        body: "Прошел выбранный интервал.",
        title: "Можно следующий стик",
        url: "/iqos/"
      }));
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) delete subscriptions[reminder.endpoint];
      console.error("push failed", error.statusCode || error.message);
    }
  }
  persist();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    sendJson(res, 500, { error: "server error" });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`iqos-push listening on ${PORT}`);
});

setInterval(sendDueReminders, 15000);
