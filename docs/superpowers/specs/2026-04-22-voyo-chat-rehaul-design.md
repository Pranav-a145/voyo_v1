# VOYO Chat Feature Rehaul — Design Spec
**Date:** 2026-04-22  
**Status:** Approved  
**Scope:** Chat intelligence, server-side fetch orchestration, trip-building logic  
**Out of scope:** UI components, auth, Supabase schema, saved itineraries, booking cards

---

## Problem Summary

The current chat architecture is built for single-destination trips with a fixed 7-variable collection flow. It fails in real usage because:

1. Trip state is tracked by scanning raw message text for marker strings (`[FLIGHTS_SHOWN]`, `[FLIGHT_CONFIRMED]`, etc.) — fragile and unextendable
2. Multi-city trips are treated as one destination string — no concept of legs
3. Variable changes (group size, dates, destination) don't reliably trigger re-fetches
4. Claude emits a large `[TOOL_CALL]` JSON block with the full trip payload — frequently malformed
5. `server/index.js` is 1,650 lines of nested `if` blocks tied to boolean flags — unmaintainable

---

## Architecture Overview

**Option chosen: Structured Trip Model + Leg Orchestrator**

- The client holds a `tripModel` object (array of legs, each with its own step, fetched data, confirmations)
- The client sends `tripModel` with every request; the server treats it as the authoritative source of truth
- The server's stage machine is replaced by a single `resolveAction(tripModel)` function that reads `currentLegIndex` and `currentLeg.step`
- Claude emits lightweight signals (5 short tag types) instead of full JSON payloads
- Single-city trips use the same code path — the leg loop runs once

---

## 1. Trip Model

The single source of truth. Replaces all marker-based state. Lives on the client, sent with every request.

```js
{
  tripType: 'single' | 'multi',
  origin: 'New York, USA',
  groupSize: 2,
  budgetPerPerson: 3000,
  currentLegIndex: 0,
  phase: 'gathering' | 'planning' | 'summary' | 'itinerary',

  legs: [
    {
      index: 0,
      city: 'Bangkok, Thailand',
      arrivalDate: '2026-11-10',
      departureDate: '2026-11-14',
      durationNights: 4,
      hotelStyle: 'boutique luxury',
      activityPreferences: ['food', 'culture', 'nightlife'],

      // Fetched data (null until fetched)
      flightsBank: [],
      hotelsBank: [],
      activitiesBank: { types: [], byType: {} },

      // Confirmations
      confirmedFlight: null,       // { id, airline, price, ... }
      confirmedHotel: null,        // { id, name, price, ... }
      confirmedActivities: [],
      mustSees: [],

      // Transport to next leg (null on last leg)
      exitTransport: {
        type: 'flight' | 'train' | 'bus' | 'ferry' | null,
        fetchNeeded: true,
        flightsBank: [],
        confirmedFlight: null,
      },

      // Current step within this leg
      step: 'arrival_flight' | 'hotel' | 'must_sees' | 'activities'
            | 'exit_transport' | 'complete',
    }
  ]
}
```

**Key invariants:**
- `legs` always has at least 1 entry
- `legs[last].exitTransport` is the departure flight home (e.g. HKT→JFK) — `exitTransport` is never null; on the last leg it always points back to `origin`
- When `tripType: 'single'`, the model has exactly 1 leg and behaves identically to the old architecture from the user's perspective

---

## 2. Server Orchestrator

`server/index.js` is split into focused modules:

```
server/
  index.js          — Express setup + /api/chat route (~50 lines)
  orchestrator.js   — resolveAction() + leg loop execution (~300 lines)
  fetchers.js       — fetchFlights, fetchHotels, fetchActivities (~200 lines)
  prompts.js        — buildSystemPrompt, per-leg context injection (~200 lines)
  streaming.js      — streamClaude, streamClaudeSSE, SSE helpers (~150 lines)
```

### resolveAction(tripModel)

Returns one action descriptor based on model state. The entire stage machine:

| `phase`     | `currentLeg.step`  | Action                                      |
|-------------|--------------------|---------------------------------------------|
| `gathering` | —                  | Stream Claude (collect trip shape)          |
| `planning`  | `arrival_flight`   | Fetch flights → stream presentation         |
| `planning`  | `hotel`            | Fetch hotels → stream presentation          |
| `planning`  | `must_sees`        | Stream must-sees from Claude knowledge      |
| `planning`  | `activities`       | Fetch activities → stream per-type          |
| `planning`  | `exit_transport`   | If flight → fetch; else → Claude general knowledge |
| `planning`  | `complete`         | Advance `currentLegIndex`, start next leg   |
| `summary`   | —                  | Stream pre-itinerary summary                |
| `itinerary` | —                  | Stream full day-by-day itinerary            |

### SSE events sent back to client

```js
{ type: 'delta', text: '...' }                    // streaming text chunk
{ type: 'trip_model_update', data: { ... } }      // model patch to merge
{ type: 'fetching' }                               // show loading skeleton
{ type: 'fetch_error', leg: 0, fetchType: '...' } // fetch failed
{ type: 'done' }                                   // stream complete
```

The client merges `trip_model_update` patches with a deep merge where the `legs` array is merged by `index` field (not by array position), so a patch containing only `legs[1]` doesn't overwrite `legs[0]`.

### What the server reads from tripModel (not message history)

- Current leg index and step → what action to take
- `legs[n].city`, `legs[n].arrivalDate`, `legs[n].departureDate` → fetch parameters
- `legs[n].hotelStyle` → hotel search query modifier
- `legs[n].activityPreferences` → activity fetch types
- `origin`, `groupSize` → flight and hotel fetch parameters

The server **never** scans message text for marker strings. Trip context is always read from the structured model.

---

## 3. Claude Signal Protocol

Replaces the current `[TOOL_CALL]` / `[STATE]` protocol.

### Out (removed)
- `[TOOL_CALL]{80-field JSON}[/TOOL_CALL]` — Claude had to compose the full fetch payload
- `[STATE]{full trip state every turn}[/STATE]` — emitted on every response, leaked into UI

### In (new signals)

| Signal | When emitted | Shape |
|--------|-------------|-------|
| `[TRIP_UPDATE]` | End of gathering phase, or when trip shape changes (city added/removed) | `{"tripType":"multi","legs":[{...}]}` |
| `[FETCH]` | When data is needed | `{"leg":0,"types":["flights"]}` |
| `[ADVANCE]` | Move to next step | `{"leg":0,"step":"hotel"}` |
| `[CONFIRM]` | Lock a selection | `{"leg":0,"type":"flight","id":"flight_2"}` |
| `[CHANGE]` | Variable changed mid-trip | `{"leg":0,"field":"durationNights","value":5}` |

Claude never emits full trip state. The client holds state; Claude only signals changes and actions.

---

## 4. Maya's Prompt Changes

### Gathering Phase (new)

Maya starts in `phase: 'gathering'`. Her gathering goals:
- Detect single vs multi-city trip from the user's first messages
- For multi-city: help user decide on city order ("Given you're flying into Bangkok, Chiang Mai → Phuket makes more geographic sense"), suggest durations per city if unsure
- Collect origin, group size, budget, and travel dates once (not per leg)
- When the full trip shape is clear, emit `[TRIP_UPDATE]` with all legs scaffolded, then `[FETCH]{"leg":0,"types":["flights"]}` to begin planning

### Per-Leg Context Injection

The server prepends current leg context to every Claude call during the planning phase:

```
CURRENT LEG: Leg 1 of 3 — Bangkok, Thailand
Arrival: Nov 10 | Departure: Nov 14 (4 nights)
Hotel style: boutique luxury
Activity preferences: food, culture, nightlife
Current step: hotel selection
Confirmed flight: Thai Airways JFK→BKK Nov 10, $980pp

UPCOMING LEGS:
- Leg 2: Chiang Mai, 3 nights, mountain villa
- Leg 3: Phuket, 4 nights, beach resort
```

Maya always knows where she is in the trip. She doesn't infer it from conversation history.

### Confirmation signals (unchanged)
`[FLIGHT_CONFIRMED]`, `[HOTEL_CONFIRMED]`, `[MUST_SEES_CONFIRMED]`, `[ACTIVITY_OK]`, `[ITINERARY_CONFIRMED]` — these are preserved. The server reads them to advance steps and update the model.

---

## 5. Client-Side Changes

### State consolidation

**Before:** ~15 separate `useState` hooks (`flightsBank`, `hotelsBank`, `activityBank`, `selectedCards`, `markers`, etc.)

**After:** One object:
```js
const [tripModel, setTripModel] = useState(initialTripModel)
```

TravelCards and other UI components receive the same data shapes they currently expect — the client reads from `tripModel.legs[currentLegIndex].flightsBank` instead of a flat `flightsBank` state variable.

### Session persistence

`tripModel` is written to `sessionStorage` on every update. On page load, the client hydrates from `sessionStorage` if present. This eliminates the current "activityBank lost on refresh" edge case.

### Request shape

```js
fetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({ messages, profile, tripModel })
})
```

`selectedCards`, `flightsBank`, `hotelsBank`, `activityBank` are no longer sent as separate top-level fields — everything is in `tripModel`.

---

## 6. Multi-City Flow (Thailand Example)

**Gathering phase:**
1. User: "I want to do Bangkok, Chiang Mai, and Phuket"
2. Maya: detects 3 cities, asks about order and rough duration per city, confirms budget/group/dates
3. Maya suggests: Bangkok first (international arrival), then Chiang Mai, then Phuket (international departure)
4. Maya emits `[TRIP_UPDATE]` with 3 legs scaffolded, then `[FETCH]{"leg":0,"types":["flights"]}`

**Planning loop — Leg 0 (Bangkok):**
- Step `arrival_flight`: fetch JFK→BKK, present 3 options, confirm
- Step `hotel`: fetch Bangkok hotels with user's preferred style, present 3, confirm
- Step `must_sees`: Maya presents Bangkok Icons + Hidden Gems from knowledge
- Step `activities`: fetch per activity type, confirm sequentially
- Step `exit_transport`: Maya asks "Bangkok → Chiang Mai — flight (~1hr) or overnight train?" User picks. If flight: `[FETCH]{"leg":0,"types":["exit_flight"]}`, present options, confirm

**Advance to Leg 1 (Chiang Mai):**
- Step `arrival_flight`: already confirmed (the BKK→CNX flight from Leg 0's exitTransport)
- Step `hotel`: fetch Chiang Mai hotels, present, confirm
- Step `must_sees` → `activities` → `exit_transport` (CNX→HKT flight)

**Advance to Leg 2 (Phuket):**
- Same pattern
- Step `exit_transport`: fetch departure flight HKT→JFK (last leg, exits to origin), present, confirm
- Step `complete`: advance to `phase: 'summary'`

**Summary → Itinerary:**
- Pre-itinerary summary shows all 3 legs, all confirmed selections
- User approves → Maya builds full multi-leg day-by-day itinerary

---

## 7. Edge Cases

| Scenario | Handling |
|----------|----------|
| User adds a city mid-planning | Maya emits `[TRIP_UPDATE]` inserting new leg; loop continues |
| Open-jaw flights | Natural: leg[0] fetches origin→city[0], last leg fetches city[last]→origin |
| Ground transport between legs | `exitTransport.fetchNeeded: false`; Maya advises from knowledge |
| Variable change mid-trip | `[CHANGE]` signal; server patches model and clears stale banks on affected legs |
| Complete destination change | `[TRIP_UPDATE]` with full legs reset; currentLegIndex resets to 0 |
| Fetch failure | `fetch_error` SSE event; Maya acknowledges and offers retry |
| Page refresh mid-session | tripModel hydrated from sessionStorage; no state lost |
| Single-city trip | 1 leg in model; identical UX to current; multi-leg code paths never execute |

---

## 8. What Is Not Changing

- All React UI components (TravelCards, ItineraryContent, AppSidebar, etc.)
- Supabase auth and profile system
- Saved itineraries and upcoming trips pages
- SSE streaming infrastructure (streamClaudeSSE function)
- Maya's personality, tone, and conversation style
- The sequential flight → hotel → must-sees → activities → summary → itinerary user flow
- SerpAPI integration (fetchFlights, fetchHotels, fetchActivities functions move to fetchers.js unchanged)
- Pexels image integration
- The confirmation signal set ([FLIGHT_CONFIRMED], [HOTEL_CONFIRMED], etc.)
