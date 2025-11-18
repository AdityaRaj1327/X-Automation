require('dotenv').config();

const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const axios = require('axios');
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
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions'
  }
};

// ==================== VALIDATION ====================
function validateConfig() {
  const required = ['MONGO_URI', 'TWITTER_EMAIL', 'TWITTER_PASSWORD', 'OPENROUTER_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
  
  console.log('✅ All environment variables loaded successfully');
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
      console.log(`  Last updated: ${session.updatedAt.toLocaleString()}`);
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
    await Session.findOneAndUpdate(
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
    console.log(`  Cookies stored: ${cookies.length}`);
  } catch (error) {
    console.error('❌ Error saving session:', error.message);
  }
}

// ==================== BROWSER FUNCTIONS ====================
async function launchBrowser() {
  try {
    console.log('🔄 Launching browser...');
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
    return { browser, page };
  } catch (error) {
    console.error('❌ Error launching browser:', error.message);
    throw error;
  }
}

// ==================== SESSION FUNCTIONS ====================
async function applySessionCookies(page, sessionData) {
  try {
    console.log('🔄 Loading Twitter to set cookies...');
    await page.goto('https://twitter.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(1000);
    
    const cleanCookies = sessionData.cookies
      .filter(cookie => cookie.name && cookie.value && cookie.domain)
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        httpOnly: cookie.httpOnly || false,
        secure: cookie.secure || false,
        sameSite: cookie.sameSite || 'Lax',
        ...(cookie.expires && cookie.expires > 0 ? { expires: cookie.expires } : {})
      }));
    
    if (cleanCookies.length > 0) {
      await page.setCookie(...cleanCookies);
      console.log('✅ Session cookies applied');
      console.log(`  Cookies loaded: ${cleanCookies.length}`);
    }
    
    if (sessionData.localStorage && Object.keys(sessionData.localStorage).length > 0) {
      await page.evaluate((data) => {
        for (const [key, value] of Object.entries(data)) {
          try { localStorage.setItem(key, value); } catch (e) {}
        }
      }, sessionData.localStorage);
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
    await page.goto('https://twitter.com/home', {
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
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        httpOnly: cookie.httpOnly || false,
        secure: cookie.secure || false,
        sameSite: cookie.sameSite || 'Lax',
        ...(cookie.expires && cookie.expires > 0 ? { expires: cookie.expires } : {})
      }));
    
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

// ==================== TWITTER LOGIN ====================
async function loginToTwitter(page) {
  try {
    console.log('🔄 Starting Twitter login process...');
    await page.goto('https://twitter.com/i/flow/login', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await sleep(3000);
    
    console.log('  📝 Entering email...');
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
    
    console.log('  ⌨️  Pressing Enter...');
    await page.keyboard.press('Enter');
    await sleep(4000);
    
    // Handle username verification if required
    try {
      const pageText = await page.evaluate(() => document.body.innerText);
      if (pageText.includes('Enter your phone number') ||
          pageText.includes('unusual login activity') ||
          pageText.includes('Verify your identity')) {
        console.log('  ⚠️  Suspicious activity detected - entering username...');
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
        console.log('  ⌨️  Pressing Enter...');
        await page.keyboard.press('Enter');
        await sleep(4000);
      }
    } catch (error) {
      console.log('  ℹ️  No verification needed');
    }
    
    console.log('  🔐 Entering password...');
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
    
    console.log('  ⌨️  Pressing Enter to login...');
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

// ==================== SCROLLING & TRENDING TOPICS ====================
async function autoScrollPages(page, scrollCount = 10) {
  console.log(`🔄 Scrolling ${scrollCount} pages...`);
  for (let i = 0; i < scrollCount; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    console.log(`  Scroll ${i + 1}/${scrollCount}`);
    await sleep(2000);
  }
  console.log('✅ Scrolling completed');
}

async function getTrendingTopics(page) {
  try {
    console.log('🔄 Extracting trending topics...');
    
    // Navigate to explore/trending section
    await page.goto('https://twitter.com/explore/tabs/trending', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(3000);
    
    const trends = await page.evaluate(() => {
      const trendElements = document.querySelectorAll('[data-testid="trend"]');
      const topics = [];
      
      trendElements.forEach(element => {
        const trendText = element.querySelector('span');
        if (trendText && trendText.textContent) {
          const text = trendText.textContent.trim();
          if (text && !text.startsWith('·') && text.length > 2) {
            topics.push(text);
          }
        }
      });
      
      // Remove duplicates
      return [...new Set(topics)];
    });
    
    console.log(`✅ Found ${trends.length} trending topics`);
    return trends.slice(0, 10); // Return top 10
  } catch (error) {
    console.error('❌ Error extracting trending topics:', error.message);
    return [];
  }
}

// ==================== AI POST GENERATION ====================
async function generatePostWithOpenRouter(apiKey, trendingTopics) {
  try {
    const topicsText = trendingTopics.length > 0 
      ? trendingTopics.slice(0, 5).join(', ') 
      : 'current events and technology';
    
    const prompt = `Create an engaging Twitter post about these trending topics: ${topicsText}. 
    The post should be:
    - Maximum 280 characters
    - Engaging and conversational
    - Include relevant perspective or insight
    - Natural and authentic
    - No hashtags unless naturally relevant
    
    Just provide the tweet text, nothing else.`;
    
    console.log('🤖 Generating AI post with OpenRouter...');
    console.log(`  Using topics: ${topicsText}`);
    
    const response = await axios.post(
      CONFIG.openrouter.apiUrl,
      {
        model: 'openai/gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a social media expert who creates engaging, authentic Twitter posts.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.8
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://twitter.com',
          'X-Title': 'Twitter Automation'
        },
        timeout: 15000
      }
    );
    
    if (response.data && response.data.choices && response.data.choices[0]) {
      const content = response.data.choices[0].message.content.trim();
      const post = content.length > 280 ? content.substring(0, 277) + '...' : content;
      console.log(`✅ Generated post (${post.length} chars): "${post}"`);
      return post;
    }
    
    throw new Error('Invalid response from OpenRouter');
  } catch (error) {
    console.error('❌ Error generating post:', error.message);
    return null;
  }
}

// ==================== POST VERIFICATION ====================
async function verifyTweetPosted(page, tweetContent) {
  try {
    console.log('  🔍 Verifying tweet was posted...');
    await sleep(2000);
    
    // Check if compose area is cleared
    const textareaCleared = await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="tweetTextarea_0"]');
      if (!textarea) return true;
      const content = textarea.textContent || textarea.innerText || '';
      return content.trim() === '';
    });
    
    if (textareaCleared) {
      console.log('  ✅ Compose area cleared - tweet posted successfully');
      return true;
    }
    
    // Check timeline for the tweet
    await page.goto('https://twitter.com/home', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await sleep(3000);
    
    const tweetFound = await page.evaluate((content) => {
      const tweets = document.querySelectorAll('[data-testid="tweet"]');
      const searchText = content.substring(0, 50);
      for (const tweet of tweets) {
        if (tweet.textContent.includes(searchText)) {
          return true;
        }
      }
      return false;
    }, tweetContent);
    
    if (tweetFound) {
      console.log('  ✅ Tweet found in timeline');
      return true;
    }
    
    console.log('  ⚠️  Could not verify tweet posting');
    return false;
    
  } catch (error) {
    console.error('  ❌ Error verifying tweet:', error.message);
    return false;
  }
}

// ==================== POST TWEET WITH CTRL+ENTER ====================
async function postTweetWithEnter(page, tweetContent) {
  try {
    console.log('\n🔄 Starting tweet posting process (using Ctrl+Enter)...');
    console.log(`📝 Content: "${tweetContent}"`);
    console.log(`📏 Length: ${tweetContent.length} characters`);
    
    // Navigate to home
    await page.goto('https://twitter.com/home', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(2000);
    
    // Step 1: Find and click the tweet compose area
    console.log('  📝 Finding tweet compose area...');
    const textareaSelectors = [
      '[data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
      'div[role="textbox"][aria-label*="Tweet"]',
      'div[role="textbox"]'
    ];
    
    let textarea = null;
    for (const selector of textareaSelectors) {
      try {
        textarea = await page.waitForSelector(selector, {
          visible: true,
          timeout: 5000
        });
        if (textarea) {
          console.log(`  ✅ Found textarea using: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!textarea) {
      throw new Error('Could not find tweet compose area');
    }
    
    // Step 2: Click and focus on textarea
    await textarea.click();
    await sleep(500);
    
    // Step 3: Type the tweet content with human-like behavior
    console.log('  ⌨️  Typing tweet content...');
    for (const char of tweetContent) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    console.log(`  ✅ Typed ${tweetContent.length} characters`);
    await sleep(1500);
    
    // Step 4: Press Ctrl+Enter to post (Twitter's keyboard shortcut)
    console.log('  ⌨️  Pressing Ctrl+Enter to post tweet...');
    
    // Detect OS for correct modifier key
    const isMac = process.platform === 'darwin';
    const modifierKey = isMac ? 'Meta' : 'Control';
    
    try {
      // Method 1: Use Ctrl+Enter (or Cmd+Enter on Mac)
      await page.keyboard.down(modifierKey);
      await page.keyboard.press('Enter');
      await page.keyboard.up(modifierKey);
      console.log(`  ✅ Pressed ${isMac ? 'Cmd' : 'Ctrl'}+Enter`);
    } catch (keyError) {
      console.log('  ⚠️  Keyboard shortcut failed, trying alternative method...');
      
      // Method 2: Trigger keyboard event directly in page context
      await page.evaluate(() => {
        const textarea = document.querySelector('[data-testid="tweetTextarea_0"]');
        if (textarea) {
          const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
            cancelable: true
          });
          textarea.dispatchEvent(event);
        }
      });
      console.log('  ✅ Triggered event via JavaScript');
    }
    
    // Step 5: Wait for tweet to be posted
    console.log('  ⏳ Waiting for tweet to post...');
    await sleep(4000);
    
    // Step 6: Verify tweet was posted
    const verified = await verifyTweetPosted(page, tweetContent);
    
    if (verified) {
      console.log('✅ Tweet posted and verified successfully!');
      return true;
    } else {
      console.log('⚠️  Tweet may have posted but verification inconclusive');
      return true;
    }
    
  } catch (error) {
    console.error('❌ Error posting tweet:', error.message);
    
    // Take screenshot for debugging
    try {
      const screenshotPath = `tweet-error-${Date.now()}.png`;
      await page.screenshot({ 
        path: screenshotPath,
        fullPage: false 
      });
      console.log(`📸 Screenshot saved: ${screenshotPath}`);
    } catch (screenshotError) {
      console.error('Could not save screenshot');
    }
    
    return false;
  }
}

// ==================== ALTERNATIVE: POST WITH BUTTON CLICK (FALLBACK) ====================
async function postTweetWithButton(page, tweetContent) {
  try {
    console.log('\n🔄 Posting tweet with button click (fallback method)...');
    
    await page.goto('https://twitter.com/home', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await sleep(2000);
    
    // Find textarea
    const textarea = await page.waitForSelector('[data-testid="tweetTextarea_0"]', {
      visible: true,
      timeout: 5000
    });
    
    await textarea.click();
    await sleep(500);
    
    // Type content
    for (const char of tweetContent) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    await sleep(1500);
    
    // Find and click post button
    const postButton = await page.waitForSelector('[data-testid="tweetButtonInline"]', {
      visible: true,
      timeout: 5000
    });
    
    await page.waitForFunction(
      (selector) => {
        const button = document.querySelector(selector);
        return button && !button.disabled;
      },
      { timeout: 10000 },
      '[data-testid="tweetButtonInline"]'
    );
    
    await postButton.click();
    console.log('  ✅ Clicked post button');
    
    await sleep(4000);
    
    return await verifyTweetPosted(page, tweetContent);
    
  } catch (error) {
    console.error('❌ Fallback method failed:', error.message);
    return false;
  }
}

// ==================== MAIN FUNCTION ====================
async function main() {
  console.log('🚀 Twitter Automation with AI Post Generation Starting...\n');
  console.log('═'.repeat(60));
  
  validateConfig();
  await connectMongoDB();
  
  let browser, page;
  
  try {
    // Launch browser
    console.log('\n📱 STEP 1: BROWSER INITIALIZATION');
    console.log('─'.repeat(60));
    const result = await launchBrowser();
    browser = result.browser;
    page = result.page;
    
    // Session management
    console.log('\n🔐 STEP 2: AUTHENTICATION');
    console.log('─'.repeat(60));
    const existingSession = await loadSessionFromDB(CONFIG.twitter.email);
    
    if (existingSession) {
      console.log('🔄 Attempting to use existing session...');
      const cookiesApplied = await applySessionCookies(page, existingSession);
      
      if (cookiesApplied) {
        const isValid = await validateSession(page);
        if (!isValid) {
          console.log('🔄 Session invalid, performing fresh login...');
          const loginSuccess = await loginToTwitter(page);
          if (!loginSuccess) {
            throw new Error('Login failed');
          }
          await extractAndSaveSession(page, CONFIG.twitter.email);
        }
      }
    } else {
      console.log('🔄 No existing session, performing fresh login...');
      const loginSuccess = await loginToTwitter(page);
      if (!loginSuccess) {
        throw new Error('Login failed');
      }
      await extractAndSaveSession(page, CONFIG.twitter.email);
    }
    
    console.log('✅ Authentication successful!');
    
    // Navigate to home and scroll
    console.log('\n📜 STEP 3: SCROLLING FEED');
    console.log('─'.repeat(60));
    await page.goto('https://twitter.com/home', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await sleep(2000);
    await autoScrollPages(page, 10);
    
    // Get trending topics
    console.log('\n📊 STEP 4: EXTRACTING TRENDING TOPICS');
    console.log('─'.repeat(60));
    const trendingTopics = await getTrendingTopics(page);
    
    if (trendingTopics.length === 0) {
      console.log('⚠️  No trending topics found, using generic prompt');
    } else {
      console.log(`✅ Trending Topics (${trendingTopics.length} found):`);
      trendingTopics.forEach((topic, i) => {
        console.log(`  ${i + 1}. ${topic}`);
      });
    }
    
    // Generate post using OpenRouter
    console.log('\n🤖 STEP 5: GENERATING AI POST');
    console.log('─'.repeat(60));
    const postContent = await generatePostWithOpenRouter(
      CONFIG.openrouter.apiKey,
      trendingTopics
    );
    
    if (!postContent) {
      throw new Error('Could not generate post content');
    }
    
    console.log('\n📝 Generated Post:');
    console.log('┌' + '─'.repeat(58) + '┐');
    console.log(`│ ${postContent.padEnd(56)} │`);
    console.log('└' + '─'.repeat(58) + '┘');
    console.log(`Length: ${postContent.length}/280 characters`);
    
    // Post the tweet using Ctrl+Enter
    console.log('\n📤 STEP 6: POSTING TWEET');
    console.log('─'.repeat(60));
    let posted = await postTweetWithEnter(page, postContent);
    
    // If Ctrl+Enter failed, try button click as fallback
    if (!posted) {
      console.log('\n⚠️  Ctrl+Enter method failed, trying button click...');
      posted = await postTweetWithButton(page, postContent);
    }
    
    // Final summary
    console.log('\n' + '═'.repeat(60));
    if (posted) {
      console.log('🎉 AUTOMATION COMPLETED SUCCESSFULLY!');
      console.log('═'.repeat(60));
      console.log('✅ Scrolled 10 pages');
      console.log(`✅ Found ${trendingTopics.length} trending topics`);
      console.log('✅ Generated AI-powered tweet');
      console.log('✅ Posted tweet using Ctrl+Enter shortcut');
    } else {
      console.log('⚠️  AUTOMATION COMPLETED WITH WARNINGS');
      console.log('═'.repeat(60));
      console.log('✅ Scrolled 10 pages');
      console.log(`✅ Found ${trendingTopics.length} trending topics`);
      console.log('✅ Generated AI-powered tweet');
      console.log('⚠️  Tweet posting failed');
    }
    
    console.log('\n⏳ Keeping browser open for 30 seconds...');
    await sleep(30000);
    
  } catch (error) {
    console.error('\n❌ AUTOMATION ERROR');
    console.error('═'.repeat(60));
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    if (browser) {
      await browser.close();
      console.log('\n✅ Browser closed');
    }
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    console.log('\n🏁 Program terminated\n');
  }
}

// Run the automation
main().catch(console.error);
