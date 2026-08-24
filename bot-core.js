/**
 * Spider Deploy Bot — Core Logic (platform-agnostic)
 * ---------------------------------------------------------
 * این فایل کل منطق ربات رو داره و روی هر دو پلتفرم اجرا میشه:
 *   - Cloudflare Workers → از طریق worker.js (لایه‌ی نازک fetch/scheduled)
 *   - Railway (Node.js)  → از طریق server.js (سرور HTTP + فایل KV)
 *
 * برای همین به هیچ API مخصوصِ فقط-Cloudflare وابسته نیست؛ همه‌چی از طریق
 * پارامتر `env` تزریق میشه:
 *   env.BOT_KV            شیء با get/put/delete/list — هرکدوم از دو لایه
 *                          پیاده‌سازی خودشون رو میدن (KV واقعی یا فایل JSON)
 *   env.BOT_TOKEN          توکن ربات تلگرام
 *   env.ADMIN_CHAT_ID      chat id مالک ربات (فقط برای Clone Bot)
 *   env.WEBHOOK_SECRET     رشته‌ی تایید وبهوک
 *   env.SOURCE_REPO/.BRANCH/.FILE   برای قابلیت Clone
 *   env.REQUIRED_CHANNELS  کانال/گروه‌های عضویت اجباری (اختیاری)
 *
 * قابلیت‌ها:
 *   - چندکاربره: هرکس با توکن Railway/Cloudflare خودش دیپلوی می‌کنه
 *   - کاتالوگ پنل (PANELS) — قابل گسترش
 *   - عضویت اجباری قبل از استفاده (REQUIRED_CHANNELS)
 *   - Update Now دستی + Auto-Update (روزانه، از طریق cron/scheduled)
 *   - 🧬 Clone Bot (فقط مالک): روی Cloudflare Worker یا روی Railway
 */

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const CF_API = "https://api.cloudflare.com/client/v4";

// ---------------------------------------------------------------------------
// 📦 کاتالوگ پنل‌ها — برای اضافه‌کردن پنل جدید فقط یه آیتم به این آرایه اضافه کن
// ---------------------------------------------------------------------------
const PANELS = [
  {
    id: "spider",
    name: "🕷️ Spider Panel",
    repo: "amirh00sain/SpiderPanel",
    buildVars(port) {
      return {
        PORT: String(port),
        ADMIN_PASSWORD: randomToken(6),
        SECRET_KEY: randomToken(20),
      };
    },
  },
  {
    id: "3xui",
    name: "🌐 3x-ui",
    repo: "x4gpanell/3x-ui",
    // این ریپو یه nginx جلوی 3x-ui داره که پنل + VLESS رو از یک پورت واحد
    // (همون $PORT خودکار Railway) رد می‌کنه؛ پورت داخلی ثابت 8080 هست.
    promptPort: false,
    buildVars() {
      return {};
    },
    note:
      "🔑 ورود اول: <code>/managepanel/</code> با یوزر/پس پیش‌فرض <code>admin/admin</code> — حتماً بلافاصله عوضش کن.\n" +
      "⚙️ موقع ساخت Inbound توی پنل: Protocol=VLESS, Listen Port=<code>8080</code> (ثابت), Network=ws, Security=none.",
  },
  // 👉 پنل بعدی رو اینجا اضافه کن
];

function findPanel(id) {
  return PANELS.find((p) => p.id === id);
}

// state مراحلِ فرم با تگ base64 قابل‌دیدن حمل میشه (نه zero-width — تلگرام
// کاراکترهای نامرئی رو به‌عنوان ضدِ اسپم حذف می‌کنه)
const STATE_TAG_RE = /\{REF:([A-Za-z0-9+/]+)\}/;

function encodeState(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, "");
}

function decodeState(text) {
  if (!text) return null;
  const m = text.match(STATE_TAG_RE);
  if (!m) return null;
  try {
    let b64 = m[1];
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
function tg(env, method) {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
}

async function tgCall(env, method, payload) {
  const res = await fetch(tg(env, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendMessage(env, chatId, text, keyboard) {
  return tgCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

async function sendPrompt(env, chatId, visibleText, step, data) {
  const ref = encodeState({ step, data: data || {} });
  return tgCall(env, "sendMessage", {
    chat_id: chatId,
    text: visibleText + "\n\n<i>برای لغو /cancel رو بفرست.</i>\n" + `<code>{REF:${ref}}</code>`,
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true },
  });
}

async function editMessage(env, chatId, messageId, text, keyboard) {
  const r = await tgCall(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
  if (!r.ok) return sendMessage(env, chatId, text, keyboard);
  return r;
}

async function answerCallback(env, callbackId, text) {
  return tgCall(env, "answerCallbackQuery", { callback_query_id: callbackId, text: text || undefined });
}

async function registerWebhook(env, origin) {
  return tgCall(env, "setWebhook", {
    url: origin + "/",
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
}

// ---------------------------------------------------------------------------
// 🔒 عضویت اجباری
// ---------------------------------------------------------------------------
// env.REQUIRED_CHANNELS = "@channel1,@channel2" (یوزرنیم‌های عمومی، جدا با کاما)
function requiredChannels(env) {
  return (env.REQUIRED_CHANNELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getMissingChannels(env, userId) {
  const channels = requiredChannels(env);
  if (!channels.length) return [];
  const missing = [];
  for (const ch of channels) {
    try {
      const r = await tgCall(env, "getChatMember", { chat_id: ch, user_id: userId });
      const status = r.result?.status;
      if (!r.ok || status === "left" || status === "kicked") missing.push(ch);
    } catch {
      missing.push(ch);
    }
  }
  return missing;
}

function membershipGateText() {
  return "🔒 <b>عضویت اجباری</b>\n\nبرای استفاده از بات، اول باید توی کانال/گروه(های) زیر عضو بشی، بعد رو «✅ عضو شدم» بزن:";
}
function membershipGateKeyboard(missing) {
  const kb = missing.map((ch) => [{ text: `➕ عضویت در ${ch}`, url: `https://t.me/${ch.replace(/^@/, "")}` }]);
  kb.push([{ text: "✅ عضو شدم، چک کن", callback_data: "check_membership" }]);
  return kb;
}

// ---------------------------------------------------------------------------
// KV helpers — فقط برای داده‌ی دائمی (cfg / proj)
// ---------------------------------------------------------------------------
const kvJson = async (env, key) => {
  const v = await env.BOT_KV.get(key);
  return v ? JSON.parse(v) : null;
};
const kvSet = (env, key, val) => env.BOT_KV.put(key, JSON.stringify(val));
const kvDel = (env, key) => env.BOT_KV.delete(key);

const cfgKey = (chatId) => `cfg:${chatId}`;
const projKey = (chatId, id) => `proj:${chatId}:${id}`;
const userKey = (chatId) => `user:${chatId}`;

async function getConfig(env, chatId) {
  return (await kvJson(env, cfgKey(chatId))) || {};
}
async function setConfig(env, chatId, patch) {
  const cur = await getConfig(env, chatId);
  const next = { ...cur, ...patch };
  await kvSet(env, cfgKey(chatId), next);
  return next;
}

async function listProjects(env, chatId) {
  const { keys } = await env.BOT_KV.list({ prefix: `proj:${chatId}:` });
  const out = [];
  for (const k of keys) {
    const p = await kvJson(env, k.name);
    if (p) out.push(p);
  }
  return out;
}

// یک بار در روز به‌ازای هر کاربر یک نوشتن — برای آمار مالک (📊 Stats)
async function trackUser(env, chatId) {
  const key = userKey(chatId);
  const existing = await env.BOT_KV.get(key);
  if (!existing) await kvSet(env, key, { firstSeen: Date.now() });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function isOwner(chatId, env) {
  return String(chatId) === String(env.ADMIN_CHAT_ID);
}

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message) return handleMessage(update.message, env);
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  const text = (msg.text || "").trim();

  const missing = await getMissingChannels(env, userId);
  if (missing.length) {
    return sendMessage(env, chatId, membershipGateText(), membershipGateKeyboard(missing));
  }

  if (text === "/start") {
    await trackUser(env, chatId);
    return sendMessage(env, chatId, mainMenuText(), mainMenuKeyboard(chatId, env));
  }
  if (text === "/cancel") {
    return sendMessage(env, chatId, "لغو شد.", mainMenuKeyboard(chatId, env));
  }

  const state = decodeState(msg.reply_to_message?.text);
  if (state) {
    const ownerOnlyStep = state.step.startsWith("clone_") || state.step === "broadcast_await_text";
    if (ownerOnlyStep && !isOwner(chatId, env)) {
      return sendMessage(env, chatId, "🚫 این قابلیت فقط برای مالک رباته.");
    }
    return handleStepInput(chatId, text, state.step, state.data || {}, env);
  }

  return sendMessage(env, chatId, "برای شروع /start رو بفرست.");
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const userId = cb.from?.id || chatId;
  const data = cb.data;

  if (data === "check_membership") {
    const missing = await getMissingChannels(env, userId);
    if (missing.length) {
      await answerCallback(env, cb.id, "هنوز عضو نشدی!");
      return editMessage(env, chatId, messageId, membershipGateText(), membershipGateKeyboard(missing));
    }
    await answerCallback(env, cb.id, "✅ خوش اومدی!");
    return editMessage(env, chatId, messageId, mainMenuText(), mainMenuKeyboard(chatId, env));
  }

  const missing = await getMissingChannels(env, userId);
  if (missing.length) {
    await answerCallback(env, cb.id);
    return editMessage(env, chatId, messageId, membershipGateText(), membershipGateKeyboard(missing));
  }

  await answerCallback(env, cb.id);

  if (
    (data === "advanced:clone" ||
      data.startsWith("clone:") ||
      data === "advanced:stats" ||
      data === "advanced:broadcast") &&
    !isOwner(chatId, env)
  ) {
    return editMessage(env, chatId, messageId, "🚫 این قابلیت فقط برای مالک رباته.", backKeyboard());
  }

  try {
    if (data === "menu:main") return editMessage(env, chatId, messageId, mainMenuText(), mainMenuKeyboard(chatId, env));
    if (data === "menu:new_deploy") return startNewDeploy(chatId, messageId, env);
    if (data === "menu:projects") return showProjects(chatId, messageId, env);
    if (data === "menu:advanced") return editMessage(env, chatId, messageId, advancedText(), advancedKeyboard(chatId, env));
    if (data === "menu:space") return showSpace(chatId, messageId, env);
    if (data === "menu:account") return showAccount(chatId, messageId, env);

    if (data === "account:connect_railway") return askRailwayToken(chatId, env);
    if (data === "account:connect_cf") return askCfCreds(chatId, env);
    if (data === "account:delete_railway") return showDeleteRailwayInfo(chatId, messageId, env);

    if (data.startsWith("proj:")) return showProjectDetail(chatId, messageId, data.split(":")[1], env);
    if (data.startsWith("tcp:create:")) return askTcpPort(chatId, data.split(":")[2], false, env);
    if (data.startsWith("tcp:change:")) return askTcpPort(chatId, data.split(":")[2], true, env);
    if (data.startsWith("deploy:panel:")) return askDeployPort(chatId, messageId, data.split(":")[2], env);
    if (data.startsWith("update:now:")) return updateProjectNow(chatId, messageId, data.split(":")[2], env);
    if (data.startsWith("update:toggle:")) return toggleAutoUpdate(chatId, messageId, data.split(":")[2], env);
    if (data.startsWith("restart:")) return restartProject(chatId, messageId, data.split(":")[1], env);
    if (data.startsWith("delete:ask:")) return askDeleteProject(chatId, messageId, data.split(":")[2], env);
    if (data.startsWith("delete:confirm:")) return deleteProject(chatId, messageId, data.split(":")[2], env);
    if (data.startsWith("qr:")) return sendProjectQr(chatId, data.split(":")[1], env);
    if (data.startsWith("domain:custom:")) return askCustomDomain(chatId, data.split(":")[2], env);

    if (data === "advanced:clone") return startClone(chatId, env);
    if (data === "clone:platform:cf") return startCloneCf(chatId, env);
    if (data === "clone:platform:railway") return startCloneRailway(chatId, env);
    if (data === "advanced:stats") return showStats(chatId, messageId, env);
    if (data === "advanced:broadcast") return startBroadcast(chatId, env);

    return editMessage(env, chatId, messageId, mainMenuText(), mainMenuKeyboard(chatId, env));
  } catch (err) {
    console.error(err);
    return editMessage(env, chatId, messageId, `❌ خطا: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
function mainMenuText() {
  return "🕷️ <b>SPIDER PANEL</b>\n\nمنوی اصلی:";
}
function mainMenuKeyboard() {
  return [
    [{ text: "🆕 New Deployment", callback_data: "menu:new_deploy" }],
    [{ text: "📁 My Projects", callback_data: "menu:projects" }],
    [{ text: "⚙️ Advanced", callback_data: "menu:advanced" }],
    [{ text: "📦 Space", callback_data: "menu:space" }],
    [{ text: "👤 Account", callback_data: "menu:account" }],
  ];
}
function backKeyboard() {
  return [[{ text: "⬅️ Back", callback_data: "menu:main" }]];
}
function advancedText() {
  return "⚙️ <b>Advanced</b>";
}
function advancedKeyboard(chatId, env) {
  const kb = [];
  if (isOwner(chatId, env)) {
    kb.push([{ text: "🧬 Clone Bot (تکثیر ربات)", callback_data: "advanced:clone" }]);
    kb.push([{ text: "📊 Stats", callback_data: "advanced:stats" }]);
    kb.push([{ text: "📣 Broadcast", callback_data: "advanced:broadcast" }]);
  }
  kb.push([{ text: "⬅️ Back", callback_data: "menu:main" }]);
  return kb;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
async function showAccount(chatId, messageId, env) {
  const cfg = await getConfig(env, chatId);
  const projects = await listProjects(env, chatId);
  const text =
    `👤 <b>Account</b>\n\n` +
    `🚂 Railway: ${cfg.railway_token ? "connected ✅" : "not connected"}\n` +
    `☁️ Cloudflare: ${cfg.cf_token ? "connected ✅" : "not connected"}\n` +
    `📁 Projects: ${projects.length}`;
  const kb = [
    [{ text: cfg.railway_token ? "🔁 Reconnect Railway" : "🚂 Connect Railway", callback_data: "account:connect_railway" }],
    [{ text: cfg.cf_token ? "🔁 Reconnect Cloudflare" : "☁️ Connect Cloudflare", callback_data: "account:connect_cf" }],
    [{ text: "🗑 Delete Railway Account", callback_data: "account:delete_railway" }],
    [{ text: "⬅️ Back", callback_data: "menu:main" }],
  ];
  return editMessage(env, chatId, messageId, text, kb);
}

async function askRailwayToken(chatId, env) {
  return sendPrompt(env, chatId, "🚂 توکن Railway رو بفرست.\n\nRailway Dashboard → Account Settings → Tokens", "await_railway_token");
}
async function askCfCreds(chatId, env) {
  return sendPrompt(env, chatId, "☁️ Cloudflare API Token رو بفرست.\n\n(دسترسی Workers Scripts:Edit + Workers KV Storage:Edit)", "await_cf_token");
}
async function showDeleteRailwayInfo(chatId, messageId, env) {
  const text =
    "🗑 <b>Delete Railway Account</b>\n\n" +
    "این دکمه فقط صفحه‌ی حذف اکانت Railway رو نشون میده، خودِ ربات چیزی حذف نمی‌کنه:\n" +
    "برو railway.app/account → پایین صفحه → Danger Zone → Delete Account.";
  return editMessage(env, chatId, messageId, text, backKeyboard());
}

// ---------------------------------------------------------------------------
// Step input handling — از reply chain میاد، نه KV
// ---------------------------------------------------------------------------
async function handleStepInput(chatId, text, step, data, env) {
  if (step === "await_railway_token") {
    await setConfig(env, chatId, { railway_token: text });
    return sendMessage(env, chatId, "✅ توکن Railway ذخیره شد.", backKeyboard());
  }
  if (step === "await_cf_token") {
    return sendPrompt(env, chatId, "حالا Cloudflare Account ID رو بفرست:", "await_cf_account_id", { cf_token: text });
  }
  if (step === "await_cf_account_id") {
    await setConfig(env, chatId, { cf_token: data.cf_token, cf_account_id: text });
    return sendMessage(env, chatId, "✅ Cloudflare وصل شد.", backKeyboard());
  }

  if (step === "new_deploy_await_port") {
    const port = parseInt(text, 10);
    if (!port || port < 1 || port > 65535) {
      return sendPrompt(env, chatId, "پورت نامعتبره، یک عدد بین 1 تا 65535 بفرست:", "new_deploy_await_port", data);
    }
    return runNewDeploy(chatId, port, data.panelId, env);
  }

  if (step === "tcp_await_port") {
    const port = parseInt(text, 10);
    if (!port || port < 1 || port > 65535) {
      return sendPrompt(env, chatId, "پورت نامعتبره، یک عدد بین 1 تا 65535 بفرست:", "tcp_await_port", data);
    }
    return runTcpProxy(chatId, data.projectId, port, data.isChange, env);
  }

  if (step === "domain_await_custom") {
    const domain = text.trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      return sendPrompt(env, chatId, "دامنه معتبر به نظر نمیاد، یه‌بار دیگه بفرست (مثلاً panel.example.com):", "domain_await_custom", data);
    }
    return runCustomDomain(chatId, data.projectId, domain, env);
  }

  if (step === "broadcast_await_text") {
    return runBroadcast(chatId, text, env);
  }

  if (step.startsWith("clone_cf_")) return handleCloneCfInput(chatId, text, step, data, env);
  if (step.startsWith("clone_rw_")) return handleCloneRailwayInput(chatId, text, step, data, env);

  return sendMessage(env, chatId, "متوجه نشدم، /start رو بزن.");
}

// ---------------------------------------------------------------------------
// Railway GraphQL helper
// ---------------------------------------------------------------------------
async function railway(token, query, variables) {
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

function randomToken(len = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// New Deployment flow
// ---------------------------------------------------------------------------
async function startNewDeploy(chatId, messageId, env) {
  const cfg = await getConfig(env, chatId);
  if (!cfg.railway_token) {
    return editMessage(env, chatId, messageId, "❗️ اول باید Railway رو وصل کنی: Account → Connect Railway", backKeyboard());
  }
  const kb = PANELS.map((p) => [{ text: p.name, callback_data: `deploy:panel:${p.id}` }]);
  kb.push([{ text: "⬅️ Back", callback_data: "menu:main" }]);
  return editMessage(env, chatId, messageId, "🆕 <b>New Deployment</b>\n\nکدوم پنل رو می‌خوای دیپلوی کنی؟", kb);
}

async function askDeployPort(chatId, messageId, panelId, env) {
  const panel = findPanel(panelId);
  if (!panel) return editMessage(env, chatId, messageId, "پنل پیدا نشد.", backKeyboard());

  if (panel.promptPort === false) {
    await editMessage(env, chatId, messageId, `🖥️ <b>${panel.name}</b>\n\nدر حال دیپلوی، پورت این پنل خودکاره...`, null);
    return runNewDeploy(chatId, null, panelId, env);
  }

  await editMessage(env, chatId, messageId, `🖥️ <b>${panel.name}</b>\n\nدر حال آماده‌سازی...`, null);
  return sendPrompt(
    env,
    chatId,
    `🖥️ <b>Create Service — ${panel.name}</b>\n\nاول سرویس رو می‌سازیم و دامنه‌ش رو می‌گیریم. اگه بعداً برای Reality/VLESS به TCP Proxy نیاز داشتی، از داخل پروژه جداگونه می‌تونی بسازیش.\n\nپورت داخلی سرویس رو بفرست (مثلاً 8080):`,
    "new_deploy_await_port",
    { panelId }
  );
}

async function runNewDeploy(chatId, port, panelId, env) {
  const panel = findPanel(panelId);
  if (!panel) return sendMessage(env, chatId, "پنل پیدا نشد، دوباره از منو امتحان کن.", backKeyboard());
  const cfg = await getConfig(env, chatId);
  const progress = await sendMessage(env, chatId, "🚀 در حال دیپلوی...\n▱▱▱▱▱▱▱▱▱▱ 0%");
  const messageId = progress.result.message_id;

  try {
    const projData = await railway(
      cfg.railway_token,
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name environments { edges { node { id name } } } } }`,
      { input: { name: panel.id + "-" + randomToken(3) } }
    );
    const project = projData.projectCreate;
    const environmentId = project.environments.edges[0].node.id;
    await editMessage(env, chatId, messageId, "🚀 در حال دیپلوی...\n▰▰▱▱▱▱▱▱▱▱ 20% (پروژه ساخته شد)");

    const variables = panel.buildVars(port);
    const svcData = await railway(
      cfg.railway_token,
      `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
      { input: { projectId: project.id, name: panel.id, source: { repo: panel.repo }, variables } }
    );
    const service = svcData.serviceCreate;
    await editMessage(env, chatId, messageId, "🚀 در حال دیپلوی...\n▰▰▰▰▱▱▱▱▱▱ 40% (سرویس از GitHub ساخته شد)");

    await railway(
      cfg.railway_token,
      `mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
      { serviceId: service.id, environmentId }
    );
    await editMessage(env, chatId, messageId, "🚀 در حال دیپلوی...\n▰▰▰▰▰▰▱▱▱▱ 60% (دیپلوی شروع شد)");

    const domData = await railway(
      cfg.railway_token,
      `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { environmentId, serviceId: service.id } }
    );
    const domain = domData.serviceDomainCreate.domain;
    await editMessage(env, chatId, messageId, "🚀 در حال دیپلوی...\n▰▰▰▰▰▰▰▰▰▰ 100% ✅");

    const proj = {
      id: project.id,
      name: project.name,
      panelId: panel.id,
      panelName: panel.name,
      serviceId: service.id,
      environmentId,
      domain,
      adminPassword: variables.ADMIN_PASSWORD || null,
      port,
      createdAt: Date.now(),
      autoUpdate: false,
      tcpProxies: [],
    };
    await kvSet(env, projKey(chatId, project.id), proj);

    const text =
      `📦 <b>${panel.name} Deployment</b>\n` +
      `Deployment completed ✅\n\n` +
      `🌐 Domain: <code>${domain}</code>\n` +
      (proj.adminPassword ? `🔑 Admin Password: <code>${proj.adminPassword}</code>\n` : "") +
      (port ? `🎯 Internal Port: <code>${port}</code>\n` : "") +
      (panel.note ? `\n${panel.note}\n` : "") +
      `\nهمین الان وارد بشو و تنظیمات اولیه رو انجام بده.`;
    const kb = [
      [{ text: "📱 QR ورود به پنل", callback_data: `qr:${project.id}` }],
      [{ text: "🔗 TCP Proxy بساز", callback_data: `tcp:create:${project.id}` }],
      [{ text: "📁 My Projects", callback_data: "menu:projects" }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ];
    return editMessage(env, chatId, messageId, text, kb);
  } catch (err) {
    return editMessage(env, chatId, messageId, `❌ دیپلوی fail شد: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

// ---------------------------------------------------------------------------
// Projects list / detail
// ---------------------------------------------------------------------------
async function showProjects(chatId, messageId, env) {
  const projects = await listProjects(env, chatId);
  if (!projects.length) return editMessage(env, chatId, messageId, "📁 هنوز پروژه‌ای نساختی.", backKeyboard());
  const kb = projects.map((p) => [{ text: `📦 ${p.name}`, callback_data: `proj:${p.id}` }]);
  kb.push([{ text: "⬅️ Back", callback_data: "menu:main" }]);
  return editMessage(env, chatId, messageId, "📁 <b>My Projects</b>", kb);
}

async function showProjectDetail(chatId, messageId, projectId, env) {
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return editMessage(env, chatId, messageId, "پروژه پیدا نشد.", backKeyboard());
  const panel = findPanel(p.panelId);
  const proxies = (p.tcpProxies || []).map((t) => `  • ${t.domain}:${t.proxyPort} → :${t.applicationPort}`).join("\n") || "  (هیچ)";
  const text =
    `📦 <b>${p.name}</b> (${p.panelName || p.panelId || "?"})\n\n` +
    `🌐 Domain: <code>${p.domain}</code>\n` +
    (p.adminPassword ? `🔑 Admin Password: <code>${p.adminPassword}</code>\n\n` : "\n") +
    (panel?.note ? `${panel.note}\n\n` : "") +
    `🔌 TCP Proxies:\n${proxies}` +
    (p.lastUpdatedAt ? `\n\n🔄 آخرین بروزرسانی: ${new Date(p.lastUpdatedAt).toLocaleString("fa-IR")}` : "");
  const kb = [
    [{ text: "➕ Create TCP Proxy", callback_data: `tcp:create:${p.id}` }],
    [{ text: "🔁 Change TCP Proxy", callback_data: `tcp:change:${p.id}` }],
    [{ text: "🔄 Update Now", callback_data: `update:now:${p.id}` }],
    [{ text: p.autoUpdate ? "🟢 Auto-Update: روشن" : "⚪️ Auto-Update: خاموش", callback_data: `update:toggle:${p.id}` }],
    [{ text: "♻️ Restart", callback_data: `restart:${p.id}` }],
    [{ text: "📱 QR ورود به پنل", callback_data: `qr:${p.id}` }],
    [{ text: "🌐 دامنه‌ی اختصاصی", callback_data: `domain:custom:${p.id}` }],
    [{ text: "🗑 Delete Project", callback_data: `delete:ask:${p.id}` }],
    [{ text: "📁 My Projects", callback_data: "menu:projects" }],
    [{ text: "⬅️ Back", callback_data: "menu:main" }],
  ];
  return editMessage(env, chatId, messageId, text, kb);
}

// ---------------------------------------------------------------------------
// ♻️ Restart / 🗑 Delete
// ---------------------------------------------------------------------------
async function restartProject(chatId, messageId, projectId, env) {
  const cfg = await getConfig(env, chatId);
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return editMessage(env, chatId, messageId, "پروژه پیدا نشد.", backKeyboard());
  try {
    await railway(
      cfg.railway_token,
      `mutation($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }`,
      { serviceId: p.serviceId, environmentId: p.environmentId }
    );
    return editMessage(env, chatId, messageId, `♻️ <b>${p.name}</b> ری‌استارت شد.`, [
      [{ text: "📦 پروژه", callback_data: `proj:${p.id}` }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ]);
  } catch (err) {
    return editMessage(env, chatId, messageId, `❌ ری‌استارت fail شد: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

async function askDeleteProject(chatId, messageId, projectId, env) {
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return editMessage(env, chatId, messageId, "پروژه پیدا نشد.", backKeyboard());
  return editMessage(
    env,
    chatId,
    messageId,
    `⚠️ <b>مطمئنی می‌خوای «${p.name}» رو پاک کنی؟</b>\n\nاین کار کل پروژه رو از Railway هم حذف می‌کنه و برگشت‌ناپذیره.`,
    [
      [{ text: "🗑 بله، پاک کن", callback_data: `delete:confirm:${p.id}` }],
      [{ text: "❌ نه، بیخیال", callback_data: `proj:${p.id}` }],
    ]
  );
}

async function deleteProject(chatId, messageId, projectId, env) {
  const cfg = await getConfig(env, chatId);
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return editMessage(env, chatId, messageId, "پروژه پیدا نشد.", backKeyboard());
  try {
    await railway(cfg.railway_token, `mutation($id: String!) { projectDelete(id: $id) }`, { id: p.id });
    await kvDel(env, projKey(chatId, projectId));
    return editMessage(env, chatId, messageId, `🗑 پروژه‌ی <b>${p.name}</b> پاک شد.`, [[{ text: "📁 My Projects", callback_data: "menu:projects" }], [{ text: "⬅️ Back", callback_data: "menu:main" }]]);
  } catch (err) {
    return editMessage(env, chatId, messageId, `❌ حذف fail شد: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

// ---------------------------------------------------------------------------
// 📱 QR ورود به پنل
// ---------------------------------------------------------------------------
// توجه: این QR فقط برای «آدرس ورود به پنل» هست، نه یک لینک اشتراک VLESS
// آماده — چون تولید کانفیگ واقعی (UUID و...) داخل خودِ پنل انجام میشه، نه
// از طریق این بات دیپلوی.
async function sendProjectQr(chatId, projectId, env) {
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return sendMessage(env, chatId, "پروژه پیدا نشد.", backKeyboard());
  const loginUrl = `https://${p.customDomain || p.domain}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(loginUrl)}`;
  return tgCall(env, "sendPhoto", {
    chat_id: chatId,
    photo: qrUrl,
    caption: `📱 QR ورود به «${p.name}»\n<code>${loginUrl}</code>`,
    parse_mode: "HTML",
  });
}

// ---------------------------------------------------------------------------
// 🌐 دامنه‌ی اختصاصی
// ---------------------------------------------------------------------------
async function askCustomDomain(chatId, projectId, env) {
  return sendPrompt(
    env,
    chatId,
    "🌐 <b>دامنه‌ی اختصاصی</b>\n\nدامنه‌ای که خودت مالکشی رو بفرست (مثلاً panel.example.com). بعدش باید یک رکورد CNAME به آدرسی که بهت میدم اضافه کنی:",
    "domain_await_custom",
    { projectId }
  );
}

async function runCustomDomain(chatId, projectId, domain, env) {
  const cfg = await getConfig(env, chatId);
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return sendMessage(env, chatId, "پروژه پیدا نشد.", backKeyboard());
  try {
    const data = await railway(
      cfg.railway_token,
      `mutation($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id domain status { dnsRecords { hostlabel recordType requiredValue } verificationToken } } }`,
      { input: { domain, environmentId: p.environmentId, serviceId: p.serviceId } }
    );
    const cd = data.customDomainCreate;
    p.customDomain = cd.domain;
    await kvSet(env, projKey(chatId, projectId), p);

    const records = (cd.status?.dnsRecords || [])
      .map((r) => `  • ${r.recordType} ${r.hostlabel || "@"} → <code>${r.requiredValue}</code>`)
      .join("\n");
    const text =
      `🌐 <b>دامنه‌ی اختصاصی اضافه شد</b>\n\nحالا این رکوردها رو توی DNS دامنه‌ت ست کن:\n\n${records || "(از داشبورد Railway چک کن)"}\n` +
      (cd.status?.verificationToken
        ? `\n📌 رکورد TXT هم لازمه با مقدار:\n<code>${cd.status.verificationToken}</code>\n`
        : "") +
      `\nبعد از تنظیم DNS، چند دقیقه صبر کن تا verify بشه.`;
    return sendMessage(env, chatId, text, [[{ text: "📦 پروژه", callback_data: `proj:${p.id}` }], [{ text: "⬅️ Back", callback_data: "menu:main" }]]);
  } catch (err) {
    return sendMessage(env, chatId, `❌ خطا: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

// ---------------------------------------------------------------------------
// 🔄 Update panel (manual + toggle for auto)
// ---------------------------------------------------------------------------
async function updateProjectNow(chatId, messageId, projectId, env) {
  const cfg = await getConfig(env, chatId);
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return editMessage(env, chatId, messageId, "پروژه پیدا نشد.", backKeyboard());
  try {
    await railway(
      cfg.railway_token,
      `mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
      { serviceId: p.serviceId, environmentId: p.environmentId }
    );
    p.lastUpdatedAt = Date.now();
    await kvSet(env, projKey(chatId, projectId), p);
    return editMessage(
      env,
      chatId,
      messageId,
      `🔄 بروزرسانی <b>${p.name}</b> شروع شد (آخرین کامیت ریپو pull میشه).`,
      [[{ text: "📦 پروژه", callback_data: `proj:${p.id}` }], [{ text: "⬅️ Back", callback_data: "menu:main" }]]
    );
  } catch (err) {
    return editMessage(env, chatId, messageId, `❌ بروزرسانی fail شد: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

async function toggleAutoUpdate(chatId, messageId, projectId, env) {
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return editMessage(env, chatId, messageId, "پروژه پیدا نشد.", backKeyboard());
  p.autoUpdate = !p.autoUpdate;
  await kvSet(env, projKey(chatId, projectId), p);
  return showProjectDetail(chatId, messageId, projectId, env);
}

// ---------------------------------------------------------------------------
// TCP proxy create / change
// ---------------------------------------------------------------------------
async function askTcpPort(chatId, projectId, isChange, env) {
  const intro = isChange
    ? "🔄 <b>Change TCP Proxy</b>\n\nپروکسی قبلی حذف میشه. پورت داخلی جدید رو بفرست (مثلاً 8080):"
    : "🖥️ <b>Create TCP Proxy</b>\n\nپورت داخلی سرویس رو بفرست (مثلاً 8080):";
  return sendPrompt(env, chatId, intro, "tcp_await_port", { projectId, isChange });
}

async function runTcpProxy(chatId, projectId, internalPort, isChange, env) {
  const cfg = await getConfig(env, chatId);
  const p = await kvJson(env, projKey(chatId, projectId));
  if (!p) return sendMessage(env, chatId, "پروژه پیدا نشد.", backKeyboard());

  try {
    if (isChange && p.tcpProxies && p.tcpProxies.length) {
      const old = p.tcpProxies[p.tcpProxies.length - 1];
      await railway(cfg.railway_token, `mutation($id: String!) { tcpProxyDelete(id: $id) }`, { id: old.id });
      p.tcpProxies.pop();
    }

    const rdata = await railway(
      cfg.railway_token,
      `mutation($input: TCPProxyCreateInput!) { tcpProxyCreate(input: $input) { id domain proxyPort applicationPort } }`,
      { input: { environmentId: p.environmentId, serviceId: p.serviceId, applicationPort: internalPort } }
    );
    const proxy = rdata.tcpProxyCreate;
    p.tcpProxies = p.tcpProxies || [];
    p.tcpProxies.push(proxy);
    await kvSet(env, projKey(chatId, projectId), p);

    const text =
      `🖥️ <b>TCP Proxy Created ✅</b>\n\n` +
      `🔗 Domain: <code>${proxy.domain}</code>\n` +
      `🔌 Port: <code>${proxy.proxyPort}</code>\n` +
      `🎯 Internal Port: <code>${proxy.applicationPort}</code>`;
    const kb = [
      [{ text: "📦 پروژه", callback_data: `proj:${p.id}` }],
      [{ text: "⬅️ Back", callback_data: "menu:main" }],
    ];
    return sendMessage(env, chatId, text, kb);
  } catch (err) {
    return sendMessage(env, chatId, `❌ خطا: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------
async function showSpace(chatId, messageId, env) {
  const cfg = await getConfig(env, chatId);
  if (!cfg.railway_token) return editMessage(env, chatId, messageId, "❗️ اول Railway رو وصل کن.", backKeyboard());
  try {
    const data = await railway(cfg.railway_token, `query { me { name email } }`);
    const projects = await listProjects(env, chatId);
    const text = `📦 <b>Space</b>\n\n👤 ${data.me.name} (${data.me.email})\n📁 پروژه‌های ساخته‌شده با این ربات: ${projects.length}`;
    return editMessage(env, chatId, messageId, text, backKeyboard());
  } catch (err) {
    return editMessage(env, chatId, messageId, `❌ ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

// ---------------------------------------------------------------------------
// 📊 Stats + 📣 Broadcast (فقط مالک)
// ---------------------------------------------------------------------------
async function showStats(chatId, messageId, env) {
  const [{ keys: userKeys }, { keys: projKeys }, { keys: cfgKeys }] = await Promise.all([
    env.BOT_KV.list({ prefix: "user:" }),
    env.BOT_KV.list({ prefix: "proj:" }),
    env.BOT_KV.list({ prefix: "cfg:" }),
  ]);
  let autoUpdateCount = 0;
  for (const k of projKeys) {
    const p = await kvJson(env, k.name);
    if (p?.autoUpdate) autoUpdateCount++;
  }
  const text =
    `📊 <b>Stats</b>\n\n` +
    `👥 کل کاربرهایی که /start زدن: ${userKeys.length}\n` +
    `🔗 اکانت‌های Railway/Cloudflare وصل‌شده: ${cfgKeys.length}\n` +
    `📦 پروژه‌های ساخته‌شده (همه‌ی کاربرها): ${projKeys.length}\n` +
    `🔄 پروژه‌های با Auto-Update روشن: ${autoUpdateCount}`;
  return editMessage(env, chatId, messageId, text, backKeyboard());
}

async function startBroadcast(chatId, env) {
  return sendPrompt(env, chatId, "📣 <b>Broadcast</b>\n\nمتنی که می‌خوای برای همه‌ی کسایی که بات رو استارت کردن ارسال بشه رو بفرست:", "broadcast_await_text");
}

async function runBroadcast(chatId, text, env) {
  const { keys } = await env.BOT_KV.list({ prefix: "user:" });
  let sent = 0;
  let failed = 0;
  for (const k of keys) {
    const uid = k.name.split(":")[1];
    try {
      const r = await sendMessage(env, uid, text);
      if (r.ok) sent++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return sendMessage(env, chatId, `📣 Broadcast ارسال شد.\n✅ موفق: ${sent}\n❌ ناموفق (بلاک/حذف‌شده): ${failed}`, backKeyboard());
}

// ---------------------------------------------------------------------------
// 🧬 Clone Bot — انتخاب پلتفرم، فقط برای مالک
// ---------------------------------------------------------------------------
async function startClone(chatId, env) {
  return sendMessage(env, chatId, "🧬 <b>Clone Bot</b>\n\nروی کدوم پلتفرم دیپلوی بشه؟", [
    [{ text: "☁️ Cloudflare Worker", callback_data: "clone:platform:cf" }],
    [{ text: "🚂 Railway", callback_data: "clone:platform:railway" }],
    [{ text: "⬅️ Back", callback_data: "menu:advanced" }],
  ]);
}

// ---- Clone → Cloudflare Worker ----
async function startCloneCf(chatId, env) {
  return sendPrompt(
    env,
    chatId,
    "☁️ <b>Clone Bot → Cloudflare</b>\n\n1️⃣ Cloudflare API Token رو بفرست (دسترسی Workers Scripts:Edit + Workers KV Storage:Edit):",
    "clone_cf_await_token"
  );
}

async function handleCloneCfInput(chatId, text, step, data, env) {
  if (step === "clone_cf_await_token") {
    return sendPrompt(env, chatId, "2️⃣ حالا Cloudflare Account ID رو بفرست:", "clone_cf_await_account", { ...data, cf_token: text });
  }
  if (step === "clone_cf_await_account") {
    return sendPrompt(env, chatId, "3️⃣ توکن ربات تلگرام جدید رو بفرست (از @BotFather):", "clone_cf_await_bot_token", { ...data, cf_account_id: text });
  }
  if (step === "clone_cf_await_bot_token") {
    return sendPrompt(env, chatId, "4️⃣ Chat ID تلگرام ادمین جدید رو بفرست:", "clone_cf_await_admin_chat", { ...data, bot_token: text });
  }
  if (step === "clone_cf_await_admin_chat") {
    return runCloneCf(chatId, { ...data, admin_chat_id: text }, env);
  }
}

async function runCloneCf(chatId, params, env) {
  const progress = await sendMessage(env, chatId, "🧬 در حال کلون کردن روی Cloudflare...\n▱▱▱▱▱▱▱▱▱▱ 0%");
  const messageId = progress.result.message_id;
  const { cf_token, cf_account_id, bot_token, admin_chat_id } = params;

  try {
    const sourceRepo = env.SOURCE_REPO;
    const branch = env.SOURCE_BRANCH || "main";
    if (!sourceRepo) throw new Error("SOURCE_REPO env تنظیم نشده — راهنمای README رو ببین.");

    // این نسخه از bot-core.js + یه لایه‌ی نازک worker.js لازمه؛ برای سادگی هردو رو
    // با هم به‌صورت یک فایل ماژول واحد باندل می‌کنیم (esbuild سبک، فقط تجمیع متن).
    const [coreSrc, entrySrc] = await Promise.all([
      fetchRaw(`${sourceRepo}/${branch}/bot-core.js`),
      fetchRaw(`${sourceRepo}/${branch}/worker.js`),
    ]);
    const bundled = bundleForCloudflare(coreSrc, entrySrc);
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▱▱▱▱▱▱▱▱ 20% (سورس گرفته شد)");

    const verifyRes = await cfFetch(cf_token, `/accounts/${cf_account_id}`, "GET");
    if (!verifyRes.success) throw new Error("توکن یا Account ID کلادفلر نامعتبره.");
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▱▱▱▱▱▱▱ 30% (توکن تایید شد)");

    const scriptName = "spider-bot-" + randomToken(4);
    const kvRes = await cfFetch(cf_token, `/accounts/${cf_account_id}/storage/kv/namespaces`, "POST", { title: scriptName + "-kv" });
    if (!kvRes.success) throw new Error("ساخت KV namespace fail شد: " + JSON.stringify(kvRes.errors));
    const kvId = kvRes.result.id;
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▰▱▱▱▱▱▱ 45% (KV ساخته شد)");

    const cloneWebhookSecret = randomToken(16);
    const metadata = {
      main_module: `${scriptName}.mjs`,
      compatibility_date: new Date().toISOString().slice(0, 10),
      bindings: [
        { type: "kv_namespace", name: "BOT_KV", namespace_id: kvId },
        { type: "secret_text", name: "BOT_TOKEN", text: bot_token },
        { type: "secret_text", name: "ADMIN_CHAT_ID", text: String(admin_chat_id) },
        { type: "secret_text", name: "WEBHOOK_SECRET", text: cloneWebhookSecret },
        { type: "plain_text", name: "SOURCE_REPO", text: sourceRepo },
        { type: "plain_text", name: "SOURCE_BRANCH", text: branch },
      ],
    };
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata), "metadata.json");
    form.append(`${scriptName}.mjs`, new Blob([bundled], { type: "application/javascript+module" }), `${scriptName}.mjs`);
    const uploadRes = await fetch(`${CF_API}/accounts/${cf_account_id}/workers/scripts/${scriptName}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${cf_token}` },
      body: form,
    }).then((r) => r.json());
    if (!uploadRes.success) throw new Error("آپلود Worker fail شد: " + JSON.stringify(uploadRes.errors));
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▰▰▰▱▱▱▱ 65% (Worker آپلود شد)");

    const subRes = await cfFetch(cf_token, `/accounts/${cf_account_id}/workers/scripts/${scriptName}/subdomain`, "POST", { enabled: true });
    if (!subRes.success) throw new Error("فعال‌سازی workers.dev fail شد: " + JSON.stringify(subRes.errors));

    const subdomainInfo = await cfFetch(cf_token, `/accounts/${cf_account_id}/workers/subdomain`, "GET");
    const wdevSub = subdomainInfo.result?.subdomain;
    if (!wdevSub) throw new Error("این اکانت هنوز workers.dev subdomain نداره؛ یک بار از داشبورد Cloudflare Workers بسازش.");
    const workerUrl = `https://${scriptName}.${wdevSub}.workers.dev`;
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▰▰▰▰▰▱▱ 85% (آدرس ساخته شد)");

    const wh = await fetch(`https://api.telegram.org/bot${bot_token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: workerUrl + "/", secret_token: cloneWebhookSecret, allowed_updates: ["message", "callback_query"] }),
    }).then((r) => r.json());
    if (!wh.ok) throw new Error("ثبت webhook تلگرام fail شد: " + wh.description);

    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▰▰▰▰▰▰▰ 100% ✅");
    const text =
      `🎉 <b>ربات روی Cloudflare کلون شد!</b>\n\n🌐 Worker: <code>${workerUrl}</code>\n👤 Admin Chat ID: <code>${admin_chat_id}</code>\n\n` +
      `ادمین جدید فقط باید توی همون چت با اون بات <code>/start</code> رو بزنه.`;
    return sendMessage(env, chatId, text, backKeyboard());
  } catch (err) {
    return editMessage(env, chatId, messageId, `❌ کلون fail شد: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

// ---- Clone → Railway ----
async function startCloneRailway(chatId, env) {
  return sendPrompt(env, chatId, "🚂 <b>Clone Bot → Railway</b>\n\n1️⃣ توکن Railway اکانت مقصد رو بفرست:", "clone_rw_await_token");
}

async function handleCloneRailwayInput(chatId, text, step, data, env) {
  if (step === "clone_rw_await_token") {
    return sendPrompt(env, chatId, "2️⃣ توکن ربات تلگرام جدید رو بفرست (از @BotFather):", "clone_rw_await_bot_token", { ...data, railway_token: text });
  }
  if (step === "clone_rw_await_bot_token") {
    return sendPrompt(env, chatId, "3️⃣ Chat ID تلگرام ادمین جدید رو بفرست:", "clone_rw_await_admin_chat", { ...data, bot_token: text });
  }
  if (step === "clone_rw_await_admin_chat") {
    return runCloneRailway(chatId, { ...data, admin_chat_id: text }, env);
  }
}

async function runCloneRailway(chatId, params, env) {
  const progress = await sendMessage(env, chatId, "🧬 در حال کلون کردن روی Railway...\n▱▱▱▱▱▱▱▱▱▱ 0%");
  const messageId = progress.result.message_id;
  const { railway_token, bot_token, admin_chat_id } = params;

  try {
    const sourceRepo = env.SOURCE_REPO;
    const branch = env.SOURCE_BRANCH || "main";
    if (!sourceRepo) throw new Error("SOURCE_REPO env تنظیم نشده — راهنمای README رو ببین.");

    const projData = await railway(
      railway_token,
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id environments { edges { node { id } } } } }`,
      { input: { name: "spider-deploy-bot-" + randomToken(3) } }
    );
    const project = projData.projectCreate;
    const environmentId = project.environments.edges[0].node.id;
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▱▱▱▱▱▱▱▱ 20% (پروژه ساخته شد)");

    const cloneWebhookSecret = randomToken(16);
    const svcData = await railway(
      railway_token,
      `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
      {
        input: {
          projectId: project.id,
          name: "spider-deploy-bot",
          source: { repo: sourceRepo },
          variables: {
            BOT_TOKEN: bot_token,
            ADMIN_CHAT_ID: String(admin_chat_id),
            WEBHOOK_SECRET: cloneWebhookSecret,
            SOURCE_REPO: sourceRepo,
            SOURCE_BRANCH: branch,
          },
        },
      }
    );
    const service = svcData.serviceCreate;
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▰▱▱▱▱▱▱ 40% (سرویس ساخته شد)");

    await railway(
      railway_token,
      `mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
      { serviceId: service.id, environmentId }
    );
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▰▰▰▱▱▱▱ 60% (دیپلوی شروع شد)");

    const domData = await railway(
      railway_token,
      `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { environmentId, serviceId: service.id } }
    );
    const domain = domData.serviceDomainCreate.domain;
    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▰▰▰▰▰▱▱ 85% (دامنه ساخته شد)");

    const wh = await fetch(`https://api.telegram.org/bot${bot_token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://${domain}/`, secret_token: cloneWebhookSecret, allowed_updates: ["message", "callback_query"] }),
    }).then((r) => r.json());
    if (!wh.ok) throw new Error("ثبت webhook تلگرام fail شد: " + wh.description);

    await editMessage(env, chatId, messageId, "🧬 در حال کلون کردن...\n▰▰▰▰▰▰▰▰▰▰ 100% ✅");
    const text =
      `🎉 <b>ربات روی Railway کلون شد!</b>\n\n🌐 Domain: <code>${domain}</code>\n👤 Admin Chat ID: <code>${admin_chat_id}</code>\n\n` +
      `چند دقیقه صبر کن تا بیلد تموم بشه، بعد ادمین جدید توی همون چت <code>/start</code> رو بزنه.\n\n` +
      `⚠️ چون این پروژه از KV واقعی استفاده نمی‌کنه (فایل JSON محلیه)، برای اینکه بعد از هر ریست/ریدیپلوی دیتاش پاک نشه، یه Railway Volume به مسیر <code>/app/data</code> وصل کن.`;
    return sendMessage(env, chatId, text, backKeyboard());
  } catch (err) {
    return editMessage(env, chatId, messageId, `❌ کلون fail شد: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
}

// ---- Clone helpers ----
async function fetchRaw(pathAfterRepo) {
  const url = `https://raw.githubusercontent.com/${pathAfterRepo}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("نتونستم سورس رو از GitHub بخونم: " + url);
  return res.text();
}

// worker.js فقط چند خط import/export داره؛ برای اینکه Cloudflare بتونه یک
// فایل واحد رو آپلود کنه، اینجا موقع کلون هردو فایل رو به‌صورت متنی به هم
// می‌چسبونیم (bot-core بدون export، بعدش export default از worker.js).
function bundleForCloudflare(coreSrc, entrySrc) {
  const coreNoExports = coreSrc.replace(/^export\s+/gm, "");
  const entryNoImports = entrySrc.replace(/^import[^\n]*\n/gm, "");
  return coreNoExports + "\n\n" + entryNoImports;
}

async function cfFetch(token, path, method, body) {
  const res = await fetch(CF_API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// 🔄 Scheduled — auto-update روزانه (cron روی Cloudflare / setInterval روی Node)
// ---------------------------------------------------------------------------
async function handleScheduled(env) {
  const { keys } = await env.BOT_KV.list({ prefix: "proj:" });
  for (const k of keys) {
    const p = await kvJson(env, k.name);
    if (!p || !p.autoUpdate) continue;
    const chatId = k.name.split(":")[1];
    const cfg = await getConfig(env, chatId);
    if (!cfg.railway_token) continue;
    try {
      await railway(
        cfg.railway_token,
        `mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
        { serviceId: p.serviceId, environmentId: p.environmentId }
      );
      p.lastUpdatedAt = Date.now();
      await kvSet(env, k.name, p);
      await sendMessage(env, chatId, `🔄 بروزرسانی خودکار <b>${p.name}</b> انجام شد.`);
    } catch (err) {
      await sendMessage(env, chatId, `⚠️ بروزرسانی خودکار <b>${p.name}</b> fail شد: ${escapeHtml(String(err.message || err))}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch entry — هم Cloudflare هم Node از این استفاده می‌کنن
// ---------------------------------------------------------------------------
async function handleFetch(req, env, ctx) {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/") {
    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try {
      update = await req.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const task = handleUpdate(update, env).catch((e) => console.error(e));
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else await task;
    return new Response("ok");
  }

  if (url.pathname === "/setup") {
    const result = await registerWebhook(env, url.origin);
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }

  return new Response("Spider Deploy Bot is alive.");
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export { handleFetch, handleScheduled };
