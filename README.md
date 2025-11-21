# Twitter Automation Project

A full-stack Twitter automation system with a modern React dashboard frontend and Node.js backend.

## Project Structure

```
├── frontend/          # React + Vite frontend application
├── data/              # CSV data files
│   ├── twitter_posts.csv
│   └── activity_log.csv
├── server.js          # Express API server
├── post.js            # Backend automation script (post automation)
├── login_X.js         # Backend automation script (login automation)
├── package.json       # Root package.json for backend
└── .env               # Environment variables
```

## Quick Start

### Install All Dependencies

From the root directory:
```bash
npm run install:all
```

Or install separately:

**Backend:**
```bash
npm install
```

**Frontend:**
```bash
cd frontend
npm install
```

### Environment Variables

Create a `.env` file in the root directory:

```env
MONGO_URI=your_mongodb_connection_string
TWITTER_EMAIL=your_twitter_email
TWITTER_USERNAME=your_twitter_username
TWITTER_PASSWORD=your_twitter_password
OPENROUTER_API_KEY=your_openrouter_api_key
AI_MODEL=openai/gpt-3.5-turbo
SCROLL_PAGES=10
PORT=3001
```

### Running the Application

**Option 1: Run both server and frontend together**
```bash
npm run dev
```

**Option 2: Run separately**

**Backend API Server:**
```bash
npm run server
```
The API will be available at `http://localhost:3001`

**Frontend (React Dashboard):**
```bash
npm run frontend
```
The frontend will be available at `http://localhost:3000`

**Backend Automation Scripts:**
```bash
npm run backend  # Runs post.js
# Or run login_X.js manually: node login_X.js
```

## API Endpoints

### Account Management
- `POST /api/account/save` - Save Twitter account credentials
- `GET /api/accounts` - Get all saved accounts
- `DELETE /api/account/:id` - Delete a saved account

### Automation Control
- `POST /api/automation/post/start` - Start post automation
- `POST /api/automation/post/stop` - Stop post automation
- `POST /api/automation/login/start` - Start login automation
- `POST /api/automation/login/stop` - Stop login automation

### Analytics & Stats
- `GET /api/stats` - Get dashboard statistics
- `GET /api/activity` - Get activity log data from CSV and MongoDB
- `GET /api/health` - Health check endpoint

## Backend

The backend consists of:
- **server.js** - Express API server that connects frontend to automation scripts
- **post.js** - Post automation script with AI post generation
- **login_X.js** - Login automation script for scrolling, liking, and commenting

### Backend Features
- MongoDB integration for data storage
- CSV logging for activity tracking
- Process management for automation scripts
- RESTful API endpoints

## Frontend

Modern React dashboard built with:
- Vite
- Tailwind CSS
- React Router
- Recharts
- Lucide React

### Frontend Features
- Dashboard with automation controls
- Analytics page with CSV/MongoDB data visualization
- Account management
- Dark/Light mode
- Real-time statistics

## Data Sources

The Analytics page displays data from:
1. **MongoDB** - ContentLog collection (posts data)
2. **CSV Files**:
   - `data/twitter_posts.csv` - Post automation logs
   - `activity_log.csv` - Login automation activity logs

## License

ISC
