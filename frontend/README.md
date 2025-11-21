# Twitter Automation Dashboard - Frontend

A modern React dashboard built with Vite and Tailwind CSS for managing Twitter automation tasks.

## Features

- 🎨 **Modern UI** - Clean, responsive design with dark/light mode support
- 📊 **Dashboard** - Stats cards, charts, and trending topics
- 👥 **User Management** - Full CRUD operations for users
- ⚙️ **Settings** - Comprehensive configuration options
- 🔍 **Search** - Built-in search functionality
- 🌓 **Dark Mode** - Toggle between light and dark themes

## Tech Stack

- **React 18** - UI library
- **Vite** - Build tool and dev server
- **Tailwind CSS** - Utility-first CSS framework
- **React Router** - Client-side routing
- **Recharts** - Chart library
- **Lucide React** - Icon library

## Getting Started

### Installation

1. Install dependencies:
```bash
npm install
```

### Development

Start the development server:
```bash
npm run dev
```

The app will be available at `http://localhost:3000`

### Build

Build for production:
```bash
npm run build
```

Preview production build:
```bash
npm run preview
```

## Project Structure

```
frontend/
├── src/
│   ├── components/          # Reusable components
│   │   ├── Button.jsx      # Button component
│   │   ├── Card.jsx        # Card component
│   │   ├── Header.jsx      # Top header bar
│   │   ├── Layout.jsx      # Main layout wrapper
│   │   ├── Modal.jsx       # Modal component
│   │   ├── Sidebar.jsx     # Sidebar navigation
│   │   └── Table.jsx       # Table component
│   ├── contexts/           # React contexts
│   │   └── ThemeContext.jsx # Dark/light mode context
│   ├── pages/              # Page components
│   │   ├── Dashboard.jsx   # Dashboard page
│   │   ├── Settings.jsx   # Settings page
│   │   └── Users.jsx       # Users management page
│   ├── App.jsx             # Main app component
│   ├── main.jsx            # Entry point
│   └── index.css           # Global styles
├── index.html              # HTML template
├── vite.config.js          # Vite configuration
├── tailwind.config.js      # Tailwind configuration
└── postcss.config.js       # PostCSS configuration
```

## Pages

### Dashboard
- Statistics cards showing key metrics
- Interactive charts (Line and Bar charts)
- Top trending topics list

### Users
- User table with search functionality
- Create, Read, Update, Delete operations
- Modal forms for adding/editing users

### Settings
- General application settings
- Security configuration
- API keys management
- Database settings

## Components

### Reusable Components

- **Button** - Customizable button with variants (primary, secondary, danger, success, outline)
- **Card** - Container component with optional title and actions
- **Modal** - Overlay modal for forms and dialogs
- **Table** - Data table with sorting and actions support

## Customization

### Theme Colors

Edit `tailwind.config.js` to customize the color scheme.

### Adding New Pages

1. Create a new component in `src/pages/`
2. Add a route in `src/App.jsx`
3. Add navigation link in `src/components/Sidebar.jsx`

