import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import AppSidebar from './AppSidebar'
import ProfileModal from './ProfileModal'
import ProductTour from './ProductTour'

export default function AppLayout({ children, scrollable = true }) {
  const navigate    = useNavigate()
  const location    = useLocation()
  const { user }   = useAuth()

  const [profile,          setProfile]          = useState(null)
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [showTour,         setShowTour]         = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('*').eq('id', user.id).single()
      .then(({ data, error }) => { if (!error && data) setProfile(data) })
  }, [user])

  // Key tour state per user so new accounts always see the tour
  useEffect(() => {
    if (!user) return
    const done = localStorage.getItem(`waypoint_tour_done_${user.id}`) === '1'
    setShowTour(!done)
  }, [user])

  // Any child (e.g. ProfileCompletionBanner) can open the modal via this event
  useEffect(() => {
    const open = () => setProfileModalOpen(true)
    window.addEventListener('open-profile-modal', open)
    return () => window.removeEventListener('open-profile-modal', open)
  }, [])

  function handleProfileSave(updated) {
    setProfile(updated)
    setProfileModalOpen(false)
    // Notify pages (Dashboard) that profile changed so they can re-sync
    window.dispatchEvent(new CustomEvent('profile-updated', { detail: updated }))
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-dvh bg-stone-50 flex flex-col">
      <header className="bg-white border-b border-gray-100 px-6 h-16 flex items-center shrink-0 sticky top-0 z-10 shadow-sm">
        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-2.5 group"
        >
          <img src="/voyo-logo.png" alt="VOYO" className="w-12 h-12 rounded-full object-cover" />
          <span className="text-lg font-bold text-gray-900 tracking-tight group-hover:text-blue-600 transition-colors">
            VOYO
          </span>
        </button>
      </header>

      <div className="flex flex-1 min-h-0">
        <AppSidebar
          onSignOut={handleSignOut}
          profile={profile}
          onEditProfile={() => setProfileModalOpen(true)}
        />
        <div className={`flex-1 min-w-0 pb-16 lg:pb-0 ${scrollable ? 'overflow-y-auto' : 'overflow-hidden flex flex-col'}`}>
          {children}
        </div>
      </div>

      {profileModalOpen && profile && user && (
        <ProfileModal
          profile={profile}
          userId={user.id}
          onClose={() => setProfileModalOpen(false)}
          onSave={handleProfileSave}
        />
      )}

      {showTour && location.pathname === '/dashboard' && (
        <ProductTour
          onDone={() => {
            localStorage.setItem(`waypoint_tour_done_${user?.id}`, '1')
            setShowTour(false)
          }}
        />
      )}
    </div>
  )
}
