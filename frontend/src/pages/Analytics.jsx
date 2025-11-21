import { useState, useEffect } from 'react'
import { RefreshCw, Calendar, TrendingUp, Heart, MessageSquare, FileText } from 'lucide-react'
import Card from '../components/Card'
import Table from '../components/Table'
import Button from '../components/Button'
import axios from 'axios'

function Analytics() {
  const [loginActivities, setLoginActivities] = useState([])
  const [postActivities, setPostActivities] = useState([])
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState({
    totalScrolls: 0,
    totalLikes: 0,
    totalComments: 0,
    totalSessions: 0,
    totalPosts: 0,
  })

  const fetchActivityData = async () => {
    setLoading(true)
    try {
      // Fetch from backend API
      const response = await axios.get('http://localhost:3001/api/activity')
      
      if (response?.data?.success) {
        setLoginActivities(response.data.loginActivities || [])
        setPostActivities(response.data.postActivities || [])
        setStats(response.data.stats || stats)
      } else if (response?.data) {
        // Handle response without success flag
        setLoginActivities(response.data.loginActivities || [])
        setPostActivities(response.data.postActivities || [])
        setStats(response.data.stats || stats)
      }
    } catch (error) {
      console.error('Error fetching activity data:', error)
      // Set empty data on error
      setLoginActivities([])
      setPostActivities([])
      setStats({
        totalScrolls: 0,
        totalLikes: 0,
        totalComments: 0,
        totalSessions: 0,
        totalPosts: 0,
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchActivityData()
  }, [])

  // Columns for Login Automation (login_X.js) table
  const loginColumns = [
    { 
      header: 'Timestamp', 
      accessor: 'timestamp', 
      render: (value) => value ? new Date(value).toLocaleString() : '-' 
    },
    {
      header: 'Post Link',
      accessor: 'post_link',
      render: (value) => value ? (
        <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline truncate max-w-xs block" title={value}>
          {value.substring(0, 50)}...
        </a>
      ) : '-'
    },
    { 
      header: 'Scroll', 
      accessor: 'scroll_count',
      render: (value) => value || 0
    },
    { 
      header: 'Like', 
      accessor: 'like_count',
      render: (value) => value || 0
    },
    {
      header: 'Comment',
      accessor: 'comment_text',
      render: (value) => value ? (
        <span className="truncate max-w-xs block" title={value}>{value}</span>
      ) : '-'
    },
  ]

  // Columns for Post Automation (post.js) table
  const postColumns = [
    { 
      header: 'Timestamp', 
      accessor: 'timestamp', 
      render: (value) => value ? new Date(value).toLocaleString() : '-' 
    },
    { 
      header: 'Trending Topic', 
      accessor: 'trending_topic',
      render: (value) => value || '-'
    },
    { 
      header: 'Topic Context', 
      accessor: 'topic_context',
      render: (value) => value || '-'
    },
    { 
      header: 'Tweet Volume', 
      accessor: 'tweet_volume',
      render: (value) => value || '-'
    },
    {
      header: 'Post Content',
      accessor: 'post_content',
      render: (value) => value ? (
        <span className="truncate max-w-md block" title={value}>{value}</span>
      ) : '-'
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Analytics</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">View automation activity and statistics</p>
        </div>
        <div className="flex space-x-3">
          <Button variant="secondary" onClick={fetchActivityData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 inline ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Scrolls</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                {stats.totalScrolls.toLocaleString()}
              </p>
            </div>
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <TrendingUp className="h-6 w-6 text-blue-500" />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Likes</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                {stats.totalLikes.toLocaleString()}
              </p>
            </div>
            <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
              <Heart className="h-6 w-6 text-red-500" />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Comments</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                {stats.totalComments.toLocaleString()}
              </p>
            </div>
            <div className="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
              <MessageSquare className="h-6 w-6 text-green-500" />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Active Sessions</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                {stats.totalSessions}
              </p>
            </div>
            <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
              <Calendar className="h-6 w-6 text-purple-500" />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Posts</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
                {stats.totalPosts.toLocaleString()}
              </p>
            </div>
            <div className="p-3 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg">
              <FileText className="h-6 w-6 text-indigo-500" />
            </div>
          </div>
        </Card>
      </div>

      {/* Login Automation Table (login_X.js) */}
      <Card title="Login Automation Activity (Latest 10)">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-8 w-8 text-gray-400 animate-spin" />
            <span className="ml-3 text-gray-600 dark:text-gray-400">Loading activity data...</span>
          </div>
        ) : loginActivities.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No login automation activity data available</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
              Start login automation to see activity logs here
            </p>
          </div>
        ) : (
          <Table columns={loginColumns} data={loginActivities} />
        )}
      </Card>

      {/* Post Automation Table (post.js) */}
      <Card title="Post Automation Activity (Latest 10)">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-8 w-8 text-gray-400 animate-spin" />
            <span className="ml-3 text-gray-600 dark:text-gray-400">Loading post data...</span>
          </div>
        ) : postActivities.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No post automation data available</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
              Start post automation to see post logs here
            </p>
          </div>
        ) : (
          <Table columns={postColumns} data={postActivities} />
        )}
      </Card>
    </div>
  )
}

export default Analytics
