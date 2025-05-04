const express = require('express');
const fs = require('fs');
const path = require('path');
const geoip = require('geoip-lite');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const UAParser = require('ua-parser-js');
const axios = require('axios'); // Added for API requests
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const logFile = path.join(__dirname, 'tracking-log.json');
const trackingData = {}; // In-memory cache

// 📮 Email transporter config
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

// Configure your preferred geolocation API
const IPINFO_TOKEN = process.env.IPINFO_TOKEN; // Get token from https://ipinfo.io
const IP_API_ENABLED = true; // Free alternative without token needed

// 📘 Logging utility
function logTrackingEvent(trackingId, event) {
  const timestamp = new Date().toISOString();
  const logEntry = { trackingId, timestamp, ...event };

  fs.readFile(logFile, (err, data) => {
    let logs = [];
    if (!err && data.length > 0) {
      try { logs = JSON.parse(data); } catch (_) {}
    }
    logs.push(logEntry);

    fs.writeFile(logFile, JSON.stringify(logs, null, 2), (err) => {
      if (err) console.error('Error writing log:', err);
    });
  });

  if (!trackingData[trackingId]) trackingData[trackingId] = [];
  trackingData[trackingId].push(logEntry);
}

// 📍 Enhanced IP Geolocation
async function getGeolocation(ip) {
  // Skip geolocation for localhost/private IPs
  if (ip === '::1' || ip === 'localhost' || ip === '127.0.0.1') {
    return {
      country: 'localhost',
      region: 'local',
      city: 'local',
      latitude: null,
      longitude: null
    };
  }

  // First try ipinfo.io (more accurate)
  try {
    if (IPINFO_TOKEN) {
      const response = await axios.get(`https://ipinfo.io/${ip}?token=${IPINFO_TOKEN}`);
      if (response.data) {
        // If location data contains coordinates in "lat,lng" format
        const coords = response.data.loc ? response.data.loc.split(',') : [null, null];
        return {
          country: response.data.country || 'unknown',
          region: response.data.region || '',
          city: response.data.city || '',
          latitude: coords[0] ? parseFloat(coords[0]) : null,
          longitude: coords[1] ? parseFloat(coords[1]) : null
        };
      }
    }
  } catch (error) {
    console.warn('ipinfo.io lookup failed:', error.message);
  }

  // Second try ip-api.com (free alternative)
  if (IP_API_ENABLED) {
    try {
      const response = await axios.get(`http://ip-api.com/json/${ip}`);
      if (response.data && response.data.status === 'success') {
        return {
          country: response.data.countryCode || 'unknown',
          region: response.data.regionName || '',
          city: response.data.city || '',
          latitude: response.data.lat || null,
          longitude: response.data.lon || null
        };
      }
    } catch (error) {
      console.warn('ip-api.com lookup failed:', error.message);
    }
  }

  // Fallback to geoip-lite (least accurate)
  const geo = geoip.lookup(ip);
  if (geo) {
    return {
      country: geo.country || 'unknown',
      region: geo.region || '',
      city: geo.city || '',
      latitude: geo.ll?.[0] || null,
      longitude: geo.ll?.[1] || null
    };
  }

  // Default empty response if all methods fail
  return {
    country: 'unknown',
    region: '',
    city: '',
    latitude: null,
    longitude: null
  };
}

// 📌 Serve pixel endpoint
app.get('/pixel/:id.png', async (req, res) => {
  const trackingId = req.params.id;

  let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();

  const userAgent = req.headers['user-agent'] || 'unknown';
  const referer = req.headers['referer'] || 'unknown';

  const ua = new UAParser(userAgent);
  const browser = ua.getBrowser();
  const device = ua.getDevice();
  const os = ua.getOS();

  // Get geolocation with improved reliability
  const location = await getGeolocation(ip);

  const trackingInfo = {
    type: 'open',
    ip,
    referer,
    location,
    device: {
      browser: `${browser.name || 'unknown'} ${browser.version || ''}`,
      os: `${os.name || 'unknown'} ${os.version || ''}`,
      model: device.model || 'unknown',
      type: device.type || 'unknown'
    }
  };

  logTrackingEvent(trackingId, trackingInfo);

  // Return a 1x1 transparent GIF
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(pixel);
});

// ✉️ Send email with pixel
app.get('/send-email', async (req, res) => {
  const { to, subject, text } = req.query;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });

  try {
    const trackingId = uuidv4();
    const trackingPixelUrl = `${req.protocol}://${req.get('host')}/pixel/${trackingId}.png`;

    const html = `
      <div>
        <p>${text || 'This is a tracked email.'}</p>
        <img src="${trackingPixelUrl}" width="1" height="1" style="display:none;" />
      </div>
    `;

    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject: subject || 'Tracked Email',
      text: text || 'Open this email to trigger tracking.',
      html
    });

    logTrackingEvent(trackingId, {
      type: 'sent',
      recipientEmail: to,
      subject,
      messageId: info.messageId
    });

    res.json({ success: true, trackingId, messageId: info.messageId });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

// 📂 Retrieve tracking logs
app.get('/tracking-logs', (req, res) => {
  fs.readFile(logFile, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading log file:', err);
      return res.status(500).json({ error: 'Unable to read log file' });
    }

    try {
      const logs = JSON.parse(data);
      res.json({ success: true, logs });
    } catch (parseError) {
      res.status(500).json({ error: 'Error parsing logs' });
    }
  });
});

// 📊 Dashboard endpoint
app.get('/dashboard', (req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'dashboard.html'), 'utf8', (err, data) => {
    if (err) {
      return res.status(500).send('Dashboard not available');
    }
    res.send(data);
  });
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
  console.log(`🚀 Enhanced email tracker running at http://localhost:${port}`);
  console.log(`📊 Dashboard available at http://localhost:${port}/dashboard`);
});