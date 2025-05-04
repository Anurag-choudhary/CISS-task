const express = require('express');
const fs = require('fs');
const path = require('path');
const geoip = require('geoip-lite');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const UAParser = require('ua-parser-js');
const axios = require('axios');
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
  // Skip geolocation for known proxy IPs
  if (isProxyIP(ip)) {
    return {
      country: 'Email Proxy',
      region: 'Email Client',
      city: 'Proxy Server',
      latitude: null,
      longitude: null,
      proxy: true
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

// Check if IP is likely an email service proxy
function isProxyIP(ip) {
  // Common ranges for Google/Gmail proxy servers
  const emailProxyRanges = [
    { start: '64.18.0.0', end: '64.18.15.255' },    // Yahoo
    { start: '65.54.190.0', end: '65.54.190.255' }, // Outlook/Hotmail
    { start: '66.102.0.0', end: '66.102.15.255' },  // Google
    { start: '72.14.192.0', end: '72.14.255.255' }, // Google
    { start: '74.125.0.0', end: '74.125.255.255' }, // Google
    { start: '209.85.128.0', end: '209.85.255.255' }, // Google
    { start: '216.33.229.0', end: '216.33.229.255' }, // AOL
    { start: '13.111.0.0', end: '13.111.255.255' }   // Apple
  ];
  
  const ipNum = ipToLong(ip);
  if (!ipNum) return false;
  
  return emailProxyRanges.some(range => {
    const startNum = ipToLong(range.start);
    const endNum = ipToLong(range.end);
    return ipNum >= startNum && ipNum <= endNum;
  });
}

// Convert IP to long for range comparison
function ipToLong(ip) {
  if (ip.includes(':')) return null; // Skip IPv6 addresses
  
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  
  return ((parseInt(parts[0], 10) << 24) |
          (parseInt(parts[1], 10) << 16) |
          (parseInt(parts[2], 10) << 8) |
          parseInt(parts[3], 10)) >>> 0;
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
    },
    isProxyDetected: isProxyIP(ip)
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

// 📋 Link tracking endpoint
app.get('/click/:id', async (req, res) => {
  const trackingId = req.params.id;
  const redirectUrl = req.query.url || '/';

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
    type: 'click',
    ip,
    referer,
    location,
    device: {
      browser: `${browser.name || 'unknown'} ${browser.version || ''}`,
      os: `${os.name || 'unknown'} ${os.version || ''}`,
      model: device.model || 'unknown',
      type: device.type || 'unknown'
    },
    redirectUrl
  };

  logTrackingEvent(trackingId, trackingInfo);
  
  // Redirect to the destination URL
  res.redirect(redirectUrl);
});

// ✉️ Send email with pixel and link tracking
app.get('/send-email', async (req, res) => {
  const { to, subject, text, redirect } = req.query;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });

  try {
    const trackingId = uuidv4();
    const domain = 'http://ciss-task.onrender.com'; // Replace with your domain
    
    // Create tracking links
    const trackingPixelUrl = `${domain}/pixel/${trackingId}.png`;
    const trackingLinkUrl = `${domain}/click/${trackingId}?url=${encodeURIComponent(redirect || 'https://example.com')}`;
    
    // Add unique identifiers to URLs to prevent caching
    const uniquePixelUrl = `${trackingPixelUrl}?v=${Date.now()}`;

    const html = `
      <div>
        <p>${text || 'This is a tracked email.'}</p>
        
        <!-- Tracking pixel -->
        <img src="${uniquePixelUrl}" width="1" height="1" alt="" style="display:none;" />
        
        <!-- Hidden backup tracking -->
        <div style="color:white;display:none;font-size:1px;">
          <img src="${uniquePixelUrl}" alt="" width="1" height="1" />
        </div>
        
        <!-- Track when user clicks -->
        <p>
          <a href="${trackingLinkUrl}">Click here for more information</a>
        </p>
        
        <!-- User-friendly footer -->
        <p style="font-size:11px;color:#999999;">
          This email contains tracking elements that help us improve our communication.
        </p>
      </div>
    `;

    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject: subject || 'Tracked Email',
      text: text || 'Open this email to trigger tracking.' + 
            '\n\nClick here for more information: ' + trackingLinkUrl,
      html
    });

    logTrackingEvent(trackingId, {
      type: 'sent',
      recipientEmail: to,
      subject,
      messageId: info.messageId
    });

    res.json({ 
      success: true, 
      trackingId, 
      messageId: info.messageId,
      note: "Email sent with both pixel and link tracking"
    });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

// 📊 Get tracking results for a specific ID
app.get('/tracking/:id', (req, res) => {
  const trackingId = req.params.id;
  
  if (trackingData[trackingId]) {
    return res.json({ 
      success: true,
      tracking: trackingData[trackingId]
    });
  }
  
  fs.readFile(logFile, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading log file:', err);
      return res.status(500).json({ error: 'Unable to read log file' });
    }

    try {
      const logs = JSON.parse(data);
      const trackingLogs = logs.filter(log => log.trackingId === trackingId);
      
      if (trackingLogs.length === 0) {
        return res.status(404).json({ error: 'No tracking data found for this ID' });
      }
      
      res.json({ success: true, tracking: trackingLogs });
    } catch (parseError) {
      res.status(500).json({ error: 'Error parsing logs' });
    }
  });
});

// 📂 Retrieve all tracking logs
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

// Start the server
app.listen(port, () => {
  console.log(`🚀 Enhanced email tracker running at http://localhost:${port}`);
});