# Discord Registration Bot — Setup Guide

This bot lets users run `/register` in Discord, sign in with Google (popup-style flow),
look themselves up in your Google Sheet, and — after confirming — get their Discord
roles assigned and nickname changed automatically.

## How it works (overview)

1. User runs `/register` → bot DMs them a link.
2. Link opens a browser tab → Google sign-in consent screen (this is the closest to a
   "popup" Discord allows; Discord doesn't support embedding a real OAuth popup inside
   the app, so this opens in the system browser instead).
3. After consent, your server receives their email and looks it up in the `ROLES` sheet.
4. Bot DMs them an embed: full name, nickname, email, roles to be assigned, and the new
   server nickname — with **Confirm** / **Deny** buttons.
5. On Confirm: roles + nickname are applied in Discord, and a row is written/overwritten
   in the `BASE DATA` sheet (column I = discord_id), unless column A for that row is
   checked (protected — sheet untouched, but Discord side still updates).
6. Duplicate emails or unmatched emails get a message telling the user to contact an
   admin; nothing is assigned.

---

## 1. Hosting: Railway (free tier) + Cloudflare Tunnel in front

The bot is a normal Node web service running on **Railway** (free trial credit
is fine for a small bot like this), with **Cloudflare** sitting in front of it
as DNS + TLS provider via a **Cloudflare Tunnel** (`cloudflared` running inside
the Railway container). Cloudflare provides the public hostname and HTTPS for
free; Railway provides the long-lived Node process that discord.js needs.

We use a tunnel rather than Cloudflare's normal orange-cloud DNS proxy because
the tunnel daemon dials *out* to Cloudflare's edge — Railway never has to
expose a public port, and Cloudflare's edge doesn't need to know the
container's IP. This also means HSTS / cert warnings about the wrong cert
issuer mean the tunnel daemon isn't running, not that the domain is hijacked.

Architecture:

```
user ─▶ Cloudflare edge (HTTPS, *.yourdomain.com, Google Trust Services cert)
            │
            └─▶ cloudflared daemon (inside the Railway container)
                    │
                    └─▶ Node + Express + discord.js
                         ├─ Discord WebSocket (bot)
                         └─ Express app: /auth, /auth/callback, /health
```

### 1a. Push the repo to GitHub

Railway deploys from a Git repo. If this code isn't on GitHub yet, push it now (the
existing `.gitignore` already excludes `.env` and `service-account-key.json`).

### 1b. Create the Railway service

1. Sign in at https://railway.com (free; needs a credit card on file but you won't
   be charged until you exceed the trial credit).
2. **New Project** → **Deploy from GitHub repo** → select this repo.
3. Railway auto-detects Node and starts building. The `railway.toml` in this repo
   pins the start command to `cloudflared tunnel run discord-bot & node src/index.js`,
   installs `cloudflared` via nixpacks apt, and points the healthcheck at `/health`.
4. Once the first deploy finishes, Railway gives you a generated URL like
   `https://discord-role-bot-production.up.railway.app`. You won't use this URL
   directly — Cloudflare's edge will be the public front door — but it's a
   useful sanity check that the container started.

**Free-tier notes:** Railway gives every account a monthly usage credit (currently
$5). A small Discord bot like this typically uses $1–2/month — well under the
limit. There are no cold-starts (unlike Render's free tier); the service stays up
continuously. As long as you stay within the monthly credit, you pay $0.

### 1c. Fill in the environment variables

In the Railway dashboard → your service → **Variables** tab, click **+ New Variable**
and add each of the following. (Railway has no equivalent of Render's Blueprint
auto-population; you type them in once and they're stored encrypted.)

| Key | Where to get the value |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → app → Bot |
| `DISCORD_GUILD_ID` | Discord: right-click your server icon → Copy Server ID |
| `DISCORD_CLIENT_ID` | Discord Developer Portal → app → General Information |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials → your OAuth client |
| `GOOGLE_CLIENT_SECRET` | same |
| `SPREADSHEET_ID` | The long ID in your Google Sheet URL |
| `PUBLIC_BASE_URL` | `https://<your-cloudflare-hostname>` (set up in step 1e) |
| `GOOGLE_REDIRECT_URI` | `${PUBLIC_BASE_URL}/auth/callback` |
| `SESSION_SECRET` | A long random string. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

The remaining variables in `.env.example` (`PORT`, `CONFIG_CACHE_TTL_MS`, the three
sheet-name vars) have sensible defaults baked into the code, but you can override
them in the Variables tab if you want.

### 1d. Add the Google service-account key as a single Variable

Unlike Render, Railway doesn't have a "Secret File" feature — every value is a
string. So instead of a file path, paste the entire contents of the service-account
JSON file into a single Variable:

1. Open your service-account JSON file in a text editor. Copy the entire contents
   (one long line is fine; multi-line also works in Railway's UI).
2. Railway dashboard → your service → **Variables** → **+ New Variable**:
   - **Name:** `GOOGLE_SERVICE_ACCOUNT_KEY`
   - **Value:** paste the JSON contents
3. Leave `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` unset (or set it to nothing) — the code
   reads `GOOGLE_SERVICE_ACCOUNT_KEY` first and only falls back to the file path
   when that one isn't set, so local dev with a file still works.

The modified `src/sheets.js` handles both forms — see the top of `getSheetsClient()`.

### 1e. Put Cloudflare in front of Railway (via Cloudflare Tunnel)

We don't use Cloudflare's normal orange-cloud DNS proxy here, because the bot
needs long-lived outbound WebSocket connections to Discord and Railway's
internal networking is happier when Cloudflare connects *into* the service
rather than being routed to a public IP. So we run a **Cloudflare Tunnel**
(`cloudflared`) inside the Railway container.

1. Sign in at https://dash.cloudflare.com → **Add a site** → enter your domain
   (e.g. `yourdomain.com`). Cloudflare gives you two nameservers; set those as
   the nameservers at your domain registrar (Namecheap, GoDaddy, etc.).
2. Wait for the nameservers to propagate (usually <1 hour, can take up to 24h).
3. **One-time, on your local machine** (any machine with `cloudflared`
   installed — see the install hint below):

   ```bash
   cloudflared tunnel login                                       # opens a browser to authorize
   cloudflared tunnel create discord-bot                          # gives you a UUID; save it
   cloudflared tunnel route dns discord-bot discord-bot.yourdomain.com
   ```

   The third command writes the correct CNAME into Cloudflare DNS for you
   (`discord-bot` → `<UUID>.cfargotunnel.com`, Proxied). You don't need to
   touch DNS by hand.

   > **Install hint:** `cloudflared` is not in apt by default. Easiest path:
   > `curl -fsSL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && sudo install -m 755 cloudflared /usr/local/bin/cloudflared`.

4. **Get a token for Railway to use:**
   ```bash
   cloudflared tunnel token discord-bot
   ```
   Copy the long opaque string it prints.

5. In Railway → your service → **Variables**, add:
   ```
   TUNNEL_TOKEN=<the long string from step 4>
   ```
   (Also make sure `PUBLIC_BASE_URL` is `https://discord-bot.yourdomain.com`
   and `GOOGLE_REDIRECT_URI` is `https://discord-bot.yourdomain.com/auth/callback`.)

6. The repo's `railway.toml` already runs `cloudflared tunnel run discord-bot`
   alongside `node src/index.js` and installs `cloudflared` via nixpacks apt
   packages. You do not need to change the start command — Railway redeploys
   automatically when `railway.toml` changes.

7. Confirm everything is connected:
   - **Cloudflare Zero Trust → Networks → Tunnels** shows `discord-bot` as
     **Healthy** (green dot, ≥1 active connection).
   - Railway deploy logs include lines like `Registered tunnel connection` from
     `cloudflared`.
   - `https://discord-bot.yourdomain.com/health` returns `ok`.

If the tunnel ever shows **Inactive** or Chrome shows **Error 1033**, the
tunnel daemon inside the Railway container isn't connecting — check the
Railway deploy logs for `cloudflared` errors first. The most common cause is
a missing or stale `TUNNEL_TOKEN`; regenerate it locally with
`cloudflared tunnel token discord-bot` and paste the new value into Railway.

> **Why this matters for HSTS / cert warnings:** when the tunnel daemon is
> healthy, Cloudflare's edge serves a real `*.yourdomain.com` cert (issued by
> Google Trust Services) for `discord-bot.yourdomain.com`. If you instead see
> Firefox warning about an unrelated cert (e.g. `*.sucuri.net`) or Chrome
> showing 1033, the tunnel isn't actually connected — it's a connectivity
> problem, not a real security incident.

### 1f. Update the Google OAuth redirect URI

In Google Cloud Console → APIs & Services → Credentials → your OAuth client →
**Authorized redirect URIs**, add:
```
https://discord-bot.yourdomain.com/auth/callback
```
(You can keep the old localhost one for local dev, or remove it.)

### 1g. Verify

- `https://discord-bot.yourdomain.com/health` returns `ok`.
- `/register` in Discord DMs you a link that starts with `https://discord-bot.yourdomain.com/auth?...`
- Clicking the link goes to Google's consent screen with the right redirect URI.

**Cost:** $0. Railway free trial credit + Cloudflare free tier. You'll only be
charged if you exceed Railway's monthly credit (a Discord bot this small won't).

### 1h. (Optional) Local development

You can still run the bot on your Ubuntu machine against the same Railway URLs
if you want to test a code change without redeploying. In that case, run:

```bash
cp .env.example .env
# edit .env — leave GOOGLE_SERVICE_ACCOUNT_KEY blank, set GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./service-account-key.json
# PUBLIC_BASE_URL still points at the Cloudflare hostname
node src/index.js
```

`discord.js` will connect to Discord and the local Express app will respond to
the Cloudflare-fronted URL. Useful for testing slash-command changes before
pushing them.

---

## 2. Google Cloud Console setup

1. Go to https://console.cloud.google.com → create a project (or reuse one).
2. **Enable APIs**: search for and enable the **Google Sheets API**.
3. **OAuth consent screen** (APIs & Services → OAuth consent screen):
   - User type: **External**
   - Scopes: add `openid`, `email`, `profile` (these are non-sensitive scopes — no
     Google verification/review process required for normal usage volumes)
   - Add yourself and any testers under "Test users" if the app stays in "Testing"
     publishing status (fine for an internal server bot — no need to publish to
     production unless you want to skip the test-user allowlist).
4. **Create OAuth Client ID** (APIs & Services → Credentials → Create Credentials → OAuth client ID):
   - Application type: **Web application**
   - Authorized redirect URI: `https://discord-bot.yourdomain.com/auth/callback`
     (use the Cloudflare hostname you set up in step 1e, NOT the
     `*.up.railway.app` URL — Google's redirect URI must match the hostname
     the user actually sees in their browser)
   - Save the **Client ID** and **Client Secret** → goes in `.env`.
5. **Create a Service Account** (APIs & Services → Credentials → Create Credentials → Service account):
   - No special role needed at the project level.
   - After creating it, go to its **Keys** tab → Add Key → JSON → download it.
   - Save this file as `service-account-key.json` in the bot's project root (or
     wherever you set `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`).
6. **Share your Google Sheet** with the service account's email address (it looks like
   `something@your-project.iam.gserviceaccount.com`) — give it **Editor** access, same
   as sharing with a normal person.

---

## 3. Discord setup

1. Go to https://discord.com/developers/applications → New Application.
2. **Bot** tab → Add Bot → copy the **Token** → goes in `.env` as `DISCORD_BOT_TOKEN`.
3. Under **Privileged Gateway Intents**, enable **Server Members Intent** (required to
   fetch members and change nicknames).
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Manage Roles`, `Manage Nicknames`, `Send Messages` (for DMs no
     special permission needed, DMs work regardless of server permissions)
   - Open the generated URL and invite the bot to your server.
5. **Important — role hierarchy**: in Server Settings → Roles, drag the bot's own role
   **above** every role it needs to assign (Core Team, HOUSE, etc.). Discord silently
   refuses role/nickname changes if the bot's role is lower than the target role, or if
   targeting a member with a higher role than the bot.
6. Get your **Server (Guild) ID**: enable Developer Mode (User Settings → Advanced),
   then right-click your server icon → Copy Server ID.
7. Get your **Application (Client) ID**: General Information tab of your application.

### Role IDs go in the CONFIG sheet, not a config file

You're managing role IDs directly in your spreadsheet's **CONFIG** tab:

| Col | Meaning |
|---|---|
| A | Role Name |
| B | Discord Role UUID |
| C | Shared Drive UUID *(unused by this bot)* |

Row 1 = headers, data starts row 2. This is also the source feeding your `ROLES!H` formula
(`=TRANSPOSE(QUERY(CONFIG!A3:A, ...))`), so role names will always match exactly between
the two sheets as long as you don't hand-edit one side inconsistently.

To add or change a role mapping: just add/edit a row in CONFIG with the Role Name (must
match the text Discord shows for that role, and must match what appears in `ROLES!H` etc.)
and paste in the role's Discord ID (right-click the role in Discord → Copy Role ID).

The bot **caches** this mapping in memory for 5 minutes by default (configurable via
`CONFIG_CACHE_TTL_MS` in `.env`) to avoid hitting the Sheets API on every single lookup.
If you've just updated CONFIG and don't want to wait, run **`/refresh-roles`** in Discord
(admin-only — requires Manage Roles permission) to force an immediate refresh.

Don't forget: **Core Team** still needs a row in CONFIG too (Role Name = `Core Team`),
since it's looked up the same way as every other role.

---

## 4. Configure the bot

1. Make sure the service account (from step 2 above) has Editor access to the whole
   spreadsheet — it needs to read CONFIG, ROLES, and BASE DATA.
2. Fill in role IDs directly in the **CONFIG** sheet tab (see below) — no code file to edit.
3. Railway reads env vars from the **Variables** tab in the dashboard. The full
   list with explanations is in `.env.example`.
4. Any local dev (optional) uses `.env` directly:
   ```bash
   cp .env.example .env
   # edit .env — leave GOOGLE_SERVICE_ACCOUNT_KEY blank,
   # set GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./service-account-key.json
   npm install
   node src/index.js
   ```
   For production, deploys to Railway handle everything — no `pm2`, no
   `cloudflared`, no systemd. Pushing to `main` on GitHub triggers an
   automatic redeploy (Railway's default behaviour).

---

## 5. Sheet structure assumptions

**ROLES sheet** (header row auto-detected by finding the row containing "Email"):
| Col | Meaning |
|---|---|
| C | Full name |
| D | Nickname |
| E | Email |
| F | Core Team checkbox |
| G | IT checkbox (informational only — ignored by the bot) |
| H+ | Role columns — header text = role name. Non-empty cell = assign that role. Cell value of exactly `.` = assign role but don't add `#RoleName` tag to nickname. |

**BASE DATA sheet** (first row = headers):
| Col | Meaning |
|---|---|
| A | Protect/skip flag — if checked, bot will not modify this row (but still applies Discord changes) |
| I (or wherever "discord_id" header is) | Discord user ID, written/overwritten by the bot |

The bot detects columns by header text where possible (not rigid letter positions), so
minor sheet rearrangement won't break it — but the **"Email"** header text and a
**"discord_id"**-ish header must exist for detection to work.

---

## 6. Testing checklist

- [ ] `https://discord-bot.yourdomain.com/health` returns `ok`
- [ ] `/register` in Discord sends you a DM with a link starting with
      `https://discord-bot.yourdomain.com/auth?...`
- [ ] Clicking the link shows Google's consent screen, not an error
- [ ] After consenting, you get redirected to a simple "you can close this" page
- [ ] You receive a follow-up DM with the embed and Confirm/Deny buttons
- [ ] Confirming actually changes your nickname and adds roles in the server
- [ ] BASE DATA sheet gets a new row with your discord_id
- [ ] Running `/register` again with the same account correctly **overwrites** the
      existing BASE DATA row (not protected) or **skips it** (if column A is checked)
- [ ] A duplicate-email test row in ROLES correctly triggers the "contact admin" message
- [ ] An email not present in ROLES correctly triggers the "not found" message
- [ ] Editing a role ID in CONFIG and running `/refresh-roles` picks up the change
      without needing a bot restart
- [ ] (Railway) A push to `main` on GitHub triggers an automatic redeploy

---

## Notes / things you may want to revisit later

- Currently only users who run `/register` are processed — I did not wire up an
  automatic "on member join" trigger, since you'd presumably still want them to
  explicitly consent to Google sign-in. Let me know if you'd like the bot to also DM
  new members proactively with the registration link on join.
- The OAuth flow opens in the **system browser**, not a true in-Discord popup — Discord
  doesn't support embedding OAuth popups inside the client; this is the standard
  pattern every Discord bot with "sign in with X" uses.
- Pending registration state (between sign-in and confirm/deny) is kept in memory. If
  you restart the bot mid-flow, an in-progress registration will need to be redone via
  `/register`. Fine for normal usage; let me know if you want this persisted instead.
