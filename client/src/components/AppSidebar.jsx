import { useLocation, useNavigate } from 'react-router-dom'

const navItems = [
  {
    label: 'Dashboard',
    shortLabel: 'Home',
    path: '/dashboard',
    exact: true,
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    label: 'Active Trip Planning',
    shortLabel: 'Planning',
    path: '/trips',
    tourId: 'active-trips',
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
      </svg>
    ),
  },
  {
    label: 'Travel Wishlist',
    shortLabel: 'Wishlist',
    path: '/wishlist',
    tourId: 'wishlist',
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
      </svg>
    ),
  },
  {
    label: 'Upcoming Trips',
    shortLabel: 'Upcoming',
    path: '/upcoming',
    tourId: 'upcoming-trips',
    icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
]

export default function AppSidebar({ onSignOut, profile, onEditProfile }) {
  const location = useLocation()
  const navigate = useNavigate()

  function isActive(item) {
    if (item.exact) return location.pathname === item.path
    return location.pathname === item.path || location.pathname.startsWith(item.path + '/')
  }

  const displayName = profile?.full_name || 'Your Profile'

  return (
    <>
      {/* Desktop sidebar — dark */}
      <aside className="w-60 shrink-0 bg-slate-900 hidden lg:flex flex-col sticky top-16 h-[calc(100vh-64px)]">
        {/* Nav items */}
        <nav className="flex-1 px-3 py-5 space-y-0.5 overflow-y-auto">
          {navItems.map(item => {
            const active = isActive(item)
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                {...(item.tourId ? { 'data-tour': item.tourId } : {})}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left ${
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
              >
                <span className={`w-4 h-4 shrink-0 [&>svg]:w-4 [&>svg]:h-4 ${active ? 'text-blue-400' : 'text-slate-500'}`}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            )
          })}
        </nav>

        {/* Profile + sign out */}
        <div className="px-3 py-3 border-t border-white/10 space-y-0.5">
          {/* Profile section */}
          <button
            data-tour="profile"
            onClick={onEditProfile}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-all text-left group"
          >
            {profile?.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt={displayName}
                className="w-8 h-8 rounded-full object-cover border border-white/20 shrink-0"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-white/15 border border-white/10 flex items-center justify-center text-white text-sm font-semibold shrink-0 select-none">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-200 truncate group-hover:text-white transition-colors">
                {displayName}
              </p>
              <p className="text-xs text-slate-500 group-hover:text-slate-400 transition-colors">
                Edit profile
              </p>
            </div>
          </button>

          {/* Sign out */}
          {onSignOut && (
            <button
              onClick={onSignOut}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-500 hover:bg-white/5 hover:text-slate-300 transition-all text-left"
            >
              <span className="w-4 h-4 shrink-0 [&>svg]:w-4 [&>svg]:h-4 text-slate-600">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </span>
              Sign out
            </button>
          )}
        </div>
      </aside>

      {/* Mobile bottom navigation */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 z-20">
        <div className="grid grid-cols-4 h-16">
          {navItems.map(item => {
            const active = isActive(item)
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                  active ? 'text-blue-600' : 'text-gray-400 active:text-gray-600'
                }`}
              >
                <span className="w-5 h-5 [&>svg]:w-5 [&>svg]:h-5">{item.icon}</span>
                <span className="text-[10px] font-medium leading-none">{item.shortLabel}</span>
              </button>
            )
          })}
        </div>
      </nav>
    </>
  )
}
