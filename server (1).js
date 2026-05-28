const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Cloudflare: get nameservers for a zone ───────────────────────────────────
async function getCloudflareNameservers(domain, cfEmail, cfApiKey) {
  // 1. Find the zone
  const zonesRes = await axios.get("https://api.cloudflare.com/client/v4/zones", {
    params: { name: domain },
    headers: {
      "X-Auth-Email": cfEmail,
      "X-Auth-Key": cfApiKey,
      "Content-Type": "application/json",
    },
  });
  if (!zonesRes.data.success || zonesRes.data.result.length === 0) {
    // Try to create the zone
    const createRes = await axios.post(
      "https://api.cloudflare.com/client/v4/zones",
      { name: domain, jump_start: false },
      {
        headers: {
          "X-Auth-Email": cfEmail,
          "X-Auth-Key": cfApiKey,
          "Content-Type": "application/json",
        },
      }
    );
    if (!createRes.data.success) {
      throw new Error("Failed to create Cloudflare zone: " + JSON.stringify(createRes.data.errors));
    }
    return createRes.data.result.name_servers;
  }
  return zonesRes.data.result[0].name_servers;
}

// ─── NAMECHEAP ────────────────────────────────────────────────────────────────
async function updateNamecheap(domain, nameservers, apiUser, apiKey, clientIp) {
  const [sld, tld] = domain.split(".");
  const ns = nameservers.map((n, i) => `Nameserver${i + 1}=${encodeURIComponent(n)}`).join("&");
  const url = `https://api.namecheap.com/xml.response?ApiUser=${apiUser}&ApiKey=${apiKey}&UserName=${apiUser}&ClientIp=${clientIp}&Command=namecheap.domains.dns.setCustom&SLD=${sld}&TLD=${tld}&${ns}`;
  const res = await axios.get(url);
  if (res.data.includes('Status="ERROR"') || res.data.includes("errors")) {
    throw new Error("Namecheap API error: " + res.data);
  }
  return { success: true, raw: res.data };
}

// ─── GODADDY ──────────────────────────────────────────────────────────────────
async function updateGodaddy(domain, nameservers, apiKey, apiSecret) {
  const nsPayload = nameservers.map((ns) => ({ nameServer: ns }));
  const res = await axios.put(
    `https://api.godaddy.com/v1/domains/${domain}/nameservers`,
    { nameServers: nameservers },
    {
      headers: {
        Authorization: `sso-key ${apiKey}:${apiSecret}`,
        "Content-Type": "application/json",
      },
    }
  );
  return { success: true, status: res.status };
}

// ─── PORKBUN ──────────────────────────────────────────────────────────────────
async function updatePorkbun(domain, nameservers, apiKey, secretApiKey) {
  const res = await axios.post(
    `https://porkbun.com/api/json/v3/domain/updateNs/${domain}`,
    { apikey: apiKey, secretapikey: secretApiKey, ns: nameservers }
  );
  if (res.data.status !== "SUCCESS") {
    throw new Error("Porkbun error: " + JSON.stringify(res.data));
  }
  return { success: true, message: res.data.message };
}

// ─── DREAMHOST ────────────────────────────────────────────────────────────────
async function updateDreamhost(domain, nameservers, apiKey) {
  // DreamHost doesn't have a direct NS update API — we remove old NS and add new
  const base = `https://api.dreamhost.com/?key=${apiKey}&format=json`;

  // List current nameservers
  const listRes = await axios.get(`${base}&cmd=dns.list_records&type=NS&editable=1`);
  const records = listRes.data.data || [];
  const domainNs = records.filter((r) => r.zone === domain && r.type === "NS");

  // Remove old ones
  for (const record of domainNs) {
    await axios.get(
      `${base}&cmd=dns.remove_record&record=${encodeURIComponent(record.record)}&type=NS&value=${encodeURIComponent(record.value)}`
    );
  }

  // Add new ones
  for (const ns of nameservers) {
    await axios.get(`${base}&cmd=dns.add_record&record=${encodeURIComponent(domain)}&type=NS&value=${encodeURIComponent(ns)}`);
  }

  return { success: true, nameservers };
}

// ─── DYNADOT ──────────────────────────────────────────────────────────────────
async function updateDynadot(domain, nameservers, apiKey) {
  const nsParams = nameservers
    .map((ns, i) => `ns${i}=${encodeURIComponent(ns)}`)
    .join("&");
  const url = `https://api.dynadot.com/api3.xml?key=${apiKey}&command=set_ns&domain=${domain}&${nsParams}`;
  const res = await axios.get(url);
  if (res.data.includes("<Status>error</Status>") || res.data.includes("<Status>Error</Status>")) {
    throw new Error("Dynadot API error: " + res.data);
  }
  return { success: true, raw: res.data };
}

// ─── SPACESHIP ────────────────────────────────────────────────────────────────
async function updateSpaceship(domain, nameservers, apiKey, apiSecret) {
  const res = await axios.put(
    `https://spaceship.dev/api/v1/dns/nameservers/${domain}`,
    { nameservers: nameservers.map((host) => ({ host })) },
    {
      headers: {
        "X-API-Key": apiKey,
        "X-API-Secret": apiSecret,
        "Content-Type": "application/json",
      },
    }
  );
  return { success: true, status: res.status };
}

// ─── Main Route ───────────────────────────────────────────────────────────────
app.post("/api/update-nameservers", async (req, res) => {
  const {
    registrar,
    domain,
    cfEmail,
    cfApiKey,
    // registrar-specific
    credentials,
  } = req.body;

  if (!registrar || !domain || !cfEmail || !cfApiKey || !credentials) {
    return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  try {
    // Step 1: Get Cloudflare nameservers
    const nameservers = await getCloudflareNameservers(domain, cfEmail, cfApiKey);

    // Step 2: Update at registrar
    let result;
    switch (registrar) {
      case "namecheap":
        result = await updateNamecheap(
          domain,
          nameservers,
          credentials.apiUser,
          credentials.apiKey,
          credentials.clientIp
        );
        break;
      case "godaddy":
        result = await updateGodaddy(domain, nameservers, credentials.apiKey, credentials.apiSecret);
        break;
      case "porkbun":
        result = await updatePorkbun(domain, nameservers, credentials.apiKey, credentials.secretApiKey);
        break;
      case "dreamhost":
        result = await updateDreamhost(domain, nameservers, credentials.apiKey);
        break;
      case "dynadot":
        result = await updateDynadot(domain, nameservers, credentials.apiKey);
        break;
      case "spaceship":
        result = await updateSpaceship(domain, nameservers, credentials.apiKey, credentials.apiSecret);
        break;
      default:
        return res.status(400).json({ success: false, error: `Unknown registrar: ${registrar}` });
    }

    return res.json({
      success: true,
      domain,
      registrar,
      nameservers,
      result,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message || "Unknown error",
    });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
