const express = require('express');
const fs = require('fs');
const path = require('path');
const geoip = require('geoip-lite');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const UAParser = require('ua-parser-js');
require('dotenv').config();

const app = express();
const port = 3000;
const logFile = path.join(__dirname, 'tracking-log.json');
const trackingData = {}; // In-memory (can use DB for persistence)

// ✉️ Configure transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

// 📦 Utility: Log tracking event to JSON file
function logTrackingEvent(trackingId, event) {
  const timestamp = new Date().toISOString();
  const logEntry = { trackingId, timestamp, ...event };

  // Write to file
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

  // Optional in-memory usage
  if (!trackingData[trackingId]) trackingData[trackingId] = [];
  trackingData[trackingId].push(logEntry);
}

// 🎯 Endpoint: Serve tracking pixel
app.get('/pixel/:id.png', (req, res) => {
  const trackingId = req.params.id;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'unknown';
  const referer = req.headers['referer'] || 'unknown';

  const ua = new UAParser(userAgent);
  const browser = ua.getBrowser();
  const device = ua.getDevice();
  const os = ua.getOS();
  const geo = geoip.lookup(ip) || {};

  const trackingInfo = {
    type: 'open',
    ip,
    referer,
    location: {
      country: geo.country || 'unknown',
      region: geo.region || 'unknown',
      city: geo.city || 'unknown',
      latitude: geo.ll?.[0] || null,
      longitude: geo.ll?.[1] || null
    },
    device: {
      browser: `${browser.name || 'unknown'} ${browser.version || ''}`,
      os: `${os.name || 'unknown'} ${os.version || ''}`,
      model: device.model || 'unknown',
      type: device.type || 'unknown'
    }
  };

  logTrackingEvent(trackingId, trackingInfo);

  // Serve 1x1 transparent GIF
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(pixel);
});

// 📬 Endpoint: Send email with tracking pixel
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

app.listen(port, () => {
  console.log(`🚀 Email tracker running at http://localhost:${port}`);
});
