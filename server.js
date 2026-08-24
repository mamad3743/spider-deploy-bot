/**
 * Railway (Node.js) entry point — همون bot-core.js رو با یک HTTP سرور
 * و یک KV شبیه‌سازی‌شده (فایل JSON) اجرا می‌کنه، تا نیازی به Cloudflare نباشه.
 *
 * ⚠️ فایل‌سیستم Railway به‌صورت پیش‌فرض ephemeral هست — یعنی بعد از هر
 * ریستارت/ریدیپلوی، فایل داده پاک میشه. برای persistent موندن داده
 * (توکن‌ها، پروژه‌ها)، از بخش Volumes توی Railway یک Volume به مسیر
 * DATA_DIR (پیش‌فرض ./data) وصل کن.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleFetch, handleScheduled } from "./bot-core.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const DATA_FILE = path.join(DATA_DIR, "kv.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

let store = {};
try {
  store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch {
  store = {};
}

let saveTimer = null;
function persist() {
  // batch نوشتن‌های نزدیک به هم توی یک فایل، برای جلوگیری از I/O زیاد
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store));
  }, 200);
}

const BOT_KV = {
  async get(key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  },
  async put(key, value) {
    store[key] = value;
    persist();
  },
  async delete(key) {
    delete store[key];
    persist();
  },
  async list({ prefix } = {}) {
    const keys = Object.keys(store)
      .filter((k) => !prefix || k.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys };
  },
};

const env = {
  BOT_KV,
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  SOURCE_REPO: process.env.SOURCE_REPO,
  SOURCE_BRANCH: process.env.SOURCE_BRANCH,
  REQUIRED_CHANNELS: process.env.REQUIRED_CHANNELS,
};

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (nodeReq, nodeRes) => {
  try {
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = `http://${nodeReq.headers.host || "localhost"}${nodeReq.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const request = new Request(url, {
      method: nodeReq.method,
      headers,
      body: ["GET", "HEAD"].includes(nodeReq.method) ? undefined : body,
    });
    const ctx = { waitUntil: (p) => p?.catch?.((e) => console.error(e)) };
    const response = await handleFetch(request, env, ctx);
    const resHeaders = {};
    response.headers.forEach((v, k) => (resHeaders[k] = v));
    nodeRes.writeHead(response.status, resHeaders);
    nodeRes.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    nodeRes.writeHead(500);
    nodeRes.end("internal error");
  }
});

server.listen(PORT, () => console.log(`Spider Deploy Bot listening on :${PORT}`));

// جایگزین Cron Trigger کلادفلر: هر ۲۴ ساعت auto-update رو چک کن
setInterval(() => {
  handleScheduled(env).catch((e) => console.error(e));
}, 24 * 60 * 60 * 1000);
