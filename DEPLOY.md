# Putting wxboard online (NAS + Docker + Cloudflare Tunnel)

This runs wxboard on your NAS with sign-ins turned on. Visitors reach it at your own web address through
**Cloudflare Tunnel**. The tunnel connects out from your NAS to Cloudflare, so:

- you don't open any ports on your router;
- your home IP address stays hidden;
- you get HTTPS (the padlock) automatically.

You need a Cloudflare account (free), a domain name (about $10–15 a year), and a NAS that runs Docker
(Synology Container Manager, Unraid, TrueNAS, or plain Docker with `docker compose`).

Cloudflare's dashboard changes now and then, so menu names below may be slightly different.

---

## 1. Get a domain on Cloudflare

1. Sign up at https://dash.cloudflare.com.
2. Go to **Domain Registration → Register Domains**, search for a name and buy it. Cloudflare sells domains at cost.
3. Pick the address for the board, for example `wx.yourdomain.com`. You'll use it in steps 3 and 4.

## 2. Copy wxboard to the NAS

Make a folder on the NAS, for example `/volume1/docker/wxboard` on Synology, and copy the project into it
(a network share is fine). You don't need `data/`, `test/` or your Mac's `config.json`.

Inside that folder, create:

```
wxboard/
  docker-compose.yml   (already in the project)
  Dockerfile           (already in the project)
  .env                 (copy .env.example, fill in below)
  config/config.json   (your settings, below)
  data/                (empty folder; accounts and the NOTAM copy go here)
```

**`config/config.json`**: the settings for the public site. Replace the example values:

```json
{
  "contact": "your-email@example.com",
  "publicUrl": "https://wx.yourdomain.com",
  "auth": {
    "signup": "approval",
    "notams": "all",
    "sessionDays": 30
  },
  "nmsEnv": "prod",
  "nmsClientId": "YOUR NMS KEY",
  "nmsClientSecret": "YOUR NMS SECRET"
}
```

Sign-ins, the port and the proxy setting are already set in `docker-compose.yml`, so they aren't needed here.
Keep this file private; it holds your FAA keys.

**`.env`**: `PUID` and `PGID` are the owner of the `wxboard` folder on the NAS. Over SSH, `id` shows yours;
on Synology it's often `1026` / `100`. Leave `TUNNEL_TOKEN` empty for now.

> **Move the existing NOTAM copy, and stop the Mac's sync.** Copy `data/notams-prod.json` and
> `data/sync-prod.json` from your Mac into the NAS `data/` folder. That way the NAS doesn't start with a full
> download. Then either stop wxboard on your Mac or remove the NMS keys from the Mac's `config.json`. **Two copies
> using the same FAA keys would go over the FAA limits** (one update per 3 minutes, one full download per day) and
> get refused with HTTP 429.

## 3. Create the tunnel

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels** and choose **Create a tunnel**.
2. Pick **Cloudflared**, name it `wxboard`, and save.
3. On the install screen, choose **Docker**. It shows a command ending in `--token eyJ...`. Copy just that long
   token into `.env` as `TUNNEL_TOKEN=eyJ...`. You don't need to run the command.
4. Next, add a **Public hostname**:
   - Subdomain: `wx` · Domain: `yourdomain.com`
   - Service type: **HTTP** · URL: **`wxboard:8080`**
5. Save. The tunnel shows as *Inactive* until step 4 starts it.

## 4. Start it

Over SSH, in the `wxboard` folder:

```bash
docker compose up -d --build
```

On Synology, you can do this without SSH: **Container Manager → Project → Create**, choose the
`wxboard` folder, and it finds `docker-compose.yml`.

Check the log; it should say `Sign-in: on`:

```bash
docker compose logs wxboard
```

## 5. Create your admin account

```bash
docker compose exec wxboard node tools/admin.js create-admin yourname
```

It asks for a password (at least 10 characters). Then open `https://wx.yourdomain.com` and sign in.
Your account menu has an **Admin** link. Sign-up requests show up there for you to approve or reject, with a
count next to the link.

## Everyday tasks

| Task | How |
|---|---|
| Approve sign-ups | Admin page, or `docker compose exec wxboard node tools/admin.js approve <name>` |
| Forgotten password | `docker compose exec wxboard node tools/admin.js reset-password <name>`, then tell them the new one |
| List accounts | `docker compose exec wxboard node tools/admin.js list` |
| Change sign-up rules | Edit `"signup"` in `config/config.json` (`approval`, `open`, `invite`, `closed`), then `docker compose restart wxboard` |
| Change who sees NOTAMs | Edit `"notams"` (`all`, `admin`, `none`), then restart |
| Update wxboard | Copy the new code over (keep `config/`, `data/`, `.env`), then `docker compose up -d --build`. From the Mac: `./deploy.sh`. From Windows: commit, then `powershell -ExecutionPolicy Bypass -File .\deploy.ps1` (sends the last commit) |
| Back up | Copy the `data/` folder. `users.json` holds the accounts; `session.key` signs sign-ins (deleting it signs everyone out) |

## Optional extra protection in Cloudflare

- **Security → Bots → Bot Fight Mode**: on. Blocks a lot of automated junk before it reaches your NAS.
- **Security → WAF → Rate limiting rules**: a rule for paths `/login` and `/signup` adds a second limit at Cloudflare's
  edge. wxboard already limits sign-in attempts and sign-ups per visitor on its own.

## How it's protected

- Every page except sign-in, sign-up and the terms needs an approved account.
- Passwords are stored hashed (scrypt), never in plain text. Repeated wrong passwords lock that username and
  address out for 15 minutes.
- Sign-ins are cookies signed with a key only the server has. Changing a password, disabling an account or changing
  someone's admin status signs them out everywhere.
- Forms only work when posted from your own site, and each signed-in form carries a one-off token.
- Each user is limited to 30 briefs a minute, so one account can't use up the weather services' limits for everyone.
- wxboard isn't reachable on your home network or the internet except through the tunnel. To also use it at
  home without the tunnel, uncomment `ports` in `docker-compose.yml`.
