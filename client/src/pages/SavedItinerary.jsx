import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import TravelCards from '../components/TravelCards'
import ItineraryContent from '../components/ItineraryContent'

const FALLBACK_GRADIENTS = [
  'from-sky-400 to-blue-600',
  'from-violet-400 to-purple-600',
  'from-amber-400 to-orange-500',
  'from-emerald-400 to-teal-600',
  'from-rose-400 to-pink-600',
  'from-indigo-400 to-blue-600',
]

function formatDateRange(dep, ret) {
  if (!dep) return null
  try {
    const d = new Date(dep + 'T12:00:00')
    const r = ret ? new Date(ret + 'T12:00:00') : null
    const fmt = date => date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    return r ? `${fmt(d)} – ${fmt(r)}` : fmt(d)
  } catch { return null }
}

// ─── Hero image ───────────────────────────────────────────────────────────────

const HERO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000

function getCachedHero(city) {
  try {
    const raw = localStorage.getItem(`waypoint_hero2_${city}`)
    if (!raw) return undefined
    const { url, ts } = JSON.parse(raw)
    if (Date.now() - ts > HERO_CACHE_TTL || url === '') { localStorage.removeItem(`waypoint_hero2_${city}`); return undefined }
    return url
  } catch { return undefined }
}

function setCachedHero(city, url) {
  try { localStorage.setItem(`waypoint_hero2_${city}`, JSON.stringify({ url: url || '', ts: Date.now() })) } catch {}
}

function TripHero({ trip }) {
  const [imgSrc, setImgSrc] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const city = trip.destination?.split(',')[0]?.trim() || ''
  const gradient = FALLBACK_GRADIENTS[city.length % FALLBACK_GRADIENTS.length]
  const dateRange = formatDateRange(trip.departureDate, trip.returnDate)

  useEffect(() => {
    if (!city) { setLoaded(true); return }
    const cached = getCachedHero(city)
    if (cached !== undefined) { setImgSrc(cached); setLoaded(true); return }

    fetch(`http://localhost:5000/api/destination-image?city=${encodeURIComponent(city)}&size=hero`)
      .then(r => r.json())
      .then(d => { setCachedHero(city, d.url); setImgSrc(d.url || null) })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [city])

  return (
    <div className="relative h-64 overflow-hidden shrink-0">
      {!loaded && <div className="w-full h-full bg-gray-200 animate-pulse" />}
      {loaded && imgSrc && (
        <img src={imgSrc} alt={city} className="w-full h-full object-cover" onError={() => setImgSrc(null)} />
      )}
      {loaded && !imgSrc && (
        <div className={`w-full h-full bg-gradient-to-br ${gradient}`} />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent" />
      <div className="absolute bottom-0 left-0 right-0 px-6 pb-7">
        <h1 className="text-2xl font-bold text-white leading-tight">{trip.destination}</h1>
        <div className="flex items-center flex-wrap gap-3 mt-2">
          {dateRange && (
            <div className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-sm text-white/80">{dateRange}</p>
            </div>
          )}
          {trip.source === 'manual' && (
            <span className="px-2.5 py-0.5 bg-white/20 backdrop-blur-sm text-white/90 text-xs rounded-full font-medium">
              Added manually
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Manual trip view ─────────────────────────────────────────────────────────

function ManualItinerary({ trip }) {
  const flights    = trip.manualFlights    || []
  const hotels     = trip.manualHotels     || []
  const activities = trip.manualActivities || []

  const Section = ({ icon, title, children }) => (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-gray-400">{icon}</span>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">{title}</h3>
      </div>
      {children}
    </div>
  )

  const LinkBadge = ({ link }) => link ? (
    <a href={link} target="_blank" rel="noopener noreferrer"
      className="text-xs text-blue-600 hover:text-blue-700 font-medium">
      Booking link →
    </a>
  ) : null

  return (
    <div className="space-y-7">
      {trip.budget && (
        <div className="bg-blue-50 rounded-xl px-4 py-3">
          <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide mb-0.5">Budget</p>
          <p className="text-sm font-medium text-blue-900">{trip.budget}</p>
        </div>
      )}

      {flights.length > 0 && (
        <Section icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
          </svg>
        } title="Flights">
          <div className="space-y-2">
            {flights.map((f, i) => (
              <div key={i} className="bg-gray-50 rounded-xl px-4 py-3 space-y-1">
                {f.airline && <p className="text-sm font-semibold text-gray-900">{f.airline}</p>}
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
                  {f.depDate && <span>Departs: {f.depDate}{f.depTime ? ` at ${f.depTime}` : ''}</span>}
                  {f.arrDate && <span>Arrives: {f.arrDate}{f.arrTime ? ` at ${f.arrTime}` : ''}</span>}
                  {f.cost    && <span>Cost: {f.cost}</span>}
                </div>
                <LinkBadge link={f.link} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {hotels.length > 0 && (
        <Section icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        } title="Hotels">
          <div className="space-y-2">
            {hotels.map((h, i) => (
              <div key={i} className="bg-gray-50 rounded-xl px-4 py-3 space-y-1">
                {h.name && <p className="text-sm font-semibold text-gray-900">{h.name}</p>}
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
                  {h.checkIn  && <span>Check-in: {h.checkIn}</span>}
                  {h.checkOut && <span>Check-out: {h.checkOut}</span>}
                  {h.cost     && <span>Cost: {h.cost}</span>}
                </div>
                <LinkBadge link={h.link} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {activities.length > 0 && (
        <Section icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
          </svg>
        } title="Activities">
          <div className="space-y-2">
            {activities.map((a, i) => (
              <div key={i} className="bg-gray-50 rounded-xl px-4 py-3 space-y-1">
                {a.name && <p className="text-sm font-semibold text-gray-900">{a.name}</p>}
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
                  {a.date && <span>Date: {a.date}</span>}
                  {a.cost && <span>Cost: {a.cost}</span>}
                </div>
                <LinkBadge link={a.link} />
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SavedItinerary() {
  const { user }    = useAuth()
  const navigate    = useNavigate()
  const { id }      = useParams()

  const [trip,    setTrip]    = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('upcoming_trips').eq('id', user.id).single()
      .then(({ data }) => {
        const found = (data?.upcoming_trips || []).find(t => t.id === id)
        setTrip(found || null)
        setLoading(false)
      })
  }, [user, id])

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!trip) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center flex-col gap-3">
        <p className="text-gray-500 font-medium">Trip not found.</p>
        <button onClick={() => navigate('/upcoming')} className="text-sm text-blue-600 hover:underline">
          ← Back to Upcoming Trips
        </button>
      </div>
    )
  }

  const hasInAppContent = trip.source === 'inapp' && (trip.itineraryText || trip.bookingCards)
  const hasBookingCards = trip.bookingCards && (
    trip.bookingCards.flights?.length > 0 ||
    trip.bookingCards.hotels?.length > 0 ||
    trip.bookingCards.activities?.length > 0
  )

  return (
    <div className="min-h-screen bg-stone-50">

      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-5 h-14 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button onClick={() => navigate('/upcoming')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors shrink-0">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Trips
        </button>
        <span className="flex-1 text-sm font-semibold text-gray-900 truncate text-center">
          {trip.destination?.split(',')[0]}
        </span>
        <div className="w-14 shrink-0" />
      </header>

      {/* Hero */}
      <TripHero trip={trip} />

      {/* Content */}
      <main className="max-w-2xl mx-auto px-5 py-8 pb-20 space-y-6">

        {/* In-app itinerary text */}
        {hasInAppContent && trip.itineraryText && (
          <div className="bg-white rounded-2xl shadow-sm px-7 py-8">
            {hasBookingCards && (
              <div className="mb-6 pb-5 border-b border-gray-100 flex items-center gap-2 text-sm text-blue-600">
                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                Your confirmed flight, hotel and activity picks are saved at the bottom
              </div>
            )}
            <ItineraryContent content={trip.itineraryText} />
          </div>
        )}

        {/* Booking cards */}
        {hasInAppContent && hasBookingCards && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 px-1">
              Booking Summary
            </p>
            <TravelCards cards={{ ...trip.bookingCards, isItinerary: true }} />
          </div>
        )}

        {/* Manual trip */}
        {trip.source === 'manual' && (
          <div className="bg-white rounded-2xl shadow-sm px-6 py-7">
            <ManualItinerary trip={trip} />
          </div>
        )}

      </main>
    </div>
  )
}
