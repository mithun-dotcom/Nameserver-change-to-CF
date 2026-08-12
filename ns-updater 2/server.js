// ─────────────────────────────────────────────────────────
//  NS Bulk Updater — backend server
//  Serves the web UI and proxies all API calls server-side
//  (so registrar APIs don't get blocked by browser CORS).
// ─────────────────────────────────────────────────────────

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ─── Cloudflare: create zone (or fetch existing) → return nameservers ───
async function getCloudflareNS({ domain, cfToken, cfAccount, zoneType }) {
  if (!cfToken || !cfAccount) throw new Error("Missing Cloudflare credentials");

  // Try to create the zone
  let res = await fetch("https://api.cloudflare.com/client/v4/zones", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: domain,
      account: { id: cfAccount },
      type: zoneType || "full",
    }),
  });
  let json = await res.json();

  if (json.success && json.result?.name_servers?.length) {
    return json.result.name_servers;
  }

  // Zone already exists (error 1061) → fetch it instead
  const exists = json.errors?.some(
    (e) => e.code === 1061 || /already exists/i.test(e.message || "")
  );
  if (exists) {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${cfToken}` } }
    );
    json = await res.json();
    if (json.success && json.result?.[0]?.name_servers?.length) {
      return json.result[0].name_servers;
    }
  }

  throw new Error(json.errors?.[0]?.message || "Could not get Cloudflare nameservers");
}

// ─── Registrar handlers ───────────────────────────────────

async function setSpaceship({ domain, ns, creds }) {
  const { key, secret } = creds;
  if (!key || !secret) throw new Error("Missing Spaceship credentials");
  const res = await fetch(`https://spaceship.dev/api/v1/domains/${domain}/nameservers`, {
    method: "PUT",
    headers: {
      "X-API-Key": key,
      "X-API-Secret": secret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ nameservers: ns.map((h) => ({ host: h })) }),
  });
  if (res.ok) return "NS set at registrar";
  const j = await res.json().catch(() => ({}));
  throw new Error(j.message || `HTTP ${res.status}`);
}

async function setNamecheap({ domain, ns, creds }) {
  const { user, key, ip } = creds;
  if (!user || !key || !ip) throw new Error("Missing Namecheap credentials");
  const parts = domain.split(".");
  const tld = parts.slice(-1)[0];
  const sld = parts.slice(0, -1).join(".");
  const p = new URLSearchParams({
    ApiUser: user,
    ApiKey: key,
    UserName: user,
    ClientIp: ip,
    Command: "namecheap.domains.dns.setCustom",
    SLD: sld,
    TLD: tld,
    Nameservers: ns.join(","),
  });
  const res = await fetch(`https://api.namecheap.com/xml.response?${p}`);
  const text = await res.text();
  if (text.includes('Status="OK"')) return "NS set at registrar";
  throw new Error(text.match(/Description="([^"]+)"/)?.[1] || "Namecheap API error");
}

async function setGoDaddy({ domain, ns, creds }) {
  const { key, secret } = creds;
  if (!key || !secret) throw new Error("Missing GoDaddy credentials");
  const res = await fetch(`https://api.godaddy.com/v1/domains/${domain}`, {
    method: "PATCH",
    headers: {
      Authorization: `sso-key ${key}:${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ nameServers: ns }),
  });
  if (res.ok) return "NS set at registrar";
  const j = await res.json().catch(() => ({}));
  throw new Error(j.message || `HTTP ${res.status}`);
}

async function setPorkbun({ domain, ns, creds }) {
  const { key, secret } = creds;
  if (!key || !secret) throw new Error("Missing Porkbun credentials");
  const res = await fetch(`https://api.porkbun.com/api/json/v3/domain/updateNs/${domain}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: key, secretapikey: secret, ns }),
  });
  const j = await res.json();
  if (j.status === "SUCCESS") return "NS set at registrar";
  throw new Error(j.message || "Porkbun API error");
}

async function setDynadot({ domain, ns, creds }) {
  const { key } = creds;
  if (!key) throw new Error("Missing Dynadot API key");
  const p = new URLSearchParams({ key, command: "set_ns", domain });
  ns.forEach((n, i) => p.append("ns" + i, n));
  const res = await fetch(`https://api.dynadot.com/api3.json?${p}`);
  const j = await res.json();
  if (j?.SetNsResponse?.ResponseCode === "0") return "NS set at registrar";
  throw new Error(j?.SetNsResponse?.Error || "Dynadot API error");
}

const REGISTRARS = {
  spaceship: setSpaceship,
  namecheap: setNamecheap,
  godaddy: setGoDaddy,
  porkbun: setPorkbun,
  dynadot: setDynadot,
};

// ─── Main endpoint: process ONE domain ────────────────────
app.post("/api/process", async (req, res) => {
  const { domain, registrar, cfToken, cfAccount, zoneType, creds } = req.body || {};

  if (!domain) return res.status(400).json({ ok: false, message: "No domain provided" });
  const handler = REGISTRARS[registrar];
  if (!handler) return res.status(400).json({ ok: false, message: "Unknown registrar" });

  try {
    // 1. Get nameservers from Cloudflare
    const ns = await getCloudflareNS({ domain, cfToken, cfAccount, zoneType });
    // 2. Push them to the registrar
    const message = await handler({ domain, ns, creds: creds || {} });
    return res.json({ ok: true, ns, message });
  } catch (err) {
    return res.json({ ok: false, message: err.message || "Unknown error" });
  }
});

// Health check (Render pings this)
app.get("/healthz", (_req, res) => res.send("ok"));

// Fallback → serve the UI
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`NS Bulk Updater running on port ${PORT}`);
});
