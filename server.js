require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// ==================== MONGODB CONNECTION ====================
async function connectMongoDB() {
  try {
    if (!process.env.MONGO_URI) {
      console.log('⚠️  MONGO_URI not set, MongoDB features will be limited');
      return false;
    }
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    return false;
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

const accountSchema = new mongoose.Schema({
  email: { type: String, required: true },
  password: { type: String, required: true },
  savedAt: { type: Date, default: Date.now }
});

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
const ContentLog = mongoose.models.ContentLog || mongoose.model('ContentLog', contentLogSchema);
const Account = mongoose.models.Account || mongoose.model('Account', accountSchema);

// ==================== CSV FILE PATHS ====================
// Try multiple possible locations for CSV files
function findCSVFile(possiblePaths) {
  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

const CSV_PATHS = {
  activityLog: findCSVFile([
    path.resolve(process.cwd(), 'activity_log.csv'),
    path.resolve(process.cwd(), 'data', 'activity_log.csv')
  ]),
  twitterPosts: findCSVFile([
    path.resolve(process.cwd(), 'data', 'twitter_posts.csv'),
    path.resolve(process.cwd(), 'twitter_posts.csv')
  ])
};

// ==================== CSV PARSING FUNCTIONS ====================
function parseCSVLine(line) {
  const values = [];
  let currentValue = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        currentValue += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(currentValue.trim());
      currentValue = '';
    } else {
      currentValue += char;
    }
  }
  values.push(currentValue.trim());
  return values;
}

function parseCSV(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    if (lines.length <= 1) return [];
    
    const headers = parseCSVLine(lines[0]).map(h => h.replace(/^"|"$/g, ''));
    const data = [];
    
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      
      const values = parseCSVLine(lines[i]);
      
      if (values.length >= headers.length) {
        const row = {};
        headers.forEach((header, index) => {
          let value = values[index] || '';
          value = value.replace(/^"|"$/g, '');
          row[header] = value;
        });
        data.push(row);
      }
    }
    
    return data;
  } catch (error) {
    console.error(`Error parsing CSV ${filePath}:`, error.message);
    return [];
  }
}

// ==================== AUTOMATION PROCESSES ====================
let postAutomationProcess = null;
let loginAutomationProcess = null;

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== ACCOUNT ROUTES ====================
app.post('/api/account/save', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }
    
    // Save to MongoDB
    if (mongoose.connection.readyState === 1) {
      const account = await Account.findOneAndUpdate(
        { email },
        { email, password, savedAt: new Date() },
        { upsert: true, new: true }
      );
      return res.json({ success: true, account });
    }
    
    // Fallback: save to file
    const accountsFile = path.join(process.cwd(), 'accounts.json');
    let accounts = [];
    if (fs.existsSync(accountsFile)) {
      accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    }
    
    const existingIndex = accounts.findIndex(acc => acc.email === email);
    const accountData = {
      id: existingIndex >= 0 ? accounts[existingIndex].id : Date.now(),
      email,
      password,
      savedAt: new Date().toISOString()
    };
    
    if (existingIndex >= 0) {
      accounts[existingIndex] = accountData;
    } else {
      accounts.push(accountData);
    }
    
    fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
    res.json({ success: true, account: accountData });
  } catch (error) {
    console.error('Error saving account:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    // Try MongoDB first
    if (mongoose.connection.readyState === 1) {
      const accounts = await Account.find().sort({ savedAt: -1 });
      return res.json({ success: true, accounts });
    }
    
    // Fallback: read from file
    const accountsFile = path.join(process.cwd(), 'accounts.json');
    if (fs.existsSync(accountsFile)) {
      const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
      return res.json({ success: true, accounts });
    }
    
    res.json({ success: true, accounts: [] });
  } catch (error) {
    console.error('Error loading accounts:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/account/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Try MongoDB first
    if (mongoose.connection.readyState === 1) {
      await Account.findByIdAndDelete(id);
      return res.json({ success: true });
    }
    
    // Fallback: delete from file
    const accountsFile = path.join(process.cwd(), 'accounts.json');
    if (fs.existsSync(accountsFile)) {
      let accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
      accounts = accounts.filter(acc => acc.id.toString() !== id);
      fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== AUTOMATION ROUTES ====================
app.post('/api/automation/post/start', async (req, res) => {
  try {
    if (postAutomationProcess && !postAutomationProcess.killed) {
      return res.status(400).json({ success: false, message: 'Post automation is already running' });
    }
    
    const { email, password, postsToDo } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }
    
    // Create a new env object with credentials and posts to do
    const env = {
      ...process.env,
      TWITTER_EMAIL: email,
      TWITTER_PASSWORD: password,
      POSTS_TO_DO: postsToDo ? String(postsToDo) : '1' // Number of posts to do
    };
    
    // Start post.js script
    postAutomationProcess = spawn('node', ['post.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env,
      detached: false
    });
    
    // Handle process output
    postAutomationProcess.stdout.on('data', (data) => {
      console.log(`[Post Automation] ${data.toString().trim()}`);
    });
    
    postAutomationProcess.stderr.on('data', (data) => {
      console.error(`[Post Automation Error] ${data.toString().trim()}`);
    });
    
    postAutomationProcess.on('exit', (code) => {
      console.log(`[Post Automation] Process exited with code ${code}`);
      postAutomationProcess = null;
    });
    
    postAutomationProcess.on('error', (error) => {
      console.error(`[Post Automation] Failed to start:`, error);
      postAutomationProcess = null;
    });
    
    // Wait a moment to check if process started successfully
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (postAutomationProcess && !postAutomationProcess.killed) {
      res.json({ success: true, message: 'Post automation started successfully' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to start post automation' });
    }
  } catch (error) {
    console.error('Error starting post automation:', error);
    if (postAutomationProcess) {
      postAutomationProcess.kill();
      postAutomationProcess = null;
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/automation/post/stop', async (req, res) => {
  try {
    if (postAutomationProcess && !postAutomationProcess.killed) {
      console.log('[Post Automation] Stopping process...');
      
      // On Windows, use different signal handling
      const isWindows = process.platform === 'win32';
      
      try {
        // Try to kill the process and all its children
        if (isWindows) {
          // On Windows, kill the process tree
          const pid = postAutomationProcess.pid;
          
          // Kill the process and its children
          exec(`taskkill /F /T /PID ${pid}`, (error) => {
            if (error) {
              console.log(`[Post Automation] Error killing process tree: ${error.message}`);
            } else {
              console.log(`[Post Automation] Process tree killed successfully`);
            }
          });
        } else {
          // On Unix-like systems, use SIGTERM first, then SIGKILL
          postAutomationProcess.kill('SIGTERM');
          
          // Force kill after 2 seconds if still running
          setTimeout(() => {
            if (postAutomationProcess && !postAutomationProcess.killed) {
              postAutomationProcess.kill('SIGKILL');
              console.log('[Post Automation] Forcefully terminated with SIGKILL');
            }
          }, 2000);
        }
      } catch (killError) {
        console.error('[Post Automation] Error during kill:', killError);
      }
      
      // Clear the process reference immediately
      postAutomationProcess = null;
      
      console.log('[Post Automation] Stop request completed');
      res.json({ success: true, message: 'Post automation stopped', running: false });
    } else {
      console.log('[Post Automation] Process was not running');
      res.json({ success: true, message: 'Post automation was not running', running: false });
    }
  } catch (error) {
    console.error('Error stopping post automation:', error);
    postAutomationProcess = null;
    res.status(500).json({ success: false, message: error.message, running: false });
  }
});

app.post('/api/automation/login/start', async (req, res) => {
  try {
    if (loginAutomationProcess && !loginAutomationProcess.killed) {
      return res.status(400).json({ success: false, message: 'Login automation is already running' });
    }
    
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }
    
    // Create a new env object with credentials
    const env = {
      ...process.env,
      TWITTER_EMAIL: email,
      TWITTER_PASSWORD: password
    };
    
    // Start login_X.js script
    loginAutomationProcess = spawn('node', ['login_X.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env,
      detached: false
    });
    
    // Handle process output
    loginAutomationProcess.stdout.on('data', (data) => {
      console.log(`[Login Automation] ${data.toString().trim()}`);
    });
    
    loginAutomationProcess.stderr.on('data', (data) => {
      console.error(`[Login Automation Error] ${data.toString().trim()}`);
    });
    
    loginAutomationProcess.on('exit', (code) => {
      console.log(`[Login Automation] Process exited with code ${code}`);
      loginAutomationProcess = null;
    });
    
    loginAutomationProcess.on('error', (error) => {
      console.error(`[Login Automation] Failed to start:`, error);
      loginAutomationProcess = null;
    });
    
    // Wait a moment to check if process started successfully
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (loginAutomationProcess && !loginAutomationProcess.killed) {
      res.json({ success: true, message: 'Login automation started successfully' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to start login automation' });
    }
  } catch (error) {
    console.error('Error starting login automation:', error);
    if (loginAutomationProcess) {
      loginAutomationProcess.kill();
      loginAutomationProcess = null;
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/automation/login/stop', async (req, res) => {
  try {
    if (loginAutomationProcess && !loginAutomationProcess.killed) {
      console.log('[Login Automation] Stopping process...');
      
      // On Windows, use different signal handling
      const isWindows = process.platform === 'win32';
      
      try {
        // Try to kill the process and all its children
        if (isWindows) {
          // On Windows, kill the process tree
          const pid = loginAutomationProcess.pid;
          
          // Kill the process and its children
          exec(`taskkill /F /T /PID ${pid}`, (error) => {
            if (error) {
              console.log(`[Login Automation] Error killing process tree: ${error.message}`);
            } else {
              console.log(`[Login Automation] Process tree killed successfully`);
            }
          });
        } else {
          // On Unix-like systems, use SIGTERM first, then SIGKILL
          loginAutomationProcess.kill('SIGTERM');
          
          // Force kill after 2 seconds if still running
          setTimeout(() => {
            if (loginAutomationProcess && !loginAutomationProcess.killed) {
              loginAutomationProcess.kill('SIGKILL');
              console.log('[Login Automation] Forcefully terminated with SIGKILL');
            }
          }, 2000);
        }
      } catch (killError) {
        console.error('[Login Automation] Error during kill:', killError);
      }
      
      // Clear the process reference immediately
      loginAutomationProcess = null;
      
      console.log('[Login Automation] Stop request completed');
      res.json({ success: true, message: 'Login automation stopped', running: false });
    } else {
      console.log('[Login Automation] Process was not running');
      res.json({ success: true, message: 'Login automation was not running', running: false });
    }
  } catch (error) {
    console.error('Error stopping login automation:', error);
    loginAutomationProcess = null;
    res.status(500).json({ success: false, message: error.message, running: false });
  }
});

// ==================== AUTOMATION STATUS ROUTES ====================
app.get('/api/automation/post/status', (req, res) => {
  res.json({ 
    running: !!(postAutomationProcess && !postAutomationProcess.killed),
    lastRun: postAutomationProcess && !postAutomationProcess.killed ? new Date() : null
  });
});

app.get('/api/automation/login/status', (req, res) => {
  res.json({ 
    running: !!(loginAutomationProcess && !loginAutomationProcess.killed),
    lastRun: loginAutomationProcess && !loginAutomationProcess.killed ? new Date() : null
  });
});

app.get('/api/automation/status', (req, res) => {
  res.json({
    postAutomation: {
      running: !!(postAutomationProcess && !postAutomationProcess.killed),
      lastRun: postAutomationProcess && !postAutomationProcess.killed ? new Date() : null
    },
    loginAutomation: {
      running: !!(loginAutomationProcess && !loginAutomationProcess.killed),
      lastRun: loginAutomationProcess && !loginAutomationProcess.killed ? new Date() : null
    }
  });
});

// ==================== STATS ROUTES ====================
app.get('/api/stats', async (req, res) => {
  try {
    let totalPosts = 0;
    let totalLikes = 0;
    let totalComments = 0;
    let activeSessions = 0;
    
    // Get posts from MongoDB
    if (mongoose.connection.readyState === 1) {
      try {
        totalPosts = await ContentLog.countDocuments({ success: true });
      } catch (err) {
        console.error('Error getting posts from MongoDB:', err);
        const postsData = parseCSV(CSV_PATHS.twitterPosts);
        totalPosts = postsData.filter(row => row.Success === 'Yes').length;
      }
    } else {
      // Fallback: count from CSV
      const postsData = parseCSV(CSV_PATHS.twitterPosts);
      totalPosts = postsData.filter(row => row.Success === 'Yes').length;
    }
    
    // Get activity data from CSV
    const activityData = parseCSV(CSV_PATHS.activityLog);
    totalLikes = activityData.reduce((sum, row) => sum + parseInt(row.like_count || 0), 0);
    totalComments = activityData.filter(row => row.comment_text && row.comment_text.trim()).length;
    
    // Get unique sessions
    const uniqueSessions = new Set(activityData.map(row => row.session_id).filter(Boolean));
    activeSessions = uniqueSessions.size;
    
    res.json({
      totalPosts,
      totalLikes,
      totalComments,
      activeSessions
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== ACTIVITY ROUTES ====================
app.get('/api/activity', async (req, res) => {
  try {
    let loginActivities = [];
    let postActivities = [];
    let stats = {
      totalScrolls: 0,
      totalLikes: 0,
      totalComments: 0,
      totalSessions: 0,
      totalPosts: 0
    };
    
    // Read activity log CSV (login_X.js data)
    if (CSV_PATHS.activityLog) {
      console.log(`📄 Reading activity log from: ${CSV_PATHS.activityLog}`);
      const activityData = parseCSV(CSV_PATHS.activityLog);
      console.log(`✅ Found ${activityData.length} activity log entries`);
      
      // Transform login activity data - newest first, limit to 10
      loginActivities = activityData
        .map(row => ({
          timestamp: row.timestamp || '',
          scroll_count: parseInt(row.scroll_count || 0),
          like_count: parseInt(row.like_count || 0),
          post_link: row.post_link || '',
          comment_text: row.comment_text || ''
        }))
        .filter(row => row.timestamp) // Filter out empty rows
        .sort((a, b) => {
          const dateA = new Date(a.timestamp);
          const dateB = new Date(b.timestamp);
          return dateB - dateA; // Newest first
        })
        .slice(0, 10);
      
      // Calculate stats from all data (not just first 10)
      stats.totalScrolls = activityData.reduce((sum, row) => sum + parseInt(row.scroll_count || 0), 0);
      stats.totalLikes = activityData.reduce((sum, row) => sum + parseInt(row.like_count || 0), 0);
      stats.totalComments = activityData.filter(row => row.comment_text && row.comment_text.trim()).length;
      const uniqueSessions = new Set(activityData.map(row => row.session_id).filter(Boolean));
      stats.totalSessions = uniqueSessions.size;
    } else {
      console.log('⚠️  Activity log CSV not found');
    }
    
    // Read posts CSV (post.js data)
    if (CSV_PATHS.twitterPosts) {
      console.log(`📄 Reading posts from: ${CSV_PATHS.twitterPosts}`);
      const postsData = parseCSV(CSV_PATHS.twitterPosts);
      console.log(`✅ Found ${postsData.length} post entries`);
      
      // Transform post data - newest first, limit to 10
      postActivities = postsData
        .map(row => ({
          timestamp: row.Timestamp || row.timestamp || '',
          trending_topic: row['Trending Topic'] || row.trending_topic || '',
          topic_context: row['Topic Context'] || row.topic_context || '',
          tweet_volume: row['Tweet Volume'] || row.tweet_volume || '',
          post_content: row['Post Content'] || row.post_content || '',
          post_length: parseInt(row['Post Length'] || row.post_length || 0),
          success: row.Success || row.success || 'No',
          model_used: row['Model Used'] || row.model_used || ''
        }))
        .filter(row => row.timestamp) // Filter out empty rows
        .sort((a, b) => {
          const dateA = new Date(a.timestamp);
          const dateB = new Date(b.timestamp);
          return dateB - dateA; // Newest first
        })
        .slice(0, 10);
      
      // Get posts count from CSV
      stats.totalPosts = postsData.filter(row => 
        (row.Success === 'Yes' || row.success === 'Yes' || row.success === true)
      ).length;
    } else {
      console.log('⚠️  Twitter posts CSV not found');
      // Try MongoDB as fallback
      if (mongoose.connection.readyState === 1) {
        try {
          stats.totalPosts = await ContentLog.countDocuments({ success: true });
          console.log(`✅ Found ${stats.totalPosts} posts in MongoDB`);
        } catch (err) {
          console.log('⚠️  Could not read posts from MongoDB:', err.message);
        }
      }
    }
    
    res.json({ 
      success: true, 
      loginActivities, 
      postActivities,
      stats 
    });
  } catch (error) {
    console.error('Error getting activity data:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== START SERVER ====================
async function startServer() {
  await connectMongoDB();
  
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 API endpoints available at http://localhost:${PORT}/api`);
  });
}

startServer().catch(console.error);

