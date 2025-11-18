require('dotenv').config();
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const axios = require('axios');
const proxyChain = require('proxy-chain');
const { setTimeout: sleep } = require('timers/promises');

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
    host: process.env.PROXY_HOST,
    port: process.env.PROXY_PORT,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
    rotateUrl: process.env.PROXY_ROTATE_URL,
    enabled: process.env.USE_PROXY === 'true'
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions'
  }
};

// ==================== VALIDATION ====================
function validateConfig() {
  const required = [
    'MONGO_URI',
    'TWITTER_EMAIL',
    'TWITTER_PASSWORD'
  ];

  if (CONFIG.proxy.enabled) {
    required.push('PROXY_HOST', 'PROXY_PORT', 'PROXY_USERNAME', 'PROXY_PASSWORD');
  }

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
  
  console.log('✅ All environment variables loaded successfully');
  console.log(`   Proxy: ${CONFIG.proxy.enabled ? 'ENABLED' : 'DISABLED'}`);
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
    const result = await Session.findOneAndUpdate(
      { accountEmail: email },
      {
        cookies,
        localStorage,
        sessionStorage,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );
    console.log('✅ Session saved to MongoDB');
    console.log(`   Cookies stored: ${cookies.length}`);
  } catch (error) {
    console.error('❌ Error saving session:', error.message);
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
    
    // Test HTTPS specifically (required for Twitter)
    const response = await axios.get('https://twitter.com', {
      proxy: proxyConfig,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400
    });
    
    console.log('✅ Proxy supports HTTPS tunneling');
    return true;
  } catch (error) {
    console.error('❌ Proxy does not support HTTPS tunneling:', error.message);
    if (error.code === 'ECONNRESET' || error.message.includes('tunnel')) {
      console.log('   💡 This proxy may not support HTTPS/SSL tunneling');
      console.log('   💡 Twitter requires HTTPS, so this proxy may not work');
    }
    return false;
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
    await safeNavigate(page, 'https://twitter.com/home', { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    await sleep(3000);
    
    const isLoggedIn = await page.evaluate(() => {
      return !window.location.href.includes('/login');
    });

    if (isLoggedIn) {
      console.log('✅ Session is valid - Already logged in');
      return true;
    } else {
      console.log('⚠️  Session expired or invalid');
      return false;
    }
  } catch (error) {
    console.error('❌ Session validation failed:', error.message);
    return false;
  }
}

async function extractAndSaveSession(page, email) {
  try {
    await sleep(3000);
    
    const rawCookies = await page.cookies();
    
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

    await saveSessionToDB(email, cleanCookies, localStorage, sessionStorage);
  } catch (error) {
    console.error('❌ Error extracting session:', error.message);
  }
}

// ==================== POST INTERACTION FUNCTIONS ====================
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
    
    return { success: true, comment };
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
    // Get all visible tweets
    const tweets = await page.$$('[data-testid="tweet"]');
    
    if (tweets.length === 0) {
      return { success: false, error: 'No tweets found' };
    }
    
    // Filter to only tweets with visible reply buttons
    const commentableTweets = [];
    for (const tweet of tweets) {
      try {
        const replyButton = await tweet.$('button[data-testid="reply"]');
        if (replyButton) {
          const isVisible = await replyButton.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return rect.top >= 0 && rect.left >= 0 && 
                   rect.bottom <= window.innerHeight && 
                   rect.right <= window.innerWidth;
          });
          if (isVisible) {
            commentableTweets.push(tweet);
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    if (commentableTweets.length === 0) {
      return { success: false, error: 'No commentable tweets found' };
    }
    
    // Randomly select one tweet
    const randomIndex = Math.floor(Math.random() * commentableTweets.length);
    const selectedTweet = commentableTweets[randomIndex];
    
    // Comment on the selected tweet
    return await commentOnPost(page, selectedTweet);
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

async function likeRandomPosts(page, likePercentage = 20) {
  try {
    // Get all like buttons and filter visible ones
    const allButtons = await page.$$('button[data-testid="like"]');
    
    if (allButtons.length === 0) {
      const totalTweets = await page.evaluate(() => {
        return document.querySelectorAll('[data-testid="tweet"]').length;
      });
      return { liked: 0, total: totalTweets, available: 0 };
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
      return { liked: 0, total: totalTweets, available: 0 };
    }
    
    // Get total tweet count
    const totalTweets = await page.evaluate(() => {
      return document.querySelectorAll('[data-testid="tweet"]').length;
    });
    
    // Calculate how many posts to like (percentage of available unliked posts, max 1 per call for human-like behavior)
    // More human-like: with 10 tweets, like 1 sometimes (not always)
    const calculatedLikes = Math.floor(visibleButtons.length * (likePercentage / 100));
    
    // If calculated is 0 but we have buttons, give a small chance to like 1 (very human-like)
    let postsToLike = 0;
    if (calculatedLikes === 0 && visibleButtons.length > 0) {
      // Small chance (20%) to like 1 post even if percentage calculation is 0
      if (Math.random() < 0.2) {
        postsToLike = 1;
      }
    } else if (calculatedLikes > 0) {
      // If calculated > 0, randomly decide if we should like (60% chance for more human-like behavior)
      if (Math.random() < 0.6) {
        postsToLike = Math.min(calculatedLikes, 1); // Max 1 per call
      }
    }
    
    if (postsToLike === 0) {
      return { liked: 0, total: totalTweets, available: visibleButtons.length };
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
    
    // Like the selected posts
    for (const button of selectedButtons) {
      try {
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
          
          // Random delay between likes (800-1500ms for faster continuous operation)
          await sleep(800 + Math.random() * 700);
        }
      } catch (error) {
        // Skip if button is not clickable (might have been removed or changed)
        continue;
      }
    }
    
    return { liked: likedCount, total: totalTweets, available: visibleButtons.length };
  } catch (error) {
    // Silently return on error to not interrupt scrolling
    return { liked: 0, total: 0, available: 0, error: error.message };
  }
}

// ==================== TWITTER LOGIN ====================
async function loginToTwitter(page) {
  try {
    console.log('🔄 Starting Twitter login process...');
    
    await safeNavigate(page, 'https://twitter.com/i/flow/login', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await sleep(3000);

    console.log('   📝 Entering email...');
    await page.waitForSelector('input[autocomplete="username"]', { 
      visible: true,
      timeout: 15000 
    });
    
    await page.click('input[autocomplete="username"]');
    await sleep(500);
    
    await page.type('input[autocomplete="username"]', CONFIG.twitter.email, { 
      delay: 100 
    });
    
    await sleep(1500);
    console.log('   ⌨️  Pressing Enter...');
    await page.keyboard.press('Enter');
    
    await sleep(4000);

    try {
      const pageText = await page.evaluate(() => document.body.innerText);
      
      if (pageText.includes('Enter your phone number') || 
          pageText.includes('unusual login activity') ||
          pageText.includes('Verify your identity')) {
        console.log('   ⚠️  Suspicious activity detected...');
        
        await page.waitForSelector('input[autocomplete="on"]', { 
          visible: true,
          timeout: 5000 
        });
        
        await page.click('input[autocomplete="on"]');
        await sleep(500);
        
        await page.type('input[autocomplete="on"]', CONFIG.twitter.username, { 
          delay: 100 
        });
        
        await sleep(1500);
        console.log('   ⌨️  Pressing Enter...');
        await page.keyboard.press('Enter');
        
        await sleep(4000);
      }
    } catch (error) {
      console.log('   ℹ️  No verification needed');
    }

    console.log('   🔐 Entering password...');
    await page.waitForSelector('input[autocomplete="current-password"]', { 
      visible: true,
      timeout: 15000 
    });
    
    await page.click('input[autocomplete="current-password"]');
    await sleep(500);
    
    await page.type('input[autocomplete="current-password"]', CONFIG.twitter.password, { 
      delay: 100 
    });
    
    await sleep(1500);
    console.log('   ⌨️  Pressing Enter to login...');
    await page.keyboard.press('Enter');
    
    await sleep(6000);
    
    const currentUrl = page.url();
    if (currentUrl.includes('/home') || !currentUrl.includes('/login')) {
      console.log('✅ Successfully logged into Twitter');
      return true;
    } else {
      console.log('⚠️  Login verification failed');
      return false;
    }

  } catch (error) {
    console.error('❌ Login failed:', error.message);
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
      console.log('\n🔄 Testing HTTPS tunneling (required for Twitter)...');
      const httpsWorks = await testProxyHTTSTunnel();
      if (!httpsWorks) {
        console.log('\n⚠️  Proxy does not support HTTPS tunneling!');
        console.log('   Twitter requires HTTPS, so this proxy will not work.');
        console.log('   Automatically continuing without proxy in 5 seconds...\n');
        await sleep(5000);
        useProxy = false;
        console.log('✅ Continuing without proxy');
      } else {
        await rotateProxyIP();
      }
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
              throw new Error('Login failed');
            }
            
            await extractAndSaveSession(page, CONFIG.twitter.email);
          }
        } else {
          console.log('\n🔄 Could not apply cookies, performing fresh login...');
          const loginSuccess = await loginToTwitter(page);
          
          if (!loginSuccess) {
            throw new Error('Login failed');
          }
          
          await extractAndSaveSession(page, CONFIG.twitter.email);
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
          throw new Error('Login failed');
        }
        
        await extractAndSaveSession(page, CONFIG.twitter.email);
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
            throw new Error('Login failed');
          }
          await extractAndSaveSession(page, CONFIG.twitter.email);
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
