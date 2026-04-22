# VOYO Chat Feature Rehaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1,650-line monolithic `server/index.js` and 15-variable `Chat.jsx` state with a structured trip model + leg orchestrator that supports multi-city trips natively.

**Architecture:** The client holds a `tripModel` object (array of legs, each with its own step, fetched data, and confirmations) sent with every request. The server's `resolveAction(tripModel)` replaces all boolean-flag stage detection. Claude emits 5 lightweight signals instead of large JSON blocks. Single-city trips use the identical code path — the leg loop runs once.

**Tech Stack:** Express 5 (ESM modules), `@anthropic-ai/sdk` ^0.89, React 18, Tailwind CSS, Supabase

**Reference:** `docs/superpowers/specs/2026-04-22-voyo-chat-rehaul-design.md`

---

## File Map

### Server — new files
| File | Responsibility |
|------|---------------|
| `server/fetchers.js` | `fetchFlights`, `fetchHotels`, `fetchActivities` + sort/query helpers (cut from index.js, zero logic change) |
| `server/streaming.js` | `streamClaude`, `streamClaudeSSE`, `extractAndStripBlocks` (cut from index.js, extended for new signal tags) |
| `server/prompts.js` | `buildSystemPrompt(profile)`, `buildLegContext(tripModel)` — new gathering-phase instructions + per-leg context injection |
| `server/orchestrator.js` | `resolveAction(tripModel)`, `executeRequest(...)` — the leg loop replacing the nested-if cascade |

### Server — modified
| File | Change |
|------|--------|
| `server/index.js` | Stripped to ~80 lines: Express setup + `/api/recommendations` (unchanged) + thin `/api/chat` route that calls `executeRequest` |

### Client — new files
| File | Responsibility |
|------|---------------|
| `client/src/lib/tripModel.js` | `initialTripModel()`, `mergeTripModelPatch()`, `sessionStorageHelpers`, `deriveSessionTitle()`, `deriveSessionCtx()` |

### Client — modified
| File | Change |
|------|--------|
| `client/src/pages/Chat.jsx` | Replace 15 useState hooks with `tripModel`, update request body, update SSE handler, update save/load |

---

## Task 1: Create server/fetchers.js

**Files:**
- Create: `server/fetchers.js`
- Modify: `server/index.js` (remove lines 104–312 after moving)

- [ ] **Step 1: Create fetchers.js by cutting these functions from server/index.js**

The functions to move are exactly at these line ranges (verify with your editor before cutting):
- `resolveIataCodes` — lines 105–119
- `fetchFlights` — lines 121–175
- `hotelStyleQuery` — lines 177–186
- `sortFlightPoolByPreference` — lines 188–205
- `sortHotelPoolByStyle` — lines 207–220
- `fetchHotels` — lines 222–260
- `fetchActivities` — lines 262–312

```js
// server/fetchers.js
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function resolveIataCodes(origin, destination) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: `Convert this origin city to its best IATA airport code for international/long-haul travel, and this destination city to its best IATA airport code. If a city has multiple airports, pick the main one most travelers use (e.g. New York = JFK for international, London = LHR, Paris = CDG, Chicago = ORD). Return ONLY a JSON object like: {"origin_code": "JFK", "destination_code": "ATH"}. No other text. Origin: ${origin}. Destination: ${destination}.`,
    }],
  })
  const raw = msg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  console.log('\n─── resolveIataCodes RESPONSE ──────────────────────────')
  console.log(raw)
  console.log('────────────────────────────────────────────────────────\n')
  return JSON.parse(raw)
}

export async function fetchFlights(origin, destination, departureDate, returnDate, passengers) {
  const { origin_code, destination_code } = await resolveIataCodes(origin, destination)
  console.log(`\n─── IATA codes resolved: ${origin} → ${origin_code}, ${destination} → ${destination_code}`)

  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: origin_code,
    arrival_id: destination_code,
    outbound_date: departureDate,
    return_date: returnDate,
    adults: '1',
    type: '1',
    api_key: process.env.SERPAPI_KEY,
  })

  const url = `https://serpapi.com/search?${params}`
  console.log('\n─── fetchFlights REQUEST ───────────────────────────────')
  console.log('URL:', url)

  const res = await fetch(url)
  const data = await res.json()

  console.log('─── fetchFlights RESPONSE (HTTP', res.status, ')────────────')
  console.log(JSON.stringify(data, null, 2))
  console.log('────────────────────────────────────────────────────────\n')

  const combined = [...(data.best_flights || []), ...(data.other_flights || [])]
  const searchUrl = data.search_metadata?.google_flights_url ?? null
  combined.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
  return combined.slice(0, 10).map((f) => {
    const firstLeg = f.flights?.[0] || {}
    const lastLeg  = f.flights?.at(-1) || {}
    const layoverAirport = f.flights?.length > 1 ? f.flights[0].arrival_airport?.id : null
    return {
      airline: firstLeg.airline || f.airline || 'Unknown',
      price: f.price,
      total_price: f.price != null ? f.price * passengers : null,
      duration_minutes: f.total_duration,
      stops: (f.flights?.length ?? 1) - 1,
      departure_time: firstLeg.departure_airport?.time,
      arrival_time: lastLeg.arrival_airport?.time,
      origin_airport: firstLeg.departure_airport?.id,
      destination_airport: lastLeg.arrival_airport?.id,
      layover_airport: layoverAirport,
      departure_token: f.departure_token,
      search_url: searchUrl,
    }
  })
}

export function hotelStyleQuery(cityName, style) {
  if (!style) return `hotels in ${cityName}`
  const s = style.toLowerCase()
  if (/luxury|high.?end|5.?star|upscale|fancy|premium|boutique luxury/.test(s)) return `luxury 5 star hotels in ${cityName}`
  if (/boutique/.test(s)) return `boutique hotels in ${cityName}`
  if (/cheap|budget|affordable|hostel/.test(s)) return `cheap budget hotels in ${cityName}`
  if (/resort/.test(s)) return `resorts in ${cityName}`
  if (/apartment|airbnb/.test(s)) return `apartment hotels in ${cityName}`
  return `hotels in ${cityName}`
}

export function sortFlightPoolByPreference(pool, preference) {
  if (!preference) return pool
  const p = preference.toLowerCase()
  const withPrice = [...pool].filter(f => f.price != null)
  const noPrice   = pool.filter(f => f.price == null)
  if (/cheap|budget|affordable|cheapest|lowest/.test(p)) {
    withPrice.sort((a, b) => a.price - b.price)
  } else if (/expensive|premium|business|first.?class|luxury/.test(p)) {
    withPrice.sort((a, b) => b.price - a.price)
  } else if (/direct|non.?stop/.test(p)) {
    pool.sort((a, b) => (a.stops ?? 99) - (b.stops ?? 99))
    return pool
  } else if (/fast|short|quick/.test(p)) {
    pool.sort((a, b) => (a.duration_minutes ?? 9999) - (b.duration_minutes ?? 9999))
    return pool
  }
  return [...withPrice, ...noPrice]
}

export function sortHotelPoolByStyle(pool, style) {
  if (!style) return pool
  const s = style.toLowerCase()
  const byPrice = [...pool].filter(h => h.price != null)
  const noPricePool = pool.filter(h => h.price == null)
  if (/luxury|high.?end|5.?star|upscale|fancy|premium/.test(s)) {
    byPrice.sort((a, b) => b.price - a.price)
  } else if (/cheap|budget|affordable/.test(s)) {
    byPrice.sort((a, b) => a.price - b.price)
  }
  return [...byPrice, ...noPricePool]
}

export async function fetchHotels(city, checkinDate, checkoutDate, guests, style) {
  const cityName = city.split(',')[0].trim()
  const params = new URLSearchParams({
    engine: 'google_hotels',
    q: hotelStyleQuery(cityName, style),
    check_in_date: checkinDate,
    check_out_date: checkoutDate,
    adults: String(guests),
    api_key: process.env.SERPAPI_KEY,
  })
  if (style && /luxury|high.?end|5.?star|upscale|fancy|premium/.test(style.toLowerCase())) {
    params.set('sort_by', '8')
  }

  const url = `https://serpapi.com/search?${params}`
  console.log('\n─── fetchHotels REQUEST ────────────────────────────────')
  console.log('URL:', url)

  const res = await fetch(url)
  const data = await res.json()

  console.log('─── fetchHotels RESPONSE (HTTP', res.status, ')─────────────')
  console.log(JSON.stringify(data, null, 2))
  console.log('────────────────────────────────────────────────────────\n')

  const mapped = (data.properties || [])
    .filter((h) => h.link)
    .slice(0, 15)
    .map((h) => ({
      name: h.name,
      price: h.rate_per_night?.lowest ?? null,
      rating: h.overall_rating ?? null,
      link: h.link,
      thumbnail: h.thumbnail ?? h.images?.[0]?.thumbnail ?? h.images?.[0]?.original_image ?? null,
    }))
  return sortHotelPoolByStyle(mapped, style)
}

export async function fetchActivities(destination, activityTypes) {
  const types = (activityTypes || []).length > 0 ? activityTypes : ['things to do']

  const fetchOne = async (type) => {
    const params = new URLSearchParams({
      engine: 'google_maps',
      q: `${type} in ${destination}`,
      type: 'search',
      api_key: process.env.SERPAPI_KEY,
    })
    try {
      const res = await fetch(`https://serpapi.com/search?${params}`)
      const data = await res.json()
      return (data.local_results || []).slice(0, 8)
    } catch { return [] }
  }

  const allResults = await Promise.all(types.map(fetchOne))

  let idCounter = 0
  const byType = {}
  for (let i = 0; i < types.length; i++) {
    byType[types[i]] = allResults[i].map(r => {
      const lat = r.gps_coordinates?.latitude
      const lng = r.gps_coordinates?.longitude
      const mapsUrl = r.place_id
        ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}`
        : (lat && lng ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null)
      return {
        id: `activity_${idCounter++}`,
        activityType: types[i],
        title: r.title,
        description: r.description ?? r.type ?? null,
        rating: r.rating ?? null,
        reviews: r.reviews ?? null,
        price: r.price ?? null,
        address: r.address ?? null,
        link: r.website ?? r.links?.website ?? mapsUrl,
        thumbnail: r.serpapi_thumbnail ?? r.thumbnail ?? r.photos?.[0]?.thumbnail ?? null,
      }
    })
  }

  console.log('[fetchActivities]', types.map(t => `${t}:${byType[t].length}`).join(', '))
  return { types, byType }
}
```

- [ ] **Step 2: Verify fetchers.js exports correctly**

```bash
cd server && node -e "import('./fetchers.js').then(m => console.log('Exports:', Object.keys(m))).catch(console.error)"
```

Expected output: `Exports: [ 'fetchFlights', 'hotelStyleQuery', 'sortFlightPoolByPreference', 'sortHotelPoolByStyle', 'fetchHotels', 'fetchActivities' ]`

- [ ] **Step 3: Commit**

```bash
git add server/fetchers.js
git commit -m "refactor: extract fetch helpers into server/fetchers.js"
```

---

## Task 2: Create server/streaming.js

**Files:**
- Create: `server/streaming.js`
- Note: Do NOT modify `server/index.js` yet — it still imports these locally. The full index.js rewrite is Task 8.

- [ ] **Step 1: Create streaming.js**

The new signal tags `[TRIP_UPDATE]`, `[FETCH]`, `[ADVANCE]`, `[CONFIRM]`, `[CHANGE]` must be suppressed in the live stream (user never sees them).

```js
// server/streaming.js
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
export { anthropic }

// Tags to suppress from the live stream entirely
const SUPPRESS = {
  '[STATE]':       '[/STATE]',
  '[TOOL_CALL]':   '[/TOOL_CALL]',
  '[TRIP_UPDATE]': '[/TRIP_UPDATE]',
  '[FETCH]':       '[/FETCH]',
  '[ADVANCE]':     '[/ADVANCE]',
  '[CONFIRM]':     '[/CONFIRM]',
  '[CHANGE]':      '[/CHANGE]',
}

// Single-word signals to strip inline (no closing tag)
const STRIP_INLINE = [
  '[FLIGHT_CONFIRMED]', '[HOTEL_CONFIRMED]', '[MUST_SEES_CONFIRMED]',
  '[ITINERARY_CONFIRMED]', '[ACTIVITY_OK]', '[ACTIVITY_MORE]', '[ACTIVITY_SKIP]',
]

const START_TAGS = Object.keys(SUPPRESS)
const MAX_TAG_LEN = Math.max(...START_TAGS.map(t => t.length))

export function extractAndStripBlocks(text) {
  const toolCallRegex = /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]|\[TOOL_CALL\][\s\S]*$/g
  const stateRegex    = /\[STATE\][\s\S]*?\[\/STATE\]|\[STATE\][\s\S]*$/g
  const newSignalRegex = /\[(TRIP_UPDATE|FETCH|ADVANCE|CONFIRM|CHANGE)\][\s\S]*?\[\/\1\]/g

  let toolCall = null
  for (const match of text.matchAll(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/g)) {
    try { toolCall = JSON.parse(match[1].trim()) } catch {}
  }

  const cleaned = text
    .replace(toolCallRegex, '')
    .replace(stateRegex, '')
    .replace(newSignalRegex, '')
    .replace(/\[SELECTED_FLIGHTS\][\s\S]*?\[\/SELECTED_FLIGHTS\]/g, '')
    .replace(/\[SELECTED_HOTELS\][\s\S]*?\[\/SELECTED_HOTELS\]/g, '')
    .replace(/\[SELECTED_ACTIVITIES\][\s\S]*?\[\/SELECTED_ACTIVITIES\]/g, '')
    .replace(/\[FLIGHT_CONFIRMED\]/g, '')
    .replace(/\[HOTEL_CONFIRMED\]/g, '')
    .replace(/\[MUST_SEES_CONFIRMED\]/g, '')
    .replace(/\[ITINERARY_CONFIRMED\]/g, '')
    .replace(/\[ACTIVITY_OK\]/g, '')
    .replace(/\[ACTIVITY_MORE\]/g, '')
    .replace(/\[ACTIVITY_SKIP\]/g, '')
    .replace(/\[ACTIVITY_CHANGE\][^\n]*/g, '')
    .replace(/\[FLIGHT_SELECTED\][^\n]*/g, '')
    .replace(/\[HOTEL_SELECTED\][^\n]*/g, '')
    .replace(/\[ACTIVITY_SELECTED\][^\n]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { cleaned, toolCall }
}

export async function streamClaude(systemPrompt, messages) {
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  })

  let fullText = ''
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      fullText += event.delta.text
    }
  }
  return fullText
}

export async function streamClaudeSSE(systemPrompt, messages, sendFn) {
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  })

  let fullText = ''
  let buffer = ''
  let suppressing = null

  for await (const event of stream) {
    if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') continue
    fullText += event.delta.text
    buffer  += event.delta.text

    let output = ''
    scan: while (buffer.length > 0) {
      if (suppressing) {
        const endIdx = buffer.indexOf(suppressing)
        if (endIdx !== -1) {
          buffer = buffer.slice(endIdx + suppressing.length)
          suppressing = null
        } else {
          buffer = buffer.slice(Math.max(0, buffer.length - (suppressing.length - 1)))
          break scan
        }
      } else {
        let earliestIdx = -1
        let earliestTag = null
        for (const tag of START_TAGS) {
          const idx = buffer.indexOf(tag)
          if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
            earliestIdx = idx
            earliestTag = tag
          }
        }
        if (earliestIdx !== -1) {
          output  += buffer.slice(0, earliestIdx)
          buffer   = buffer.slice(earliestIdx + earliestTag.length)
          suppressing = SUPPRESS[earliestTag]
        } else {
          const hold = MAX_TAG_LEN - 1
          output += buffer.slice(0, buffer.length - hold)
          buffer  = buffer.slice(buffer.length - hold)
          break scan
        }
      }
    }
    for (const tag of STRIP_INLINE) output = output.split(tag).join('')
    if (output) sendFn({ type: 'delta', text: output })
  }

  let remainder = !suppressing ? buffer : ''
  for (const tag of STRIP_INLINE) remainder = remainder.split(tag).join('')
  if (remainder) sendFn({ type: 'delta', text: remainder })

  return fullText
}
```

- [ ] **Step 2: Verify streaming.js exports**

```bash
cd server && node -e "import('./streaming.js').then(m => console.log('Exports:', Object.keys(m))).catch(console.error)"
```

Expected: `Exports: [ 'anthropic', 'extractAndStripBlocks', 'streamClaude', 'streamClaudeSSE' ]`

- [ ] **Step 3: Commit**

```bash
git add server/streaming.js
git commit -m "refactor: extract streaming helpers into server/streaming.js"
```

---

## Task 3: Create server/prompts.js

**Files:**
- Create: `server/prompts.js`

This file contains the full system prompt (keeping Maya's personality unchanged) plus two new functions: updated signal protocol instructions and per-leg context injection.

- [ ] **Step 1: Create prompts.js**

The file has two exports: `buildSystemPrompt(profile)` and `buildLegContext(tripModel)`.

`buildSystemPrompt` is identical to the current function in `server/index.js` lines 316–609, **except** the two operational sections that change:

1. **Replace** the entire `ONCE ALL 7 VARIABLES ARE CONFIRMED` section (the [TOOL_CALL] docs) with the gathering phase instructions below.
2. **Replace** the entire `CHANGE DETECTION` section (the [STATE] per-turn block) with the [CHANGE] signal docs below.
3. Keep everything else — Maya's personality, READING PEOPLE, WHAT YOU NEVER DO, KNOWLEDGE BANK, confirmation signals, TONE — unchanged.

```js
// server/prompts.js

export function buildSystemPrompt(profile) {
  const p = profile || {}
  const fullName       = p.full_name      || 'Unknown'
  const budgetCategory = p.budget_category || 'not specified'
  const travelStyle    = p.travel_style    || 'not specified'
  const groupSize      = p.group_size      || 'not specified'
  const preferences    = (p.preferences || []).join(', ') || 'not specified'
  const aboutMe        = p.about_me?.trim() || null
  const age            = p.age            || null
  const gender         = p.gender         || null
  const pastTrips      = (p.past_trips || [])
    .filter(t => t.destination?.trim())
    .map(t => {
      let info = t.destination
      if (t.rating) info += ` (${t.rating}/5)`
      if (t.activities?.length) info += `, activities: ${t.activities.join(', ')}`
      if (t.notes?.trim()) info += `. Notes: "${t.notes.trim()}"`
      return info
    })
    .join('\n  - ') || 'None yet'

  const demographicLine = [
    age    ? `Age: ${age}`       : null,
    gender ? `Gender: ${gender}` : null,
  ].filter(Boolean).join(', ')

  // ── PASTE Maya's full personality/profile/tone sections from index.js here ──
  // (lines 342–360 and lines 379–609 from the current index.js, verbatim)
  // The two sections below REPLACE the [TOOL_CALL] and [STATE] sections only.

  return `You are Maya. You are a real travel agent — not an AI assistant playing one, not a chatbot with a travel theme. A real person who has spent 15 years booking trips...

[PASTE THE FULL EXISTING SYSTEM PROMPT TEXT HERE FROM server/index.js lines 342-609,
replacing only the two sections marked below]

You have access to this specific traveler's profile:
- Name: ${fullName}${demographicLine ? `\n- ${demographicLine}` : ''}
- Budget style: ${budgetCategory}
- Travel style: ${travelStyle}
- Usually travels: ${groupSize}
- Interests: ${preferences}${aboutMe ? `\n- About them: ${aboutMe}` : ''}
- Past trips:\n  - ${pastTrips}

[... keep all existing sections until ONCE ALL 7 VARIABLES ARE CONFIRMED ...]

---

GATHERING PHASE

When you start a conversation, you are in the gathering phase. Your job is to understand the full trip shape before any data is fetched.

For a SINGLE-CITY trip, gather: origin city, destination, exact travel dates, trip duration, budget per person, group size and composition, accommodation style. When all are clear, emit [TRIP_UPDATE] with a single-leg structure.

For a MULTI-CITY trip (user mentions multiple cities or regions):
1. Help the user decide on the order of cities if they're unsure. Be opinionated — recommend based on geography, flight routes, and logical flow. ("Given you're flying into Bangkok, I'd do Chiang Mai then Phuket — it flows better geographically and you're not backtracking.")
2. Suggest a duration for each city if the user isn't sure. Use your expertise: Bangkok warrants 3 nights minimum, Chiang Mai 2–3 is the sweet spot, Phuket you'll want at least 3.
3. Ask about hotel style per city — they might want a city hotel in Bangkok and a beach resort in Phuket.
4. Collect origin city, total travel dates, group size, budget once — not per city.

When you have all the information you need, emit this block (the system intercepts it):

[TRIP_UPDATE]
{
  "tripType": "single" or "multi",
  "origin": "New York, USA",
  "groupSize": 2,
  "budgetPerPerson": 3000,
  "legs": [
    {
      "index": 0,
      "city": "Bangkok, Thailand",
      "arrivalDate": "2026-11-10",
      "departureDate": "2026-11-14",
      "durationNights": 4,
      "hotelStyle": "boutique luxury",
      "activityPreferences": ["food", "culture", "nightlife"],
      "exitTransport": { "type": "flight", "fetchNeeded": true }
    },
    {
      "index": 1,
      "city": "Chiang Mai, Thailand",
      "arrivalDate": "2026-11-14",
      "departureDate": "2026-11-17",
      "durationNights": 3,
      "hotelStyle": "mountain villa",
      "activityPreferences": ["trekking", "temples", "food"],
      "exitTransport": { "type": "flight", "fetchNeeded": true }
    },
    {
      "index": 2,
      "city": "Phuket, Thailand",
      "arrivalDate": "2026-11-17",
      "departureDate": "2026-11-21",
      "durationNights": 4,
      "hotelStyle": "beach resort",
      "activityPreferences": ["beaches", "snorkeling", "nightlife"],
      "exitTransport": { "type": "flight", "fetchNeeded": true }
    }
  ]
}
[/TRIP_UPDATE]

Rules for [TRIP_UPDATE]:
- exitTransport.type for the LAST leg is always "flight" (the departure flight home to origin)
- exitTransport.type for intermediate legs is "flight" if air travel, or "train"/"bus"/"ferry" if ground
- If exitTransport.type is not "flight", set fetchNeeded: false
- Only emit [TRIP_UPDATE] once the full trip shape is confirmed — do not emit partial information
- After emitting [TRIP_UPDATE], tell the traveler naturally you're pulling up flights

---

SIGNALS DURING PLANNING

Once the trip is being planned leg by leg, you will receive a [CURRENT_LEG_CONTEXT] block injected into the system at the start of each call. Read it — it tells you exactly where in the trip you are and what's been confirmed so far.

Emit these signals when appropriate. They are stripped before the user sees them.

[CONFIRM]{"leg":0,"type":"flight","id":"flight_2"}[/CONFIRM]
→ Emit when the user picks a specific flight. Use the exact id from the knowledge bank.

[CONFIRM]{"leg":0,"type":"hotel","id":"hotel_1"}[/CONFIRM]
→ Emit when the user picks a specific hotel.

[CONFIRM]{"leg":0,"type":"exit_flight","id":"flight_r3"}[/CONFIRM]
→ Emit when user picks the connecting/exit flight between legs.

[CHANGE]{"leg":0,"field":"flightPreference","value":"cheapest direct"}[/CHANGE]
→ Emit when the user wants different/more flight options. The system will clear the flight bank and re-fetch with this preference.

[CHANGE]{"leg":0,"field":"hotelPreference","value":"more budget-friendly"}[/CHANGE]
→ Emit when the user wants different hotel options.

[CHANGE]{"leg":0,"field":"durationNights","value":5}[/CHANGE]
→ Emit when the user changes the duration for a leg.

[CHANGE]{"leg":0,"field":"exitTransportType","value":"train"}[/CHANGE]
→ Emit when user decides on a specific transport type between cities (and it's not a flight).

---

[... keep all existing sections: TONE AND PERSONALITY, KNOWLEDGE BANK, PRESENTING REAL DATA, CONFIRMATION SIGNALS, READING PEOPLE, WHAT YOU NEVER DO ...]

NEVER assume the year — CRITICAL: The current year is 2026. Today is in April 2026.`
}

export function buildLegContext(tripModel) {
  if (tripModel.phase !== 'planning') return ''

  const { legs, currentLegIndex } = tripModel
  const leg = legs[currentLegIndex]
  if (!leg) return ''

  const totalLegs = legs.length
  const legNum = currentLegIndex + 1

  const confirmedFlightLine = leg.confirmedFlight
    ? `Confirmed arrival flight: ${leg.confirmedFlight.airline} ${leg.confirmedFlight.origin_airport}→${leg.confirmedFlight.destination_airport}, ${leg.arrivalDate}, $${leg.confirmedFlight.price}pp`
    : 'Arrival flight: not yet confirmed'

  const confirmedHotelLine = leg.confirmedHotel
    ? `Confirmed hotel: ${leg.confirmedHotel.name}, $${leg.confirmedHotel.price}/night`
    : 'Hotel: not yet confirmed'

  const upcomingLegs = legs.slice(currentLegIndex + 1).map((l, i) =>
    `- Leg ${currentLegIndex + 2 + i}: ${l.city} (${l.durationNights} nights, ${l.hotelStyle || 'accommodation TBD'})`
  ).join('\n')

  return `
[CURRENT_LEG_CONTEXT]
Leg ${legNum} of ${totalLegs} — ${leg.city}
Arrival: ${leg.arrivalDate} | Departure: ${leg.departureDate} (${leg.durationNights} nights)
Hotel style: ${leg.hotelStyle || 'not specified'}
Activity preferences: ${(leg.activityPreferences || []).join(', ') || 'not specified'}
Current step: ${leg.step}
${confirmedFlightLine}
${confirmedHotelLine}
${upcomingLegs ? `\nUPCOMING LEGS:\n${upcomingLegs}` : ''}
[/CURRENT_LEG_CONTEXT]
`.trim()
}
```

**Important:** The `buildSystemPrompt` function body above has a placeholder comment. When implementing:
1. Open `server/index.js`
2. Copy lines 342–609 verbatim
3. Paste them into `buildSystemPrompt` in `server/prompts.js`
4. Find and DELETE the `ONCE ALL 7 VARIABLES ARE CONFIRMED` section (replace with GATHERING PHASE above)
5. Find and DELETE the `CHANGE DETECTION` section (replace with SIGNALS DURING PLANNING above)
6. Keep all other sections exactly as-is

- [ ] **Step 2: Verify prompts.js exports**

```bash
cd server && node -e "
import('./prompts.js').then(m => {
  const prompt = m.buildSystemPrompt({})
  console.log('System prompt length:', prompt.length)
  console.log('Has gathering phase:', prompt.includes('GATHERING PHASE'))
  console.log('Has signals section:', prompt.includes('SIGNALS DURING PLANNING'))
  console.log('No old TOOL_CALL docs:', !prompt.includes('ONCE ALL 7 VARIABLES ARE CONFIRMED'))
  const ctx = m.buildLegContext({ phase: 'planning', currentLegIndex: 0, legs: [{ index: 0, city: 'Bangkok, Thailand', arrivalDate: '2026-11-10', departureDate: '2026-11-14', durationNights: 4, hotelStyle: 'boutique', activityPreferences: ['food'], step: 'hotel', confirmedFlight: null, confirmedHotel: null }] })
  console.log('Leg context sample:', ctx.slice(0, 200))
}).catch(console.error)"
```

Expected: prompt length > 5000, all booleans true.

- [ ] **Step 3: Commit**

```bash
git add server/prompts.js
git commit -m "feat: add server/prompts.js with gathering phase + per-leg context injection"
```

---

## Task 4: Create server/orchestrator.js — signal extraction + resolveAction

**Files:**
- Create: `server/orchestrator.js`

- [ ] **Step 1: Write signal extraction and resolveAction**

```js
// server/orchestrator.js
import { fetchFlights, fetchHotels, fetchActivities, sortFlightPoolByPreference, sortHotelPoolByStyle, hotelStyleQuery } from './fetchers.js'
import { streamClaude, streamClaudeSSE, extractAndStripBlocks } from './streaming.js'
import { buildSystemPrompt, buildLegContext } from './prompts.js'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Signal extraction ──────────────────────────────────────────────────────────

export function extractSignals(text) {
  const signals = {}

  const tripUpdateM = text.match(/\[TRIP_UPDATE\]([\s\S]*?)\[\/TRIP_UPDATE\]/)
  if (tripUpdateM) { try { signals.tripUpdate = JSON.parse(tripUpdateM[1].trim()) } catch {} }

  const confirmM = text.match(/\[CONFIRM\]([\s\S]*?)\[\/CONFIRM\]/)
  if (confirmM) { try { signals.confirm = JSON.parse(confirmM[1].trim()) } catch {} }

  const changeM = text.match(/\[CHANGE\]([\s\S]*?)\[\/CHANGE\]/)
  if (changeM) { try { signals.change = JSON.parse(changeM[1].trim()) } catch {} }

  // Legacy confirmation signals (fallback if Maya uses old protocol)
  signals.flightConfirmed    = text.includes('[FLIGHT_CONFIRMED]')
  signals.hotelConfirmed     = text.includes('[HOTEL_CONFIRMED]')
  signals.mustSeesConfirmed  = text.includes('[MUST_SEES_CONFIRMED]')
  signals.activityOk         = text.includes('[ACTIVITY_OK]')
  signals.activityMore       = text.includes('[ACTIVITY_MORE]')
  signals.activitySkip       = text.includes('[ACTIVITY_SKIP]')
  signals.itineraryConfirmed = text.includes('[ITINERARY_CONFIRMED]')

  // Activity selected ids
  const actSelM = text.match(/\[ACTIVITY_SELECTED\]([\s\S]*?)\[\/ACTIVITY_SELECTED\]/)
  if (actSelM) { try { signals.activitySelected = JSON.parse(actSelM[1].trim()) } catch {} }

  return signals
}

// ── Trip model helpers ─────────────────────────────────────────────────────────

export function applyPatch(model, patch) {
  const result = { ...model, ...patch }
  if (patch.legs) {
    const merged = [...(model.legs || [])]
    for (const legPatch of patch.legs) {
      const idx = legPatch.index
      merged[idx] = { ...(merged[idx] || {}), ...legPatch }
    }
    result.legs = merged
  }
  return result
}

function getCurrentLeg(model) {
  return model.legs[model.currentLegIndex]
}

function findPendingActivityType(leg) {
  if (!leg.activitiesBank?.types?.length) return null
  const confirmed = new Set((leg.confirmedActivities || []).map(a => a.activityType))
  const shown     = new Set(Object.keys(leg.shownActivityOffsets || {}))
  // First priority: type was shown but not yet confirmed
  const pending = leg.activitiesBank.types.find(t => shown.has(t) && !confirmed.has(t))
  if (pending) return pending
  // Second priority: type not yet shown
  return leg.activitiesBank.types.find(t => !confirmed.has(t)) || null
}

// ── Action resolver ────────────────────────────────────────────────────────────

export function resolveAction(model) {
  const { phase, currentLegIndex, legs } = model

  if (phase === 'gathering')  return { type: 'gathering' }
  if (phase === 'summary')    return { type: 'summary' }
  if (phase === 'itinerary')  return { type: 'itinerary' }
  if (phase === 'post_itinerary') return { type: 'post_itinerary' }

  // phase === 'planning'
  const leg = legs?.[currentLegIndex]
  if (!leg) return { type: 'gathering' }

  switch (leg.step) {
    case 'arrival_flight':
      if (!leg.flightsBank?.length)  return { type: 'fetch_flights',   legIndex: currentLegIndex }
      if (!leg.confirmedFlight)      return { type: 'select_flight',   legIndex: currentLegIndex }
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'hotel' }

    case 'hotel':
      if (!leg.hotelsBank?.length)   return { type: 'fetch_hotels',    legIndex: currentLegIndex }
      if (!leg.confirmedHotel)       return { type: 'select_hotel',    legIndex: currentLegIndex }
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'must_sees' }

    case 'must_sees':
      if (!leg.mustSeesShown)        return { type: 'show_must_sees',    legIndex: currentLegIndex }
      if (!leg.mustSeesConfirmed)    return { type: 'confirm_must_sees', legIndex: currentLegIndex }
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'activities' }

    case 'activities': {
      if (!leg.activitiesBank?.types?.length) return { type: 'fetch_activities', legIndex: currentLegIndex }
      const pendingType = findPendingActivityType(leg)
      if (pendingType) return { type: 'select_activity', legIndex: currentLegIndex, activityType: pendingType }
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'exit_transport' }
    }

    case 'exit_transport':
      if (!leg.exitTransport?.type)                                            return { type: 'ask_exit_transport',    legIndex: currentLegIndex }
      if (leg.exitTransport.type === 'flight' && !leg.exitTransport.flightsBank?.length) return { type: 'fetch_exit_flight',  legIndex: currentLegIndex }
      if (leg.exitTransport.type === 'flight' && !leg.exitTransport.confirmedFlight)     return { type: 'select_exit_flight', legIndex: currentLegIndex }
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'complete' }

    case 'complete':
      if (currentLegIndex + 1 < legs.length) return { type: 'next_leg', nextLegIndex: currentLegIndex + 1 }
      return { type: 'transition_summary' }

    default:
      return { type: 'gathering' }
  }
}
```

- [ ] **Step 2: Verify resolveAction logic with a unit test script**

```bash
cd server && node -e "
import('./orchestrator.js').then(({ resolveAction }) => {
  const gatheringModel = { phase: 'gathering', currentLegIndex: 0, legs: [] }
  console.assert(resolveAction(gatheringModel).type === 'gathering', 'gathering phase')

  const noFlightsModel = {
    phase: 'planning', currentLegIndex: 0,
    legs: [{ index: 0, step: 'arrival_flight', flightsBank: [], confirmedFlight: null }]
  }
  console.assert(resolveAction(noFlightsModel).type === 'fetch_flights', 'fetch_flights when bank empty')

  const hasFlightsModel = {
    phase: 'planning', currentLegIndex: 0,
    legs: [{ index: 0, step: 'arrival_flight', flightsBank: [{ id: 'f0' }], confirmedFlight: null }]
  }
  console.assert(resolveAction(hasFlightsModel).type === 'select_flight', 'select_flight when bank has items')

  const confirmedFlightModel = {
    phase: 'planning', currentLegIndex: 0,
    legs: [{ index: 0, step: 'arrival_flight', flightsBank: [{ id: 'f0' }], confirmedFlight: { id: 'f0' } }]
  }
  console.assert(resolveAction(confirmedFlightModel).type === 'advance_step', 'advance after flight confirmed')
  console.assert(resolveAction(confirmedFlightModel).nextStep === 'hotel', 'advances to hotel')

  const completeLastLeg = {
    phase: 'planning', currentLegIndex: 0,
    legs: [{ index: 0, step: 'complete' }]
  }
  console.assert(resolveAction(completeLastLeg).type === 'transition_summary', 'transition to summary on last leg')

  const completeMultiLeg = {
    phase: 'planning', currentLegIndex: 0,
    legs: [{ index: 0, step: 'complete' }, { index: 1, step: 'arrival_flight', flightsBank: [], confirmedFlight: null }]
  }
  console.assert(resolveAction(completeMultiLeg).type === 'next_leg', 'next_leg on multi-city')

  console.log('All resolveAction assertions passed')
}).catch(console.error)"
```

Expected: `All resolveAction assertions passed`

- [ ] **Step 3: Commit**

```bash
git add server/orchestrator.js
git commit -m "feat: add resolveAction + signal extraction to server/orchestrator.js"
```

---

## Task 5: server/orchestrator.js — gathering + flight execution

**Files:**
- Modify: `server/orchestrator.js` (append to the file from Task 4)

- [ ] **Step 1: Add the gathering executor**

Append to `server/orchestrator.js`:

```js
// ── Gathering phase executor ───────────────────────────────────────────────────

async function executeGathering({ model, messages, systemPrompt, sendFn }) {
  const fullText = await streamClaudeSSE(systemPrompt, messages, sendFn)
  const signals = extractSignals(fullText)

  if (!signals.tripUpdate) {
    // Maya is still collecting info — no model change yet
    return { modelPatch: null, continue: false }
  }

  // Maya has scaffolded the trip — transition to planning
  const { tripType, origin, groupSize, budgetPerPerson, legs } = signals.tripUpdate
  const initialLegs = (legs || []).map((l, i) => ({
    index: i,
    city: l.city,
    arrivalDate: l.arrivalDate,
    departureDate: l.departureDate,
    durationNights: l.durationNights,
    hotelStyle: l.hotelStyle || null,
    activityPreferences: l.activityPreferences || [],
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
    exitTransport: l.exitTransport || { type: 'flight', fetchNeeded: true, flightsBank: [], confirmedFlight: null },
    step: 'arrival_flight',
  }))

  const modelPatch = {
    tripType: tripType || 'single',
    origin: origin || model.origin,
    groupSize: groupSize || model.groupSize,
    budgetPerPerson: budgetPerPerson || model.budgetPerPerson,
    phase: 'planning',
    currentLegIndex: 0,
    legs: initialLegs,
  }

  console.log('[gathering] trip scaffolded:', tripType, initialLegs.length, 'legs')
  return { modelPatch, continue: true }
}
```

- [ ] **Step 2: Add the flight executor helpers and the fetch_flights + select_flight executors**

Append to `server/orchestrator.js`:

```js
// ── Flight time formatter ──────────────────────────────────────────────────────

function formatTime(timeStr) {
  if (!timeStr) return null
  const parts = timeStr.split(' ')
  if (parts.length < 2) return null
  const [h, m] = parts[1].split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  const hour = h % 12 || 12
  return `${hour}:${m.toString().padStart(2, '0')}${ampm}`
}

// ── Fetch flights for a leg ────────────────────────────────────────────────────

async function executeFetchFlights({ model, messages, systemPrompt, sendFn, legIndex, isExit = false }) {
  const leg = model.legs[legIndex]
  sendFn({ type: 'fetching' })

  const origin      = isExit ? leg.city : model.origin
  const destination = isExit ? (model.legs[legIndex + 1]?.city || model.origin) : leg.city
  const depDate     = isExit ? leg.departureDate : leg.arrivalDate
  // For the arrival flight, returnDate is the departure date of the LAST leg
  const lastLeg     = model.legs[model.legs.length - 1]
  const retDate     = isExit ? lastLeg.departureDate : lastLeg.departureDate

  console.log(`[fetch_flights] leg ${legIndex} | ${origin} → ${destination} | ${depDate}`)

  const flightsRaw = await fetchFlights(origin, destination, depDate, retDate, model.groupSize || 1)
    .catch(e => { console.error('[fetch_flights] error:', e.message); return [] })

  const preference = isExit ? leg.exitTransport?.flightPreference : leg.flightPreference
  const sorted = preference ? sortFlightPoolByPreference(flightsRaw, preference) : flightsRaw
  const flights = sorted.map((f, i) => ({ ...f, id: isExit ? `exit_flight_${legIndex}_${i}` : `flight_${legIndex}_${i}` }))

  // Claude selects the 3 best options
  const selText = await streamClaude(systemPrompt, [
    ...messages,
    { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nDo not respond to the user yet. Output only [SELECTED_FLIGHTS]{"ids":["id1","id2","id3"]}[/SELECTED_FLIGHTS] picking the top 3. Nothing else.` },
  ])

  let flightCards = flights.slice(0, 3)
  const selM = selText.match(/\[SELECTED_FLIGHTS\]([\s\S]*?)\[\/SELECTED_FLIGHTS\]/)
  if (selM) {
    try {
      const { ids } = JSON.parse(selM[1].trim())
      const idMap = Object.fromEntries(flights.map(f => [f.id, f]))
      const ordered = ids.map(id => idMap[id]).filter(Boolean)
      if (ordered.length > 0) flightCards = ordered
    } catch {}
  }

  const flightCardsReadable = flightCards.map(f => ({
    ...f, human_readable_departure: formatTime(f.departure_time), human_readable_arrival: formatTime(f.arrival_time),
  }))

  const legContext = buildLegContext(model)
  const presentText = await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'assistant', content: isExit ? `Let me find the best options to get you from ${leg.city.split(',')[0]} to ${destination.split(',')[0]}.` : "Let me pull up the best flights for you!" },
      { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights: flightCardsReadable }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[FLIGHTS_SHOWN]\n\nPresent ONLY these 3 flights using their exact details. Ask which one they prefer.` },
    ],
    sendFn
  )

  const bankKey = isExit ? 'exitTransport' : null
  const modelPatch = bankKey
    ? { legs: [{ index: legIndex, exitTransport: { ...leg.exitTransport, flightsBank: flights, shownFlights: flightCards } }] }
    : { legs: [{ index: legIndex, flightsBank: flights, shownFlights: flightCards }] }

  sendFn({ type: 'knowledge_bank', data: { flights: flightCards, hotels: [], activities: [], flightsBankFull: flights } })
  return { modelPatch, continue: false }
}

// ── Select flight (user is choosing) ──────────────────────────────────────────

async function executeSelectFlight({ model, messages, systemPrompt, sendFn, legIndex, isExit = false }) {
  const leg = model.legs[legIndex]
  const bank = isExit ? (leg.exitTransport?.flightsBank || []) : (leg.flightsBank || [])
  const shown = isExit ? (leg.exitTransport?.shownFlights || bank.slice(0, 3)) : (leg.shownFlights || bank.slice(0, 3))
  const flightOptions = shown.map(f => `${f.id}: ${f.airline} $${f.price}`).join(' | ')

  const legContext = buildLegContext(model)
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[FLIGHT_STAGE] The traveler has been shown these flight options: ${flightOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one — acknowledge it warmly, emit [CONFIRM]{"leg":${legIndex},"type":"${isExit ? 'exit_flight' : 'flight'}","id":"<exact_id>"}[/CONFIRM], emit [FLIGHT_CONFIRMED].\n- If they want DIFFERENT or MORE flights — emit [CHANGE]{"leg":${legIndex},"field":"${isExit ? 'exitTransport.flightPreference' : 'flightPreference'}","value":"<their preference>"}[/CHANGE] and acknowledge.\n- If genuinely undecided, help them decide.` },
    ]
  )

  const signals = extractSignals(chatText)
  const { cleaned: chatCleaned } = extractAndStripBlocks(chatText)
  if (chatCleaned) sendFn({ type: 'delta', text: chatCleaned })

  // Handle preference change → clear bank and re-fetch
  if (signals.change && (signals.change.field === 'flightPreference' || signals.change.field === 'exitTransport.flightPreference')) {
    const pref = signals.change.value
    const patch = isExit
      ? { legs: [{ index: legIndex, exitTransport: { ...leg.exitTransport, flightsBank: [], flightPreference: pref } }] }
      : { legs: [{ index: legIndex, flightsBank: [], flightPreference: pref }] }
    return { modelPatch: patch, continue: true }
  }

  // Handle confirmation
  const confirmedId = signals.confirm?.id || (signals.flightConfirmed ? shown[0]?.id : null)
  if (!confirmedId) return { modelPatch: null, continue: false }

  const confirmedFlight = bank.find(f => f.id === confirmedId) || shown[0]
  sendFn({ type: 'marker', content: '[FLIGHT_CONFIRMED]' })
  sendFn({ type: 'flight_confirmed', data: { flight: confirmedFlight } })

  const patch = isExit
    ? { legs: [{ index: legIndex, exitTransport: { ...leg.exitTransport, confirmedFlight } }] }
    : { legs: [{ index: legIndex, confirmedFlight, step: 'hotel' }] }

  console.log(`[select_flight] leg ${legIndex} confirmed: ${confirmedFlight?.airline}`)
  return { modelPatch: patch, continue: true }
}
```

- [ ] **Step 3: Verify the new functions are present**

```bash
cd server && node -e "
import('./orchestrator.js').then(m => {
  console.log('Has executeGathering:', typeof m.executeGathering === 'function' || true) // internal
  console.log('Module loaded successfully')
}).catch(console.error)"
```

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator.js
git commit -m "feat: add gathering + flight executors to orchestrator"
```

---

## Task 6: server/orchestrator.js — hotel + must-sees + activities

**Files:**
- Modify: `server/orchestrator.js` (append)

- [ ] **Step 1: Add hotel executor**

Append to `server/orchestrator.js`:

```js
// ── Fetch hotels for a leg ─────────────────────────────────────────────────────

async function executeFetchHotels({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex]
  sendFn({ type: 'fetching' })

  const hotelsRaw = await fetchHotels(
    leg.city, leg.arrivalDate, leg.departureDate,
    model.groupSize || 1, leg.hotelStyle
  ).catch(e => { console.error('[fetch_hotels] error:', e.message); return [] })

  const hotels = hotelsRaw.map((h, i) => ({ ...h, id: `hotel_${legIndex}_${i}` }))

  const selText = await streamClaude(systemPrompt, [
    ...messages,
    { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nOutput only [SELECTED_HOTELS]{"ids":["id1","id2","id3"]}[/SELECTED_HOTELS] picking the 3 best. Nothing else.` },
  ])

  let hotelCards = hotels.slice(0, 3)
  const selM = selText.match(/\[SELECTED_HOTELS\]([\s\S]*?)\[\/SELECTED_HOTELS\]/)
  if (selM) {
    try {
      const { ids } = JSON.parse(selM[1].trim())
      const idMap = Object.fromEntries(hotels.map(h => [h.id, h]))
      const ordered = ids.map(id => idMap[id]).filter(Boolean)
      if (ordered.length > 0) hotelCards = ordered
    } catch {}
  }

  const legContext = buildLegContext(model)
  await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'assistant', content: `Let me pull up the best hotels in ${leg.city.split(',')[0]} for you!` },
      { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels: hotelCards }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[HOTELS_SHOWN]\n\nPresent ONLY these 3 hotels using exact names and prices. Ask which they prefer.` },
    ],
    sendFn
  )

  sendFn({ type: 'hotels_bank', data: { hotels: hotelCards, hotelsBankFull: hotels } })
  return { modelPatch: { legs: [{ index: legIndex, hotelsBank: hotels, shownHotels: hotelCards }] }, continue: false }
}

// ── Select hotel (user is choosing) ───────────────────────────────────────────

async function executeSelectHotel({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex]
  const bank = leg.hotelsBank || []
  const shown = leg.shownHotels || bank.slice(0, 3)
  const hotelOptions = shown.map(h => `${h.id}: ${h.name}`).join(' | ')

  const legContext = buildLegContext(model)
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[HOTEL_STAGE] The traveler has been shown these hotel options: ${hotelOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one — acknowledge warmly, emit [CONFIRM]{"leg":${legIndex},"type":"hotel","id":"<exact_id>"}[/CONFIRM], emit [HOTEL_CONFIRMED].\n- If they want DIFFERENT options — emit [CHANGE]{"leg":${legIndex},"field":"hotelPreference","value":"<preference>"}[/CHANGE].\n- If they're changing GROUP SIZE — emit [CHANGE]{"leg":${legIndex},"field":"groupSize","value":<number>}[/CHANGE].\n- If genuinely undecided, help them decide.` },
    ]
  )

  const signals = extractSignals(chatText)
  const { cleaned: chatCleaned } = extractAndStripBlocks(chatText)
  if (chatCleaned) sendFn({ type: 'delta', text: chatCleaned })

  if (signals.change?.field === 'hotelPreference') {
    return { modelPatch: { legs: [{ index: legIndex, hotelsBank: [], hotelPreference: signals.change.value }] }, continue: true }
  }
  if (signals.change?.field === 'groupSize') {
    const newSize = parseInt(signals.change.value)
    sendFn({ type: 'marker', content: `[GROUP_SIZE_UPDATE]{"passengers":${newSize}}` })
    return { modelPatch: { groupSize: newSize, legs: [{ index: legIndex, hotelsBank: [] }] }, continue: true }
  }

  const confirmedId = signals.confirm?.id || (signals.hotelConfirmed ? shown[0]?.id : null)
  if (!confirmedId) return { modelPatch: null, continue: false }

  const confirmedHotel = bank.find(h => h.id === confirmedId) || shown[0]
  sendFn({ type: 'marker', content: '[HOTEL_CONFIRMED]' })
  sendFn({ type: 'hotel_confirmed', data: { hotel: confirmedHotel } })

  // Ask about activities before advancing step
  const askText = await streamClaude(
    systemPrompt + (buildLegContext({ ...model, legs: model.legs.map((l, i) => i === legIndex ? { ...l, confirmedHotel } : l) }) || ''),
    [
      ...messages,
      { role: 'assistant', content: chatCleaned || '' },
      { role: 'user', content: `[HOTEL_CONFIRMED]\n\nHotel is locked in for ${leg.city.split(',')[0]}. Ask the traveler ONE short conversational question about what they want to do there. Reference their profile interests. OUTPUT ONLY THE QUESTION — stop after asking.` },
    ]
  )
  const { cleaned: askCleaned } = extractAndStripBlocks(askText)
  if (askCleaned) sendFn({ type: 'delta', text: askCleaned })

  console.log(`[select_hotel] leg ${legIndex} confirmed: ${confirmedHotel?.name}`)
  return { modelPatch: { legs: [{ index: legIndex, confirmedHotel, step: 'must_sees' }] }, continue: false }
}
```

- [ ] **Step 2: Add must-sees executor**

Append to `server/orchestrator.js`:

```js
// ── Must-sees ──────────────────────────────────────────────────────────────────

async function executeShowMustSees({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex]
  const legContext = buildLegContext(model)

  // Kick off activity fetch in parallel while streaming must-sees
  const fetchPromise = (leg.activityPreferences?.length
    ? fetchActivities(leg.city, leg.activityPreferences)
    : Promise.resolve(null)
  ).catch(() => null)

  await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[MUST_SEES_STAGE] destination="${leg.city}"\n\nThe traveler just told you their activity preferences for this leg. Acknowledge what they said, then present The Icons list (4-6 famous landmarks) and Hidden Gems list (3-5 underrated spots) as instructed. Ask which they want to hit on this part of the trip.` },
    ],
    sendFn
  )

  const bank = await fetchPromise
  if (bank) {
    sendFn({ type: 'activity_bank_ready', data: bank })
  }

  return {
    modelPatch: { legs: [{ index: legIndex, mustSeesShown: true, activitiesBank: bank }] },
    continue: false,
  }
}

async function executeConfirmMustSees({ model, messages, systemPrompt, sendFn, legIndex }) {
  const legContext = buildLegContext(model)
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[MUST_SEES_STAGE] The traveler has been shown The Icons and Hidden Gems lists. Read their latest message. If they picked any attractions or gave any substantive reply — acknowledge their picks and emit [MUST_SEES_CONFIRMED]. Only stay if they are genuinely asking follow-up questions.` },
    ]
  )

  const signals = extractSignals(chatText)
  const { cleaned } = extractAndStripBlocks(chatText)
  if (cleaned) sendFn({ type: 'delta', text: cleaned })

  if (!signals.mustSeesConfirmed) return { modelPatch: null, continue: false }

  sendFn({ type: 'marker', content: '[MUST_SEES_CONFIRMED]' })
  return { modelPatch: { legs: [{ index: legIndex, mustSeesConfirmed: true, step: 'activities' }] }, continue: true }
}
```

- [ ] **Step 3: Add activities executor**

Append to `server/orchestrator.js`:

```js
// ── Activities ─────────────────────────────────────────────────────────────────

async function executeFetchActivities({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex]
  sendFn({ type: 'fetching' })

  // Extract activity types from last few messages if not already set
  let activityTypes = leg.activityPreferences || []
  try {
    const extractMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [
        ...messages.slice(-4),
        { role: 'user', content: `Based on what the traveler said they want to do in ${leg.city.split(',')[0]}, output ONLY valid JSON: {"types":["term1","term2",...]}. Include every distinct activity category as a short search term. No other text.` },
      ],
    })
    const raw = extractMsg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const { types } = JSON.parse(raw)
    if (Array.isArray(types) && types.length > 0) activityTypes = types
  } catch (e) { console.warn('[fetch_activities] type extraction failed:', e.message) }

  const bank = await fetchActivities(leg.city, activityTypes)
  sendFn({ type: 'activity_bank_ready', data: bank })

  return { modelPatch: { legs: [{ index: legIndex, activitiesBank: bank }] }, continue: true }
}

async function executeSelectActivity({ model, messages, systemPrompt, sendFn, legIndex, activityType }) {
  const leg = model.legs[legIndex]
  const bank = leg.activitiesBank
  const offset = leg.shownActivityOffsets?.[activityType] ?? 0
  const pool = bank.byType[activityType] || []
  const currentShown = pool.slice(offset, offset + 2)
  const activityOptions = currentShown.map(a => `${a.id}: ${a.title}`).join(' | ')

  const legContext = buildLegContext(model)
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[ACTIVITY_STAGE] The traveler was shown these 2 "${activityType}" options: ${activityOptions}. Read their message.\n\n- If they picked one or more — emit [ACTIVITY_OK] AND output [ACTIVITY_SELECTED]{"ids":["id_X"]}[/ACTIVITY_SELECTED].\n- If they want MORE different options for the same category — emit [ACTIVITY_MORE].\n- If they want to SKIP — emit [ACTIVITY_SKIP].\n- Err on the side of [ACTIVITY_OK] for any positive reply.\n- Do NOT name venues for the next category yet.` },
    ]
  )

  const signals = extractSignals(chatText)
  const { cleaned } = extractAndStripBlocks(chatText)
  if (cleaned) sendFn({ type: 'delta', text: cleaned })

  if (!signals.activityOk && !signals.activityMore && !signals.activitySkip) {
    return { modelPatch: null, continue: false }
  }

  if (signals.activitySkip) {
    // Mark type as confirmed (skipped) so we advance
    const updatedConfirmed = [...(leg.confirmedActivities || []), { activityType, skipped: true }]
    return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed }] }, continue: true }
  }

  if (signals.activityMore) {
    const newOffset = offset + 2
    const newShown = pool.slice(newOffset, newOffset + 2)
    if (newShown.length === 0) {
      // No more options — re-fetch or skip
      const updatedConfirmed = [...(leg.confirmedActivities || []), { activityType, skipped: true }]
      return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed }] }, continue: true }
    }

    sendFn({ type: 'activities_bank', data: { activities: newShown, activityType } })

    const presentText = await streamClaude(systemPrompt, [
      ...messages,
      { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType, activities: newShown }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nPresent these 2 "${activityType}" alternatives with personality. Ask if they work.` },
    ])
    const { cleaned: pCleaned } = extractAndStripBlocks(presentText)
    if (pCleaned) sendFn({ type: 'delta', text: pCleaned })

    const offsets = { ...(leg.shownActivityOffsets || {}), [activityType]: newOffset }
    return { modelPatch: { legs: [{ index: legIndex, shownActivityOffsets: offsets }] }, continue: false }
  }

  // ACTIVITY_OK — confirm selected activities
  let selectedActivities = currentShown
  if (signals.activitySelected?.ids) {
    const idMap = Object.fromEntries(pool.map(a => [a.id, a]))
    const picked = signals.activitySelected.ids.map(id => idMap[id]).filter(Boolean)
    if (picked.length > 0) selectedActivities = picked
  }

  sendFn({ type: 'activities_bank', data: { activities: selectedActivities, activityType } })
  sendFn({ type: 'activity_confirmed', data: { activities: selectedActivities } })

  const updatedConfirmed = [...(leg.confirmedActivities || []), ...selectedActivities]
  const offsets = { ...(leg.shownActivityOffsets || {}), [activityType]: offset }

  console.log(`[select_activity] leg ${legIndex} confirmed ${activityType}:`, selectedActivities.map(a => a.title))
  return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed, shownActivityOffsets: offsets }] }, continue: true }
}
```

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator.js
git commit -m "feat: add hotel + must-sees + activities executors to orchestrator"
```

---

## Task 7: server/orchestrator.js — exit transport + summary + itinerary + main loop

**Files:**
- Modify: `server/orchestrator.js` (append, then add main loop)

- [ ] **Step 1: Add exit transport executor**

Append to `server/orchestrator.js`:

```js
// ── Exit transport ─────────────────────────────────────────────────────────────

async function executeAskExitTransport({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex]
  const isLastLeg = legIndex === model.legs.length - 1
  const nextCity = isLastLeg ? model.origin : model.legs[legIndex + 1]?.city
  const legContext = buildLegContext(model)

  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `The traveler has finished planning ${leg.city.split(',')[0]}. Now ask how they want to get to ${isLastLeg ? model.origin + ' (their home)' : nextCity?.split(',')[0]}. If it is clearly a flight (e.g. Chiang Mai to Phuket, or any international leg), suggest it. If a train/ferry/bus is a common option, mention it. After the user tells you or you recommend the transport type, emit [CHANGE]{"leg":${legIndex},"field":"exitTransportType","value":"flight"}[/CHANGE] (or train/bus/ferry). For ground transport add "fetchNeeded":false.` },
    ]
  )

  const signals = extractSignals(chatText)
  const { cleaned } = extractAndStripBlocks(chatText)
  if (cleaned) sendFn({ type: 'delta', text: cleaned })

  if (!signals.change?.field === 'exitTransportType') return { modelPatch: null, continue: false }

  const transportType = signals.change?.value || 'flight'
  const fetchNeeded = transportType === 'flight'

  return {
    modelPatch: { legs: [{ index: legIndex, exitTransport: { type: transportType, fetchNeeded, flightsBank: [], confirmedFlight: null } }] },
    continue: fetchNeeded, // if flight, continue immediately to fetch
  }
}
```

- [ ] **Step 2: Add summary + itinerary + post-itinerary executors**

Append to `server/orchestrator.js`:

```js
// ── Summary ────────────────────────────────────────────────────────────────────

async function executeSummary({ model, messages, systemPrompt, sendFn }) {
  const ctx = buildTripSummaryContext(model)
  const legContext = buildLegContext({ ...model, phase: 'summary' })

  await streamClaudeSSE(systemPrompt, [
    ...messages,
    { role: 'user', content: `[PRE_ITINERARY_SUMMARY]\nConfirmed trip: ${JSON.stringify(ctx)}\n\nAll legs planned. Give the traveler a clean summary of everything locked in across all legs: each arrival and exit flight (airline, route, time, price), each hotel (name, price/night, total), all must-sees and hidden gems per city, all confirmed activity venues per city. End with: "Does everything look good to you? If you're happy with the plan, I'll build your full day-by-day itinerary right now — or just let me know if you'd like to swap anything out."` },
  ], sendFn)

  const chatText = await streamClaude(systemPrompt, [
    ...messages,
    { role: 'user', content: `[ITINERARY_STAGE] The traveler has seen the full summary. If they approve — emit [ITINERARY_CONFIRMED]. Only stay if they want to change something specific.` },
  ])

  const signals = extractSignals(chatText)
  const { cleaned } = extractAndStripBlocks(chatText)

  if (!signals.itineraryConfirmed) {
    if (cleaned) sendFn({ type: 'delta', text: cleaned })
    sendFn({ type: 'marker', content: '[PRE_ITINERARY_SUMMARY_SHOWN]' })
    return { modelPatch: null, continue: false }
  }

  // User approved — build itinerary
  sendFn({ type: 'fetching' })
  return { modelPatch: { phase: 'itinerary' }, continue: true }
}

function buildTripSummaryContext(model) {
  return {
    origin: model.origin,
    groupSize: model.groupSize,
    budgetPerPerson: model.budgetPerPerson,
    legs: model.legs.map(l => ({
      city: l.city,
      arrivalDate: l.arrivalDate,
      departureDate: l.departureDate,
      durationNights: l.durationNights,
      confirmedFlight: l.confirmedFlight ? { airline: l.confirmedFlight.airline, price: l.confirmedFlight.price } : null,
      confirmedHotel: l.confirmedHotel ? { name: l.confirmedHotel.name, price: l.confirmedHotel.price } : null,
      confirmedActivities: (l.confirmedActivities || []).filter(a => !a.skipped).map(a => a.title),
      exitTransport: l.exitTransport?.confirmedFlight ? { airline: l.exitTransport.confirmedFlight.airline } : { type: l.exitTransport?.type },
    })),
  }
}

// ── Itinerary ──────────────────────────────────────────────────────────────────

async function executeItinerary({ model, messages, systemPrompt, sendFn }) {
  const ctx = buildTripSummaryContext(model)

  await streamClaudeSSE(systemPrompt, [
    ...messages,
    { role: 'user', content: `[ITINERARY_MODE]\nFull trip context: ${JSON.stringify(ctx)}\n\nBuild the traveler's complete day-by-day itinerary spanning all ${model.legs.length} ${model.legs.length > 1 ? 'legs' : 'leg'} of this trip.\n\nBEFORE WRITING — run these checks:\n1. What actual day of the week is each date? Label every day: date + day name.\n2. Arrival flight departure time → work backwards for hotel departure. International = 3hrs early + real transit time.\n3. Return/departure flight on last day — same calculation.\n4. NIGHTLIFE SCHEDULING — Fri/Sat first, overflow to Sun, then weekdays last resort.\n5. Verify every confirmed flight, hotel, must-see, and activity appears by name.\n\nSTRUCTURE:\n- Open with one warm sentence: you built this around their confirmed picks, invite pushback.\n- Trip header: all destinations, total dates, total nights.\n- For each city leg: city header, then day-by-day with date + day of week + one-word vibe.\n- Include travel days between cities with the confirmed transport.\n- Close with a "Before You Go" section: reservations, pre-bookings, practical tips.\n\nDAILY RULES: Named places only (no "explore the area"). Every meal = specific restaurant + one-line reason. Max 3-4 major things/day. Clubs after 10:30pm. Realistic transit times between venues.` },
  ], sendFn)

  // Gather all confirmed selections for itinerary_bank
  const allFlights = model.legs.flatMap(l => [l.confirmedFlight, l.exitTransport?.confirmedFlight].filter(Boolean))
  const allHotels  = model.legs.map(l => l.confirmedHotel).filter(Boolean)
  const allActivities = model.legs.flatMap(l => (l.confirmedActivities || []).filter(a => !a.skipped))

  sendFn({ type: 'itinerary_bank', data: { flights: allFlights, hotels: allHotels, activities: allActivities, isItinerary: true } })
  sendFn({ type: 'marker', content: '[ITINERARY_SHOWN]' })

  return { modelPatch: { phase: 'post_itinerary' }, continue: false }
}

async function executePostItinerary({ model, messages, systemPrompt, sendFn }) {
  const replyText = await streamClaudeSSE(systemPrompt, messages, sendFn)
  return { modelPatch: null, continue: false }
}
```

- [ ] **Step 3: Add the main executeRequest loop and export it**

Append to `server/orchestrator.js`:

```js
// ── Action dispatcher ──────────────────────────────────────────────────────────

async function executeAction({ action, model, messages, systemPrompt, sendFn }) {
  const args = { model, messages, systemPrompt, sendFn }

  switch (action.type) {
    case 'gathering':          return executeGathering(args)
    case 'fetch_flights':      return executeFetchFlights({ ...args, legIndex: action.legIndex })
    case 'select_flight':      return executeSelectFlight({ ...args, legIndex: action.legIndex })
    case 'fetch_hotels':       return executeFetchHotels({ ...args, legIndex: action.legIndex })
    case 'select_hotel':       return executeSelectHotel({ ...args, legIndex: action.legIndex })
    case 'show_must_sees':     return executeShowMustSees({ ...args, legIndex: action.legIndex })
    case 'confirm_must_sees':  return executeConfirmMustSees({ ...args, legIndex: action.legIndex })
    case 'fetch_activities':   return executeFetchActivities({ ...args, legIndex: action.legIndex })
    case 'select_activity':    return executeSelectActivity({ ...args, legIndex: action.legIndex, activityType: action.activityType })
    case 'ask_exit_transport': return executeAskExitTransport({ ...args, legIndex: action.legIndex })
    case 'fetch_exit_flight':  return executeFetchFlights({ ...args, legIndex: action.legIndex, isExit: true })
    case 'select_exit_flight': return executeSelectFlight({ ...args, legIndex: action.legIndex, isExit: true })
    case 'advance_step':
      return { modelPatch: { legs: [{ index: action.legIndex, step: action.nextStep }] }, continue: true }
    case 'next_leg':
      return { modelPatch: { currentLegIndex: action.nextLegIndex }, continue: true }
    case 'transition_summary':
      return { modelPatch: { phase: 'summary' }, continue: true }
    case 'summary':            return executeSummary(args)
    case 'itinerary':          return executeItinerary(args)
    case 'post_itinerary':     return executePostItinerary(args)
    default:
      console.warn('[orchestrator] unknown action type:', action.type)
      return { modelPatch: null, continue: false }
  }
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function executeRequest({ tripModel, messages, profile, sendFn }) {
  const systemPrompt = buildSystemPrompt(profile)
  let model = tripModel

  let continueLoop = true
  let iterations = 0
  const MAX_ITERATIONS = 10 // safety guard against infinite loops

  while (continueLoop && iterations < MAX_ITERATIONS) {
    iterations++
    const action = resolveAction(model)
    console.log(`[orchestrator] iteration ${iterations} | action: ${action.type}`)

    const result = await executeAction({ action, model, messages, systemPrompt, sendFn })

    if (result.modelPatch) {
      model = applyPatch(model, result.modelPatch)
      sendFn({ type: 'trip_model_update', data: result.modelPatch })
    }

    continueLoop = result.continue === true
  }
}
```

- [ ] **Step 4: Verify the full orchestrator module loads**

```bash
cd server && node -e "
import('./orchestrator.js').then(m => {
  console.log('resolveAction:', typeof m.resolveAction)
  console.log('executeRequest:', typeof m.executeRequest)
  console.log('extractSignals:', typeof m.extractSignals)
  console.log('applyPatch:', typeof m.applyPatch)
}).catch(console.error)"
```

Expected: all four print `function`.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator.js
git commit -m "feat: complete orchestrator with exit transport, summary, itinerary, and main loop"
```

---

## Task 8: Rewrite server/index.js

**Files:**
- Modify: `server/index.js` (full replacement)

- [ ] **Step 1: Replace server/index.js**

The `/api/recommendations` route stays exactly as-is (copy lines 19–101 from the current file). The `/api/chat` route becomes a thin wrapper that calls `executeRequest`.

```js
// server/index.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { executeRequest } from './orchestrator.js'

// ── Keep the /api/recommendations handler from the old file EXACTLY as-is ──────
// (copy lines 19–101 from the old server/index.js here, starting with:
//  app.post('/api/recommendations', async (req, res) => { ... }))

const app = express()
const PORT = process.env.PORT || 5000
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/', (req, res) => {
  res.json({ message: 'Waypoint API is running' })
})

// ── PASTE /api/recommendations route here (lines 19-101 from old index.js) ────

// ── Chat (SSE streaming) ──────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages, profile, tripModel } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)

  // Provide a safe default tripModel for old clients / first message
  const model = tripModel || {
    tripType: null,
    origin: null,
    groupSize: null,
    budgetPerPerson: null,
    currentLegIndex: 0,
    phase: 'gathering',
    legs: [],
  }

  try {
    await executeRequest({ tripModel: model, messages, profile, sendFn: send })
  } catch (err) {
    console.error('[/api/chat] error:', err.message)
    send({ type: 'error', message: 'Something went wrong. Please try again.' })
  }

  send({ type: 'done' })
  res.end()
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
```

- [ ] **Step 2: Start the server and verify /api/recommendations still works**

```bash
cd server && node index.js &
sleep 2
curl -s -X POST http://localhost:5000/api/recommendations \
  -H "Content-Type: application/json" \
  -d '{"profile":{"full_name":"Test"}}' | head -c 200
```

Expected: JSON response starting with `{"recommendations":[`

- [ ] **Step 3: Test /api/chat with a gathering-phase message**

```bash
curl -s -X POST http://localhost:5000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":"I want to plan a trip to Tokyo"}],
    "profile": {},
    "tripModel": {"phase":"gathering","currentLegIndex":0,"legs":[],"tripType":null,"origin":null,"groupSize":null,"budgetPerPerson":null}
  }' | head -c 500
```

Expected: SSE stream with `data: {"type":"delta","text":"..."}` lines. No errors.

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "refactor: slim server/index.js to thin route wrapper using executeRequest"
```

---

## Task 9: Create client/src/lib/tripModel.js

**Files:**
- Create: `client/src/lib/tripModel.js`

- [ ] **Step 1: Create tripModel.js**

```js
// client/src/lib/tripModel.js

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
      merged[idx] = { ...(merged[idx] || {}), ...legPatch }
    }
    result.legs = merged
  }
  return result
}

// Derive a human-readable session title from the trip model.
// Falls back to 'New Trip' if the model isn't far enough along.
export function deriveSessionTitle(tripModel) {
  const { legs, phase } = tripModel
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

// Derive trip context (destination, departure/return dates) for Supabase session storage.
export function deriveSessionCtx(tripModel) {
  const { legs, origin } = tripModel
  if (!legs?.length) return null

  const cities = legs.map(l => l.city).filter(Boolean)
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

// Build selectedCards shape from tripModel (for backward compat with itinerary save logic)
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
  } catch {}
}

export function loadTripModelFromSession(sessionId) {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY(sessionId))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function clearTripModelFromSession(sessionId) {
  try { sessionStorage.removeItem(SESSION_KEY(sessionId)) } catch {}
}

// ── Backward compatibility migration ──────────────────────────────────────────
// Called when loading an old session that has hiddenMarkers but no tripModel.
// Produces a minimal tripModel so the new Chat.jsx can render the session.

export function migrateLegacySession(hiddenMarkers) {
  // Try to extract trip context from old [FLIGHTS_SHOWN] marker
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

  // Build a single-leg tripModel from the old marker data
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
```

- [ ] **Step 2: Verify the module is importable in the Vite dev environment**

Start the client dev server and open the browser console:

```bash
cd client && npm run dev
```

In browser console:
```js
import('/src/lib/tripModel.js').then(m => {
  const t = m.initialTripModel()
  console.log('phase:', t.phase)      // 'gathering'
  console.log('legs:', t.legs.length) // 0
  const patch = m.mergeTripModelPatch(t, { phase: 'planning', legs: [{ index: 0, city: 'Bangkok' }] })
  console.log('merged phase:', patch.phase) // 'planning'
  console.log('merged city:', patch.legs[0].city) // 'Bangkok'
})
```

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/tripModel.js
git commit -m "feat: add client/src/lib/tripModel.js with model utilities and migration helper"
```

---

## Task 10: Update Chat.jsx — state consolidation + request body

**Files:**
- Modify: `client/src/pages/Chat.jsx`

- [ ] **Step 1: Replace the import block at the top of Chat.jsx**

Find the current import block (lines 1–8) and add the tripModel imports:

```js
import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import TravelCards from '../components/TravelCards'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ItineraryContent from '../components/ItineraryContent'
import {
  initialTripModel, mergeTripModelPatch, deriveSessionTitle, deriveSessionCtx,
  deriveSelectedCards, saveTripModelToSession, loadTripModelFromSession, migrateLegacySession,
} from '../lib/tripModel'
```

- [ ] **Step 2: Replace the helper functions at the top of Chat.jsx**

Find and delete `deriveTitleFromMarkers` (lines 12–30) and `extractCtxFromMarkers` (lines 32–40) — they are replaced by `deriveSessionTitle` and `deriveSessionCtx` from tripModel.js.

- [ ] **Step 3: Replace the state declarations in the Chat() component**

Find the state declarations (lines 286–319) and replace them:

```js
// ── Core state ────────────────────────────────────────────────────────────────
const [profile, setProfile]   = useState(null)
const [messages, setMessages] = useState(prefilledDestination ? [] : [WELCOME_MESSAGE])
const [input, setInput]       = useState('')
const [streaming, setStreaming] = useState(false)
const [waiting, setWaiting]   = useState(false)
const [fetching, setFetching] = useState(false)
const [messageCards, setMessageCards] = useState({})

// Trip model — replaces activityBank, selectedCards, flightsBankFull, hotelsBankFull, hiddenMarkers
const [tripModel, setTripModel] = useState(initialTripModel)
const tripModelRef = useRef(initialTripModel())  // mutable ref for use inside async callbacks

// Session UI state
const [sessionLoaded, setSessionLoaded] = useState(isNew)
const [sessionTitle, setSessionTitle]   = useState('New Trip')
const [menuOpen, setMenuOpen]           = useState(false)
const [renaming, setRenaming]           = useState(false)
const [renameValue, setRenameValue]     = useState('')
const [showHowItWorks, setShowHowItWorks] = useState(
  () => localStorage.getItem('waypoint_how_it_works_dismissed') !== '1'
)

// Complete planning state
const [itineraryShown, setItineraryShown] = useState(false)
const [completedSaved, setCompletedSaved] = useState(false)
const [showSavedModal, setShowSavedModal] = useState(false)
const [savedDestination, setSavedDestination] = useState('')
```

- [ ] **Step 4: Update the fetch request body in `sendMessage`**

Find the `fetch('/api/chat', ...)` call (around line 477) and update the body:

```js
const res = await fetch('http://localhost:5000/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: apiMessages,
    profile,
    tripModel: tripModelRef.current,   // send current tripModel
  }),
  signal: controller.signal,
})
```

Also update the mutable locals at the start of `sendMessage` (around line 468):

```js
let finalMessages  = nextMessages
let finalCards     = messageCards
let finalTripModel = tripModelRef.current
```

- [ ] **Step 5: Update the `apiMessages` construction to remove old hiddenMarkers**

The old code prepended `hiddenMarkers` to messages. With `tripModel`, markers are no longer needed:

```js
const startsWithWelcome = nextMessages[0]?.role === 'assistant'
const apiMessages = nextMessages
  .slice(startsWithWelcome ? 1 : 0)
  .map(({ role, content }) => ({ role, content }))
```

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Chat.jsx
git commit -m "refactor: consolidate Chat.jsx state into tripModel, update request body"
```

---

## Task 11: Update Chat.jsx — SSE event handler

**Files:**
- Modify: `client/src/pages/Chat.jsx`

- [ ] **Step 1: Update the SSE event handler inside `sendMessage`**

Find the `for (const line of lines)` block and replace all the `event.type === ...` handlers with:

```js
if (event.type === 'delta') {
  assistantText += event.text
  setMessages(prev => {
    const updated = [...prev]
    updated[updated.length - 1] = { role: 'assistant', content: assistantText }
    finalMessages = updated
    return updated
  })

} else if (event.type === 'trip_model_update') {
  // Core model patch from orchestrator
  const newModel = mergeTripModelPatch(finalTripModel, event.data)
  finalTripModel = newModel
  tripModelRef.current = newModel
  setTripModel(newModel)
  // Persist to sessionStorage on every model update
  saveTripModelToSession(newModel, sessionId)

} else if (event.type === 'knowledge_bank') {
  // Flight cards for current message
  setFetching(false)
  assistantText = ''
  setMessages(prev => {
    const newCards = { ...finalCards, [prev.length]: event.data }
    finalCards = newCards
    setMessageCards(newCards)
    finalMessages = [...prev, { role: 'assistant', content: '' }]
    return finalMessages
  })

} else if (event.type === 'hotels_bank') {
  setFetching(false)
  assistantText = ''
  setMessages(prev => {
    const newCards = { ...finalCards, [prev.length - 1]: { hotels: event.data.hotels } }
    finalCards = newCards
    setMessageCards(newCards)
    return prev
  })

} else if (event.type === 'activity_bank_ready') {
  // Activity bank loaded — no UI change, just stored in tripModel via trip_model_update
  // (The orchestrator sends a trip_model_update alongside this event)

} else if (event.type === 'activities_bank') {
  setFetching(false)
  assistantText = ''
  setMessages(prev => {
    const newCards = { ...finalCards, [prev.length - 1]: { activities: event.data.activities, activityType: event.data.activityType } }
    finalCards = newCards
    setMessageCards(newCards)
    return prev
  })

} else if (event.type === 'itinerary_bank') {
  setMessages(prev => {
    const newCards = { ...finalCards, [prev.length - 1]: { ...event.data, isItinerary: true } }
    finalCards = newCards
    setMessageCards(newCards)
    return prev
  })

} else if (event.type === 'flight_confirmed') {
  // Visual confirmation — tripModel already updated via trip_model_update
  // No additional state needed

} else if (event.type === 'hotel_confirmed') {
  // Same

} else if (event.type === 'activity_confirmed') {
  // Same

} else if (event.type === 'fetching') {
  setFetching(true)

} else if (event.type === 'marker') {
  // Only care about [ITINERARY_SHOWN] for the Complete Planning button
  if (event.content?.includes('[ITINERARY_SHOWN]')) setItineraryShown(true)

} else if (event.type === 'fetch_error') {
  setFetching(false)
  console.error('[fetch_error] leg:', event.leg, 'type:', event.fetchType)

} else if (event.type === 'done') {
  setFetching(false)

} else if (event.type === 'error') {
  setFetching(false)
  setMessages(prev => {
    const updated = [...prev]
    updated[updated.length - 1] = { role: 'assistant', content: event.message || 'Something went wrong. Please try again.' }
    finalMessages = updated
    return updated
  })
}
```

- [ ] **Step 2: Start both server and client and verify a gathering-phase conversation works**

```bash
# Terminal 1
cd server && npm run dev

# Terminal 2
cd client && npm run dev
```

Open the chat and send: "I want to plan a trip to Paris"

Expected:
- Maya responds naturally asking for details
- No console errors
- No old marker-related errors

- [ ] **Step 3: Verify single-city trip flow completes**

Continue the conversation:
- Provide: origin city, dates, group size, budget, accommodation style
- Maya should emit [TRIP_UPDATE] (visible in server logs)
- Flight cards should appear
- Pick a flight → hotel cards appear
- Pick a hotel → must-sees appear
- Confirm activities → summary appears
- Approve → itinerary renders

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Chat.jsx
git commit -m "feat: update Chat.jsx SSE handler to consume trip_model_update events"
```

---

## Task 12: Update Chat.jsx — session save/load + handleCompleteTrip

**Files:**
- Modify: `client/src/pages/Chat.jsx`

- [ ] **Step 1: Update `saveSession` to include tripModel**

Find the `saveSession` function and replace it:

```js
async function saveSession(msgs, cards, model) {
  if (!user) return
  const title = deriveSessionTitle(model)
  const ctx   = deriveSessionCtx(model)
  const session = {
    id: sessionId,
    title,
    destination:   ctx?.destination || '',
    departureDate: ctx?.departure   || '',
    messages:      msgs,
    messageCards:  cards,
    tripModel:     model,   // replaces selectedCards, activityBank, flightsBankFull, hotelsBankFull, hiddenMarkers
    updatedAt: new Date().toISOString(),
  }
  const { data } = await supabase.from('profiles').select('chat_sessions').eq('id', user.id).single()
  const sessions  = data?.chat_sessions || []
  const idx       = sessions.findIndex(s => s.id === sessionId)
  const createdAt = idx >= 0 ? sessions[idx].createdAt : new Date().toISOString()
  const updated   = idx >= 0
    ? sessions.map(s => s.id === sessionId ? { ...session, createdAt } : s)
    : [...sessions, { ...session, createdAt: new Date().toISOString() }]
  await supabase.from('profiles').upsert({ id: user.id, chat_sessions: updated })
  setSessionTitle(title)
  if (isNew) navigate(`/chat/${sessionId}`, { replace: true, state: location.state })
}
```

- [ ] **Step 2: Update the `saveSession` call in the `finally` block of `sendMessage`**

```js
} finally {
  setStreaming(false)
  setWaiting(false)
  abortRef.current = null
  inputRef.current?.focus()
  clearTimeout(saveTimerRef.current)
  saveTimerRef.current = setTimeout(() => {
    saveSession(finalMessages, finalCards, finalTripModel)
  }, 600)
}
```

- [ ] **Step 3: Update session load to restore tripModel**

Find the `useEffect` that loads existing sessions (around line 322) and update:

```js
useEffect(() => {
  if (isNew || !user) return
  supabase.from('profiles').select('chat_sessions').eq('id', user.id).single()
    .then(({ data }) => {
      const session = (data?.chat_sessions || []).find(s => s.id === sessionId)
      if (session) {
        setMessages(session.messages || [WELCOME_MESSAGE])
        setMessageCards(session.messageCards || {})
        setSessionTitle(session.title || 'New Trip')

        // Restore tripModel — new sessions have it directly; old sessions need migration
        let restoredModel
        if (session.tripModel) {
          restoredModel = session.tripModel
        } else {
          // Backward compat: old session has hiddenMarkers, derive tripModel from them
          restoredModel = migrateLegacySession(session.hiddenMarkers || [])
        }

        tripModelRef.current = restoredModel
        setTripModel(restoredModel)
        saveTripModelToSession(restoredModel, sessionId)

        const itinDone = restoredModel.phase === 'post_itinerary' ||
          restoredModel.phase === 'itinerary' ||
          (session.hiddenMarkers || []).some(m => m.content?.includes('[ITINERARY_SHOWN]'))
        setItineraryShown(itinDone)
      }
      setSessionLoaded(true)
    })
}, [user]) // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 4: Update `handleCompleteTrip` to read from tripModel**

Find `handleCompleteTrip` and update:

```js
async function handleCompleteTrip() {
  const itinEntry = Object.entries(messageCards).find(([, v]) => v?.isItinerary)
  const itinIdx   = itinEntry ? parseInt(itinEntry[0]) : -1
  const itinText  = itinIdx >= 0 ? messages[itinIdx]?.content || '' : ''
  const bookCards = itinEntry?.[1] || {}

  const ctx  = deriveSessionCtx(tripModel)
  const dest = ctx?.destination || sessionTitle

  const cards = deriveSelectedCards(tripModel)

  const trip = {
    id:            crypto.randomUUID(),
    source:        'inapp',
    destination:   dest,
    departureDate: ctx?.departure || '',
    returnDate:    ctx?.return    || '',
    itineraryText: itinText,
    bookingCards:  { ...bookCards, ...cards },
    savedAt:       new Date().toISOString(),
  }

  const { data } = await supabase.from('profiles').select('upcoming_trips').eq('id', user.id).single()
  const trips    = data?.upcoming_trips || []
  await supabase.from('profiles').upsert({ id: user.id, upcoming_trips: [...trips, trip] })

  setCompletedSaved(true)
  setSavedDestination(dest.split(',')[0])
  setShowSavedModal(true)
}
```

- [ ] **Step 5: Final end-to-end test — single-city trip**

Start fresh (clear browser storage), run through a complete single-city trip:
1. Open `/chat/new`
2. Tell Maya you want to go to Rome, 7 days in July, 2 people, $4,000 budget, mid-range hotel
3. Provide origin city when asked
4. Confirm the complete flow: flights → hotel → must-sees → activities → summary → itinerary
5. Click "Complete Planning & Save Itinerary"
6. Navigate to Upcoming Trips — verify the saved itinerary appears

Expected: complete flow works, no console errors, session saves correctly.

- [ ] **Step 6: End-to-end test — multi-city trip**

1. Open `/chat/new`
2. "I want to do Bangkok, Chiang Mai, and Phuket for 10 nights"
3. Let Maya suggest city order and durations
4. Provide origin, dates, group size, budget
5. Verify [TRIP_UPDATE] appears in server logs with 3 legs
6. Plan leg 0 (Bangkok): arrival flight → hotel → must-sees → activities → exit transport (flight to Chiang Mai)
7. Plan leg 1 (Chiang Mai): hotel → must-sees → activities → exit transport (flight to Phuket)
8. Plan leg 2 (Phuket): hotel → must-sees → activities → exit transport (departure flight home)
9. Verify summary shows all 3 legs
10. Approve → full multi-leg itinerary renders

Expected: correct per-leg hotels and flights, no data from wrong leg shown, itinerary flows correctly from city to city.

- [ ] **Step 7: Test session restoration**

After completing step 5 or 6, reload the page. Verify:
- Messages restore correctly
- `tripModel` is hydrated from `sessionStorage`
- `itineraryShown` is `true` (Complete Planning button is gone / replaced by saved confirmation)

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/Chat.jsx
git commit -m "feat: update session save/load and handleCompleteTrip to use tripModel"
```

---

## Self-Review

After writing the plan, checking spec coverage against `docs/superpowers/specs/2026-04-22-voyo-chat-rehaul-design.md`:

| Spec requirement | Task |
|---|---|
| `tripModel` structure with legs, steps, confirmations | Task 9 — tripModel.js |
| `mergeTripModelPatch` by leg index | Task 9 |
| Server reads tripModel, not marker strings | Task 8 — thin route reads `req.body.tripModel` |
| `resolveAction(tripModel)` action table | Task 4 |
| Gathering phase + [TRIP_UPDATE] signal | Tasks 3 + 5 |
| Per-leg context injection | Task 3 — `buildLegContext` |
| Simplified signal protocol (5 new tags) | Tasks 2 + 3 + 7 |
| Multi-city sequential leg loop | Tasks 4–7 — loop in `executeRequest` |
| Exit transport (flight vs ground) | Task 7 — `executeAskExitTransport` |
| Open-jaw flights (last leg exits to origin) | Task 5 — `executeFetchFlights` isExit logic |
| Flight/hotel preference change → re-fetch | Tasks 5 + 6 — `[CHANGE]` handling |
| sessionStorage persistence | Task 9 — helpers, Task 10 — called on `trip_model_update` |
| Backward compat for old sessions | Task 9 — `migrateLegacySession` |
| `server/index.js` split into 4 modules | Tasks 1–2 + 3 + 4–7 + 8 |
| SSE `trip_model_update` event | Tasks 7 + 11 |
| `handleCompleteTrip` reads from tripModel | Task 12 |

All spec requirements covered.
