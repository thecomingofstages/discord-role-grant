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

## 1. Expose your local server via Cloudflare Tunnel

This replaces any need for a VPS, public IP, or reverse proxy like Caddy. Cloudflare
Tunnel (`cloudflared`) runs on your existing machine and creates an outbound-only
encrypted connection to Cloudflare's edge — nothing is exposed directly from your home
network. Cloudflare handles HTTPS automatically.

### 1a. Install cloudflared

```bash
# Ubuntu / Debian (your setup)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

Verify: `cloudflared --version`

### 1b. Log in to Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser window. Select the domain you want to use (e.g. `yourdomain.com`).
It will save a certificate to `~/.cloudflared/cert.pem` automatically.

### 1c. Create the tunnel

```bash
cloudflared tunnel create discord-bot
```

This creates a tunnel and saves a credentials file to
`~/.cloudflared/<TUNNEL-UUID>.json`. Note the UUID printed — you'll need it in the next step.

### 1d. Create the tunnel config file

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>           # paste the UUID from above
credentials-file: /home/<your-username>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: discord-bot.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404   # catch-all required by cloudflared
```

Replace `<TUNNEL-UUID>`, `<your-username>`, and `yourdomain.com` with real values.

### 1e. Route DNS to the tunnel

```bash
cloudflared tunnel route dns discord-bot discord-bot.yourdomain.com
```

This adds a CNAME record in Cloudflare DNS automatically — no need to touch the
Cloudflare dashboard manually.

### 1f. Run the tunnel

```bash
cloudflared tunnel run discord-bot
```

To run it as a background service that starts on boot:

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

### 1g. Verify

Once the bot is running (step 4), visit:
`https://discord-bot.yourdomain.com/health` — should return `ok`.

**Cost:** Free. Cloudflare Tunnel is part of the free Cloudflare plan. No VPS needed.

> **Note for Google OAuth setup (step 2):** use `https://discord-bot.yourdomain.com/auth/callback`
> as the redirect URI — same as before, the tunnel makes this URL publicly reachable
> even though the bot runs locally.

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

1. Copy `.env.example` to `.env` and fill in every value.
2. Find your **Spreadsheet ID**: it's the long string in the sheet's URL between
   `/d/` and `/edit`.
3. Make sure the service account (from step 2 above) has Editor access to the whole
   spreadsheet — it needs to read CONFIG, ROLES, and BASE DATA.
4. Fill in role IDs directly in the **CONFIG** sheet tab (see below) — no code file to edit.
5. Install dependencies:
   ```bash
   npm install
   ```
6. Run the bot:
   ```bash
   node src/index.js
   ```
   For production, use a process manager so it survives reboots/crashes:
   ```bash
   npm install -g pm2
   pm2 start src/index.js --name discord-role-bot
   pm2 save
   pm2 startup
   ```

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
- [ ] `/register` in Discord sends you a DM with a working link
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
