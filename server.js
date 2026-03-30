const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Add domain to Cloudflare (create zone)
app.post('/api/cloudflare/add-zone', async (req, res) => {
  const { domain, cfApiKey, cfEmail } = req.body;
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/zones', {
      method: 'POST',
      headers: {
        'X-Auth-Email': cfEmail,
        'X-Auth-Key': cfApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: domain, jump_start: false }),
    });
    const data = await response.json();
    if (!data.success) {
      // Check if zone already exists
      if (data.errors && data.errors.some(e => e.code === 1061)) {
        // Zone already exists, fetch it
        const existing = await fetch(
          `https://api.cloudflare.com/client/v4/zones?name=${domain}`,
          {
            headers: {
              'X-Auth-Email': cfEmail,
              'X-Auth-Key': cfApiKey,
            },
          }
        );
        const existingData = await existing.json();
        if (existingData.success && existingData.result.length > 0) {
          const zone = existingData.result[0];
          return res.json({
            success: true,
            zoneId: zone.id,
            nameservers: zone.name_servers,
            alreadyExisted: true,
          });
        }
      }
      return res.json({ success: false, error: data.errors?.[0]?.message || 'Unknown error' });
    }
    res.json({
      success: true,
      zoneId: data.result.id,
      nameservers: data.result.name_servers,
      alreadyExisted: false,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Update nameservers on Spaceship
app.post('/api/spaceship/update-ns', async (req, res) => {
  const { domain, nameservers, ssApiKey, ssApiSecret } = req.body;
  try {
    const response = await fetch(`https://spaceship.dev/api/v1/domains/${domain}/nameservers`, {
      method: 'PUT',
      headers: {
        'X-Api-Key': ssApiKey,
        'X-Api-Secret': ssApiSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hosts: nameservers }),
    });

    if (response.status === 204) {
      return res.json({ success: true });
    }

    const data = await response.json();
    if (response.ok) {
      res.json({ success: true, data });
    } else {
      res.json({ success: false, error: data?.message || data?.errors?.[0]?.message || `HTTP ${response.status}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
