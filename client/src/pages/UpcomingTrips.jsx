import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import AppLayout from '../components/AppLayout'
import AddManualTripModal from '../components/AddManualTripModal'

function getTripSummary(trip) {
  const dest = trip.destination?.split(',')[0] || 'your destination'

  if (trip.source === 'inapp' && trip.itineraryText) {
    const plain = trip.itineraryText
      .replace(/#+\s[^\n]*/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`[^`]+`/g, '')
      .replace(/[-•]\s/g, '')
      .replace(/\n+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()

    if (!plain) return `Your ${dest} itinerary is ready. Tap to view the full plan.`
    if (plain.length <= 180) return plain
    const cut = plain.slice(0, 180)
    const lastSpace = cut.lastIndexOf(' ')
    return cut.slice(0, lastSpace > 80 ? lastSpace : 180) + '…'
  }

  if (trip.source === 'inapp') {
    return `Your ${dest} itinerary is still being put together. Head to Active Trip Planning to continue with Maya.`
  }

  // Manual trip — build from saved metadata
  const flights    = (trip.manualFlights    || []).filter(Boolean)
  const hotels     = (trip.manualHotels     || []).filter(Boolean)
  const activities = (trip.manualActivities || []).filter(Boolean)

  const parts = []
  if (flights.length)    parts.push(`${flights.length} flight leg${flights.length > 1 ? 's' : ''} booked`)
  if (hotels.length)     parts.push(`${hotels.length} hotel${hotels.length > 1 ? 's' : ''} reserved`)
  if (activities.length) parts.push(`${activities.length} activit${activities.length > 1 ? 'ies' : 'y'} lined up`)

  if (!parts.length) {
    return trip.budget
      ? `A ${trip.budget} budget trip to ${dest}. Open the itinerary to add flights, hotels, and activities.`
      : `A manually added trip to ${dest}. Open the itinerary to fill in your plans.`
  }

  const joined = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]

  return `${joined.charAt(0).toUpperCase() + joined.slice(1)}${trip.budget ? ` on a ${trip.budget} budget` : ''} for ${dest}.`
}

function TripImage({ destination, source }) {
  const [imgSrc, setImgSrc]   = useState(null)
  const [loaded, setLoaded]   = useState(false)

  useEffect(() => {
    if (source !== 'inapp' || !destination) { setLoaded(true); return }
    const city = destination.split(',')[0].trim()
    fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(city)}`)
      .then(r => r.json())
      .then(d => { if (d.thumbnail?.source) setImgSrc(d.thumbnail.source) })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [destination, source])

  if (source !== 'inapp') {
    return (
      <div className="h-36 bg-gray-100 flex items-center justify-center relative shrink-0">
        <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 004 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" />
        </svg>
        <span className="absolute bottom-2 left-2 px-2 py-0.5 bg-gray-200 text-gray-500 text-xs rounded-full font-medium">
          Added manually
        </span>
      </div>
    )
  }

  return (
    <div className="h-36 bg-gray-100 overflow-hidden shrink-0 relative">
      {!loaded && <div className="w-full h-full bg-gray-200 animate-pulse" />}
      {loaded && imgSrc && <img src={imgSrc} alt={destination} className="w-full h-full object-cover" onError={() => setImgSrc(null)} />}
      {loaded && !imgSrc && (
        <div className="w-full h-full bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
          <svg className="w-8 h-8 text-blue-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 004 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" />
          </svg>
        </div>
      )}
    </div>
  )
}

function formatDateRange(dep, ret) {
  if (!dep) return null
  try {
    const d = new Date(dep + 'T12:00:00')
    const r = ret ? new Date(ret + 'T12:00:00') : null
    const fmt = date => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return r ? `${fmt(d)} – ${fmt(r)}` : fmt(d)
  } catch { return null }
}

export default function UpcomingTrips() {
  const { user }  = useAuth()
  const navigate  = useNavigate()

  const [trips,      setTrips]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [showAdd,    setShowAdd]    = useState(false)
  const [completing, setCompleting] = useState(null) // trip being completed
  const [showAddPast,setShowAddPast]= useState(false)
  const [pastFormTrip, setPastFormTrip] = useState(null)

  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('upcoming_trips').eq('id', user.id).single()
      .then(({ data }) => {
        const raw = data?.upcoming_trips || []
        setTrips(sortChronologically(raw))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [user])

  function sortChronologically(arr) {
    return [...arr].sort((a, b) => {
      const da = a.departureDate ? new Date(a.departureDate) : new Date('9999-12-31')
      const db = b.departureDate ? new Date(b.departureDate) : new Date('9999-12-31')
      return da - db
    })
  }

  async function handleAddManualTrip(formData) {
    const trip = {
      id:            crypto.randomUUID(),
      source:        'manual',
      destination:   formData.destination,
      departureDate: formData.departureDate,
      returnDate:    formData.returnDate,
      budget:        formData.budget,
      manualFlights:    formData.manualFlights,
      manualHotels:     formData.manualHotels,
      manualActivities: formData.manualActivities,
      savedAt:       new Date().toISOString(),
    }
    const updated = sortChronologically([...trips, trip])
    setTrips(updated)
    await supabase.from('profiles').upsert({ id: user.id, upcoming_trips: updated })
    setShowAdd(false)
  }

  async function markCompleted(tripId) {
    const trip = trips.find(t => t.id === tripId)
    setPastFormTrip(trip)
    const updated = trips.filter(t => t.id !== tripId)
    setTrips(updated)
    await supabase.from('profiles').upsert({ id: user.id, upcoming_trips: updated })
    setCompleting(null)
    setShowAddPast(true)
  }

  async function handleAddToPastTrips(tripId, formData) {
    // Add to profile past_trips
    const { data } = await supabase.from('profiles').select('past_trips').eq('id', user.id).single()
    const past = data?.past_trips || []
    const newEntry = {
      destination: pastFormTrip?.destination || '',
      rating:      formData.rating || null,
      activities:  formData.activities || [],
      notes:       formData.notes || '',
    }
    await supabase.from('profiles').upsert({ id: user.id, past_trips: [...past, newEntry] })
    setShowAddPast(false)
    setPastFormTrip(null)
  }

  return (
    <AppLayout>
      <main className="max-w-4xl mx-auto px-6 py-10">

        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Upcoming Trips</h1>
            <p className="text-sm text-gray-500 mt-1">
              {trips.length > 0 ? `${trips.length} trip${trips.length !== 1 ? 's' : ''} planned` : 'No upcoming trips yet'}
            </p>
          </div>
          <button onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-gray-900 hover:bg-gray-700 text-white text-sm font-medium rounded-xl transition-colors">
            + Add manually
          </button>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
                <div className="h-36 bg-gray-200 animate-pulse" />
                <div className="p-4 space-y-2">
                  <div className="h-5 w-3/4 bg-gray-200 rounded animate-pulse" />
                  <div className="h-3.5 w-1/2 bg-gray-100 rounded animate-pulse" />
                  <div className="h-3 w-full bg-gray-100 rounded animate-pulse mt-1" />
                  <div className="h-3 w-5/6 bg-gray-100 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : trips.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <svg className="w-12 h-12 text-gray-200 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-gray-500 font-medium">No upcoming trips</p>
            <p className="text-sm text-gray-400 mt-1">Complete a planning chat or add a trip manually.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {trips.map(trip => (
              <div key={trip.id} className="bg-white border border-gray-200 rounded-2xl overflow-hidden hover:shadow-md hover:border-blue-200 transition-all group relative">

                <button
                  onClick={e => { e.stopPropagation(); setCompleting(trip.id) }}
                  className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center shadow-sm hover:bg-white border border-gray-200 transition-colors"
                  title="Mark as completed"
                >
                  <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </button>

                <div className="cursor-pointer" onClick={() => navigate(`/upcoming/${trip.id}`)}>
                  <TripImage destination={trip.destination} source={trip.source} />
                  <div className="p-4">
                    <h3 className="text-base font-semibold text-gray-900 leading-snug truncate">
                      {trip.destination?.split(',')[0]}
                    </h3>
                    {formatDateRange(trip.departureDate, trip.returnDate) && (
                      <p className="text-xs text-gray-400 mt-1">
                        {formatDateRange(trip.departureDate, trip.returnDate)}
                      </p>
                    )}
                    <p className="text-xs text-gray-500 mt-2 leading-relaxed line-clamp-3">
                      {getTripSummary(trip)}
                    </p>
                    <div className="flex items-center justify-between mt-3">
                      <p className="text-xs text-blue-600 font-medium group-hover:underline">
                        View itinerary →
                      </p>
                      {trip.bookingCards && (trip.bookingCards.flights?.length > 0 || trip.bookingCards.hotels?.length > 0 || trip.bookingCards.activities?.length > 0) && (
                        <span className="text-[10px] font-medium text-gray-400 flex items-center gap-0.5">
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                          Booking picks saved
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {showAdd && <AddManualTripModal onSave={handleAddManualTrip} onClose={() => setShowAdd(false)} />}

      {completing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full space-y-4">
            <p className="text-sm font-semibold text-gray-900">Mark trip as completed?</p>
            <p className="text-sm text-gray-600">
              This will remove it from Upcoming Trips. Would you like to add it to your past trips profile?
            </p>
            <div className="flex gap-3">
              <button onClick={() => markCompleted(completing)}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-xl">
                Yes, add to past trips
              </button>
              <button onClick={async () => {
                const updated = trips.filter(t => t.id !== completing)
                setTrips(updated)
                await supabase.from('profiles').upsert({ id: user.id, upcoming_trips: updated })
                setCompleting(null)
              }}
                className="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-xl">
                Just remove
              </button>
            </div>
            <button onClick={() => setCompleting(null)} className="w-full text-center text-xs text-gray-400 hover:text-gray-600">
              Cancel
            </button>
          </div>
        </div>
      )}

      {showAddPast && pastFormTrip && (
        <AddToPastTripsModal
          destination={pastFormTrip.destination}
          onSave={data => handleAddToPastTrips(pastFormTrip.id, data)}
          onClose={() => { setShowAddPast(false); setPastFormTrip(null) }}
        />
      )}
    </AppLayout>
  )
}

// ─── Add to Past Trips mini-modal ─────────────────────────────────────────────

const ACTIVITY_OPTIONS = ['Beach', 'Hiking', 'Food', 'Nightlife', 'Culture', 'Adventure', 'Shopping', 'Relaxation', 'City exploring', 'Nature']

function AddToPastTripsModal({ destination, onSave, onClose }) {
  const [rating,     setRating]     = useState('')
  const [activities, setActivities] = useState([])
  const [notes,      setNotes]      = useState('')

  function toggleActivity(a) {
    setActivities(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a])
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full space-y-4">
        <h2 className="text-base font-semibold text-gray-900">Add to Past Trips</h2>
        <p className="text-sm text-gray-500">Destination: <span className="font-medium text-gray-800">{destination}</span></p>

        <div>
          <label className="block text-xs text-gray-500 mb-2">Rating (1–5)</label>
          <div className="flex gap-2">
            {[1,2,3,4,5].map(n => (
              <button key={n} type="button"
                onClick={() => setRating(n)}
                className={`w-9 h-9 rounded-lg text-sm font-medium border transition-colors ${
                  rating === n ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:border-blue-300'
                }`}>{n}</button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-2">Activities</label>
          <div className="flex flex-wrap gap-2">
            {ACTIVITY_OPTIONS.map(a => (
              <button key={a} type="button" onClick={() => toggleActivity(a)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  activities.includes(a) ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:border-blue-300'
                }`}>{a}</button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Notes (optional)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
            placeholder="Highlights, recommendations..."
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none" />
        </div>

        <div className="flex gap-3">
          <button onClick={() => onSave({ rating, activities, notes })}
            className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors">
            Save
          </button>
          <button onClick={onClose}
            className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-xl transition-colors">
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
