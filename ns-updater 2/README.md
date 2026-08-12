# NS Bulk Updater

Bulk-update your domains' nameservers to Cloudflare. For each domain the app:

1. Adds (or finds) the domain as a **zone in Cloudflare** and reads back the nameservers Cloudflare assigns.
2. Pushes those nameservers to your **registrar** (Spaceship, Namecheap, GoDaddy, Porkbun, or Dynadot).

All API calls run **server-side** (Node/Express), so registrar APIs that block browser requests (CORS) work fine.

---

## Run locally

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000

---

## Deploy on Render

1. Push this folder to a **GitHub repo**.
2. In Render, click **New → Web Service** and connect that repo.
3. Render auto-detects Node. Confirm these settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
4. Click **Create Web Service**. When the build finishes you'll get a public URL.

Render sets the `PORT` environment variable automatically — the server already reads it.

### Debugging on Render
- Open your service → **Logs** tab to see live server output (every request and error is logged there).
- **Events** tab shows build/deploy history.
- If a build fails, the Logs tab shows the npm error. Most common fix: make sure `package.json` is in the repo root.

---

## Push to GitHub (quick reference)

```bash
git init
git add .
git commit -m "NS bulk updater"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ns-updater.git
git push -u origin main
```

---

## Notes per registrar

| Registrar  | Credentials needed              | Notes |
|------------|---------------------------------|-------|
| Spaceship  | API Key + Secret                | Scopes: `domains:read`, `domains:write` |
| Namecheap  | Username + API Key + Client IP  | Your **server's** IP must be whitelisted. On Render, add the service's static outbound IP (Settings → find the outbound IPs) to Namecheap's API whitelist. |
| GoDaddy    | API Key + Secret                | Use Production keys, not OTE/Sandbox. |
| Porkbun    | API Key + Secret API Key        | Enable API access per-domain in Porkbun. |
| Dynadot    | API Key                         | Rate-limited to ~200 requests/day. |

## Cloudflare token
Create a **scoped API token** (not the Global API Key) with **Zone → Zone → Edit** permission. You also need your **Account ID** (found on any zone's Overview page, right sidebar).

---

## Security note
Credentials are entered in the browser and sent to your own server only for each request — they are **not stored** anywhere. Since this deployment is yours, that's fine. Don't share the public URL with people you don't trust, or add your own login in front of it.
