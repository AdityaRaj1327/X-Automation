require('dotenv').config();
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const axios = require('axios');
const proxyChain = require('proxy-chain');
const { setTimeout: sleep } = require('timers/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==================== CONFIGURATION ====================
const CONFIG = {
  mongodb: {
    uri: process.env.MONGO_URI
  },
  twitter: {
    email: process.env.TWITTER_EMAIL,
    username: process.env.TWITTER_USERNAME,
    password: process.env.TWITTER_PASSWORD
  },
  proxy: {
    host: process.env.PROXY_HOST || '195.201.248.211',
    port: process.env.PROXY_PORT || '12765',
    username: process.env.PROXY_USERNAME || 'digitalguruseven',
    password: process.env.PROXY_PASSWORD || 'dERmacYAstAR',
    rotateUrl: process.env.PROXY_ROTATE_URL || 'https://gridpanel.net/api/reboot?token=NDU5NjQsNDc1ZDZkYjUtNWUxMi00OTVjLWIzMzctY2NjMTYyNmNiNjFj',
    enabled: process.env.USE_PROXY !== 'false' // Default to true unless explicitly set to 'false'
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions'
  },
  activityCsvPath: process.env.ACTIVITY_CSV_PATH || path.resolve(process.cwd(), 'activity_log.csv')
};

// ==================== CSV TRACKING HELPERS ====================
// CSV header fields: timestamp,scroll_count,like_count,post_link,comment_post_link,comment_text,number_of_comments,session_id
function ensureCsvHeader() {
  const header = 'timestamp,scroll_count,like_count,post_link,comment_post_link,comment_text,number_of_comments,session_id\n';
  try {
    if (!fs.existsSync(CONFIG.activityCsvPath)) {
      fs.writeFileSync(CONFIG.activityCsvPath, header, { encoding: 'utf8' });
      console.log(`✅ Created CSV tracking file: ${CONFIG.activityCsvPath}`);
    }
  } catch (err) {
    console.error('❌ Could not create CSV tracking file:', err.message);
  }
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // escape quotes by doubling them, and wrap in quotes if contains comma/newline/quote
  const needsWrap = /[",\n]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needsWrap ? `"${escaped}"` : escaped;
}

/**
 * Appends an entry to the CSV file. entry is an object with keys matching header.
 * This function is synchronous to reduce collision risk in single-process script.
 */
function appendCsvEntry(entry) {
  try {
    const row = [
      escapeCsvCell(entry.timestamp),
      escapeCsvCell(entry.scroll_count),
      escapeCsvCell(entry.like_count),
      escapeCsvCell(entry.post_link),
      escapeCsvCell(entry.comment_post_link),
      escapeCsvCell(entry.comment_text),
      escapeCsvCell(entry.number_of_comments),
      escapeCsvCell(entry.session_id)
    ].join(',') + '\n';

    fs.appendFileSync(CONFIG.activityCsvPath, row, { encoding: 'utf8' });
  } catch (err) {
    console.error('❌ Failed to append CSV entry:', err.message);
  }
}

// Create session id for this run
const SESSION_ID = (typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
ensureCsvHeader();

// ==================== VALIDATION ====================
function validateConfig() {
  const required = [
    'MONGO_URI',
    'TWITTER_EMAIL',
    'TWITTER_PASSWORD'
  ];

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
  
  // Validate proxy config if enabled (check that values exist, either from env or defaults)
  if (CONFIG.proxy.enabled) {
    if (!CONFIG.proxy.host || !CONFIG.proxy.port || !CONFIG.proxy.username || !CONFIG.proxy.password) {
      console.error('❌ Proxy is enabled but missing required proxy configuration');
      console.error('   Please set PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD');
      process.exit(1);
    }
  }
  
  console.log('✅ All environment variables loaded successfully');
  console.log(`   Proxy: ${CONFIG.proxy.enabled ? 'ENABLED' : 'DISABLED'}`);
  if (CONFIG.proxy.enabled) {
    console.log(`   Proxy Host: ${CONFIG.proxy.host}:${CONFIG.proxy.port}`);
  }
  console.log(`   Activity CSV: ${CONFIG.activityCsvPath}`);
  console.log(`   Session ID: ${SESSION_ID}`);
}

// ==================== MONGODB SCHEMA ====================
const sessionSchema = new mongoose.Schema({
  accountEmail: { type: String, required: true, unique: true },
  cookies: { type: Array, required: true },
  localStorage: { type: Object, default: {} },
  sessionStorage: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);

// ==================== DATABASE FUNCTIONS ====================
async function connectMongoDB() {
  try {
    await mongoose.connect(CONFIG.mongodb.uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
}

async function loadSessionFromDB(email) {
  try {
    const session = await Session.findOne({ accountEmail: email });
    if (session) {
      console.log('✅ Session found in MongoDB');
      console.log(`   Last updated: ${session.updatedAt.toLocaleString()}`);
      return session;
    }
    console.log('ℹ️  No existing session found');
    return null;
  } catch (error) {
    console.error('❌ Error loading session:', error.message);
    return null;
  }
}

async function saveSessionToDB(email, cookies, localStorage, sessionStorage) {
  try {
    // Check if session already exists
    const existingSession = await Session.findOne({ accountEmail: email });
    const isNewSession = !existingSession;
    
    const result = await Session.findOneAndUpdate(
      { accountEmail: email },
      {
        accountEmail: email,
        cookies,
        localStorage,
        sessionStorage,
        updatedAt: new Date(),
        // Only set createdAt if this is a new session
        ...(isNewSession ? { createdAt: new Date() } : {})
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    
    if (isNewSession) {
      console.log('✅ New session created and saved to MongoDB');
      console.log(`   Account Email: ${email}`);
    } else {
      console.log('✅ Session updated in MongoDB');
      console.log(`   Account Email: ${email}`);
    }
    console.log(`   Cookies stored: ${cookies.length}`);
    console.log(`   Session ID: ${result._id}`);
  } catch (error) {
    console.error('❌ Error saving session:', error.message);
    console.error('   Stack:', error.stack);
  }
}

// ==================== PROXY FUNCTIONS ====================
async function testProxyConnection() {
  try {
    console.log('🔄 Testing proxy connection...');
    console.log(`   Proxy: ${CONFIG.proxy.host}:${CONFIG.proxy.port}`);
    
    const proxyConfig = {
      protocol: 'http',
      host: CONFIG.proxy.host,
      port: parseInt(CONFIG.proxy.port),
      auth: {
        username: CONFIG.proxy.username,
        password: CONFIG.proxy.password
      }
    };
    
    // Try HTTPS first (most common)
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        proxy: proxyConfig,
        timeout: 15000,
        validateStatus: (status) => status === 200 // Only accept 200
      });
      
      if (response.data && response.data.ip) {
        console.log('✅ Proxy is working');
        console.log(`   Your IP through proxy: ${response.data.ip}`);
        return true;
      }
    } catch (httpsError) {
      // If HTTPS fails, try HTTP (some proxies don't support HTTPS)
      try {
        console.log('   ⚠️  HTTPS test failed, trying HTTP...');
        const response = await axios.get('http://api.ipify.org?format=json', {
          proxy: proxyConfig,
          timeout: 15000
        });
        
        if (response.data && response.data.ip) {
          console.log('✅ Proxy is working (HTTP only)');
          console.log(`   Your IP through proxy: ${response.data.ip}`);
          console.log('   ⚠️  Note: Proxy may not support HTTPS - browser may still work');
          return true;
        }
      } catch (httpError) {
        // Both failed, throw the HTTPS error as primary
        throw httpsError;
      }
    }
    
    throw new Error('Proxy test completed but no valid response received');
  } catch (error) {
    console.error('❌ Proxy connection test failed:', error.message);
    
    if (error.response) {
      console.error(`   HTTP Status: ${error.response.status}`);
      if (error.response.data) {
        const errorData = typeof error.response.data === 'string' 
          ? error.response.data.substring(0, 200)
          : JSON.stringify(error.response.data).substring(0, 200);
        console.error(`   Response: ${errorData}`);
      }
      
      // Provide specific guidance based on status code
      if (error.response.status === 400) {
        console.log('   💡 Status 400 usually means:');
        console.log('      - Proxy authentication failed (wrong username/password)');
        console.log('      - Proxy server rejected the request format');
        console.log('      - Proxy requires different authentication method');
      } else if (error.response.status === 407) {
        console.log('   💡 Status 407 means proxy authentication required');
        console.log('      - Check username and password are correct');
      } else if (error.response.status === 403) {
        console.log('   💡 Status 403 means access forbidden');
        console.log('      - Your IP may need to be whitelisted');
        console.log('      - Proxy may have restrictions');
      }
    }
    
    if (error.code) {
      console.error(`   Error Code: ${error.code}`);
      if (error.code === 'ECONNREFUSED') {
        console.log('   💡 Connection refused - proxy server may be offline');
      } else if (error.code === 'ETIMEDOUT') {
        console.log('   💡 Timeout - proxy server may be slow or unreachable');
      }
    }
    
    console.log('\n   📋 Troubleshooting checklist:');
    console.log('   - Verify PROXY_HOST, PROXY_PORT are correct');
    console.log('   - Verify PROXY_USERNAME and PROXY_PASSWORD are correct');
    console.log('   - Check if proxy server is online and accessible');
    console.log('   - Some proxies require IP whitelisting');
    console.log('   - Try testing proxy with curl: curl -x http://user:pass@host:port https://api.ipify.org');
    
    return false;
  }
}

async function rotateProxyIP() {
  if (!CONFIG.proxy.enabled || !CONFIG.proxy.rotateUrl) {
    return;
  }
  
  try {
    console.log('🔄 Rotating proxy IP...');
    await axios.get(CONFIG.proxy.rotateUrl, { timeout: 15000 });
    console.log('✅ Proxy IP rotated successfully');
    await sleep(8000); // Increased wait time for rotation
  } catch (error) {
    console.error('⚠️  Proxy rotation failed:', error.message);
  }
}

async function testProxyHTTSTunnel() {
  try {
    console.log('🔄 Testing proxy HTTPS tunneling capability...');
    const proxyConfig = {
      protocol: 'http',
      host: CONFIG.proxy.host,
      port: parseInt(CONFIG.proxy.port),
      auth: {
        username: CONFIG.proxy.username,
        password: CONFIG.proxy.password
      }
    };
    
    // Test HTTPS with a simple site first (more reliable than Twitter)
    // Accept any status code - even 400/403 means the tunnel works
    try {
      const response = await axios.get('https://www.google.com', {
        proxy: proxyConfig,
        timeout: 10000,
        maxRedirects: 3,
        validateStatus: () => true // Accept any status code
      });
      
      // If we got a response (even error), HTTPS tunneling works
      console.log('✅ Proxy supports HTTPS tunneling');
      return true;
    } catch (testError) {
      // Check if it's a connection error (tunnel doesn't work) vs HTTP error (tunnel works)
      if (testError.code === 'ECONNREFUSED' || 
          testError.code === 'ECONNRESET' || 
          testError.code === 'ETIMEDOUT' ||
          testError.message.includes('tunnel') ||
          testError.message.includes('ENOTFOUND')) {
        // Real connection error - tunnel doesn't work
        throw testError;
      }
      
      // HTTP errors (400, 403, etc.) mean the tunnel works, just the site rejected us
      console.log('✅ Proxy supports HTTPS tunneling (got response, even if error)');
      return true;
    }
  } catch (error) {
    // Only log as failure if it's a real connection error
    if (error.code === 'ECONNRESET' || 
        error.code === 'ECONNREFUSED' || 
        error.code === 'ETIMEDOUT' ||
        error.message.includes('tunnel') ||
        error.message.includes('ENOTFOUND')) {
      console.error('❌ Proxy does not support HTTPS tunneling:', error.message);
      console.log('   💡 This proxy may not support HTTPS/SSL tunneling');
      return false;
    }
    
    // Other errors might still mean tunnel works, so allow it
    console.log('⚠️  HTTPS test inconclusive, but will try with browser anyway');
    return true;
  }
}

async function launchBrowserWithProxy() {
  let newProxyUrl = null;
  try {
    const oldProxyUrl = `http://${CONFIG.proxy.username}:${CONFIG.proxy.password}@${CONFIG.proxy.host}:${CONFIG.proxy.port}`;
    
    console.log('🔄 Setting up proxy chain...');
    newProxyUrl = await proxyChain.anonymizeProxy(oldProxyUrl);
    console.log('✅ Proxy chain created');
    console.log(`   Local proxy: ${newProxyUrl}`);
    
    const browser = await puppeteer.launch({
      headless: false,
      args: [
        `--proxy-server=${newProxyUrl}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--window-size=1920,1080',
        '--disable-dev-shm-usage'
      ]
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    
    // Set up error handling for tunnel failures
    page.on('error', (error) => {
      if (error.message.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
        console.error('⚠️  Tunnel connection error detected');
      }
    });
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Test if proxy actually works by trying to load a simple HTTPS page
    try {
      console.log('🔄 Verifying proxy tunnel with test page...');
      await page.goto('https://www.google.com', { 
        waitUntil: 'domcontentloaded',
        timeout: 15000 
      });
      console.log('✅ Browser launched with proxy - tunnel test passed');
    } catch (tunnelError) {
      if (tunnelError.message.includes('ERR_TUNNEL_CONNECTION_FAILED') || 
          tunnelError.message.includes('net::ERR_PROXY_CONNECTION_FAILED')) {
        await browser.close();
        if (newProxyUrl) {
          try {
            await proxyChain.closeAnonymizedProxy(newProxyUrl, true);
          } catch (e) {}
        }
        throw new Error('Proxy tunnel connection failed - proxy may not support HTTPS tunneling');
      }
      // Other errors are okay, just log
      console.log('   ⚠️  Tunnel test had issues but continuing...');
    }
    
    return { browser, page, proxyUrl: newProxyUrl };
  } catch (error) {
    // Clean up proxy chain if it was created
    if (newProxyUrl) {
      try {
        await proxyChain.closeAnonymizedProxy(newProxyUrl, true);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    console.error('❌ Error launching browser with proxy:', error.message);
    throw error;
  }
}

async function launchBrowser() {
  try {
    console.log('🔄 Launching browser without proxy...');
    
    const browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
      ]
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('✅ Browser launched successfully');
    
    return { browser, page, proxyUrl: null };
  } catch (error) {
    console.error('❌ Error launching browser:', error.message);
    throw error;
  }
}

// ==================== SESSION FUNCTIONS ====================
async function safeNavigate(page, url, options = {}) {
  try {
    await page.goto(url, {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout: options.timeout || 30000
    });
    return true;
  } catch (error) {
    if (error.message.includes('ERR_TUNNEL_CONNECTION_FAILED') || 
        error.message.includes('net::ERR_PROXY_CONNECTION_FAILED') ||
        error.message.includes('tunnel')) {
      console.error(`❌ Tunnel connection failed when accessing ${url}`);
      console.error('   This indicates the proxy does not support HTTPS tunneling');
      throw new Error('PROXY_TUNNEL_FAILED');
    }
    throw error;
  }
}

async function applySessionCookies(page, sessionData) {
  try {
    console.log('🔄 Loading Twitter to set cookies...');
    await safeNavigate(page, 'https://twitter.com', { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    await sleep(1000);
    
    const cleanCookies = sessionData.cookies
      .filter(cookie => {
        return cookie.name && cookie.value && cookie.domain;
      })
      .map(cookie => {
        const cleaned = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          httpOnly: cookie.httpOnly || false,
          secure: cookie.secure || false,
          sameSite: cookie.sameSite || 'Lax'
        };
        
        if (cookie.expires && cookie.expires > 0) {
          cleaned.expires = cookie.expires;
        }
        
        return cleaned;
      });
    
    if (cleanCookies.length > 0) {
      await page.setCookie(...cleanCookies);
      console.log('✅ Session cookies applied');
      console.log(`   Cookies loaded: ${cleanCookies.length}`);
    } else {
      console.log('⚠️  No valid cookies to apply');
      return false;
    }
    
    if (sessionData.localStorage && Object.keys(sessionData.localStorage).length > 0) {
      await page.evaluate((data) => {
        for (const [key, value] of Object.entries(data)) {
          try {
            localStorage.setItem(key, value);
          } catch (e) {}
        }
      }, sessionData.localStorage);
    }

    if (sessionData.sessionStorage && Object.keys(sessionData.sessionStorage).length > 0) {
      await page.evaluate((data) => {
        for (const [key, value] of Object.entries(data)) {
          try {
            sessionStorage.setItem(key, value);
          } catch (e) {}
        }
      }, sessionData.sessionStorage);
    }
    
    return true;

  } catch (error) {
    console.error('❌ Error applying cookies:', error.message);
    return false;
  }
}

async function validateSession(page) {
  try {
    console.log('🔄 Validating session...');
    
    // First, check if already logged in on current page (before navigating)
    const currentLoggedIn = await isLoggedIn(page);
    if (currentLoggedIn) {
      console.log('✅ Session is valid - Already logged in (current page check)');
      return true;
    }
    
    // Try to navigate to home page with error handling
    let navigationSuccess = false;
    try {
      await safeNavigate(page, 'https://twitter.com/home', {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      await sleep(2000);
      navigationSuccess = true;
    } catch (navError) {
      // If navigation fails, check if we're already logged in on current page
      console.log('   ⚠️  Navigation had issues, checking current page status...');
      const stillLoggedIn = await isLoggedIn(page);
      if (stillLoggedIn) {
        console.log('✅ Session is valid - Already logged in (despite navigation error)');
        return true;
      }
      // If navigation failed and we're not logged in, continue to check
    }
    
    // Check login status after navigation attempt (or if navigation was skipped)
    const isLoggedInStatus = await isLoggedIn(page);
    
    if (isLoggedInStatus) {
      console.log('✅ Session is valid - Already logged in');
      return true;
    } else {
      console.log('⚠️  Session expired or invalid');
      return false;
    }
  } catch (error) {
    // If error occurs, try one more time to check current page
    try {
      const fallbackCheck = await isLoggedIn(page);
      if (fallbackCheck) {
        console.log('✅ Session is valid - Already logged in (fallback check)');
        return true;
      }
    } catch (e) {
      // Ignore fallback errors
    }
    
    console.error('❌ Session validation failed:', error.message);
    return false;
  }
}

async function extractAndSaveSession(page, email) {
  try {
    console.log('\n💾 Extracting session data for MongoDB storage...');
    await sleep(3000);
    
    const rawCookies = await page.cookies();
    console.log(`   📦 Found ${rawCookies.length} cookies`);
    
    const cleanCookies = rawCookies
      .filter(cookie => cookie.name && cookie.value && cookie.domain)
      .map(cookie => {
        const cleaned = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          httpOnly: cookie.httpOnly || false,
          secure: cookie.secure || false,
          sameSite: cookie.sameSite || 'Lax'
        };
        
        if (cookie.expires && cookie.expires > 0) {
          cleaned.expires = cookie.expires;
        }
        
        return cleaned;
      });
    
    console.log(`   ✅ Cleaned ${cleanCookies.length} valid cookies`);
    
    const localStorage = await page.evaluate(() => {
      try {
        return JSON.parse(JSON.stringify(window.localStorage));
      } catch (e) {
        return {};
      }
    });
    
    const sessionStorage = await page.evaluate(() => {
      try {
        return JSON.parse(JSON.stringify(window.sessionStorage));
      } catch (e) {
        return {};
      }
    });

    console.log(`   💾 Saving session to MongoDB for account: ${email}...`);
    await saveSessionToDB(email, cleanCookies, localStorage, sessionStorage);
    console.log('   ✅ Session extraction and save completed successfully\n');
  } catch (error) {
    console.error('❌ Error extracting session:', error.message);
    console.error('   Stack:', error.stack);
  }
}

// ==================== POST INTERACTION FUNCTIONS ====================
async function getCommentCount(tweetElement) {
  try {
    const commentCount = await tweetElement.evaluate((el) => {
      // Find the reply button
      const replyButton = el.querySelector('button[data-testid="reply"]');
      if (!replyButton) return null;
      
      // Get aria-label which often contains the count
      const ariaLabel = replyButton.getAttribute('aria-label') || '';
      
      // Extract number from aria-label (e.g., "Reply. 5 replies" or "5 replies")
      const ariaMatch = ariaLabel.match(/(\d+)\s*repl/i);
      if (ariaMatch) {
        const num = parseInt(ariaMatch[1], 10);
        if (num >= 1 && num < 20) {
          return num;
        }
        return null; // Skip if not 1-19
      }
      
      // Try to find the count in the button's parent or sibling elements
      let parent = replyButton.parentElement;
      let attempts = 0;
      
      while (parent && attempts < 3) {
        const text = parent.textContent || parent.innerText || '';
        
        // Look for patterns like "5" or "5 replies" or "Reply 5"
        const patterns = [
          /(\d+)\s*repl/i,  // "5 replies"
          /repl[^\d]*(\d+)/i,  // "Reply 5"
          /^(\d+)$/  // Just a number
        ];
        
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num >= 1 && num < 20) {
              return num;
            }
            if (num >= 20 || num === 0) {
              return null; // Skip if 0 or >= 20
            }
          }
        }
        
        // Check for spans or divs with numbers near the button
        const siblings = Array.from(parent.children || []);
        for (const sibling of siblings) {
          if (sibling === replyButton) continue;
          const siblingText = sibling.textContent || sibling.innerText || '';
          const numMatch = siblingText.match(/^(\d+)$/);
          if (numMatch) {
            const num = parseInt(numMatch[1], 10);
            if (num >= 1 && num < 20) {
              return num;
            }
            if (num >= 20 || num === 0) {
              return null;
            }
          }
        }
        
        parent = parent.parentElement;
        attempts++;
      }
      
      // If no number found and button exists, likely 0 comments (skip)
      return null;
    });
    
    return commentCount;
  } catch (error) {
    console.error('  ⚠️  Error getting comment count:', error.message);
    return null;
  }
}

async function extractPostText(page, tweetElement) {
  try {
    const text = await tweetElement.evaluate(el => {
      // Try to find the tweet text - Twitter uses various selectors
      const textElement = el.querySelector('[data-testid="tweetText"]') || 
                         el.querySelector('[lang]') ||
                         el.querySelector('span[dir="auto"]');
      
      if (textElement) {
        return textElement.innerText || textElement.textContent || '';
      }
      
      // Fallback: get all text from the tweet
      return el.innerText || el.textContent || '';
    });
    
    return text.trim();
  } catch (error) {
    return '';
  }
}

/**
 * Helper to find the canonical post link (status URL) for a tweet element.
 * Returns null if not found.
 */
async function getTweetLinkFromElement(tweetElement) {
  try {
    const hrefHandle = await tweetElement.evaluateHandle(el => {
      // Find an anchor with /status/ in href inside this tweet element
      const anchor = el.querySelector('a[href*="/status/"]');
      if (anchor) return anchor.href;
      // try searching deeper for anchors (some layouts)
      const anchors = el.querySelectorAll('a');
      for (const a of anchors) {
        if (a.href && a.href.includes('/status/')) return a.href;
      }
      return null;
    });
    const href = await hrefHandle.jsonValue();
    return href || null;
  } catch (e) {
    return null;
  }
}

async function generateAIComment(postText) {
  try {
    if (!CONFIG.openrouter.apiKey) {
      throw new Error('OpenRouter API key not configured');
    }
    
    if (!postText || postText.length < 10) {
      return null; // Skip if post text is too short
    }
    
    const response = await axios.post(
      CONFIG.openrouter.apiUrl,
      {
        model: 'openai/gpt-3.5-turbo', // You can change this to any model
        messages: [
          {
            role: 'system',
            content: 'You are a friendly Twitter user. Generate a short, natural, engaging comment (max 280 characters) that responds to the tweet. Be authentic and conversational. Do not use hashtags or @mentions unless necessary.'
          },
          {
            role: 'user',
            content: `Generate a natural comment for this tweet:\n\n"${postText.substring(0, 500)}"\n\nComment (max 280 chars, natural and engaging):`
          }
        ],
        max_tokens: 150,
        temperature: 0.8
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://twitter.com',
          'X-Title': 'Twitter Automation'
        },
        timeout: 15000
      }
    );
    
    if (response.data && response.data.choices && response.data.choices[0]) {
      const comment = response.data.choices[0].message.content.trim();
      // Ensure comment is within Twitter's character limit
      return comment.length > 280 ? comment.substring(0, 277) + '...' : comment;
    }
    
    return null;
  } catch (error) {
    console.error('   ⚠️  Error generating AI comment:', error.message);
    return null;
  }
}

async function commentOnPost(page, tweetElement) {
  try {
    // First check comment count - only proceed if less than 20
    const commentCount = await getCommentCount(tweetElement);
    
    if (commentCount === null || commentCount === 0 || commentCount >= 20) {
      return { 
        success: false, 
        error: `Comment count is ${commentCount === null ? 'unknown' : commentCount}, skipping (only commenting on posts with less than 20 comments)` 
      };
    }
    
    console.log(`   ✅ Post has ${commentCount} comment(s) - proceeding to comment`);
    
    // Find the reply/comment button
    const replyButton = await tweetElement.$('button[data-testid="reply"]');
    
    if (!replyButton) {
      return { success: false, error: 'Reply button not found' };
    }
    
    // Extract post text for AI generation
    const postText = await extractPostText(page, tweetElement);
    
    if (!postText) {
      return { success: false, error: 'Could not extract post text' };
    }
    
    // Generate AI comment
    console.log('   🤖 Generating AI comment...');
    const comment = await generateAIComment(postText);
    
    if (!comment) {
      return { success: false, error: 'Could not generate comment' };
    }
    
    console.log(`   💬 Generated comment: "${comment.substring(0, 50)}..."`);
    
    // Get post link for logging (attempt before clicking, in case modal changes DOM)
    const postLink = await getTweetLinkFromElement(tweetElement);
    
    // Scroll button into view
    await replyButton.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(500 + Math.random() * 500);
    
    // Click reply button
    await replyButton.click();
    await sleep(1000 + Math.random() * 1000);
    
    // Wait for reply textarea to appear (Twitter uses various selectors)
    let replyTextarea = null;
    const textareaSelectors = [
      'div[data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
      'div[role="textbox"][data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ];
    
    for (const selector of textareaSelectors) {
      try {
        replyTextarea = await page.waitForSelector(selector, { 
          visible: true, 
          timeout: 3000 
        });
        if (replyTextarea) break;
      } catch (e) {
        continue;
      }
    }
    
    if (!replyTextarea) {
      return { success: false, error: 'Reply textarea not found' };
    }
    
    // Type the comment with human-like delays
    await replyTextarea.click();
    await sleep(500 + Math.random() * 500);
    
    // Clear any existing text first
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await sleep(200);
    
    // Type character by character for more human-like behavior
    for (const char of comment) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    await sleep(1000 + Math.random() * 1000);
    
    // Find and click the reply/tweet button (try multiple selectors)
    let tweetButton = await page.$('button[data-testid="tweetButton"]');
    
    if (!tweetButton) {
      // Try alternative selectors
      tweetButton = await page.$('button[data-testid="tweetButtonInline"]');
    }
    
    if (!tweetButton) {
      // Try finding by role
      tweetButton = await page.$('div[role="button"][data-testid="tweetButton"]');
    }
    
    if (!tweetButton) {
      // Try finding any button with "Reply" text
      tweetButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => btn.textContent.includes('Reply') && !btn.disabled) || null;
      });
      
      if (tweetButton && tweetButton.asElement()) {
        tweetButton = tweetButton.asElement();
      } else {
        tweetButton = null;
      }
    }
    
    if (!tweetButton) {
      // Try to close the reply modal if tweet button not found
      await page.keyboard.press('Escape');
      await sleep(500);
      return { success: false, error: 'Tweet button not found' };
    }
    
    // Check if button is enabled
    const isEnabled = await tweetButton.evaluate(el => !el.disabled);
    
    if (!isEnabled) {
      await page.keyboard.press('Escape');
      return { success: false, error: 'Tweet button is disabled' };
    }
    
    // Click to post the comment
    await tweetButton.click();
    await sleep(2000);
    
    // Verify comment was posted (check if reply modal closed)
    await sleep(1000);
    
    // Click home button to return to home feed
    try {
      let homeButton = await page.$('a[aria-label="Home"]');
      
      if (!homeButton) {
        homeButton = await page.$('a[href="/home"]');
      }
      
      if (!homeButton) {
        homeButton = await page.$('a[data-testid="AppTabBar_Home_Link"]');
      }
      
      if (homeButton) {
        await homeButton.click();
        await sleep(1000);
        console.log('   🏠 Clicked home button');
      } else {
        // Try navigating to home via URL
        await page.goto('https://twitter.com/home', { waitUntil: 'domcontentloaded', timeout: 5000 });
        await sleep(1000);
        console.log('   🏠 Navigated to home');
      }
    } catch (error) {
      console.log('   ⚠️  Could not click home button, continuing...');
    }
    
    return { success: true, comment, postLink };
  } catch (error) {
    // Try to close reply modal if open
    try {
      await page.keyboard.press('Escape');
    } catch (e) {}
    
    return { success: false, error: error.message };
  }
}

async function commentOnRandomPost(page) {
  try {
    console.log('   🔍 Looking for posts with less than 20 comments...');
    
    // Get all visible tweets
    const tweets = await page.$$('[data-testid="tweet"]');
    
    if (tweets.length === 0) {
      return { success: false, error: 'No tweets found' };
    }
    
    console.log(`   📊 Found ${tweets.length} tweets, checking comment counts...`);
    
    // Filter to only tweets with less than 20 comments and visible reply buttons
    const commentableTweets = [];
    for (const tweet of tweets) {
      try {
        // First check comment count
        const commentCount = await getCommentCount(tweet);
        if (commentCount === null || commentCount === 0 || commentCount >= 20) {
          continue; // Skip posts with 0 or >= 20 comments
        }
        
        // Then check if reply button is visible
        const replyButton = await tweet.$('button[data-testid="reply"]');
        if (replyButton) {
          const isVisible = await replyButton.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return rect.top >= 0 && rect.left >= 0 && 
                   rect.bottom <= window.innerHeight && 
                   rect.right <= window.innerWidth;
          });
          if (isVisible) {
            commentableTweets.push({ tweet, commentCount });
            console.log(`   ✅ Found eligible post with ${commentCount} comment(s)`);
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    if (commentableTweets.length === 0) {
      console.log('   ⚠️  No posts found with less than 20 comments');
      return { success: false, error: 'No eligible posts found (need less than 20 comments)' };
    }
    
    console.log(`   ✅ Found ${commentableTweets.length} eligible post(s) with less than 20 comments`);
    
    // Randomly select one tweet
    const randomIndex = Math.floor(Math.random() * commentableTweets.length);
    const selected = commentableTweets[randomIndex];
    
    console.log(`   🎲 Selected post with ${selected.commentCount} comment(s)`);
    
    // Comment on the selected tweet
    return await commentOnPost(page, selected.tweet);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function openNotifications(page) {
  try {
    // Find and click the notifications button
    let notificationsButton = await page.$('a[aria-label="Notifications"]');
    
    if (!notificationsButton) {
      notificationsButton = await page.$('a[href="/notifications"]');
    }
    
    if (!notificationsButton) {
      notificationsButton = await page.$('a[data-testid="AppTabBar_Notifications_Link"]');
    }
    
    if (!notificationsButton) {
      // Try navigating directly
      await safeNavigate(page, 'https://twitter.com/notifications', { waitUntil: 'domcontentloaded' });
      await sleep(2000);
      return true;
    }
    
    await notificationsButton.click();
    await sleep(2000);
    console.log('   🔔 Opened notifications');
    return true;
  } catch (error) {
    console.log('   ⚠️  Error opening notifications:', error.message);
    return false;
  }
}

async function getReplyNotifications(page) {
  try {
    // Wait for notifications to load
    await sleep(2000);
    
    // Find all notification items that are replies
    const replyNotifications = await page.evaluate(() => {
      const notifications = Array.from(document.querySelectorAll('[data-testid="notification"]'));
      const replies = [];
      
      notifications.forEach((notif, index) => {
        const text = notif.innerText || notif.textContent || '';
        // Check if it's a reply notification
        if (text.includes('replied to your') || text.includes('replied') || text.includes('Reply')) {
          // Try to find the reply button or link
          const replyButton = notif.querySelector('button[data-testid="reply"]') ||
                             notif.querySelector('a[href*="/status/"]');
          
          if (replyButton) {
            replies.push({
              index,
              element: notif,
              text: text.substring(0, 200)
            });
          }
        }
      });
      
      return replies.map(r => r.index);
    });
    
    return replyNotifications;
  } catch (error) {
    console.log('   ⚠️  Error getting reply notifications:', error.message);
    return [];
  }
}

async function replyToNotification(page, notificationIndex) {
  try {
    // Get all notifications
    const notifications = await page.$$('[data-testid="notification"]');
    
    if (notificationIndex >= notifications.length) {
      return { success: false, error: 'Notification index out of range' };
    }
    
    const notification = notifications[notificationIndex];
    
    // Extract the original tweet text and reply text
    const notificationData = await notification.evaluate(el => {
      const text = el.innerText || el.textContent || '';
      return text;
    });
    
    // Click on the notification to open the conversation
    await notification.click();
    await sleep(2000);
    
    // Wait for the tweet thread to load
    await sleep(2000);
    
    // Find the reply that was made to our comment
    const replyTweet = await page.$('[data-testid="tweet"]');
    
    if (!replyTweet) {
      return { success: false, error: 'Could not find reply tweet' };
    }
    
    // Extract the reply text
    const replyText = await extractPostText(page, replyTweet);
    
    if (!replyText || replyText.length < 5) {
      return { success: false, error: 'Could not extract reply text' };
    }
    
    // Generate AI reply
    console.log(`   🤖 Generating AI reply to: "${replyText.substring(0, 50)}..."`);
    const aiReply = await generateAIComment(replyText);
    
    if (!aiReply) {
      return { success: false, error: 'Could not generate AI reply' };
    }
    
    console.log(`   💬 Generated reply: "${aiReply.substring(0, 50)}..."`);
    
    // Find reply button on the tweet
    const replyButton = await replyTweet.$('button[data-testid="reply"]');
    
    if (!replyButton) {
      return { success: false, error: 'Reply button not found' };
    }
    
    // Click reply button
    await replyButton.click();
    await sleep(1000 + Math.random() * 1000);
    
    // Wait for reply textarea
    let replyTextarea = null;
    const textareaSelectors = [
      'div[data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
      'div[role="textbox"][data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ];
    
    for (const selector of textareaSelectors) {
      try {
        replyTextarea = await page.waitForSelector(selector, { visible: true, timeout: 3000 });
        if (replyTextarea) break;
      } catch (e) {
        continue;
      }
    }
    
    if (!replyTextarea) {
      return { success: false, error: 'Reply textarea not found' };
    }
    
    // Type the reply
    await replyTextarea.click();
    await sleep(500 + Math.random() * 500);
    
    // Clear any existing text
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await sleep(200);
    
    // Type character by character
    for (const char of aiReply) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    await sleep(1000 + Math.random() * 1000);
    
    // Find and click tweet button
    let tweetButton = await page.$('button[data-testid="tweetButton"]');
    
    if (!tweetButton) {
      tweetButton = await page.$('button[data-testid="tweetButtonInline"]');
    }
    
    if (!tweetButton) {
      await page.keyboard.press('Escape');
      return { success: false, error: 'Tweet button not found' };
    }
    
    const isEnabled = await tweetButton.evaluate(el => !el.disabled);
    
    if (!isEnabled) {
      await page.keyboard.press('Escape');
      return { success: false, error: 'Tweet button is disabled' };
    }
    
    // Post the reply
    await tweetButton.click();
    await sleep(2000);
    
    console.log('   ✅ Replied to notification');
    
    // Go back to home
    await safeNavigate(page, 'https://twitter.com/home', { waitUntil: 'domcontentloaded' });
    await sleep(1000);
    
    return { success: true, reply: aiReply };
  } catch (error) {
    // Try to close any open modals
    try {
      await page.keyboard.press('Escape');
      await sleep(500);
    } catch (e) {}
    
    // Navigate back to home
    try {
      await safeNavigate(page, 'https://twitter.com/home', { waitUntil: 'domcontentloaded' });
    } catch (e) {}
    
    return { success: false, error: error.message };
  }
}

async function checkAndReplyToNotifications(page) {
  try {
    console.log('\n🔔 Checking notifications for replies...');
    
    // Open notifications
    const opened = await openNotifications(page);
    if (!opened) {
      return { checked: false, replied: 0 };
    }
    
    // Get reply notifications
    const replyIndices = await getReplyNotifications(page);
    
    if (replyIndices.length === 0) {
      console.log('   ℹ️  No reply notifications found');
      // Navigate back to home
      await safeNavigate(page, 'https://twitter.com/home', { waitUntil: 'domcontentloaded' });
      await sleep(1000);
      return { checked: true, replied: 0 };
    }
    
    console.log(`   📬 Found ${replyIndices.length} reply notification(s)`);
    
    let repliedCount = 0;
    
    // Reply to each notification (limit to 3 to avoid spam)
    const notificationsToReply = replyIndices.slice(0, 3);
    
    for (const index of notificationsToReply) {
      try {
        console.log(`   💬 Replying to notification ${index + 1}/${notificationsToReply.length}...`);
        const result = await replyToNotification(page, index);
        
        if (result.success) {
          repliedCount++;
          console.log(`   ✅ Successfully replied!`);
        } else {
          console.log(`   ⚠️  Could not reply: ${result.error}`);
        }
        
        // Wait between replies
        await sleep(3000 + Math.random() * 2000);
      } catch (error) {
        console.log(`   ⚠️  Error replying to notification: ${error.message}`);
      }
    }
    
    // Navigate back to home
    await safeNavigate(page, 'https://twitter.com/home', { waitUntil: 'domcontentloaded' });
    await sleep(1000);
    
    return { checked: true, replied: repliedCount };
  } catch (error) {
    console.log(`   ⚠️  Error checking notifications: ${error.message}`);
    // Try to navigate back to home
    try {
      await safeNavigate(page, 'https://twitter.com/home', { waitUntil: 'domcontentloaded' });
    } catch (e) {}
    return { checked: false, replied: 0 };
  }
}

/**
 * Updated likeRandomPosts: returns also the post links that were liked so we can log them.
 * Return format:
 *  { liked: <number>, total: <number>, available: <number>, likedPostLinks: [<href>, ...] }
 */
async function likeRandomPosts(page, likePercentage = 20) {
  try {
    // Get all like buttons and filter visible ones
    const allButtons = await page.$$('button[data-testid="like"]');
    
    if (allButtons.length === 0) {
      const totalTweets = await page.evaluate(() => {
        return document.querySelectorAll('[data-testid="tweet"]').length;
      });
      return { liked: 0, total: totalTweets, available: 0, likedPostLinks: [] };
    }
    
    // Filter to only visible buttons
    const visibleButtons = [];
    for (const button of allButtons) {
      try {
        const isVisible = await button.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.top >= 0 && rect.left >= 0 && 
                 rect.bottom <= window.innerHeight && 
                 rect.right <= window.innerWidth;
        });
        if (isVisible) {
          visibleButtons.push(button);
        }
      } catch (e) {
        // Skip if button is not accessible
        continue;
      }
    }
    
    if (visibleButtons.length === 0) {
      const totalTweets = await page.evaluate(() => {
        return document.querySelectorAll('[data-testid="tweet"]').length;
      });
      return { liked: 0, total: totalTweets, available: 0, likedPostLinks: [] };
    }
    
    // Get total tweet count
    const totalTweets = await page.evaluate(() => {
      return document.querySelectorAll('[data-testid="tweet"]').length;
    });
    
    // Calculate how many posts to like (percentage of available unliked posts, max 1 per call for human-like behavior)
    const calculatedLikes = Math.floor(visibleButtons.length * (likePercentage / 100));
    
    let postsToLike = 0;
    if (calculatedLikes === 0 && visibleButtons.length > 0) {
      if (Math.random() < 0.2) {
        postsToLike = 1;
      }
    } else if (calculatedLikes > 0) {
      if (Math.random() < 0.6) {
        postsToLike = Math.min(calculatedLikes, 1); // Max 1 per call
      }
    }
    
    if (postsToLike === 0) {
      return { liked: 0, total: totalTweets, available: visibleButtons.length, likedPostLinks: [] };
    }
    
    // Randomly select posts to like
    const selectedButtons = [];
    const availableIndices = Array.from({ length: visibleButtons.length }, (_, i) => i);
    
    for (let i = 0; i < postsToLike && availableIndices.length > 0; i++) {
      const randomIndex = Math.floor(Math.random() * availableIndices.length);
      selectedButtons.push(visibleButtons[availableIndices[randomIndex]]);
      availableIndices.splice(randomIndex, 1);
    }
    
    let likedCount = 0;
    const likedPostLinks = [];
    
    // Like the selected posts
    for (const button of selectedButtons) {
      try {
        // Find tweet ancestor and get post link
        const tweetElementHandle = await button.evaluateHandle(el => el.closest('[data-testid="tweet"]') || null);
        let postLink = null;
        if (tweetElementHandle) {
          try {
            const link = await tweetElementHandle.evaluate(el => {
              const a = el.querySelector('a[href*="/status/"]');
              if (a) return a.href;
              const anchors = el.querySelectorAll('a');
              for (const an of anchors) {
                if (an.href && an.href.includes('/status/')) return an.href;
              }
              return null;
            });
            postLink = link || null;
          } catch (e) {
            postLink = null;
          }
        }

        // Scroll the button into view smoothly
        await button.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        await sleep(300 + Math.random() * 400); // Random delay between 300-700ms
        
        // Verify button is still visible and clickable
        const isStillVisible = await button.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.top >= 0 && rect.left >= 0 && 
                 rect.bottom <= window.innerHeight && 
                 rect.right <= window.innerWidth;
        });
        
        if (isStillVisible) {
          // Click the like button
          await button.click();
          likedCount++;
          if (postLink) likedPostLinks.push(postLink);
          
          // Random delay between likes (800-1500ms for faster continuous operation)
          await sleep(800 + Math.random() * 700);
        }
      } catch (error) {
        // Skip if button is not clickable (might have been removed or changed)
        continue;
      }
    }
    
    return { liked: likedCount, total: totalTweets, available: visibleButtons.length, likedPostLinks };
  } catch (error) {
    // Silently return on error to not interrupt scrolling
    return { liked: 0, total: 0, available: 0, likedPostLinks: [], error: error.message };
  }
}

// ==================== TWITTER LOGIN ====================
async function isLoggedIn(page) {
  try {
    const currentUrl = page.url();
    
    // First check: if we're on a login/flow page, definitely not logged in
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow')) {
      return false;
    }
    
    // Second check: look for logged-in indicators on the page
    try {
      const hasLoggedInElements = await page.evaluate(() => {
        // Check for multiple indicators that suggest we're logged in
        const indicators = [
          document.querySelector('[data-testid="SideNav_NewTweet_Button"]'),
          document.querySelector('a[aria-label="Home"]'),
          document.querySelector('[data-testid="AppTabBar_Home_Link"]'),
          document.querySelector('nav[role="navigation"]'),
          document.querySelector('[data-testid="primaryColumn"]'),
          document.querySelector('a[href="/home"]'),
          document.querySelector('[aria-label*="Home"]')
        ];
        
        // Return true if at least one indicator is found
        return indicators.some(el => el !== null);
      });
      
      if (hasLoggedInElements) {
        return true;
      }
    } catch (evalError) {
      // If evaluation fails, continue with URL check
      console.log('   ⚠️  Could not evaluate page elements, using URL check only');
    }
    
    // Third check: if we're on known logged-in pages, assume logged in
    if (currentUrl.includes('/home') || 
        currentUrl.includes('/compose/tweet') ||
        currentUrl.includes('/notifications') ||
        currentUrl.includes('/messages') ||
        currentUrl.includes('/explore') ||
        currentUrl.includes('/settings')) {
      return true;
    }
    
    // If none of the checks passed, assume not logged in
    return false;
  } catch (error) {
    console.error('   ⚠️  Error checking login status:', error.message);
    return false;
  }
}

async function waitForManualLogin(page, maxWaitTime = 300000) {
  console.log('\n⏳ Waiting for manual login...');
  console.log('   💡 Please login manually in the browser');
  console.log(`   ⏱️  Will check every 5 seconds for up to ${maxWaitTime / 1000} seconds`);
  
  const startTime = Date.now();
  const checkInterval = 5000; // Check every 5 seconds
  
  while (Date.now() - startTime < maxWaitTime) {
    await sleep(checkInterval);
    
    try {
      const loggedIn = await isLoggedIn(page);
      if (loggedIn) {
        console.log('✅ Manual login detected!');
        return true;
      }
    } catch (error) {
      // Continue checking
    }
    
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed % 30 === 0) {
      console.log(`   ⏳ Still waiting... (${elapsed}s elapsed)`);
    }
  }
  
  console.log('⚠️  Timeout waiting for manual login');
  return false;
}

async function loginToTwitter(page) {
  try {
    console.log('🔄 Starting Twitter login process...');
    
    await safeNavigate(page, 'https://twitter.com/i/flow/login', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await sleep(3000);

    // Try multiple selectors for username/email field
    const usernameSelectors = [
      'input[autocomplete="username"]',
      'input[name="text"]',
      'input[type="text"]',
      'input[data-testid="ocfEnterTextTextInput"]'
    ];
    
    let usernameField = null;
    for (const selector of usernameSelectors) {
      try {
        usernameField = await page.waitForSelector(selector, { 
          visible: true,
          timeout: 5000 
        });
        if (usernameField) break;
      } catch (e) {
        continue;
      }
    }
    
    if (!usernameField) {
      console.log('   ⚠️  Could not find username field, checking if already logged in...');
      if (await isLoggedIn(page)) {
        console.log('✅ Already logged in!');
        return true;
      }
      throw new Error('Username field not found');
    }

    console.log('   📝 Entering email...');
    await usernameField.click();
    await sleep(500);
    
    await usernameField.type(CONFIG.twitter.email, { 
      delay: 100 
    });
    
    await sleep(1500);
    console.log('   ⌨️  Pressing Enter...');
    await page.keyboard.press('Enter');
    
    await sleep(4000);

    // Check for verification step
    try {
      const pageText = await page.evaluate(() => document.body.innerText);
      
      if (pageText.includes('Enter your phone number') || 
          pageText.includes('unusual login activity') ||
          pageText.includes('Verify your identity') ||
          pageText.includes('phone number or username')) {
        console.log('   ⚠️  Verification step detected...');
        
        const verificationSelectors = [
          'input[autocomplete="on"]',
          'input[name="text"]',
          'input[type="text"]',
          'input[data-testid="ocfEnterTextTextInput"]'
        ];
        
        let verificationField = null;
        for (const selector of verificationSelectors) {
          try {
            verificationField = await page.waitForSelector(selector, { 
              visible: true,
              timeout: 5000 
            });
            if (verificationField) break;
          } catch (e) {
            continue;
          }
        }
        
        if (verificationField) {
          await verificationField.click();
          await sleep(500);
          
          await verificationField.type(CONFIG.twitter.username, { 
            delay: 100 
          });
          
          await sleep(1500);
          console.log('   ⌨️  Pressing Enter...');
          await page.keyboard.press('Enter');
          
          await sleep(4000);
        }
      }
    } catch (error) {
      console.log('   ℹ️  No verification needed or verification field not found');
    }

    // Try multiple selectors for password field
    const passwordSelectors = [
      'input[autocomplete="current-password"]',
      'input[name="password"]',
      'input[type="password"]',
      'input[data-testid="ocfEnterTextTextInput"]'
    ];
    
    console.log('   🔐 Looking for password field...');
    let passwordField = null;
    for (const selector of passwordSelectors) {
      try {
        passwordField = await page.waitForSelector(selector, { 
          visible: true,
          timeout: 5000 
        });
        if (passwordField) {
          console.log(`   ✅ Found password field with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!passwordField) {
      console.log('   ⚠️  Could not find password field automatically');
      console.log('   💡 This might be a different login flow');
      console.log('   💡 You can login manually and the session will be saved');
      return false;
    }
    
    await passwordField.click();
    await sleep(500);
    
    await passwordField.type(CONFIG.twitter.password, { 
      delay: 100 
    });
    
    await sleep(1500);
    console.log('   ⌨️  Pressing Enter to login...');
    await page.keyboard.press('Enter');
    
    await sleep(6000);
    
    // Check if login was successful
    if (await isLoggedIn(page)) {
      console.log('✅ Successfully logged into Twitter');
      return true;
    } else {
      console.log('⚠️  Login verification failed - URL check');
      return false;
    }

  } catch (error) {
    console.error('❌ Login failed:', error.message);
    // Check if user might have logged in manually
    try {
      if (await isLoggedIn(page)) {
        console.log('✅ Detected login (possibly manual)');
        return true;
      }
    } catch (e) {
      // Ignore
    }
    return false;
  }
}

// ==================== MAIN AUTOMATION ====================
async function automateTwitter() {
  console.log('🚀 Twitter Automation Starting...\n');
  
  validateConfig();
  await connectMongoDB();

  let browser, page, proxyUrl = null;
  let useProxy = CONFIG.proxy.enabled;

  // Test proxy if enabled
  if (useProxy) {
    const proxyWorks = await testProxyConnection();
    if (!proxyWorks) {
      console.log('\n⚠️  Proxy basic test failed. Do you want to:');
      console.log('   1. Continue WITHOUT proxy (recommended)');
      console.log('   2. Try to rotate proxy IP and retry');
      console.log('\n   Automatically continuing without proxy in 5 seconds...\n');
      
      await sleep(5000);
      useProxy = false;
      console.log('✅ Continuing without proxy');
    } else {
      // Test HTTPS tunneling (required for Twitter)
      // Note: Even if this test fails, we'll still try with browser since proxy-chain handles it differently
      console.log('\n🔄 Testing HTTPS tunneling (required for Twitter)...');
      const httpsWorks = await testProxyHTTSTunnel();
      if (!httpsWorks) {
        console.log('\n⚠️  HTTPS test failed, but will still try with browser...');
        console.log('   proxy-chain may handle HTTPS differently than axios test\n');
        // Don't disable proxy - let browser try it
      } else {
        console.log('✅ HTTPS tunneling test passed\n');
      }
      await rotateProxyIP();
    }
  }

  // Launch browser based on proxy status
  try {
    if (useProxy) {
      try {
        const result = await launchBrowserWithProxy();
        browser = result.browser;
        page = result.page;
        proxyUrl = result.proxyUrl;
      } catch (proxyError) {
        if (proxyError.message.includes('tunnel') || 
            proxyError.message.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
          console.error('\n❌ Proxy tunnel connection failed');
          console.log('🔄 Automatically retrying without proxy...\n');
          useProxy = false;
          const result = await launchBrowser();
          browser = result.browser;
          page = result.page;
          proxyUrl = null;
        } else {
          throw proxyError;
        }
      }
    } else {
      const result = await launchBrowser();
      browser = result.browser;
      page = result.page;
    }
  } catch (error) {
    console.error('❌ Failed to launch browser with proxy');
    console.log('🔄 Retrying without proxy...');
    const result = await launchBrowser();
    browser = result.browser;
    page = result.page;
    proxyUrl = null;
    useProxy = false;
  }

  try {
    const existingSession = await loadSessionFromDB(CONFIG.twitter.email);

    if (existingSession) {
      console.log('\n🔄 Attempting to use existing session...');
      try {
        const cookiesApplied = await applySessionCookies(page, existingSession);
        
        if (cookiesApplied) {
          const isValid = await validateSession(page);

          if (!isValid) {
            console.log('\n🔄 Session invalid, performing fresh login...');
            const loginSuccess = await loginToTwitter(page);
            
            if (!loginSuccess) {
              console.log('\n⚠️  Automated login failed, waiting for manual login...');
              const manualLoginSuccess = await waitForManualLogin(page, 300000);
              if (!manualLoginSuccess && !(await isLoggedIn(page))) {
                throw new Error('Login failed');
              }
            }
            
            // Verify login before saving
            if (await isLoggedIn(page)) {
              await extractAndSaveSession(page, CONFIG.twitter.email);
            } else {
              throw new Error('Login verification failed');
            }
          }
        } else {
          console.log('\n🔄 Could not apply cookies, performing fresh login...');
          const loginSuccess = await loginToTwitter(page);
          
          if (!loginSuccess) {
            console.log('\n⚠️  Automated login failed, waiting for manual login...');
            const manualLoginSuccess = await waitForManualLogin(page, 300000);
            if (!manualLoginSuccess && !(await isLoggedIn(page))) {
              throw new Error('Login failed');
            }
          }
          
          // Verify login before saving
          if (await isLoggedIn(page)) {
            await extractAndSaveSession(page, CONFIG.twitter.email);
          } else {
            throw new Error('Login verification failed');
          }
        }
      } catch (tunnelError) {
        if (tunnelError.message === 'PROXY_TUNNEL_FAILED' && useProxy) {
          console.error('\n❌ Proxy tunnel failed during navigation');
          console.log('🔄 Closing browser and retrying without proxy...\n');
          
          // Close current browser
          if (proxyUrl) {
            try {
              await proxyChain.closeAnonymizedProxy(proxyUrl, true);
            } catch (e) {}
          }
          await browser.close();
          
          // Restart without proxy
          useProxy = false;
          const result = await launchBrowser();
          browser = result.browser;
          page = result.page;
          proxyUrl = null;
          
          console.log('✅ Retrying with fresh browser (no proxy)...\n');
          
          // Retry the operation
          const cookiesApplied = await applySessionCookies(page, existingSession);
          if (cookiesApplied) {
            const isValid = await validateSession(page);
            if (!isValid) {
              const loginSuccess = await loginToTwitter(page);
              if (!loginSuccess) {
                throw new Error('Login failed');
              }
              await extractAndSaveSession(page, CONFIG.twitter.email);
            }
          } else {
            const loginSuccess = await loginToTwitter(page);
            if (!loginSuccess) {
              throw new Error('Login failed');
            }
            await extractAndSaveSession(page, CONFIG.twitter.email);
          }
        } else {
          throw tunnelError;
        }
      }
    } else {
      console.log('\n🔄 No existing session, performing fresh login...');
      try {
        const loginSuccess = await loginToTwitter(page);
        
        if (!loginSuccess) {
          console.log('\n⚠️  Automated login failed');
          console.log('💡 Waiting for manual login...');
          console.log('   The browser will remain open for you to login manually');
          console.log('   The session will be automatically saved once login is detected\n');
          
          // Wait for manual login
          const manualLoginSuccess = await waitForManualLogin(page, 300000); // 5 minutes
          
          if (!manualLoginSuccess) {
            // Check one more time if user logged in
            if (await isLoggedIn(page)) {
              console.log('✅ Login detected on final check');
            } else {
              throw new Error('Login failed - please login manually and restart the script');
            }
          }
        }
        
        // Verify login before saving session
        if (await isLoggedIn(page)) {
          console.log('\n✅ Login confirmed, saving session...');
          await extractAndSaveSession(page, CONFIG.twitter.email);
        } else {
          throw new Error('Login verification failed');
        }
      } catch (tunnelError) {
        if (tunnelError.message === 'PROXY_TUNNEL_FAILED' && useProxy) {
          console.error('\n❌ Proxy tunnel failed during login');
          console.log('🔄 Closing browser and retrying without proxy...\n');
          
          // Close current browser
          if (proxyUrl) {
            try {
              await proxyChain.closeAnonymizedProxy(proxyUrl, true);
            } catch (e) {}
          }
          await browser.close();
          
          // Restart without proxy
          useProxy = false;
          const result = await launchBrowser();
          browser = result.browser;
          page = result.page;
          proxyUrl = null;
          
          console.log('✅ Retrying login with fresh browser (no proxy)...\n');
          
          // Retry login
          const loginSuccess = await loginToTwitter(page);
          if (!loginSuccess) {
            console.log('\n⚠️  Automated login failed, waiting for manual login...');
            const manualLoginSuccess = await waitForManualLogin(page, 300000);
            if (!manualLoginSuccess && !(await isLoggedIn(page))) {
              throw new Error('Login failed');
            }
          }
          
          // Verify and save session
          if (await isLoggedIn(page)) {
            await extractAndSaveSession(page, CONFIG.twitter.email);
          } else {
            throw new Error('Login verification failed');
          }
        } else {
          throw tunnelError;
        }
      }
    }

    console.log('\n✅ Twitter automation ready!');
    console.log('📍 Current URL:', page.url());

    await safeNavigate(page, 'https://twitter.com/home', { waitUntil: 'networkidle2' });
    console.log('\n🎯 Ready for automation tasks...');
    
    // Wait for page to fully load
    await sleep(3000);
    
    // First, check notifications and reply to any replies
    if (CONFIG.openrouter.apiKey) {
      console.log('\n🔔 Step 1: Checking notifications for replies...');
      const notificationResult = await checkAndReplyToNotifications(page);
      
      if (notificationResult.checked) {
        if (notificationResult.replied > 0) {
          console.log(`   ✅ Replied to ${notificationResult.replied} notification(s)`);
        } else {
          console.log('   ℹ️  No replies to respond to');
        }
      }
      
      await sleep(2000);
    }
    
    console.log('\n📜 Step 2: Starting continuous infinite scrolling with random likes and AI comments...');
    if (CONFIG.openrouter.apiKey) {
      console.log('   ✅ OpenRouter API configured - AI comments enabled');
    } else {
      console.log('   ⚠️  OpenRouter API key not found - AI comments disabled');
    }
    
    // Continuous scrolling function - scrolls forever and likes posts randomly
    async function scrollFeed() {
      let scrollAttempts = 0;
      let totalLiked = 0;
      let totalCommented = 0;
      
      // Infinite scroll loop
      while (true) {
        // Scroll down smoothly
        await page.evaluate(() => {
          window.scrollBy({
            top: 800,
            behavior: 'smooth'
          });
        });
        
        await sleep(2000); // Wait for content to load
        
        scrollAttempts++;
        
        // Check current tweet count
        const currentTweetCount = await page.evaluate(() => {
          return document.querySelectorAll('[data-testid="tweet"]').length;
        });
        
        // Like posts randomly on every scroll (5% of unliked posts)
        try {
          const result = await likeRandomPosts(page, 5);
          
          if (result.liked > 0) {
            totalLiked += result.liked;
            console.log(`   ❤️  Liked ${result.liked} posts (Total liked: ${totalLiked}, ${result.available} unliked available, ${result.total} total tweets)`);
            // Log each liked post to CSV
            for (const postLink of result.likedPostLinks) {
              appendCsvEntry({
                timestamp: new Date().toISOString(),
                scroll_count: scrollAttempts,
                like_count: 1,
                post_link: postLink,
                comment_post_link: '',
                comment_text: '',
                number_of_comments: totalCommented,
                session_id: SESSION_ID
              });
            }
          }
        } catch (error) {
          // Silently continue on error
        }
        
        // Comment on 1 post every 20 scrolls
        if (scrollAttempts % 20 === 0 && CONFIG.openrouter.apiKey) {
          try {
            console.log(`   💬 Attempting to comment (every 20 scrolls)...`);
            const commentResult = await commentOnRandomPost(page);
            
            if (commentResult.success) {
              totalCommented++;
              console.log(`   ✅ Commented successfully! (Total commented: ${totalCommented})`);
              console.log(`   💬 Comment: "${commentResult.comment}"`);
              // Log comment to CSV
              appendCsvEntry({
                timestamp: new Date().toISOString(),
                scroll_count: scrollAttempts,
                like_count: 0,
                post_link: '', // no like link
                comment_post_link: commentResult.postLink || '',
                comment_text: commentResult.comment || '',
                number_of_comments: totalCommented,
                session_id: SESSION_ID
              });
            } else {
              console.log(`   ⚠️  Could not comment: ${commentResult.error}`);
            }
          } catch (error) {
            console.log(`   ⚠️  Error during commenting: ${error.message}`);
          }
        }
        
        // Check notifications for replies every 50 scrolls
        if (scrollAttempts % 50 === 0 && CONFIG.openrouter.apiKey) {
          try {
            console.log(`\n   🔔 Checking notifications (every 50 scrolls)...`);
            const notificationResult = await checkAndReplyToNotifications(page);
            
            if (notificationResult.checked && notificationResult.replied > 0) {
              console.log(`   ✅ Replied to ${notificationResult.replied} notification(s) during scrolling`);
            }
          } catch (error) {
            console.log(`   ⚠️  Error checking notifications: ${error.message}`);
          }
        }
        
        // Log progress every 5 scrolls
        if (scrollAttempts % 5 === 0) {
          console.log(`   📊 Scrolled ${scrollAttempts} times, found ${currentTweetCount} tweets, total liked: ${totalLiked}, total commented: ${totalCommented}`);
        }
      }
    }
    
    // Start scrolling in background (non-blocking)
    scrollFeed().catch(error => {
      console.error('❌ Scrolling error:', error.message);
    });
    
    console.log('✅ Continuous scrolling started! Browser will remain open...');
    console.log('   💡 You can now interact with the browser manually');
    console.log('   💡 Press Ctrl+C to exit the script');
    
    // Close MongoDB connection before keeping script alive
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    
    // Keep proxy chain open since browser is still using it
    if (proxyUrl) {
      console.log('   ℹ️  Proxy chain will remain active while browser is open');
    }
    
    console.log('\n⏳ Keeping script alive to maintain browser connection...');
    console.log('   (Browser will close if script exits)');
    
    // Keep the script running to maintain browser connection
    // The browser will stay open as long as the script is running
    await new Promise(() => {}); // Never resolves, keeps script alive

  } catch (error) {
    console.error('\n❌ Automation error:', error.message);
    console.error(error.stack);
    console.log('\n⚠️  Error occurred, but browser will remain open...');
    console.log('   💡 You can still interact with the browser manually');
    
    // Check if user is logged in despite the error, and save session if so
    try {
      if (await isLoggedIn(page)) {
        console.log('\n✅ Detected login status - saving session...');
        await extractAndSaveSession(page, CONFIG.twitter.email);
        console.log('✅ Session saved successfully!');
      } else {
        console.log('\n💡 If you login manually, the session will be saved automatically');
        console.log('   Waiting 30 seconds to check for manual login...');
        
        // Wait a bit and check again
        await sleep(30000);
        if (await isLoggedIn(page)) {
          console.log('✅ Manual login detected - saving session...');
          await extractAndSaveSession(page, CONFIG.twitter.email);
          console.log('✅ Session saved successfully!');
        }
      }
    } catch (saveError) {
      console.log('⚠️  Could not save session:', saveError.message);
    }
    
    console.log('   💡 Press Ctrl+C to exit the script');
    
    // Close MongoDB connection before keeping script alive
    try {
      await mongoose.connection.close();
      console.log('✅ MongoDB connection closed');
    } catch (closeError) {
      console.log('⚠️  Error closing MongoDB:', closeError.message);
    }
    
    // Keep proxy chain open since browser is still using it
    if (proxyUrl) {
      console.log('   ℹ️  Proxy chain will remain active while browser is open');
    }
    
    console.log('\n⏳ Keeping script alive to maintain browser connection...');
    
    // Keep the script running even after error to maintain browser connection
    await new Promise(() => {}); // Never resolves, keeps script alive
  } finally {
    // Browser is NOT closed here - it remains open for manual use
    // MongoDB is already closed above
  }
}

automateTwitter().catch(console.error);
