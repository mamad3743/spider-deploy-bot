/**
 * Spider Deploy Bot — Cloudflare Worker
 * ---------------------------------------------------------
 * یک ربات تلگرامی سرورلس (روی Cloudflare Worker) که:
 *   - پروژه‌ی amirh00sain/SpiderPanel رو روی Railway دیپلوی می‌کنه
 *   - TCP Proxy می‌سازه/عوض می‌کنه
 *   - پروژه‌های ساخته‌شده رو لیست می‌کنه
 *   - می‌تونه از خودش یک نسخه‌ی جدید (کلون) روی اکانت Cloudflare
 *     یک ادمین دیگه دیپلوی کنه
 *
 * ⚡️ بهینه‌سازی مصرف KV (نسخه‌ی دوم)
 * ---------------------------------------------------------
 * Cloudflare Workers KV در پلن رایگان فقط ۱۰۰۰ نوشتن (write) در روز میده —
 * این عملاً محدودکننده‌تر از سقف ۱۰۰k ریکوئست Worker هست.
 * برای همین، state مراحلِ فرم‌های چندمرحله‌ای (مثل «پورت رو بفرست») دیگه
 * توی KV ذخیره نمیشه. به‌جاش با force_reply پیام می‌فرستیم و یک بلوک
 * «نامرئی» (کاراکترهای zero-width) که وضعیت فعلی رو نگه می‌داره ته پیام
 * می‌چسبونیم. وقتی ادمین روی اون پیام Reply می‌کنه، تلگرام خودِ پیام اصلی
 * (با بلوک نامرئی) رو داخل `reply_to_message` برمی‌گردونه و ما همون‌جا
 * state رو دیکد می‌کنیم — بدون هیچ خواندن/نوشتنِ KV.
 *
 * KV فقط برای داده‌ی واقعاً دائمی استفاده میشه:
 *   - توکن‌های Railway/Cloudflare ذخیره‌شده‌ی ادمین (cfg:*)
 *   - پروژه‌های ساخته‌شده (proj:*)
 * که هرکدوم فقط یک بار در پایان یک فرآیند نوشته میشن، نه در هر مرحله.
 *
 * Bindings مورد نیاز:
 *   BOT_KV          KV namespace          - فقط cfg/proj، نه session
 *   BOT_TOKEN       secret                - توکن ربات تلگرام
 *   ADMIN_CHAT_ID   secret                - chat id تلگرام مالک ربات
 *   WEBHOOK_SECRET  secret                - رشته‌ی رندوم برای تایید درخواست‌های تلگرام
 *   SOURCE_REPO     var (plain text)      - "user/repo" جایی که همین فایل نگه‌داری میشه (برای کلون)
 *   SOURCE_BRANCH   var (plain text, پیش‌فرض main)
 *   SOURCE_FILE     var (plain text, پیش‌فرض worker.js)
 */

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const SPIDER_REPO = "amirh00sain/SpiderPanel";
const CF_API = "https://api.cloudflare.com/client/v4";

// کاراکترهای نامرئی برای انکد کردن state داخل متن پیام (بدون هیچ اثر بصری)
const ZW0 = "\u200B"; // bit 0
const ZW1 = "\u200C"; // bit 1
const ZW_SEP = "\u2063"; // جداکننده‌ی متن قابل‌دیدن از بلوک نامرئی

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(req, env, ctx) {
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
      ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error(e)));
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      const result = await registerWebhook(env, url.origin);
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Spider Deploy Bot is alive.");
  },
};

// ---------------------------------------------------------------------------
// State encoding (zero-width, carried via Telegram reply chain — no KV)
// ---------------------------------------------------------------------------
function encodeState(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let out = "";
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) {
      out += (b >> i) & 1 ? ZW1 : ZW0;
    }
  }
  return out;
}

function decodeState(text) {
  if (!text) return null;
  const bits = [...text].filter((c) => c === ZW0 || c === ZW1);
  if (!bits.length || bits.length % 8 !== 0) return null;
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] === ZW1 ? 1 : 0);
    bytes.push(byte);
  }
  try {
    const json = new TextDecoder().decode(new Uint8Array(bytes));
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

// یک پیام force-reply می‌فرسته که ته متنش (نامرئی) وضعیت فعلی فرم رو حمل می‌کنه.
// هیچ نوشتنی توی KV اتفاق نمی‌افته.
async function sendPrompt(env, chatId, visibleText, step, data) {
  const marker = ZW_SEP + encodeState({ step, data: data || {} });
  return tgCall(env, "sendMessage", {
    chat_id: chatId,
    text: visibleText + "\n\n<i>برای لغو /cancel رو بفرست.</i>" + marker,
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
  return tgCall(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text || undefined,
  });
}

async function registerWebhook(env, workerOrigin) {
  return tgCall(env, "setWebhook", {
    url: workerOrigin + "/",
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
}

// ---------------------------------------------------------------------------
// KV helpers — فقط برای داده‌ی دائمی (cfg / proj)، نه session
// ---------------------------------------------------------------------------
const kvJson = async (env, key) => {
  const v = await env.BOT_KV.get(key);
  return v ? JSON.parse(v) : null;
};
const kvSet = (env, key, val) => env.BOT_KV.put(key, JSON.stringify(val));

const cfgKey = (chatId) => `cfg:${chatId}`;
const projKey = (chatId, id) => `proj:${chatId}:${id}`;

async function getConfig(env, chatId) {
  return (await kvJson(env, cfgKey(chatId))) || {};
}
async function setConfig(env, chatId, patch) {
  const cur = await getConfig(env, chatId);
  const next = { ...cur, ...patch };
  await kvSet(env, cfgKey(chatId), next); // ۱ نوشتن
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

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message) return handleMessage(update.message, env);
}

function isAdmin(chatId, env) {
  return String(chatId) === String(env.ADMIN_CHAT_ID);
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId, env)) {
    return sendMessage(env, chatId, "🚫 این ربات خصوصیه و فقط برای مالکش کار می‌کنه.");
  }
  const text = (msg.text || "").trim();

  if (text === "/start") {
    return sendMessage(env, chatId, mainMenuText(), mainMenuKeyboard());
  }
  if (text === "/cancel") {
    return sendMessage(env, chatId, "لغو شد.", mainMenuKeyboard());
  }

  // state رو از پیامی که این متن ریپلایش کرده می‌خونیم — بدون KV
  const state = decodeState(msg.reply_to_message?.text);
  if (state) return handleStepInput(chatId, text, state.step, state.data || {}, env);

  return sendMessage(env, chatId, "برای شروع /start رو بفرست.");
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  if (!isAdmin(chatId, env)) {
    return answerCallback(env, cb.id, "دسترسی نداری.");
  }
  await answerCallback(env, cb.id);
  const data = cb.data;

  try {
    if (data === "menu:main") return editMessage(env, chatId, messageId, mainMenuText(), mainMenuKeyboard());
    if (data === "menu:new_deploy") return startNewDeploy(chatId, messageId, env);
    if (data === "menu:projects") return showProjects(chatId, messageId, env);
    if (data === "menu:advanced") return editMessage(env, chatId, messageId, advancedText(), advancedKeyboard());
    if (data === "menu:space") return showSpace(chatId, messageId, env);
    if (data === "menu:account") return showAccount(chatId, messageId, env);

    if (data === "account:connect_railway") return askRailwayToken(chatId, env);
    if (data === "account:connect_cf") return askCfCreds(chatId, env);
    if (data === "account:delete_railway") return showDeleteRailwayInfo(chatId, messageId, env);

    if (data.startsWith("proj:")) return showProjectDetail(chatId, messageId, data.split(":")[1], env);
    if (data.startsWith("tcp:create:")) return askTcpPort(chatId, data.split(":")[2], false, env);
    if (data.startsWith("tcp:change:")) return askTcpPort(chatId, data.split(":")[2], true, env);

    if (data === "advanced:clone") return startClone(chatId, env);

    return editMessage(env, chatId, messageId, mainMenuText(), mainMenuKeyboard());
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
function advancedKeyboard() {
  return [
    [{ text: "🧬 Clone Bot (تکثیر ربات)", callback_data: "advanced:clone" }],
    [{ text: "⬅️ Back", callback_data: "menu:main" }],
  ];
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
  return sendPrompt(
    env,
    chatId,
    "☁️ Cloudflare API Token رو بفرست.\n\n(دسترسی Workers Scripts:Edit + Workers KV Storage:Edit)",
    "await_cf_token"
  );
}

async function showDeleteRailwayInfo(chatId, messageId, env) {
  const text =
    "🗑 <b>Delete Railway Account</b>\n\n" +
    "این دکمه فقط صفحه‌ی حذف اکانت Railway رو نشون میده، خودِ ربات چیزی حذف نمی‌کنه:\n" +
    "برو railway.app/account → پایین صفحه → Danger Zone → Delete Account.";
  return editMessage(env, chatId, messageId, text, backKeyboard());
}

// ---------------------------------------------------------------------------
// Step input handling — همه از reply chain میان، نه KV
// ---------------------------------------------------------------------------
async function handleStepInput(chatId, text, step, data, env) {
  if (step === "await_railway_token") {
    await setConfig(env, chatId, { railway_token: text }); // ۱ نوشتن دائمی
    return sendMessage(env, chatId, "✅ توکن Railway ذخیره شد.", backKeyboard());
  }

  if (step === "await_cf_token") {
    return sendPrompt(env, chatId, "حالا Cloudflare Account ID رو بفرست:", "await_cf_account_id", { cf_token: text });
  }
  if (step === "await_cf_account_id") {
    await setConfig(env, chatId, { cf_token: data.cf_token, cf_account_id: text }); // ۱ نوشتن دائمی
    return sendMessage(env, chatId, "✅ Cloudflare وصل شد.", backKeyboard());
  }

  if (step === "new_deploy_await_port") {
    const port = parseInt(text, 10);
    if (!port || port < 1 || port > 65535) {
      return sendPrompt(env, chatId, "پورت نامعتبره، یک عدد بین 1 تا 65535 بفرست:", "new_deploy_await_port");
    }
    return runNewDeploy(chatId, port, env);
  }

  if (step === "tcp_await_port") {
    const port = parseInt(text, 10);
    if (!port || port < 1 || port > 65535) {
      return sendPrompt(env, chatId, "پورت نامعتبره، یک عدد بین 1 تا 65535 بفرست:", "tcp_await_port", data);
    }
    return runTcpProxy(chatId, data.projectId, port, data.isChange, env);
  }

  if (step.startsWith("clone_")) return handleCloneInput(chatId, text, step, data, env);

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
  await editMessage(env, chatId, messageId, "🖥️ <b>Create Service</b>\n\nدر حال آماده‌سازی...", null);
  return sendPrompt(env, chatId, "🖥️ <b>Create TCP Proxy... اول سرویس رو می‌سازیم</b>\n\nپورت داخلی سرویس رو بفرست (مثلاً 8080):", "new_deploy_await_port");
}

async function runNewDeploy(chatId, port, env) {
  const cfg = await getConfig(env, chatId);
  const progress = await sendMessage(env, chatId, "🚀 در حال دیپلوی...\n▱▱▱▱▱▱▱▱▱▱ 0%");
  const messageId = progress.result.message_id;

  try {
    const projData = await railway(
      cfg.railway_token,
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name environments { edges { node { id name } } } } }`,
      { input: { name: "spider-panel-" + randomToken(3) } }
    );
    const project = projData.projectCreate;
    const environmentId = project.environments.edges[0].node.id;
    await editMessage(env, chatId, messageId, "🚀 در حال دیپلوی...\n▰▰▱▱▱▱▱▱▱▱ 20% (پروژه ساخته شد)");

    const adminPassword = randomToken(6);
    const secretKey = randomToken(20);
    const svcData = await railway(
      cfg.railway_token,
      `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
      {
        input: {
          projectId: project.id,
          name: "spider-panel",
          source: { repo: SPIDER_REPO },
          variables: { PORT: String(port), ADMIN_PASSWORD: adminPassword, SECRET_KEY: secretKey },
        },
      }
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
      serviceId: service.id,
      environmentId,
      domain,
      adminPassword,
      port,
      createdAt: Date.now(),
      tcpProxies: [],
    };
    await kvSet(env, projKey(chatId, project.id), proj); // ۱ نوشتن دائمی

    const text =
      `📦 <b>Spider Panel Deployment</b>\n` +
      `Deployment completed ✅\n\n` +
      `🌐 Domain: <code>${domain}</code>\n` +
      `🔑 Admin Password: <code>${adminPassword}</code>\n` +
      `🎯 Internal Port: <code>${port}</code>\n\n` +
      `همین الان وارد بشو و رمز رو عوض کن.`;
    const kb = [
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
  const proxies = (p.tcpProxies || []).map((t) => `  • ${t.domain}:${t.proxyPort} → :${t.applicationPort}`).join("\n") || "  (هیچ)";
  const text =
    `📦 <b>${p.name}</b>\n\n` +
    `🌐 Domain: <code>${p.domain}</code>\n` +
    `🔑 Admin Password: <code>${p.adminPassword}</code>\n\n` +
    `🔌 TCP Proxies:\n${proxies}`;
  const kb = [
    [{ text: "➕ Create TCP Proxy", callback_data: `tcp:create:${p.id}` }],
    [{ text: "🔁 Change TCP Proxy", callback_data: `tcp:change:${p.id}` }],
    [{ text: "📁 My Projects", callback_data: "menu:projects" }],
    [{ text: "⬅️ Back", callback_data: "menu:main" }],
  ];
  return editMessage(env, chatId, messageId, text, kb);
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
    await kvSet(env, projKey(chatId, projectId), p); // ۱ نوشتن دائمی

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
// 🧬 Clone Bot
// ---------------------------------------------------------------------------
async function startClone(chatId, env) {
  return sendPrompt(
    env,
    chatId,
    "🧬 <b>Clone Bot</b>\n\n1️⃣ Cloudflare API Token رو بفرست (دسترسی Workers Scripts:Edit + Workers KV Storage:Edit):",
    "clone_await_cf_token"
  );
}

async function handleCloneInput(chatId, text, step, data, env) {
  if (step === "clone_await_cf_token") {
    return sendPrompt(env, chatId, "2️⃣ حالا Cloudflare Account ID رو بفرست:", "clone_await_cf_account", { ...data, cf_token: text });
  }
  if (step === "clone_await_cf_account") {
    return sendPrompt(env, chatId, "3️⃣ توکن ربات تلگرام جدید رو بفرست (از @BotFather):", "clone_await_bot_token", { ...data, cf_account_id: text });
  }
  if (step === "clone_await_bot_token") {
    return sendPrompt(env, chatId, "4️⃣ Chat ID تلگرام ادمین جدید رو بفرست:", "clone_await_admin_chat", { ...data, bot_token: text });
  }
  if (step === "clone_await_admin_chat") {
    return runClone(chatId, { ...data, admin_chat_id: text }, env);
  }
}

async function runClone(chatId, params, env) {
  const progress = await sendMessage(env, chatId, "🧬 در حال کلون کردن ربات...\n▱▱▱▱▱▱▱▱▱▱ 0%");
  const messageId = progress.result.message_id;
  const { cf_token, cf_account_id, bot_token, admin_chat_id } = params;

  try {
    const sourceRepo = env.SOURCE_REPO;
    const branch = env.SOURCE_BRANCH || "main";
    const file = env.SOURCE_FILE || "worker.js";
    if (!sourceRepo) throw new Error("SOURCE_REPO env تنظیم نشده — راهنمای README رو ببین.");
    const rawUrl = `https://raw.githubusercontent.com/${sourceRepo}/${branch}/${file}`;
    const srcRes = await fetch(rawUrl);
    if (!srcRes.ok) throw new Error("نتونستم سورس رو از GitHub بخونم: " + rawUrl);
    const sourceCode = await srcRes.text();
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
        { type: "plain_text", name: "SOURCE_FILE", text: file },
      ],
    };
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata), "metadata.json");
    form.append(`${scriptName}.mjs`, new Blob([sourceCode], { type: "application/javascript+module" }), `${scriptName}.mjs`);
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
      `🎉 <b>ربات کلون شد!</b>\n\n🌐 Worker: <code>${workerUrl}</code>\n👤 Admin Chat ID: <code>${admin_chat_id}</code>\n\n` +
      `ادمین جدید فقط باید توی همون چت با اون بات <code>/start</code> رو بزنه.`;
    return sendMessage(env, chatId, text, backKeyboard());
  } catch (err) {
    return editMessage(env, chatId, messageId, `❌ کلون fail شد: ${escapeHtml(String(err.message || err))}`, backKeyboard());
  }
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
// Utils
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
