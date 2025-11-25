require('dotenv').config();

const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const fs = require('fs');
const path = require('path');
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
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: process.env.AI_MODEL || 'openai/gpt-3.5-turbo'
  },
  automation: {
    scrollPages: parseInt(process.env.SCROLL_PAGES) || 10,
    maxRetries: 3,
    similarityThreshold: 0.7,
    minDelayMs: 2000,
    maxDelayMs: 5000,
    postsToDo: parseInt(process.env.POSTS_TO_DO) || 1 // Number of posts to do
  },
  csv: {
    filename: 'twitter_posts.csv',
    directory: './data'
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

// ==================== CSV FUNCTIONS ====================
function ensureDataDirectory() {
  const dataDir = path.resolve(CONFIG.csv.directory);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`✅ Created data directory: ${dataDir}`);
  }
}

function initializeCSV() {
  ensureDataDirectory();
  const csvPath = path.join(CONFIG.csv.directory, CONFIG.csv.filename);
  
  // Check if CSV exists, if not create with headers
  if (!fs.existsSync(csvPath)) {
    const headers = [
      'Timestamp',
      'Date',
      'Time',
      'Trending Topic',
      'Topic Context',
      'Tweet Volume',
      'Post Content',
      'Post Length',
      'Success',
      'Retry Count',
      'Model Used',
      'Temperature',
      'Method'
    ].join(',') + '\n';
    
    fs.writeFileSync(csvPath, headers, 'utf8');
    console.log(`✅ Created CSV file: ${csvPath}`);
  }
  
  return csvPath;
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function appendToCSV(csvPath, data) {
  try {
    const now = new Date();
    const row = [
      escapeCSV(now.toISOString()),
      escapeCSV(now.toLocaleDateString()),
      escapeCSV(now.toLocaleTimeString()),
      escapeCSV(data.trendingTopic),
      escapeCSV(data.trendContext),
      escapeCSV(data.tweetCount),
      escapeCSV(data.postContent),
      escapeCSV(data.postLength),
      escapeCSV(data.success ? 'Yes' : 'No'),
      escapeCSV(data.retryCount),
      escapeCSV(data.model),
      escapeCSV(data.temperature),
      escapeCSV(data.method)
    ].join(',') + '\n';
    
    fs.appendFileSync(csvPath, row, 'utf8');
    console.log(`✅ Appended to CSV: ${csvPath}`);
    return true;
  } catch (error) {
    console.error('❌ Error writing to CSV:', error.message);
    return false;
  }
}

function readCSVStats(csvPath) {
  try {
    if (!fs.existsSync(csvPath)) return null;
    
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    if (lines.length <= 1) return { totalPosts: 0, successfulPosts: 0, failedPosts: 0 };
    
    const dataLines = lines.slice(1); // Skip header
    const totalPosts = dataLines.length;
    const successfulPosts = dataLines.filter(line => line.includes(',Yes,')).length;
    const failedPosts = totalPosts - successfulPosts;
    
    return { totalPosts, successfulPosts, failedPosts };
  } catch (error) {
    console.error('❌ Error reading CSV stats:', error.message);
    return null;
  }
}

// ==================== MONGODB SCHEMAS ====================
const sessionSchema = new mongoose.Schema({
  accountEmail: { type: String, required: true, unique: true },
  cookies: { type: Array, required: true },
  localStorage: { type: Object, default: {} },
  sessionStorage: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const contentLogSchema = new mongoose.Schema({
  trendingTopic: String,
  trendContext: String,
  tweetCount: String,
  generatedPost: String,
  postedAt: { type: Date, default: Date.now },
  postLength: Number,
  success: Boolean,
  retryCount: Number,
  engagement: {
    likes: { type: Number, default: 0 },
    retweets: { type: Number, default: 0 },
    replies: { type: Number, default: 0 },
    views: { type: Number, default: 0 }
  },
  metadata: {
    model: String,
    temperature: Number,
    scrollPages: Number,
    method: String
  }
});

const errorLogSchema = new mongoose.Schema({
  errorType: String,
  errorMessage: String,
  stackTrace: String,
  context: Object,
  timestamp: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);
const ContentLog = mongoose.model('ContentLog', contentLogSchema);
const ErrorLog = mongoose.model('ErrorLog', errorLogSchema);

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

async function logSuccessfulPost(trendingTopic, trendContext, tweetCount, postContent, retryCount, metadata, csvPath) {
  try {
    // Save to MongoDB
    await ContentLog.create({
      trendingTopic,
      trendContext,
      tweetCount,
      generatedPost: postContent,
      postLength: postContent.length,
      success: true,
      retryCount,
      metadata
    });
    console.log('✅ Post logged to MongoDB');
    
    // Save to CSV
    const csvData = {
      trendingTopic,
      trendContext,
      tweetCount,
      postContent,
      postLength: postContent.length,
      success: true,
      retryCount,
      model: metadata.model,
      temperature: metadata.temperature,
      method: metadata.method
    };
    
    appendToCSV(csvPath, csvData);
    
  } catch (error) {
    console.error('❌ Error logging post:', error.message);
  }
}

async function logFailedPost(trendingTopic, trendContext, tweetCount, postContent, error, csvPath) {
  try {
    // Save to MongoDB
    await ContentLog.create({
      trendingTopic,
      trendContext,
      tweetCount,
      generatedPost: postContent,
      postLength: postContent.length,
      success: false,
      retryCount: CONFIG.automation.maxRetries
    });
    
    await ErrorLog.create({
      errorType: 'POST_FAILED',
      errorMessage: error.message,
      stackTrace: error.stack,
      context: { trendingTopic, postContent }
    });
    
    // Save to CSV
    const csvData = {
      trendingTopic,
      trendContext,
      tweetCount,
      postContent,
      postLength: postContent.length,
      success: false,
      retryCount: CONFIG.automation.maxRetries,
      model: CONFIG.openrouter.model,
      temperature: 0.85,
      method: 'failed'
    };
    
    appendToCSV(csvPath, csvData);
    
  } catch (err) {
    console.error('❌ Error logging failure:', err.message);
  }
}

async function checkContentDiversity(newPost) {
  try {
    const recentPosts = await ContentLog.find({
      postedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      success: true
    }).limit(20);
    
    if (recentPosts.length === 0) return true;
    
    for (const post of recentPosts) {
      const similarity = stringSimilarity.compareTwoStrings(
        post.generatedPost.toLowerCase(),
        newPost.toLowerCase()
      );
      
      if (similarity > CONFIG.automation.similarityThreshold) {
        console.log(`⚠️  Post too similar to recent post (${(similarity * 100).toFixed(1)}% match)`);
        console.log(`   Recent: "${post.generatedPost.substring(0, 50)}..."`);
        return false;
      }
    }
    
    console.log('✅ Post is sufficiently unique');
    return true;
  } catch (error) {
    console.error('❌ Error checking diversity:', error.message);
    return true;
  }
}

// ==================== UTILITY FUNCTIONS ====================
async function humanDelay(min = CONFIG.automation.minDelayMs, max = CONFIG.automation.maxDelayMs) {
  const delay = Math.floor(Math.random() * (max - min + 1) + min);
  await sleep(delay);
}

function getOptimalPostingTime() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  
  const optimalHours = [9, 10, 11, 12, 13, 17, 18];
  const isWeekday = day >= 1 && day <= 5;
  
  const isOptimal = isWeekday && optimalHours.includes(hour);
  
  if (!isOptimal) {
    console.log(`⚠️  Current time (${now.toLocaleTimeString()}) may not be optimal for engagement`);
    console.log(`   Best times: Weekdays 9-11 AM, 12-1 PM, 5-6 PM`);
  } else {
    console.log(`✅ Posting at optimal time: ${now.toLocaleTimeString()}`);
  }
  
  return isOptimal;
}

async function randomMouseMovement(page) {
  try {
    const x = Math.floor(Math.random() * 800) + 100;
    const y = Math.floor(Math.random() * 600) + 100;
    await page.mouse.move(x, y, { steps: 10 });
  } catch (error) {
    // Ignore errors
  }
}

function selectRandomTrend(trends, usedTopics = []) {
  const availableTrends = trends.filter(trend => 
    !usedTopics.includes(trend.topic.toLowerCase())
  );
  
  if (availableTrends.length === 0) {
    console.log('  🔄 All topics used, resetting selection pool');
    const randomIndex = Math.floor(Math.random() * trends.length);
    return trends[randomIndex];
  }
  
  const randomIndex = Math.floor(Math.random() * availableTrends.length);
  const selectedTrend = availableTrends[randomIndex];
  
  console.log(`  🎲 Randomly selected trend ${randomIndex + 1} from ${availableTrends.length} available`);
  return selectedTrend;
}

// ==================== BROWSER FUNCTIONS ====================
async function launchBrowser() {
  try {
    console.log('🔄 Launching browser with anti-detection measures...');
    const browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--window-size=1920,1080',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });
    
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    
    await page.setViewport({ width: 1920, height: 1080 });
    
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];
    
    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(randomUA);
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });
      
      window.chrome = {
        runtime: {}
      };
      
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });
    
    console.log('✅ Browser launched with stealth mode');
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
    await humanDelay(1000, 2000);
    
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
    await humanDelay(3000, 5000);
    
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
    await humanDelay(3000, 5000);
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
    await humanDelay(3000, 5000);
    await randomMouseMovement(page);
    
    console.log('  📝 Entering email...');
    await page.waitForSelector('input[autocomplete="username"]', {
      visible: true,
      timeout: 15000
    });
    await page.click('input[autocomplete="username"]');
    await humanDelay(500, 1000);
    
    for (const char of CONFIG.twitter.email) {
      await page.keyboard.type(char, {
        delay: 80 + Math.random() * 120
      });
    }
    await humanDelay(1500, 2500);
    
    console.log('  ⌨️  Pressing Enter...');
    await page.keyboard.press('Enter');
    await humanDelay(4000, 6000);
    
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
        await humanDelay(500, 1000);
        
        for (const char of CONFIG.twitter.username) {
          await page.keyboard.type(char, {
            delay: 80 + Math.random() * 120
          });
        }
        await humanDelay(1500, 2500);
        console.log('  ⌨️  Pressing Enter...');
        await page.keyboard.press('Enter');
        await humanDelay(4000, 6000);
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
    await humanDelay(500, 1000);
    
    for (const char of CONFIG.twitter.password) {
      await page.keyboard.type(char, {
        delay: 80 + Math.random() * 120
      });
    }
    await humanDelay(1500, 2500);
    
    console.log('  ⌨️  Pressing Enter to login...');
    await page.keyboard.press('Enter');
    await humanDelay(6000, 8000);
    
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
    await randomMouseMovement(page);
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    console.log(`  Scroll ${i + 1}/${scrollCount}`);
    await humanDelay(2000, 4000);
  }
  console.log('✅ Scrolling completed');
}

async function getTrendingTopicsWithContext(page) {
  try {
    console.log('🔄 Extracting trending topics with context...');
    
    await page.goto('https://twitter.com/explore/tabs/trending', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await humanDelay(3000, 5000);
    
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await humanDelay(1000, 2000);
    }
    
    const trends = await page.evaluate(() => {
      const trendElements = document.querySelectorAll('[data-testid="trend"]');
      const topics = [];
      
      trendElements.forEach(element => {
        try {
          const spans = element.querySelectorAll('span');
          let trendText = '';
          let context = '';
          let tweetCount = '';
          
          spans.forEach((span, index) => {
            const text = span.textContent.trim();
            
            if (text.includes('Trending') || text.includes('·')) {
              context = text;
              return;
            }
            
            if (text.includes('posts') || text.includes('Tweets') || text.includes('K') || text.includes('M')) {
              tweetCount = text;
              return;
            }
            
            if (!trendText && text.length > 2 && !text.startsWith('#')) {
              trendText = text;
            } else if (trendText && text.startsWith('#')) {
              trendText = text;
            }
          });
          
          if (trendText && trendText.length > 2) {
            topics.push({
              topic: trendText,
              context: context || 'Trending now',
              tweetCount: tweetCount || 'N/A'
            });
          }
        } catch (err) {
          console.error('Error parsing trend:', err);
        }
      });
      
      const uniqueTopics = [];
      const seenTopics = new Set();
      
      topics.forEach(t => {
        if (!seenTopics.has(t.topic.toLowerCase())) {
          seenTopics.add(t.topic.toLowerCase());
          uniqueTopics.push(t);
        }
      });
      
      return uniqueTopics;
    });
    
    console.log(`✅ Found ${trends.length} trending topics with context`);
    return trends.slice(0, 15);
  } catch (error) {
    console.error('❌ Error extracting trending topics:', error.message);
    return [];
  }
}

async function sampleTrendingTweets(page, trendTopic, sampleSize = 3) {
  try {
    console.log(`  🔍 Sampling tweets for: "${trendTopic}"`);
    
    const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(trendTopic)}&src=trend_click&f=live`;
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await humanDelay(3000, 5000);
    
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await humanDelay(1000, 2000);
    }
    
    const sampleTweets = await page.evaluate((size) => {
      const tweets = [];
      const tweetElements = document.querySelectorAll('[data-testid="tweet"]');
      
      let count = 0;
      for (const tweetEl of tweetElements) {
        if (count >= size) break;
        
        try {
          const tweetText = tweetEl.querySelector('[data-testid="tweetText"]');
          if (tweetText && tweetText.textContent) {
            const text = tweetText.textContent.trim();
            if (text.length > 20) {
              tweets.push(text);
              count++;
            }
          }
        } catch (err) {
          continue;
        }
      }
      
      return tweets;
    }, sampleSize);
    
    console.log(`  ✅ Sampled ${sampleTweets.length} tweets`);
    return sampleTweets;
  } catch (error) {
    console.error(`  ❌ Error sampling tweets: ${error.message}`);
    return [];
  }
}

// ==================== AI POST GENERATION ====================
async function generatePostWithOpenRouter(apiKey, selectedTrend, allTrends, sampleTweets = []) {
  try {
    const topicsWithContext = allTrends
      .slice(0, 5)
      .map((t, i) => `${i + 1}. ${t.topic} (${t.context}) - ${t.tweetCount}`)
      .join('\n');
    
    let sampleContext = '';
    if (sampleTweets.length > 0) {
      sampleContext = `\n\nSAMPLE TWEETS FROM THIS TREND:\n${sampleTweets.slice(0, 2).map((t, i) => `${i + 1}. "${t.substring(0, 100)}..."`).join('\n')}`;
    }
    
    const prompt = `You're a social media expert creating an authentic Twitter post.

CURRENT TRENDING TOPICS:
${topicsWithContext}

SELECTED TOPIC: "${selectedTrend.topic}"${sampleContext}

TASK:
Create an engaging tweet about: "${selectedTrend.topic}"

REQUIREMENTS:
- Maximum 280 characters (strict limit)
- Be conversational, authentic, and insightful
- Add a unique perspective or observation
- Match the tone/style of the sample tweets if provided
- Use 1-2 relevant hashtags ONLY if natural
- Include a hook to drive engagement (question, bold statement, or insight)
- Avoid generic commentary

Return ONLY the tweet text, nothing else.`;
    
    console.log('🤖 Generating AI post with OpenRouter...');
    console.log(`  Selected topic: "${selectedTrend.topic}"`);
    console.log(`  Model: ${CONFIG.openrouter.model}`);
    
    const response = await axios.post(
      CONFIG.openrouter.apiUrl,
      {
        model: CONFIG.openrouter.model,
        messages: [
          {
            role: 'system',
            content: 'You are a viral social media strategist who creates engaging, authentic Twitter content that drives conversation.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.85,
        top_p: 0.9
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
      let content = response.data.choices[0].message.content.trim();
      content = content.replace(/^["']|["']$/g, '');
      const post = content.length > 280 ? content.substring(0, 277) + '...' : content;
      
      console.log(`✅ Generated post (${post.length} chars)`);
      console.log(`   Preview: "${post.substring(0, 80)}${post.length > 80 ? '...' : ''}"`);
      
      return { 
        post, 
        topic: selectedTrend.topic, 
        context: selectedTrend.context,
        tweetCount: selectedTrend.tweetCount
      };
    }
    
    throw new Error('Invalid response from OpenRouter');
  } catch (error) {
    console.error('❌ Error generating post:', error.message);
    
    if (error.response) {
      console.error('  API Response:', error.response.data);
    }
    
    return null;
  }
}

// ==================== COMMENT FUNCTIONS ====================
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
        if (num >= 1 && num <= 9) {
          return num;
        }
        return null; // Skip if not 1-9
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
            if (num >= 1 && num <= 9) {
              return num;
            }
            if (num > 9 || num === 0) {
              return null; // Skip if 0 or >= 10
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
            if (num >= 1 && num <= 9) {
              return num;
            }
            if (num > 9 || num === 0) {
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

async function generateAIComment(postText) {
  try {
    if (!CONFIG.openrouter.apiKey) {
      return null;
    }
    
    const prompt = `You are a friendly Twitter user. Generate a short, natural, engaging comment (max 280 characters) that responds to this tweet. Be authentic and conversational. Do not use hashtags or @mentions unless necessary.

Tweet: "${postText.substring(0, 500)}"

Generate a natural comment:`;
    
    const response = await axios.post(
      CONFIG.openrouter.apiUrl,
      {
        model: CONFIG.openrouter.model,
        messages: [
          {
            role: 'system',
            content: 'You are a friendly Twitter user. Generate a short, natural, engaging comment (max 280 characters) that responds to the tweet. Be authentic and conversational. Do not use hashtags or @mentions unless necessary.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.85,
        top_p: 0.9
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
      let comment = response.data.choices[0].message.content.trim();
      comment = comment.replace(/^["']|["']$/g, '');
      return comment.length > 280 ? comment.substring(0, 277) + '...' : comment;
    }
    
    return null;
  } catch (error) {
    console.error('  ❌ Error generating AI comment:', error.message);
    return null;
  }
}

async function extractPostText(page, tweetElement) {
  try {
    const text = await tweetElement.evaluate((el) => {
      const textElement = el.querySelector('[data-testid="tweetText"]') || 
                         el.querySelector('[lang]') ||
                         el.querySelector('span[dir="auto"]');
      
      if (textElement) {
        return textElement.innerText || textElement.textContent || '';
      }
      
      return el.innerText || el.textContent || '';
    });
    
    return text.trim();
  } catch (error) {
    return '';
  }
}

async function getTweetLinkFromElement(tweetElement) {
  try {
    const hrefHandle = await tweetElement.evaluateHandle((el) => {
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

async function commentOnPost(page, tweetElement) {
  try {
    // First check comment count - only proceed if 1-9
    const commentCount = await getCommentCount(tweetElement);
    
    if (commentCount === null || commentCount === 0 || commentCount > 9) {
      return { 
        success: false, 
        error: `Comment count is ${commentCount === null ? 'unknown' : commentCount}, skipping (only commenting on posts with 1-9 comments)` 
      };
    }
    
    console.log(`  ✅ Post has ${commentCount} comment(s) - proceeding to comment`);
    
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
    console.log('  🤖 Generating AI comment...');
    const comment = await generateAIComment(postText);
    
    if (!comment) {
      return { success: false, error: 'Could not generate comment' };
    }
    
    console.log(`  💬 Generated comment: "${comment.substring(0, 50)}..."`);
    
    // Get post link for logging (attempt before clicking, in case modal changes DOM)
    const postLink = await getTweetLinkFromElement(tweetElement);
    
    // Scroll button into view
    await replyButton.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await humanDelay(500, 1000);
    
    // Click reply button
    await replyButton.click();
    await humanDelay(1000, 2000);
    
    // Wait for reply textarea to appear
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
      await page.keyboard.press('Escape');
      return { success: false, error: 'Reply textarea not found' };
    }
    
    // Type the comment with human-like delays
    await replyTextarea.click();
    await humanDelay(500, 1000);
    
    // Clear any existing text first
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await humanDelay(200, 400);
    
    // Type character by character
    for (const char of comment) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    await humanDelay(1000, 2000);
    
    // Find and click the reply/tweet button
    let tweetButton = await page.$('button[data-testid="tweetButton"]');
    
    if (!tweetButton) {
      tweetButton = await page.$('button[data-testid="tweetButtonInline"]');
    }
    
    if (!tweetButton) {
      await page.keyboard.press('Escape');
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
    await humanDelay(2000, 3000);
    
    // Verify comment was posted (check if reply modal closed)
    const modalClosed = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="tweetTextarea_0"]');
      return !modal || modal.offsetParent === null;
    });
    
    if (modalClosed) {
      console.log('  ✅ Comment posted successfully');
      return { success: true, comment, commentCount, postLink };
    } else {
      // Try to close modal
      await page.keyboard.press('Escape');
      return { success: true, comment, commentCount, postLink }; // Assume success even if modal still open
    }
    
  } catch (error) {
    console.error('  ❌ Error commenting on post:', error.message);
    try {
      await page.keyboard.press('Escape');
    } catch (e) {
      // Ignore
    }
    return { success: false, error: error.message };
  }
}

async function findAndCommentOnPosts(page, maxAttempts = 10) {
  try {
    console.log('\n💬 STEP: FINDING POSTS TO COMMENT ON');
    console.log('─'.repeat(60));
    console.log('  🔍 Looking for posts with 1-9 comments...');
    
    // Get all visible tweets
    const tweets = await page.$$('[data-testid="tweet"]');
    
    if (tweets.length === 0) {
      return { success: false, error: 'No tweets found' };
    }
    
    console.log(`  📊 Found ${tweets.length} tweets, checking comment counts...`);
    
    // Filter to only tweets with 1-9 comments
    const eligibleTweets = [];
    for (const tweet of tweets) {
      try {
        const commentCount = await getCommentCount(tweet);
        if (commentCount !== null && commentCount >= 1 && commentCount <= 9) {
          eligibleTweets.push({ tweet, commentCount });
          console.log(`  ✅ Found eligible post with ${commentCount} comment(s)`);
        }
      } catch (e) {
        continue;
      }
    }
    
    if (eligibleTweets.length === 0) {
      console.log('  ⚠️  No posts found with 1-9 comments');
      return { success: false, error: 'No eligible posts found (need 1-9 comments)' };
    }
    
    console.log(`  ✅ Found ${eligibleTweets.length} eligible post(s) with 1-9 comments`);
    
    // Randomly select one tweet
    const randomIndex = Math.floor(Math.random() * eligibleTweets.length);
    const selected = eligibleTweets[randomIndex];
    
    console.log(`  🎲 Selected post with ${selected.commentCount} comment(s)`);
    
    // Comment on the selected tweet
    return await commentOnPost(page, selected.tweet);
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== POST VERIFICATION ====================
async function verifyTweetPosted(page, tweetContent) {
  try {
    console.log('  🔍 Verifying tweet was posted...');
    await humanDelay(2000, 3000);
    
    const textareaCleared = await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="tweetTextarea_0"]');
      if (!textarea) return true;
      const content = textarea.textContent || textarea.innerText || '';
      return content.trim() === '';
    });
    
    if (textareaCleared) {
      console.log('  ✅ Compose area cleared - tweet posted successfully');
      // Navigate to home immediately after successful post
      await page.goto('https://twitter.com/home', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      await humanDelay(2000, 3000);
      return true;
    }
    
    await page.goto('https://twitter.com/home', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await humanDelay(3000, 5000);
    
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

// ==================== POST TWEET FUNCTION ====================
async function postTweetWithButton(page, tweetContent) {
  try {
    console.log('\n🔄 Starting tweet posting process...');
    console.log(`📝 Content: "${tweetContent}"`);
    console.log(`📏 Length: ${tweetContent.length} characters`);
    
    await page.goto('https://twitter.com/home', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await humanDelay(2000, 3000);
    await randomMouseMovement(page);
    
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
    
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (el) {
        el.textContent = '';
        el.innerHTML = '';
      }
    }, textareaSelectors[0]);
    
    await textarea.click();
    await humanDelay(500, 1000);
    await randomMouseMovement(page);
    
    console.log('  ⌨️  Typing tweet content...');
    for (const char of tweetContent) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    console.log(`  ✅ Typed ${tweetContent.length} characters`);
    await humanDelay(2000, 3000);
    
    console.log('  🖱️  Preparing to click Post button...');
    
    const postButtonSelector = '[data-testid="tweetButtonInline"]';
    
    await page.waitForSelector(postButtonSelector, {
      visible: true,
      timeout: 10000
    });
    console.log('  ✅ Post button found');
    
    await page.evaluate((selector) => {
      const button = document.querySelector(selector);
      if (button) {
        button.disabled = false;
        button.removeAttribute('disabled');
        button.removeAttribute('aria-disabled');
      }
    }, postButtonSelector);
    
    console.log('  ✅ Button enabled (forced)');
    await humanDelay(1000, 1500);
    
    await page.evaluate((selector) => {
      const button = document.querySelector(selector);
      if (button) {
        button.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    }, postButtonSelector);
    
    await humanDelay(800, 1200);
    console.log('  ✅ Button scrolled into view');
    
    let clicked = false;
    
    try {
      console.log('  🖱️  Attempting native browser click...');
      await page.$eval(postButtonSelector, element => element.click());
      console.log('  ✅ Post button clicked (native click)');
      clicked = true;
    } catch (nativeError) {
      console.log('  ⚠️  Native click failed, trying page.evaluate...');
    }
    
    if (!clicked) {
      try {
        await page.evaluate((selector) => {
          const button = document.querySelector(selector);
          if (button) {
            button.click();
          }
        }, postButtonSelector);
        console.log('  ✅ Post button clicked (evaluate click)');
        clicked = true;
      } catch (evalError) {
        console.log('  ⚠️  Evaluate click failed, trying coordinate click...');
      }
    }
    
    if (!clicked) {
      try {
        const buttonElement = await page.$(postButtonSelector);
        if (buttonElement) {
          const box = await buttonElement.boundingBox();
          if (box) {
            const x = box.x + (box.width / 2);
            const y = box.y + (box.height / 2);
            await page.mouse.click(x, y, { delay: 100 });
            console.log('  ✅ Post button clicked (coordinate click)');
            clicked = true;
          }
        }
      } catch (coordError) {
        console.log('  ❌ All click methods failed');
      }
    }
    
    if (!clicked) {
      throw new Error('Failed to click Post button with all methods');
    }
    
    console.log('  ⏳ Waiting for tweet to post...');
    await humanDelay(5000, 7000);
    
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
    
    try {
      const screenshotPath = `tweet-error-${Date.now()}.png`;
      await page.screenshot({ 
        path: screenshotPath,
        fullPage: true 
      });
      console.log(`📸 Screenshot saved: ${screenshotPath}`);
    } catch (screenshotError) {
      console.error('Could not save screenshot');
    }
    
    return false;
  }
}

// ==================== POST WITH RETRY LOGIC ====================
async function postTweetWithRetry(page, postData, csvPath, maxRetries = CONFIG.automation.maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`\n📤 POSTING ATTEMPT ${attempt}/${maxRetries}`);
    console.log('─'.repeat(60));
    
    try {
      const success = await postTweetWithButton(page, postData.post);
      
      if (success) {
        await logSuccessfulPost(
          postData.topic,
          postData.context,
          postData.tweetCount,
          postData.post,
          attempt,
          {
            model: CONFIG.openrouter.model,
            temperature: 0.85,
            scrollPages: CONFIG.automation.scrollPages,
            method: 'native_click_forced'
          },
          csvPath
        );
        return true;
      }
      
      if (attempt < maxRetries) {
        console.log(`⏳ Waiting before retry...`);
        await humanDelay(5000, 10000);
      }
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        await logFailedPost(postData.topic, postData.context, postData.tweetCount, postData.post, error, csvPath);
        return false;
      }
      
      await humanDelay(3000, 6000);
    }
  }
  
  return false;
}

// ==================== MAIN FUNCTION ====================
async function main() {
  console.log('🚀 ENHANCED TWITTER AUTOMATION WITH AI & CSV LOGGING\n');
  console.log('═'.repeat(60));
  
  validateConfig();
  
  // Initialize CSV
  const csvPath = initializeCSV();
  console.log(`📄 CSV file: ${csvPath}`);
  
  // Show CSV stats
  const stats = readCSVStats(csvPath);
  if (stats) {
    console.log(`📊 CSV Stats: ${stats.totalPosts} total posts (${stats.successfulPosts} successful, ${stats.failedPosts} failed)\n`);
  }
  
  await connectMongoDB();
  
  let browser, page;
  const usedTopics = [];
  
  try {
    console.log('\n⏰ TIMING CHECK');
    console.log('─'.repeat(60));
    getOptimalPostingTime();
    
    console.log('\n📱 STEP 1: BROWSER INITIALIZATION');
    console.log('─'.repeat(60));
    const result = await launchBrowser();
    browser = result.browser;
    page = result.page;
    
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
    
    console.log('\n📜 STEP 3: SCROLLING FEED');
    console.log('─'.repeat(60));
    await page.goto('https://twitter.com/home', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await humanDelay(2000, 3000);
    await autoScrollPages(page, CONFIG.automation.scrollPages);
    
    console.log('\n📊 STEP 4: EXTRACTING TRENDING TOPICS');
    console.log('─'.repeat(60));
    const trendingTopics = await getTrendingTopicsWithContext(page);
    
    if (trendingTopics.length === 0) {
      throw new Error('No trending topics found');
    }
    
    console.log(`✅ Trending Topics (${trendingTopics.length} found):\n`);
    trendingTopics.forEach((trend, i) => {
      console.log(`${i + 1}. ${trend.topic}`);
      console.log(`   Context: ${trend.context}`);
      console.log(`   Volume: ${trend.tweetCount}`);
      console.log();
    });
    
    console.log('🎲 STEP 5: RANDOM TOPIC SELECTION');
    console.log('─'.repeat(60));
    const selectedTrend = selectRandomTrend(trendingTopics, usedTopics);
    usedTopics.push(selectedTrend.topic.toLowerCase());
    
    console.log(`✅ Selected: "${selectedTrend.topic}"`);
    console.log(`   Context: ${selectedTrend.context}`);
    console.log(`   Volume: ${selectedTrend.tweetCount}\n`);
    
    console.log('📝 STEP 6: SAMPLING TRENDING TWEETS');
    console.log('─'.repeat(60));
    const sampleTweets = await sampleTrendingTweets(page, selectedTrend.topic, 3);
    
    if (sampleTweets.length > 0) {
      console.log(`\nSample tweets for "${selectedTrend.topic}":`);
      sampleTweets.forEach((tweet, i) => {
        console.log(`\n${i + 1}. "${tweet.substring(0, 100)}${tweet.length > 100 ? '...' : ''}"`);
      });
    }
    
    console.log('\n\n🤖 STEP 7: GENERATING AI POST');
    console.log('─'.repeat(60));
    const postData = await generatePostWithOpenRouter(
      CONFIG.openrouter.apiKey,
      selectedTrend,
      trendingTopics,
      sampleTweets
    );
    
    if (!postData) {
      throw new Error('Could not generate post content');
    }
    
    console.log('\n📝 Generated Post:');
    console.log('┌' + '─'.repeat(58) + '┐');
    const lines = postData.post.match(/.{1,56}/g) || [postData.post];
    lines.forEach(line => {
      console.log(`│ ${line.padEnd(56)} │`);
    });
    console.log('└' + '─'.repeat(58) + '┘');
    console.log(`Length: ${postData.post.length}/280 characters`);
    console.log(`Topic: ${postData.topic}`);
    
    console.log('\n🔍 STEP 8: CONTENT DIVERSITY CHECK');
    console.log('─'.repeat(60));
    const isDiverse = await checkContentDiversity(postData.post);
    
    if (!isDiverse) {
      console.log('⚠️  Generated post is too similar to recent posts');
      console.log('   Regenerating with different trend...');
      
      const newTrend = selectRandomTrend(trendingTopics, usedTopics);
      usedTopics.push(newTrend.topic.toLowerCase());
      
      const retryPostData = await generatePostWithOpenRouter(
        CONFIG.openrouter.apiKey,
        newTrend,
        trendingTopics,
        []
      );
      
      if (retryPostData) {
        Object.assign(postData, retryPostData);
        console.log(`✅ New post generated: "${postData.post.substring(0, 60)}..."`);
      }
    }
    
    console.log('\n📤 STEP 9: POSTING TWEETS');
    console.log('═'.repeat(60));
    console.log(`📝 Posts to do: ${CONFIG.automation.postsToDo}`);
    
    let totalPosted = 0;
    let totalFailed = 0;
    
    // Loop to post multiple times
    for (let postNumber = 1; postNumber <= CONFIG.automation.postsToDo; postNumber++) {
      console.log(`\n🔄 POST ${postNumber}/${CONFIG.automation.postsToDo}`);
      console.log('─'.repeat(60));
      
      // If not the first post, get a new trend and generate new content
      if (postNumber > 1) {
        console.log('\n📊 Getting new trending topic...');
        const newTrendingTopics = await getTrendingTopicsWithContext(page);
        if (newTrendingTopics.length > 0) {
          const newSelectedTrend = selectRandomTrend(newTrendingTopics, usedTopics);
          usedTopics.push(newSelectedTrend.topic.toLowerCase());
          
          console.log(`✅ Selected: "${newSelectedTrend.topic}"`);
          
          const newSampleTweets = await sampleTrendingTweets(page, newSelectedTrend.topic, 3);
          
          const newPostData = await generatePostWithOpenRouter(
            CONFIG.openrouter.apiKey,
            newSelectedTrend,
            newTrendingTopics,
            newSampleTweets
          );
          
          if (newPostData) {
            Object.assign(postData, newPostData);
            console.log(`✅ Generated new post: "${postData.post.substring(0, 60)}..."`);
          }
        }
        
        // Navigate to home before posting
        await page.goto('https://twitter.com/home', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await humanDelay(2000, 3000);
      }
      
      const posted = await postTweetWithRetry(page, postData, csvPath);
      
      if (posted) {
        totalPosted++;
        console.log(`✅ Post ${postNumber} completed successfully!`);
        
        // Navigate to home after successful post
        await page.goto('https://twitter.com/home', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await humanDelay(3000, 5000); // Wait before next post
        
        // If not the last post, wait a bit more
        if (postNumber < CONFIG.automation.postsToDo) {
          console.log(`⏳ Waiting before next post...`);
          await humanDelay(5000, 8000);
        }
      } else {
        totalFailed++;
        console.log(`⚠️  Post ${postNumber} failed`);
      }
    }
    
    // Comment on posts with 1-9 comments
    if (CONFIG.openrouter.apiKey) {
      console.log('\n💬 STEP 10: COMMENTING ON POSTS');
      console.log('═'.repeat(60));
      console.log('  📋 Filter: Only commenting on posts with 1-9 comments');
      
      // Navigate to home to see posts
      await page.goto('https://twitter.com/home', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      await humanDelay(3000, 5000);
      
      // Scroll a bit to see more posts
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await humanDelay(2000, 3000);
      }
      
      const commentResult = await findAndCommentOnPosts(page);
      
      if (commentResult.success) {
        console.log(`\n✅ Successfully commented on a post!`);
        console.log(`   Comment: "${commentResult.comment?.substring(0, 60)}${commentResult.comment?.length > 60 ? '...' : ''}"`);
        console.log(`   Post had ${commentResult.commentCount} comment(s)`);
      } else {
        console.log(`\n⚠️  Could not comment: ${commentResult.error}`);
      }
    } else {
      console.log('\n💬 STEP 10: COMMENTING ON POSTS');
      console.log('═'.repeat(60));
      console.log('  ⚠️  OpenRouter API key not configured - commenting disabled');
    }
    
    console.log('\n' + '═'.repeat(60));
    if (totalPosted > 0) {
      console.log('🎉 AUTOMATION COMPLETED!');
      console.log('═'.repeat(60));
      console.log(`✅ Total posts attempted: ${CONFIG.automation.postsToDo}`);
      console.log(`✅ Successfully posted: ${totalPosted}`);
      if (totalFailed > 0) {
        console.log(`⚠️  Failed posts: ${totalFailed}`);
      }
      console.log(`✅ Scrolled ${CONFIG.automation.scrollPages} pages`);
      console.log(`✅ Found ${trendingTopics.length} trending topics`);
      console.log(`✅ Logged to MongoDB & CSV`);
      console.log(`   CSV: ${csvPath}`);
    } else {
      console.log('⚠️  AUTOMATION COMPLETED WITH WARNINGS');
      console.log('═'.repeat(60));
      console.log(`❌ All ${CONFIG.automation.postsToDo} posts failed`);
      console.log(`   Error logged to CSV: ${csvPath}`);
    }
    
    console.log('\n⏳ Keeping browser open for 30 seconds for verification...');
    await sleep(30000);
    
  } catch (error) {
    console.error('\n❌ AUTOMATION ERROR');
    console.error('═'.repeat(60));
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    
    try {
      await ErrorLog.create({
        errorType: 'CRITICAL_AUTOMATION_ERROR',
        errorMessage: error.message,
        stackTrace: error.stack,
        context: { timestamp: new Date() }
      });
    } catch (logError) {
      console.error('Could not log error to database:', logError.message);
    }
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

main().catch(console.error);
