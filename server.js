// Cloudflare ⇆ Spaceship onboarder — backend (Render)
// Proxies API calls so the browser never hits Cloudflare/Spaceship directly (no CORS issues).
// Credentials are passed per-request and never stored or logged.

const express = require("express");
const app = express();
app.use(express.json({ limit: "1mb" }));

// --- CORS ---
// Set ALLOWED_ORIGIN in Render to your Netlify URL (e.g. https://your-site.netlify.app).
// Defaults to "*" so it works before you lock it down.
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const CF_API = "https://api.cloudflare.com/client/v4";
const SS_API = "https://spaceship.dev/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Cloudflare: create the zone, or fetch it if it already exists ---
async function cfCreateOrGetZone(domain, token, accountId, type) {
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const res = await fetch(CF_API + "/zones", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: domain, account: { id: accountId }, type }),
  });
  let data = {};
  try { data = await res.json(); } catch {}

  if (data.success) return { zone: data.result, created: true };

  // 1061 = zone already exists in this account → look it up and reuse it
  const exists = (data.errors || []).some((e) => e.code === 1061);
  if (exists) {
    const r2 = await fetch(CF_API + "/zones?name=" + encodeURIComponent(domain), { headers });
    let d2 = {};
    try { d2 = await r2.json(); } catch {}
    if (d2.success && d2.result && d2.result.length) return { zone: d2.result[0], created: false };
  }

  const msg = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || "zone create failed";
  throw new Error("Cloudflare — " + msg);
}

// --- Spaceship: repoint nameservers to custom (Cloudflare) hosts, with 429 backoff ---
async function ssSetNameservers(domain, hosts, key, secret) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${SS_API}/domains/${domain}/nameservers`, {
      method: "PUT",
      headers: { "X-API-Key": key, "X-API-Secret": secret, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "custom", hosts }),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const wait = parseInt(res.headers.get("retry-after") || "5", 10) * 1000;
      await sleep(wait);
      continue;
    }
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch {}
    throw new Error(`Spaceship — NS update ${res.status}${detail ? " · " + detail : ""}`);
  }
  throw new Error("Spaceship — rate limited (429) after retries");
}

// --- Health check ---
app.get("/", (_req, res) => res.json({ ok: true, service: "cf-spaceship-onboarder" }));

// --- Onboard a single domain: create CF zone → set Spaceship NS ---
app.post("/api/onboard", async (req, res) => {
  const { domain, cfToken, cfAccount, ssKey, ssSecret, type } = req.body || {};
  if (!domain || !cfToken || !cfAccount || !ssKey || !ssSecret) {
    return res.status(400).json({ status: "error", info: "Missing required fields" });
  }
  try {
    const { zone, created } = await cfCreateOrGetZone(domain, cfToken, cfAccount, type || "full");
    const ns = zone.name_servers || [];
    if (ns.length < 2) {
      throw new Error("Cloudflare returned no nameservers (zone status: " + zone.status + ")");
    }
    await ssSetNameservers(domain, ns, ssKey, ssSecret);
    res.json({
      status: created ? "done" : "exists",
      info: (created ? "Zone created · " : "Zone existed · ") + "NS → " + ns.join(", "),
      nameservers: ns,
    });
  } catch (err) {
    // 200 with an error payload so the frontend can render it per-row
    res.json({ status: "error", info: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("cf-spaceship-onboarder listening on " + PORT));
