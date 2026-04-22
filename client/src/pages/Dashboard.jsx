import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import AppLayout from '../components/AppLayout'
import DestinationCard from '../components/DestinationCard'

// ─── Skeleton components ──────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm">
      <div className="h-44 bg-gray-200 animate-pulse" />
      <div className="p-5 space-y-3">
        <div className="h-5 w-3/4 bg-gray-200 rounded animate-pulse" />
        <div className="h-3.5 w-full bg-gray-200 rounded animate-pulse" />
        <div className="h-3.5 w-2/3 bg-gray-200 rounded animate-pulse" />
        <div className="h-3.5 w-1/2 bg-gray-100 rounded animate-pulse mt-4" />
      </div>
    </div>
  )
}

// ─── Profile completion banner ────────────────────────────────────────────────

function ProfileCompletionBanner({ profile, onOpenModal }) {
  const fields = [
    { done: (profile?.preferences || []).length > 0,                     weight: 20 },
    { done: !!profile?.budget_category,                                   weight: 15 },
    { done: !!profile?.travel_style,                                      weight: 15 },
    { done: (profile?.past_trips || []).some(t => t.destination?.trim()), weight: 15 },
    { done: !!profile?.group_size,                                        weight: 10 },
    { done: !!profile?.full_name?.trim(),                                 weight: 10 },
    { done: !!profile?.about_me?.trim(),                                  weight: 8  },
    { done: !!profile?.avatar_url,                                        weight: 4  },
    { done: !!profile?.age,                                               weight: 2  },
    { done: !!profile?.gender?.trim(),                                    weight: 1  },
  ]

  const pct       = fields.reduce((sum, f) => sum + (f.done ? f.weight : 0), 0)
  const remaining = fields.filter(f => !f.done).length

  if (pct === 100) return null

  const radius = 20
  const circ   = 2 * Math.PI * radius
  const offset = circ * (1 - pct / 100)

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-4 flex items-center gap-4 shadow-sm">
      <div className="shrink-0 relative w-14 h-14">
        <svg className="w-14 h-14 -rotate-90" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r={radius} strokeWidth="4" fill="none" stroke="#e5e7eb" />
          <circle cx="24" cy="24" r={radius} strokeWidth="4" fill="none" stroke="#2563eb"
            strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-gray-900">{pct}%</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900">Complete your profile</p>
        <p className="text-xs text-gray-500 mt-0.5">
          {remaining} field{remaining !== 1 ? 's' : ''} remaining — help Maya get to know you better
        </p>
      </div>
      <button onClick={onOpenModal}
        className="shrink-0 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap">
        Fill in →
      </button>
    </div>
  )
}

// ─── Recommendation cache helpers ────────────────────────────────────────────

function getWeekKey() {
  const d    = new Date()
  const jan1 = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7)
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}

function getDayKey() {
  return new Date().toISOString().split('T')[0]
}

async function loadRecommendations(profile, userId) {
  const weekKey = getWeekKey()
  const dayKey  = getDayKey()
  const cached  = profile.cached_recs  // already in the profile row, no extra query

  // Fully fresh — no API call needed
  if (cached?.weekKey === weekKey && cached?.dayKey === dayKey) {
    return [...cached.stable, ...cached.experimental]
  }

  // Fetch 12 fresh recs from server
  const res = await fetch('http://localhost:5000/api/recommendations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  })
  if (!res.ok) throw new Error('Server error')
  const data   = await res.json()
  const sorted = [...(data.recommendations || [])].sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))

  let stable, experimental

  if (cached?.weekKey === weekKey) {
    // Same week — keep the exact stable 8, only swap experimental 4
    stable       = cached.stable
    experimental = sorted.slice(8, 12)
  } else {
    // Week rolled over or first load — replace everything
    stable       = sorted.slice(0, 8)
    experimental = sorted.slice(8, 12)
  }

  // Persist to Supabase so it survives logout, device switches, cache clears
  await supabase.from('profiles').upsert({
    id: userId,
    cached_recs: { weekKey, dayKey, stable, experimental },
  })

  return [...stable, ...experimental]
}


// ─── Main component ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user }   = useAuth()
  const navigate   = useNavigate()

  const [profile,         setProfile]         = useState(null)
  const [recommendations, setRecommendations] = useState([])
  const [loadingProfile,  setLoadingProfile]  = useState(true)
  const [loadingRecs,     setLoadingRecs]     = useState(true)
  const [recsError,       setRecsError]       = useState(null)
  const [bookmarks,       setBookmarks]       = useState([])
  const [showLimitWarning,setShowLimitWarning]= useState(false)

  // Fetch profile
  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('*').eq('id', user.id).single()
      .then(({ data, error }) => {
        if (!error && data) {
          setProfile(data)
          setBookmarks(data.bookmarks || [])
        }
        setLoadingProfile(false)
      })
  }, [user])

  // Re-sync when profile is saved via the sidebar modal
  useEffect(() => {
    const handler = (e) => {
      if (e.detail) {
        setProfile(e.detail)
        setBookmarks(e.detail.bookmarks || [])
      }
    }
    window.addEventListener('profile-updated', handler)
    return () => window.removeEventListener('profile-updated', handler)
  }, [])

  // Load recommendations (cache-first)
  useEffect(() => {
    if (!profile || !user) return
    setLoadingRecs(true)
    setRecsError(null)
    loadRecommendations(profile, user.id)
      .then(recs => setRecommendations(recs))
      .catch(() => setRecsError('Could not load recommendations. Please try again later.'))
      .finally(() => setLoadingRecs(false))
  }, [profile])

  // Bookmark toggle
  async function toggleBookmark(rec) {
    const already  = bookmarks.some(b => b.destination === rec.destination)
    const updated  = already
      ? bookmarks.filter(b => b.destination !== rec.destination)
      : [...bookmarks, { destination: rec.destination, reason: rec.reason, bestTime: rec.bestTime,
          personalNote: rec.personalNote || null, hearMeOut: rec.hearMeOut || null,
          isExperimental: rec.isExperimental || false, savedAt: new Date().toISOString() }]

    setBookmarks(updated)
    await supabase.from('profiles').upsert({ id: user.id, bookmarks: updated })
  }

  async function removeBookmark(destination) {
    const updated = bookmarks.filter(b => b.destination !== destination)
    setBookmarks(updated)
    await supabase.from('profiles').upsert({ id: user.id, bookmarks: updated })
  }

  const displayName    = profile?.full_name || user?.user_metadata?.full_name || 'Traveller'
  const activeSessions = profile?.chat_sessions || []
  const atSessionLimit = activeSessions.length >= 3

  function handlePlanNewTrip() {
    if (atSessionLimit) { setShowLimitWarning(true); return }
    navigate('/chat/new')
  }

  function handlePlanNow(destination) {
    if (atSessionLimit) { setShowLimitWarning(true); return }
    navigate('/chat/new', { state: { destination } })
  }

  return (
    <AppLayout>
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">

        {/* Greeting hero */}
        <section className="relative overflow-hidden bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 rounded-2xl shadow-md">
          {/* Earth decoration */}
          <div className="absolute -right-14 -top-14 opacity-25 pointer-events-none select-none">
            <svg viewBox="0 0 200 200" className="w-56 h-56">
              <defs>
                <radialGradient id="earthOcean" cx="38%" cy="32%">
                  <stop offset="0%" stopColor="#7dd3fc"/>
                  <stop offset="100%" stopColor="#0c4a6e"/>
                </radialGradient>
                <radialGradient id="earthShadow" cx="72%" cy="72%" r="55%">
                  <stop offset="35%" stopColor="transparent"/>
                  <stop offset="100%" stopColor="rgba(0,0,30,0.55)"/>
                </radialGradient>
                <radialGradient id="earthShine" cx="28%" cy="22%" r="38%">
                  <stop offset="0%" stopColor="rgba(255,255,255,0.28)"/>
                  <stop offset="100%" stopColor="transparent"/>
                </radialGradient>
                <clipPath id="earthClip">
                  <circle cx="100" cy="100" r="82"/>
                </clipPath>
              </defs>

              {/* Ocean */}
              <circle cx="100" cy="100" r="82" fill="url(#earthOcean)"/>

              {/* Continents */}
              <g clipPath="url(#earthClip)">
                {/* Americas */}
                <path
                  d="M30,55 C25,65 22,80 28,95 C32,105 40,110 42,122 C44,132 38,140 40,150 C42,158 50,162 58,158 C68,152 70,140 67,128 C64,116 60,108 62,98 C64,88 70,82 72,72 C74,60 68,48 60,44 C52,40 35,45 30,55Z"
                  fill="#86efac" opacity="0.82"
                />
                {/* Europe + Africa */}
                <path
                  d="M95,38 C90,40 86,46 88,54 C90,62 96,65 96,73 C96,81 90,87 92,96 C94,105 102,108 104,118 C106,128 102,138 105,147 C108,156 116,160 122,155 C128,150 128,140 125,130 C122,120 116,114 116,104 C116,94 120,87 118,78 C116,69 110,64 112,56 C114,48 118,44 115,38 C112,33 100,36 95,38Z"
                  fill="#86efac" opacity="0.82"
                />
                {/* Asia */}
                <path
                  d="M118,38 C130,34 148,36 158,45 C168,54 167,66 160,74 C153,82 144,84 142,93 C140,102 145,110 142,118 C139,124 132,126 130,118 C128,110 132,102 128,95 C124,88 116,85 116,76 C116,67 116,56 118,38Z"
                  fill="#86efac" opacity="0.82"
                />
                {/* Australia */}
                <path
                  d="M148,125 C140,124 134,130 134,138 C134,148 140,156 150,158 C160,160 168,154 168,144 C168,134 160,126 148,125Z"
                  fill="#86efac" opacity="0.82"
                />
              </g>

              {/* Sphere shadow (bottom-right darkening) */}
              <circle cx="100" cy="100" r="82" fill="url(#earthShadow)"/>
              {/* Sphere highlight (top-left shine) */}
              <circle cx="100" cy="100" r="82" fill="url(#earthShine)"/>
              {/* Atmosphere ring */}
              <circle cx="100" cy="100" r="83" fill="none" stroke="rgba(147,197,253,0.45)" strokeWidth="5"/>
            </svg>
          </div>

          <div className="relative p-6">
            <p className="text-sm font-medium text-blue-200 mb-1.5">Ready for your next adventure?</p>
            <h1 className="text-2xl font-bold text-white leading-tight">
              Where are we heading next{displayName !== 'Traveller' ? `, ${displayName.split(' ')[0]}` : ''}?
            </h1>
          </div>
        </section>

        {/* Profile completion banner */}
        {!loadingProfile && profile && (
          <ProfileCompletionBanner
            profile={profile}
            onOpenModal={() => window.dispatchEvent(new CustomEvent('open-profile-modal'))}
          />
        )}

        {/* Session limit warning */}
        {showLimitWarning && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-start gap-3">
            <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-amber-800">
                You have 3 trips in planning.{' '}
                <button onClick={() => navigate('/trips')} className="font-semibold underline hover:no-underline">
                  Go to Active Trip Planning
                </button>{' '}
                to finish or cancel one before starting a new trip.
              </p>
            </div>
            <button onClick={() => setShowLimitWarning(false)} className="text-amber-400 hover:text-amber-600 shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Plan a New Trip CTA */}
        <section className="space-y-2">
          <button
            data-tour="plan-trip"
            onClick={handlePlanNewTrip}
            disabled={atSessionLimit}
            className="w-full py-4 px-6 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-base font-bold rounded-2xl shadow-md hover:shadow-lg disabled:hover:shadow-md transition-all flex items-center justify-center gap-2.5"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {atSessionLimit ? '3 of 3 Planning Slots Used' : 'Plan a New Trip'}
          </button>
          {!atSessionLimit && (
            <p className="text-center text-xs text-gray-400 flex items-center justify-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-indigo-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
              </svg>
              Chat with Maya, your personal AI travel agent
            </p>
          )}
        </section>

        {/* Recommendations */}
        <section className="space-y-4">
          <div data-tour="recommendations">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-bold text-gray-900">Recommended For You</h2>
              <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-500 text-[11px] font-medium rounded-full">
                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Updates weekly
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-0.5 leading-relaxed">The ones we know you'll love are at the top — the ones we're not so sure about but would be an unforgettable experience are at the bottom.</p>
          </div>

          {recsError ? (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{recsError}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {loadingRecs
                ? Array.from({ length: 9 }).map((_, i) => <CardSkeleton key={i} />)
                : recommendations.map((rec, i) => (
                    <DestinationCard
                      key={i}
                      destination={rec.destination}
                      reason={rec.reason}
                      bestTime={rec.bestTime}
                      personalNote={rec.personalNote || null}
                      hearMeOut={rec.hearMeOut || null}
                      isExperimental={rec.isExperimental || false}
                      bookmarked={bookmarks.some(b => b.destination === rec.destination)}
                      onBookmark={() => toggleBookmark(rec)}
                      onPlanNow={() => handlePlanNow(rec.destination)}
                    />
                  ))
              }
            </div>
          )}
        </section>

      </main>

    </AppLayout>
  )
}
