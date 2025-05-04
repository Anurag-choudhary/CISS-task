const express = require('express');
const fs = require('fs');
const path = require('path');
const geoip = require('geoip-lite');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const UAParser = require('ua-parser-js');
const { SuperfaceClient } = require('@superfaceai/one-sdk');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const logFile = path.join(__dirname, 'tracking-log.json');
const trackingData = {}; // In-memory cache

const sdk = new SuperfaceClient();

// 📮 Email transporter config
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

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

// 📍 IP Geolocation fallback using Superface
async function getGeoFromSuperface(ip) {
  try {
    const profile = await sdk.getProfile('address/ip-geolocation');
    const result = await profile.getUseCase('IpGeolocation').perform(
      { ipAddress: ip },
      {
        provider: 'ipdata' // you can change to 'ipgeolocation', 'ipwhois', etc.
      }
    );

    if (result.isOk()) {
      const data = result.unwrap();
      return {
        country: data.country || 'unknown',
        region: data.region || '',
        city: data.city || '',
        latitude: data.latitude || null,
        longitude: data.longitude || null
      };
    } else {
      console.warn('Superface IP lookup failed:', result.error);
      return null;
    }
  } catch (err) {
    console.error('Superface error:', err.message);
    return null;
  }
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

  // Primary: geoip-lite
  let geo = geoip.lookup(ip);
  let location = {
    country: geo?.country || 'unknown',
    region: geo?.region || '',
    city: geo?.city || '',
    latitude: geo?.ll?.[0] || null,
    longitude: geo?.ll?.[1] || null
  };

  // Fallback if city or region is missing
  if (!location.region || !location.city) {
    const superfaceLocation = await getGeoFromSuperface(ip);
    if (superfaceLocation) {
      location = { ...location, ...superfaceLocation };
    }
  }

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

app.listen(port, () => {
  console.log(`🚀 Email tracker with Superface running at http://localhost:${port}`);
});
