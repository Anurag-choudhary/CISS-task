const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const UAParser = require('ua-parser-js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const logFile = path.join(__dirname, 'tracking-log.json');

// Initialize or load tracking data
let trackingData = {};
try {
  if (fs.existsSync(logFile)) {
    const data = fs.readFileSync(logFile, 'utf8');
    if (data) trackingData = JSON.parse(data);
  }
} catch (err) {
  console.error('Error reading tracking data:', err);
}

// Setup email transporter (Gmail)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD // Use App Password for Gmail
  }
});

// Parse JSON and form data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Function to log tracking events
function logTrackingEvent(trackingId, event) {
  const timestamp = new Date().toISOString();
  const logEntry = { trackingId, timestamp, ...event };

  // Store in memory
  if (!trackingData[trackingId]) trackingData[trackingId] = [];
  trackingData[trackingId].push(logEntry);

  // Write to file
  fs.writeFileSync(logFile, JSON.stringify(trackingData, null, 2));
  
  return logEntry;
}

// Get geolocation from IP
async function getGeolocation(ip) {
  try {
    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    if (response.data && response.data.status === 'success') {
      return {
        country: response.data.country || 'unknown',
        region: response.data.regionName || '',
        city: response.data.city || '',
        latitude: response.data.lat || null,
        longitude: response.data.lon || null
      };
    }
  } catch (error) {
    console.warn('Geolocation lookup failed:', error.message);
  }
  
  return {
    country: 'unknown',
    region: '',
    city: '',
    latitude: null,
    longitude: null
  };
}

// Tracking pixel endpoint
app.get('/pixel/:id.png', async (req, res) => {
  const trackingId = req.params.id;
  const originalRecipient = req.query.recipient || 'unknown';
  const forwardFlag = req.query.forwarded === 'true';
  
  // Get IP and user agent
  let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  
  const userAgent = req.headers['user-agent'] || 'unknown';
  const referer = req.headers['referer'] || 'unknown';
  
  // Parse user agent
  const ua = new UAParser(userAgent);
  const browser = ua.getBrowser();
  const device = ua.getDevice();
  const os = ua.getOS();
  
  // Get location
  const location = await getGeolocation(ip);
  
  // Log the event
  logTrackingEvent(trackingId, {
    type: forwardFlag ? 'forward-open' : 'open',
    originalRecipient,
    ip,
    location,
    timestamp: new Date().toISOString(),
    device: {
      browser: `${browser.name || 'unknown'} ${browser.version || ''}`,
      os: `${os.name || 'unknown'} ${os.version || ''}`,
      model: device.model || 'unknown',
      type: device.type || 'unknown'
    }
  });
  
  // Return 1x1 transparent GIF
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

// Forward reporting endpoint
app.post('/report-forward', (req, res) => {
  const { trackingId, forwardedTo, forwardedFrom } = req.body;
  
  if (!trackingId || !forwardedTo) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  const event = logTrackingEvent(trackingId, {
    type: 'forward-report',
    forwardedTo,
    forwardedFrom: forwardedFrom || 'unknown',
    method: 'form-submission',
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true, message: 'Forward reported successfully', event });
});

// Forward reporting page
app.get('/report-forward/:id', (req, res) => {
  const trackingId = req.params.id;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Email Forward Report</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; }
        input { width: 100%; padding: 8px; box-sizing: border-box; }
        button { background: #4285f4; color: white; border: none; padding: 10px 15px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>You've received a forwarded email</h1>
      <p>Please let us know your email address:</p>
      
      <div class="form-group">
        <label for="email">Your Email:</label>
        <input type="email" id="email" required>
      </div>
      
      <div class="form-group">
        <label for="forwarder">Who forwarded this email to you? (optional)</label>
        <input type="text" id="forwarder">
      </div>
      
      <button onclick="submitForm()">Submit</button>
      
      <div id="status" style="margin-top: 20px;"></div>
      
      <script>
        function submitForm() {
          const email = document.getElementById('email').value;
          const forwarder = document.getElementById('forwarder').value;
          
          if (!email) {
            alert('Please enter your email address');
            return;
          }
          
          fetch('/report-forward', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              trackingId: '${trackingId}',
              forwardedTo: email,
              forwardedFrom: forwarder
            })
          })
          .then(response => response.json())
          .then(data => {
            document.getElementById('status').innerHTML = '<p style="color: green;">Thank you for your submission!</p>';
          })
          .catch(error => {
            document.getElementById('status').innerHTML = '<p style="color: red;">Error submitting your information.</p>';
          });
        }
      </script>
    </body>
    </html>
  `);
});

// Send email with tracking pixel
app.get('/send-email', async (req, res) => {
  const { to, subject = 'Important Information', text = 'Check out this information' } = req.query;
  
  if (!to) {
    return res.status(400).json({ error: 'Recipient email is required' });
  }
  
  try {
    const trackingId = uuidv4();
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    
    // Create tracking pixel URL with recipient info
    const pixelUrl = `${baseUrl}/pixel/${trackingId}.png?recipient=${encodeURIComponent(to)}&v=${Date.now()}`;
    const forwardPixelUrl = `${baseUrl}/pixel/${trackingId}.png?recipient=${encodeURIComponent(to)}&forwarded=true&v=${Date.now()}`;
    const reportForwardUrl = `${baseUrl}/report-forward/${trackingId}`;
    
    // Email HTML with tracking
    const html = `
      <div>
        <p>${text}</p>
        
        <!-- Hidden tracking pixel -->
        <img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;">
        
        <!-- Forward detection instructions -->
        <p style="font-size:12px; color:#777; margin-top:30px; border-top:1px solid #eee; padding-top:10px;">
          Want to share this email? 
          <a href="mailto:?subject=${encodeURIComponent('Fwd: ' + subject)}&body=${encodeURIComponent(
            'Forwarded message\n\n' + text + 
            '\n\n---\nIf you received this email, please let us know: ' + reportForwardUrl
          )}">Forward to a friend</a>
        </p>
        
        <!-- Secondary tracking pixel that only loads when forwarded -->
        <img src="${forwardPixelUrl}" width="1" height="1" alt="" style="display:none;">
      </div>
    `;
    
    // Send the email
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text: `${text}\n\n---\nIf you received this as a forward, please let us know: ${reportForwardUrl}`,
      html
    });
    
    // Log the send event
    logTrackingEvent(trackingId, {
      type: 'sent',
      recipientEmail: to,
      subject,
      messageId: info.messageId
    });
    
    res.json({
      success: true,
      trackingId,
      message: 'Email sent with tracking'
    });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email', details: error.message });
  }
});

// Get tracking results
app.get('/tracking/:id', (req, res) => {
  const trackingId = req.params.id;
  
  if (trackingData[trackingId]) {
    return res.json({
      success: true,
      tracking: trackingData[trackingId]
    });
  }
  
  res.status(404).json({ error: 'No tracking data found for this ID' });
});

// Start the server
app.listen(port, () => {
  console.log(`Email tracker running on http://localhost:${port}`);
});