function Card({ children, className = '', title, action }) {
  return (
    <div className={`bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 ${className}`}>
      {title && (
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {title}
          </h3>
          {action && <div>{action}</div>}
        </div>
      )}
      <div className={title ? 'p-6' : 'p-6'}>
        {children}
      </div>
    </div>
  )
}

export default Card

