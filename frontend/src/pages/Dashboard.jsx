import { useState, useEffect } from 'react'
import { Play, MessageSquare, Activity, Loader, Save, Check, Eye, Trash2, Square } from 'lucide-react'
import Card from '../components/Card'
import Button from '../components/Button'
import axios from 'axios'

function Dashboard() {
  const [credentials, setCredentials] = useState({
    email: '',
    password: '',
  })
  const [savedAccounts, setSavedAccounts] = useState([])
  const [isAccountSaved, setIsAccountSaved] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isPostAutomationRunning, setIsPostAutomationRunning] = useState(false)
  const [isLoginAutomationRunning, setIsLoginAutomationRunning] = useState(false)
  const [isStoppingPost, setIsStoppingPost] = useState(false)
  const [isStoppingLogin, setIsStoppingLogin] = useState(false)
  const [postsToDo, setPostsToDo] = useState('') // Number of posts to do
  const [automationStatus, setAutomationStatus] = useState({
    postAutomation: { running: false, lastRun: null },
    loginAutomation: { running: false, lastRun: null },
  })

  // Load saved accounts and check automation status on mount
  useEffect(() => {
    loadSavedAccounts()
    checkAutomationStatus()
    // Check status every 5 seconds
    const statusInterval = setInterval(checkAutomationStatus, 5000)
    return () => clearInterval(statusInterval)
  }, [])

  const checkAutomationStatus = async () => {
    try {
      const [postStatus, loginStatus] = await Promise.all([
        axios.get('http://localhost:3001/api/automation/post/status').catch(() => ({ data: { running: false, lastRun: null } })),
        axios.get('http://localhost:3001/api/automation/login/status').catch(() => ({ data: { running: false, lastRun: null } }))
      ])
      
      const postRunning = postStatus?.data?.running === true
      const loginRunning = loginStatus?.data?.running === true
      
      console.log('Status check - Post running:', postRunning, 'Login running:', loginRunning)
      
      setAutomationStatus(prev => {
        const newStatus = {
          postAutomation: {
            running: postRunning,
            lastRun: postRunning 
              ? (prev.postAutomation.running ? prev.postAutomation.lastRun : new Date()) 
              : prev.postAutomation.lastRun
          },
          loginAutomation: {
            running: loginRunning,
            lastRun: loginRunning 
              ? (prev.loginAutomation.running ? prev.loginAutomation.lastRun : new Date()) 
              : prev.loginAutomation.lastRun
          }
        }
        console.log('Updated automation status:', newStatus)
        return newStatus
      })
    } catch (error) {
      console.error('Error checking automation status:', error)
    }
  }

  const loadSavedAccounts = async () => {
    try {
      // Try to load from backend
      try {
        const response = await axios.get('http://localhost:3001/api/accounts')
        if (response?.data?.accounts) {
          setSavedAccounts(response.data.accounts)
          return
        }
      } catch (apiError) {
        // Fallback: load from localStorage
        console.log('Loading from localStorage...')
      }
      
      // Load from localStorage
      const savedAccountsData = localStorage.getItem('twitter_accounts')
      if (savedAccountsData) {
        try {
          const accounts = JSON.parse(savedAccountsData)
          setSavedAccounts(Array.isArray(accounts) ? accounts : [accounts])
        } catch (parseError) {
          console.error('Error parsing saved accounts:', parseError)
          setSavedAccounts([])
        }
      } else {
        // Also check for old format (single account)
        const oldSaved = localStorage.getItem('twitter_credentials')
        if (oldSaved) {
          try {
            const oldAccount = JSON.parse(oldSaved)
            // Convert old format to new format
            const newAccount = {
              id: Date.now(),
              email: oldAccount.email || '',
              password: oldAccount.password || '',
              savedAt: new Date().toISOString(),
            }
            setSavedAccounts([newAccount])
            localStorage.setItem('twitter_accounts', JSON.stringify([newAccount]))
            localStorage.removeItem('twitter_credentials')
          } catch (parseError) {
            console.error('Error parsing old credentials:', parseError)
          }
        } else {
          setSavedAccounts([])
        }
      }
    } catch (error) {
      console.error('Error loading saved accounts:', error)
      setSavedAccounts([])
    }
  }

  const handleInputChange = (e) => {
    setCredentials({
      ...credentials,
      [e.target.name]: e.target.value,
    })
    // Reset saved status when credentials change
    if (isAccountSaved) {
      setIsAccountSaved(false)
    }
  }

  const saveAccount = async () => {
    if (!credentials.email || !credentials.password) {
      return
    }

    try {
      setIsSaving(true)
      // Save credentials to backend/localStorage
      const response = await axios.post('http://localhost:3001/api/account/save', {
        email: credentials.email,
        password: credentials.password,
      }).catch(() => {
        // Fallback: save to localStorage for demo
        const existingAccounts = JSON.parse(localStorage.getItem('twitter_accounts') || '[]')
        const newAccount = {
          id: Date.now(),
          email: credentials.email,
          password: credentials.password,
          savedAt: new Date().toISOString(),
        }
        const updatedAccounts = [...existingAccounts, newAccount]
        localStorage.setItem('twitter_accounts', JSON.stringify(updatedAccounts))
        return { data: { success: true, message: 'Account saved successfully', account: newAccount } }
      })
      
      if (response?.data?.success) {
        setIsAccountSaved(true)
        setCredentials({ email: '', password: '' }) // Clear form
        loadSavedAccounts() // Reload saved accounts
      }
    } catch (error) {
      console.error('Error saving account:', error)
      // Fallback: save to localStorage
      const existingAccounts = JSON.parse(localStorage.getItem('twitter_accounts') || '[]')
      const newAccount = {
        id: Date.now(),
        email: credentials.email,
        password: credentials.password,
        savedAt: new Date().toISOString(),
      }
      const updatedAccounts = [...existingAccounts, newAccount]
      localStorage.setItem('twitter_accounts', JSON.stringify(updatedAccounts))
      setIsAccountSaved(true)
      setCredentials({ email: '', password: '' }) // Clear form
      loadSavedAccounts() // Reload saved accounts
    } finally {
      setIsSaving(false)
    }
  }

  const useSavedAccount = (account) => {
    setCredentials({
      email: account.email,
      password: account.password,
    })
    setIsAccountSaved(true)
  }

  const deleteSavedAccount = async (account) => {
    // Get the correct ID - try account.id first, then account._id (MongoDB), then email as fallback
    const accountId = account.id || account._id || account.email
    
    if (!accountId) {
      console.error('Cannot delete account: no ID found')
      return
    }

    try {
      await axios.delete(`http://localhost:3001/api/account/${accountId}`).catch(() => {
        // Fallback: delete from localStorage
        const existingAccounts = JSON.parse(localStorage.getItem('twitter_accounts') || '[]')
        const updatedAccounts = existingAccounts.filter(acc => {
          // Match by id, _id, or email
          return acc.id !== accountId && acc._id !== accountId && acc.email !== accountId
        })
        localStorage.setItem('twitter_accounts', JSON.stringify(updatedAccounts))
        return { data: { success: true } }
      })
      loadSavedAccounts()
    } catch (error) {
      console.error('Error deleting account:', error)
      // Still try to delete from localStorage as fallback
      try {
        const existingAccounts = JSON.parse(localStorage.getItem('twitter_accounts') || '[]')
        const updatedAccounts = existingAccounts.filter(acc => {
          return acc.id !== accountId && acc._id !== accountId && acc.email !== accountId
        })
        localStorage.setItem('twitter_accounts', JSON.stringify(updatedAccounts))
        loadSavedAccounts()
      } catch (localError) {
        console.error('Error deleting from localStorage:', localError)
      }
    }
  }

  const startPostAutomation = async () => {
    if (!isAccountSaved && savedAccounts.length === 0) {
      return
    }

    const accountToUse = isAccountSaved ? credentials : savedAccounts[0]

    if (!accountToUse || !accountToUse.email || !accountToUse.password) {
      return
    }

    try {
      setIsPostAutomationRunning(true)
      // Call backend API to start post automation
      const postsToDoValue = postsToDo ? parseInt(postsToDo) : 1
      if (!postsToDoValue || postsToDoValue < 1) {
        console.error('Invalid posts to do value')
        return
      }
      
      const response = await axios.post('http://localhost:3001/api/automation/post/start', {
        email: accountToUse.email,
        password: accountToUse.password,
        postsToDo: postsToDoValue, // Send number of posts to do
      })
      
      if (response?.data?.success) {
        // Immediately update status to show stop button
        const now = new Date()
        console.log('Post automation started, updating status to running')
        setAutomationStatus(prev => {
          const newStatus = {
            ...prev,
            postAutomation: { running: true, lastRun: now },
          }
          console.log('Updated post automation status:', newStatus.postAutomation)
          return newStatus
        })
        // Check status after delays to ensure it's synced with backend
        setTimeout(() => {
          console.log('Checking post automation status after 1.5s')
          checkAutomationStatus()
        }, 1500)
        setTimeout(() => {
          console.log('Checking post automation status after 3s')
          checkAutomationStatus()
        }, 3000)
      } else {
        // If start failed, make sure status is false
        setAutomationStatus(prev => ({
          ...prev,
          postAutomation: { running: false, lastRun: prev.postAutomation.lastRun },
        }))
      }
    } catch (error) {
      console.error('Error starting post automation:', error)
      // Make sure status is false on error
      setAutomationStatus(prev => ({
        ...prev,
        postAutomation: { running: false, lastRun: prev.postAutomation.lastRun },
      }))
    } finally {
      setIsPostAutomationRunning(false)
    }
  }

  const startLoginAutomation = async () => {
    if (!isAccountSaved && savedAccounts.length === 0) {
      return
    }

    const accountToUse = isAccountSaved ? credentials : savedAccounts[0]

    if (!accountToUse || !accountToUse.email || !accountToUse.password) {
      return
    }

    try {
      setIsLoginAutomationRunning(true)
      // Call backend API to start login automation
      const response = await axios.post('http://localhost:3001/api/automation/login/start', {
        email: accountToUse.email,
        password: accountToUse.password,
      })
      
      if (response?.data?.success) {
        // Immediately update status to show stop button
        const now = new Date()
        console.log('Login automation started, updating status to running')
        setAutomationStatus(prev => {
          const newStatus = {
            ...prev,
            loginAutomation: { running: true, lastRun: now },
          }
          console.log('Updated login automation status:', newStatus.loginAutomation)
          return newStatus
        })
        // Check status after delays to ensure it's synced with backend
        setTimeout(() => {
          console.log('Checking login automation status after 1.5s')
          checkAutomationStatus()
        }, 1500)
        setTimeout(() => {
          console.log('Checking login automation status after 3s')
          checkAutomationStatus()
        }, 3000)
      } else {
        // If start failed, make sure status is false
        setAutomationStatus(prev => ({
          ...prev,
          loginAutomation: { running: false, lastRun: prev.loginAutomation.lastRun },
        }))
      }
    } catch (error) {
      console.error('Error starting login automation:', error)
      // Make sure status is false on error
      setAutomationStatus(prev => ({
        ...prev,
        loginAutomation: { running: false, lastRun: prev.loginAutomation.lastRun },
      }))
    } finally {
      setIsLoginAutomationRunning(false)
    }
  }

  const stopPostAutomation = async () => {
    try {
      setIsStoppingPost(true)
      console.log('Stopping post automation...')
      
      // Immediately update UI to show stopping state
      setAutomationStatus(prev => ({
        ...prev,
        postAutomation: { running: false, lastRun: prev.postAutomation.lastRun },
      }))
      
      // Call backend API to stop post automation
      const response = await axios.post('http://localhost:3001/api/automation/post/stop')
      
      console.log('Stop response:', response?.data)
      
      if (response?.data?.success) {
        // Ensure status is set to stopped
        setAutomationStatus(prev => ({
          ...prev,
          postAutomation: { running: false, lastRun: prev.postAutomation.lastRun },
        }))
        console.log('Post automation stopped successfully')
      }
    } catch (error) {
      console.error('Error stopping post automation:', error)
      // Update status anyway - assume it's stopped
      setAutomationStatus(prev => ({
        ...prev,
        postAutomation: { running: false, lastRun: prev.postAutomation.lastRun },
      }))
    } finally {
      setIsStoppingPost(false)
      // Check status multiple times to ensure it's synced
      setTimeout(() => {
        console.log('Checking status after stop (1s)')
        checkAutomationStatus()
      }, 1000)
      setTimeout(() => {
        console.log('Checking status after stop (3s)')
        checkAutomationStatus()
      }, 3000)
    }
  }

  const stopLoginAutomation = async () => {
    try {
      setIsStoppingLogin(true)
      console.log('Stopping login automation...')
      
      // Immediately update UI to show stopping state
      setAutomationStatus(prev => ({
        ...prev,
        loginAutomation: { running: false, lastRun: prev.loginAutomation.lastRun },
      }))
      
      // Call backend API to stop login automation
      const response = await axios.post('http://localhost:3001/api/automation/login/stop')
      
      console.log('Stop response:', response?.data)
      
      if (response?.data?.success) {
        // Ensure status is set to stopped
        setAutomationStatus(prev => ({
          ...prev,
          loginAutomation: { running: false, lastRun: prev.loginAutomation.lastRun },
        }))
        console.log('Login automation stopped successfully')
      }
    } catch (error) {
      console.error('Error stopping login automation:', error)
      // Update status anyway - assume it's stopped
      setAutomationStatus(prev => ({
        ...prev,
        loginAutomation: { running: false, lastRun: prev.loginAutomation.lastRun },
      }))
    } finally {
      setIsStoppingLogin(false)
      // Check status multiple times to ensure it's synced
      setTimeout(() => {
        console.log('Checking status after stop (1s)')
        checkAutomationStatus()
      }, 1000)
      setTimeout(() => {
        console.log('Checking status after stop (3s)')
        checkAutomationStatus()
      }, 3000)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">Manage your Twitter automation</p>
      </div>

      {/* Saved Accounts Section */}
      <Card title={`Saved Accounts (${savedAccounts.length})`} className="max-w-2xl">
        {savedAccounts.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No saved accounts yet. Save your credentials to get started.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {savedAccounts.map((account) => (
              <div
                key={account.id || account.email}
                className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <div className="flex items-center space-x-3 flex-1">
                  <div className="flex-shrink-0">
                    <div className="h-10 w-10 bg-blue-500 rounded-full flex items-center justify-center text-white font-semibold">
                      {account.email?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {account.email || 'Unknown'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Saved {account.savedAt ? new Date(account.savedAt).toLocaleDateString() : 'Recently'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => useSavedAccount(account)}
                    className="p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                    title="Use this account"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => deleteSavedAccount(account)}
                    className="p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors flex-shrink-0"
                    title="Delete this account"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Login Credentials Form - Compact */}
      <Card title="Twitter Credentials" className="max-w-2xl">
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Email
              </label>
              <input
                type="email"
                name="email"
                value={credentials.email}
                onChange={handleInputChange}
                placeholder="your.email@example.com"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Password
              </label>
              <input
                type="password"
                name="password"
                value={credentials.password}
                onChange={handleInputChange}
                placeholder="Enter password"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {isAccountSaved && (
                <div className="flex items-center space-x-2 text-green-600 dark:text-green-400 text-sm">
                  <Check className="h-4 w-4" />
                  <span>Account saved</span>
                </div>
              )}
            </div>
            <Button
              onClick={saveAccount}
              disabled={!credentials.email || !credentials.password || isSaving || isAccountSaved}
              variant="primary"
              size="sm"
            >
              {isSaving ? (
                <>
                  <Loader className="h-4 w-4 mr-2 inline animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2 inline" />
                  Save Account
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>

      {/* Automation Start Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Post Automation Card */}
        <Card>
          <div className="flex flex-col h-full">
            <div className="flex items-center space-x-3 mb-4">
              <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <MessageSquare className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Post Automation
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Auto-post tweets with AI
                </p>
              </div>
            </div>
            <div className="flex-1 mb-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                Automatically generates and posts tweets based on trending topics using AI. Runs post.js script.
              </p>
              <div className="flex items-center space-x-3">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Posts to do:
                </label>
                <input
                  type="number"
                  min="1"
                  value={postsToDo}
                  onChange={(e) => setPostsToDo(e.target.value)}
                  disabled={automationStatus.postAutomation.running}
                  placeholder="Enter number"
                  className="w-20 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            {automationStatus.postAutomation.running ? (
              <Button
                onClick={stopPostAutomation}
                disabled={isStoppingPost}
                variant="danger"
                className="w-full"
              >
                {isStoppingPost ? (
                  <>
                    <Loader className="h-4 w-4 mr-2 inline animate-spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Square className="h-4 w-4 mr-2 inline" />
                    Stop Post Automation
                  </>
                )}
              </Button>
            ) : (
              <Button
                onClick={startPostAutomation}
                disabled={(!isAccountSaved && savedAccounts.length === 0) || isPostAutomationRunning}
                variant="primary"
                className="w-full"
              >
                {isPostAutomationRunning ? (
                  <>
                    <Loader className="h-4 w-4 mr-2 inline animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2 inline" />
                    Start Post Automation
                  </>
                )}
              </Button>
            )}
          </div>
        </Card>

        {/* Login Automation Card */}
        <Card>
          <div className="flex flex-col h-full">
            <div className="flex items-center space-x-3 mb-4">
              <div className="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                <Activity className="h-6 w-6 text-green-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Login Automation
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Auto-scroll, like & comment
                </p>
              </div>
            </div>
            <div className="flex-1 mb-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Automatically scrolls feed, likes posts, and comments using AI-generated responses. Runs login_X.js script.
              </p>
            </div>
            {automationStatus.loginAutomation.running ? (
              <Button
                onClick={stopLoginAutomation}
                disabled={isStoppingLogin}
                variant="danger"
                className="w-full"
              >
                {isStoppingLogin ? (
                  <>
                    <Loader className="h-4 w-4 mr-2 inline animate-spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Square className="h-4 w-4 mr-2 inline" />
                    Stop Login Automation
                  </>
                )}
              </Button>
            ) : (
              <Button
                onClick={startLoginAutomation}
                disabled={(!isAccountSaved && savedAccounts.length === 0) || isLoginAutomationRunning}
                variant="success"
                className="w-full"
              >
                {isLoginAutomationRunning ? (
                  <>
                    <Loader className="h-4 w-4 mr-2 inline animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2 inline" />
                    Start Login Automation
                  </>
                )}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

export default Dashboard
