export function initialTripModel() {
  return {
    tripType: null,
    origin: null,
    groupSize: null,
    budgetPerPerson: null,
    currentLegIndex: 0,
    phase: 'gathering',
    legs: [],
  }
}

// Merge a patch from a trip_model_update SSE event into the existing model.
// Legs are merged by their `index` field — a patch containing only leg[1]
// does not overwrite leg[0].
export function mergeTripModelPatch(prev, patch) {
  const result = { ...prev, ...patch }
  if (patch.legs) {
    const merged = [...(prev.legs || [])]
    for (const legPatch of patch.legs) {
      const idx = legPatch.index
      if (idx == null || !Number.isInteger(idx)) continue
      merged[idx] = { ...(merged[idx] || {}), ...legPatch }
    }
    result.legs = merged
  }
  return result
}

// Derive a human-readable session title from the trip model.
// Falls back to 'New Trip' if the model isn't far enough along.
export function deriveSessionTitle(tripModel) {
  const { legs } = tripModel
  if (!legs?.length) return 'New Trip'

  const cities = legs.map(l => l.city?.split(',')[0]?.trim()).filter(Boolean)
  if (!cities.length) return 'New Trip'

  const firstLeg = legs[0]
  const dep = firstLeg?.arrivalDate ? new Date(firstLeg.arrivalDate + 'T12:00:00') : null
  const lastLeg = legs[legs.length - 1]
  const ret = lastLeg?.departureDate ? new Date(lastLeg.departureDate + 'T12:00:00') : null

  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  if (cities.length > 1) {
    const title = cities.join(' + ')
    return dep && ret ? `${title}, ${fmt(dep)}–${fmt(ret)}` : title
  }

  return dep && ret ? `${cities[0]}, ${fmt(dep)}–${fmt(ret)}` : cities[0]
}

// Derive trip context for Supabase session storage.
export function deriveSessionCtx(tripModel) {
  const { legs, origin } = tripModel
  if (!legs?.length) return null

  const cities = legs.map(l => l.city).filter(Boolean)
  if (!cities.length) return null
  const firstLeg = legs[0]
  const lastLeg  = legs[legs.length - 1]

  return {
    destination: cities.join(' + '),
    departure:   firstLeg?.arrivalDate   || '',
    return:      lastLeg?.departureDate  || '',
    origin:      origin || '',
    passengers:  tripModel.groupSize || 1,
  }
}

// Build selectedCards shape from tripModel for itinerary save logic.
export function deriveSelectedCards(tripModel) {
  const allFlights    = (tripModel.legs || []).flatMap(l =>
    [l.confirmedFlight, l.exitTransport?.confirmedFlight].filter(Boolean)
  )
  const allHotels     = (tripModel.legs || []).map(l => l.confirmedHotel).filter(Boolean)
  const allActivities = (tripModel.legs || []).flatMap(l =>
    (l.confirmedActivities || []).filter(a => !a.skipped)
  )
  return { flights: allFlights, hotels: allHotels, activities: allActivities }
}

// ── SessionStorage helpers ─────────────────────────────────────────────────────

const SESSION_KEY = (id) => `voyo_trip_${id}`

export function saveTripModelToSession(tripModel, sessionId) {
  try {
    sessionStorage.setItem(SESSION_KEY(sessionId), JSON.stringify(tripModel))
  } catch (e) {
    console.warn('[tripModel] save failed', e)
  }
}

export function loadTripModelFromSession(sessionId) {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY(sessionId))
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    console.warn('[tripModel] load failed', e)
    return null
  }
}

export function clearTripModelFromSession(sessionId) {
  try { sessionStorage.removeItem(SESSION_KEY(sessionId)) } catch {}
}

// ── Legacy session migration ───────────────────────────────────────────────────
// Called when loading an old session that has hiddenMarkers but no tripModel.

export function migrateLegacySession(hiddenMarkers) {
  let ctx = null
  for (const m of (hiddenMarkers || [])) {
    const match = (m.content || '').match(/\[FLIGHTS_SHOWN\] ({.+})/)
    if (match) {
      try { ctx = JSON.parse(match[1]); break } catch {}
    }
  }

  const hasItinerary = (hiddenMarkers || []).some(m => m.content?.includes('[ITINERARY_SHOWN]'))

  if (!ctx) {
    return { ...initialTripModel(), phase: hasItinerary ? 'post_itinerary' : 'gathering' }
  }

  const leg = {
    index: 0,
    city: ctx.destination || '',
    arrivalDate: ctx.departure || '',
    departureDate: ctx.return || '',
    durationNights: null,
    hotelStyle: null,
    activityPreferences: ctx.activities || [],
    flightsBank: [],
    hotelsBank: [],
    activitiesBank: null,
    confirmedFlight: null,
    confirmedHotel: null,
    confirmedActivities: [],
    mustSees: [],
    mustSeesShown: false,
    mustSeesConfirmed: false,
    shownActivityOffsets: {},
    exitTransport: { type: 'flight', fetchNeeded: true, flightsBank: [], confirmedFlight: null },
    step: hasItinerary ? 'complete' : 'arrival_flight',
  }

  return {
    tripType: 'single',
    origin: ctx.origin || null,
    groupSize: ctx.passengers || null,
    budgetPerPerson: null,
    currentLegIndex: 0,
    phase: hasItinerary ? 'post_itinerary' : 'planning',
    legs: [leg],
  }
}
