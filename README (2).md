# Spider Deploy Bot

ربات تلگرامیِ سرورلس (روی Cloudflare Workers) که [amirh00sain/SpiderPanel](https://github.com/amirh00sain/SpiderPanel)
رو روی Railway دیپلوی می‌کنه، TCP Proxy می‌سازه، و می‌تونه از خودش یک نسخه‌ی جدید (کلون) بسازه.

## چرا Worker به‌جای یک سرور پایتون؟

- سرورلس: هزینه‌ی نگه‌داری سرور جدا نداره.
- Webhook-based: تلگرام فقط وقتی پیام واقعی می‌رسه Worker رو صدا می‌زنه (نه polling مداوم) → کمترین مصرف ریکوئست.
- قابلیت «Clone»: چون خودِ بات یک اسکریپت ساده‌ست، می‌تونه از GitHub سورسِ خودش رو بخونه و
  یک کپی از خودش رو روی اکانت Cloudflare یک نفر دیگه آپلود کنه.

## مراحل نصب اول (برای خودت، ادمین اصلی)

### ۱. پیش‌نیاز

```bash
npm install -g wrangler
wrangler login
```

### ۲. ساخت ربات تلگرام

با [@BotFather](https://t.me/BotFather) یک بات بساز و توکنش رو نگه دار.
`Chat ID` خودت رو هم از [@userinfobot](https://t.me/userinfobot) بگیر.

### ۳. این پوشه رو push کن به یک ریپوی GitHub خودت

قابلیت Clone در زمان اجرا سورس `worker.js` رو از `raw.githubusercontent.com` می‌خونه،
پس `wrangler.toml` → `SOURCE_REPO` باید به همون ریپو اشاره کنه:

```toml
SOURCE_REPO = "yourusername/spider-deploy-bot"
```

### ۴. ساخت KV namespace

```bash
wrangler kv namespace create BOT_KV
```

`id` خروجی رو داخل `wrangler.toml` جایگزین `REPLACE_WITH_KV_ID` کن.

### ۵. ست کردن Secret ها

```bash
wrangler secret put BOT_TOKEN          # توکن بات از BotFather
wrangler secret put ADMIN_CHAT_ID      # chat id خودت
wrangler secret put WEBHOOK_SECRET     # یک رشته‌ی رندوم دلخواه، مثلاً از این دستور:
                                        #   openssl rand -hex 16
```

### ۶. دیپلوی

```bash
wrangler deploy
```

### ۷. ثبت وبهوک تلگرام

بعد از دیپلوی، آدرس Worker رو (مثلاً `https://spider-deploy-bot.yourname.workers.dev`)
یک بار با `/setup` باز کن:

```
https://spider-deploy-bot.yourname.workers.dev/setup
```

این خودش وبهوک تلگرام رو با `WEBHOOK_SECRET` ثبت می‌کنه.

### ۸. شروع

توی تلگرام به رباتت `/start` بزن.

-----

## قابلیت‌های منو

|منو                   |کار                                                                                                                              |
|----------------------|---------------------------------------------------------------------------------------------------------------------------------|
|🆕 New Deployment      |پروژه‌ی SpiderPanel رو روی Railway از رو ریپوی `amirh00sain/SpiderPanel` می‌سازه، دامنه می‌گیره، رمز ادمین و SECRET_KEY رندوم می‌سازه|
|📁 My Projects         |لیست پروژه‌های ساخته‌شده با این ربات + جزئیات هر کدوم                                                                              |
|🔌 TCP Proxy           |ساخت/تعویض TCP Proxy برای هر پروژه (برای Reality/XHTTP)                                                                          |
|⚙️ Advanced → Clone Bot|دیپلوی یک کپی کامل از همین ربات روی اکانت Cloudflare یک نفر دیگه                                                                 |
|📦 Space               |نمای کلی اکانت Railway وصل‌شده                                                                                                    |
|👤 Account             |وصل‌کردن/قطع‌کردن Railway و Cloudflare                                                                                             |

## قابلیت Clone (تکثیر ربات)

از منوی **Advanced → 🧬 Clone Bot** این ۴ مورد پرسیده میشه:

1. Cloudflare API Token جدید (با دسترسی `Workers Scripts:Edit` + `Workers KV Storage:Edit`)
1. Cloudflare Account ID جدید
1. توکن بات تلگرام جدید (از BotFather)
1. Chat ID تلگرام ادمین جدید

بعدش ربات به‌صورت خودکار:

- سورس خودش رو از GitHub می‌خونه (همون ریپویی که در `SOURCE_REPO` تنظیم شده)
- یک KV namespace جدید روی اکانت CF مقصد می‌سازه
- Worker رو آپلود می‌کنه (با bindings و secret‌های مخصوص همون ادمین جدید)
- workers.dev subdomain رو براش فعال می‌کنه
- وبهوک تلگرام بات جدید رو ثبت می‌کنه

نکته: اکانت Cloudflare مقصد باید از قبل یک بار workers.dev subdomain فعال کرده باشه
(یک‌بار از داشبورد Cloudflare → Workers → «Set up a subdomain»)، چون Cloudflare API
اجازه‌ی ساخت subdomain جدید برای یک اکانت رو نمی‌ده — فقط فعال/غیرفعال‌سازی روی اسکریپت.

## نکات بهینه‌سازی مصرف

- Webhook به‌جای polling → صفر ریکوئست وقتی کسی پیام نمی‌ده.
- برای پیام‌های مرحله‌ای (progress bar دیپلوی) از `editMessageText` استفاده شده، نه ارسال پیام جدید در هر مرحله.
- Free plan کلادفلر ۱۰۰k ریکوئست Worker در روز میده — برای این نوع بات عملاً بی‌نهایته، چون هر کلون
  روی اکانت Cloudflare جدای خودش اجراست (سهمیه‌اش جدا حساب میشه).

### چرا دیگه از KV برای state فرم‌ها استفاده نمیشه

سقف واقعی محدودکننده، ریکوئست Worker نیست — **نوشتن (write) در Workers KV** هست: پلن رایگان
فقط **۱۰۰۰ نوشتن در روز** میده. اگه state هر مرحله‌ی فرم (پورت، توکن، …) توی KV ذخیره بشه،
با استفاده‌ی معمولی همون ۱۰۰۰ تا زود تموم میشه.

راه‌حل این نسخه: وقتی بات یه سوال متنی می‌پرسه (`sendPrompt`)، وضعیت فعلی فرم رو با کاراکترهای
**نامرئی** (zero-width) ته همون پیام می‌چسبونه. وقتی ادمین روی اون پیام Reply می‌کنه، تلگرام
خودِ پیام قبلی رو (با بلوک نامرئی) داخل `reply_to_message` برمی‌گردونه و بات همون‌جا state رو
دیکد می‌کنه — بدون هیچ خواندن یا نوشتنِ KV.

نتیجه: KV فقط برای داده‌ای که واقعاً باید دائمی بمونه نوشته میشه (توکن ذخیره‌شده، پروژه‌ی ساخته‌شده)
— هرکدوم یک بار در پایان یک فرآیند، نه در هر مرحله. این عملاً مصرف نوشتن رو به کمتر از ۱۰٪ حالت قبل می‌رسونه.

**نکته‌ی امنیتی این روش:** توکن‌هایی که موقع فرم (مثلاً Cloudflare token در فرآیند Clone) تایپ می‌کنی،
تا قبل از ذخیره‌ی نهایی به‌صورت نامرئی داخل تاریخچه‌ی همون چت خصوصی‌ت با بات می‌مونن (نه در جایی عمومی).
چون چت بین تو و بات خصوصیه و کسی جز خودت بهش دسترسی نداره، ریسک عملی‌ای نداره — ولی اگه دوست داری این
پیام‌های واسط رو بعد از هر مرحله با `deleteMessage` پاک کنه هم می‌تونم اضافه کنم.

## امنیت

- ربات فقط به `ADMIN_CHAT_ID` جواب میده؛ بقیه پیام‌ها رد میشه.
- توکن‌های Railway/Cloudflare فقط داخل KV همون بات ذخیره میشن، هیچ‌جا لاگ نمیشن.
- `WEBHOOK_SECRET` جلوی صدا زدن الکی Worker توسط بقیه رو می‌گیره.