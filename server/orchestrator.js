import 'dotenv/config';
import { fetchFlights, fetchHotels, fetchActivities, sortFlightPoolByPreference, sortHotelPoolByStyle, hotelStyleQuery } from './fetchers.js';
import { streamClaude, streamClaudeSSE, extractAndStripBlocks } from './streaming.js';
import { buildSystemPrompt, buildLegContext } from './prompts.js';

// ── Signal extraction ──────────────────────────────────────────────────────────

export function extractSignals(text) {
  const signals = {};

  const tripUpdateM = text.match(/\[TRIP_UPDATE\]([\s\S]*?)\[\/TRIP_UPDATE\]/);
  if (tripUpdateM) { try { signals.tripUpdate = JSON.parse(tripUpdateM[1].trim()); } catch {} }

  const confirmM = text.match(/\[CONFIRM\]([\s\S]*?)\[\/CONFIRM\]/);
  if (confirmM) { try { signals.confirm = JSON.parse(confirmM[1].trim()); } catch {} }

  const changeM = text.match(/\[CHANGE\]([\s\S]*?)\[\/CHANGE\]/);
  if (changeM) { try { signals.change = JSON.parse(changeM[1].trim()); } catch {} }

  signals.flightConfirmed    = text.includes('[FLIGHT_CONFIRMED]');
  signals.hotelConfirmed     = text.includes('[HOTEL_CONFIRMED]');
  signals.mustSeesConfirmed  = text.includes('[MUST_SEES_CONFIRMED]');
  signals.activityOk         = text.includes('[ACTIVITY_OK]');
  signals.activityMore       = text.includes('[ACTIVITY_MORE]');
  signals.activitySkip       = text.includes('[ACTIVITY_SKIP]');
  signals.itineraryConfirmed = text.includes('[ITINERARY_CONFIRMED]');

  const actSelM = text.match(/\[ACTIVITY_SELECTED\]([\s\S]*?)\[\/ACTIVITY_SELECTED\]/);
  if (actSelM) { try { signals.activitySelected = JSON.parse(actSelM[1].trim()); } catch {} }

  return signals;
}

// ── Trip model helpers ─────────────────────────────────────────────────────────

export function applyPatch(model, patch) {
  const result = { ...model, ...patch };
  if (patch.legs) {
    const merged = [...(model.legs || [])];
    for (const legPatch of patch.legs) {
      const idx = legPatch.index;
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) continue;
      merged[idx] = { ...(merged[idx] || {}), ...legPatch };
    }
    result.legs = merged;
  }
  return result;
}

function getCurrentLeg(model) {
  return model.legs[model.currentLegIndex];
}

function findPendingActivityType(leg) {
  if (!leg.activitiesBank?.types?.length) return null;
  const confirmed = new Set((leg.confirmedActivities || []).map(a => a.activityType));
  const shown     = new Set(Object.keys(leg.shownActivityOffsets || {}));
  const pending = leg.activitiesBank.types.find(t => shown.has(t) && !confirmed.has(t));
  if (pending) return pending;
  return leg.activitiesBank.types.find(t => !shown.has(t) && !confirmed.has(t)) || null;
}

// ── Action resolver ────────────────────────────────────────────────────────────

export function resolveAction(model) {
  const { phase, currentLegIndex, legs } = model;

  if (phase === 'gathering')      return { type: 'gathering' };
  if (phase === 'summary')        return { type: 'summary' };
  if (phase === 'itinerary')      return { type: 'itinerary' };
  if (phase === 'post_itinerary') return { type: 'post_itinerary' };

  if (phase !== 'planning') {
    console.warn(`[resolveAction] unrecognized phase: "${phase}"`);
    return { type: 'gathering' };
  }

  const leg = legs?.[currentLegIndex];
  if (!leg) return { type: 'gathering' };

  switch (leg.step) {
    case 'arrival_flight':
      if (!leg.flightsBank?.length)  return { type: 'fetch_flights',  legIndex: currentLegIndex };
      if (!leg.confirmedFlight)      return { type: 'select_flight',  legIndex: currentLegIndex };
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'hotel' };

    case 'hotel':
      if (!leg.hotelsBank?.length)   return { type: 'fetch_hotels',   legIndex: currentLegIndex };
      if (!leg.confirmedHotel)       return { type: 'select_hotel',   legIndex: currentLegIndex };
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'must_sees' };

    case 'must_sees':
      if (!leg.mustSeesShown)        return { type: 'show_must_sees',    legIndex: currentLegIndex };
      if (!leg.mustSeesConfirmed)    return { type: 'confirm_must_sees', legIndex: currentLegIndex };
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'activities' };

    case 'activities': {
      if (!leg.activitiesBank?.types?.length) return { type: 'fetch_activities', legIndex: currentLegIndex };
      const pendingType = findPendingActivityType(leg);
      if (pendingType) return { type: 'select_activity', legIndex: currentLegIndex, activityType: pendingType };
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'exit_transport' };
    }

    case 'exit_transport':
      if (!leg.exitTransport?.type)
        return { type: 'ask_exit_transport',  legIndex: currentLegIndex };
      if (leg.exitTransport.type === 'flight' && !leg.exitTransport.flightsBank?.length)
        return { type: 'fetch_exit_flight',   legIndex: currentLegIndex };
      if (leg.exitTransport.type === 'flight' && !leg.exitTransport.confirmedFlight)
        return { type: 'select_exit_flight',  legIndex: currentLegIndex };
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'complete' };

    case 'complete':
      if (currentLegIndex + 1 < legs.length) return { type: 'next_leg', nextLegIndex: currentLegIndex + 1 };
      return { type: 'transition_summary' };

    default:
      return { type: 'gathering' };
  }
}

// ── Gathering phase executor ───────────────────────────────────────────────────

async function executeGathering({ model, messages, systemPrompt, sendFn }) {
  const fullText = await streamClaudeSSE(systemPrompt, messages, sendFn);
  const signals = extractSignals(fullText);

  if (!signals.tripUpdate) {
    return { modelPatch: null, continue: false };
  }

  const { tripType, origin, groupSize, budgetPerPerson, legs } = signals.tripUpdate;
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
  }));

  const modelPatch = {
    tripType: tripType || 'single',
    origin: origin || model.origin,
    groupSize: groupSize || model.groupSize,
    budgetPerPerson: budgetPerPerson || model.budgetPerPerson,
    phase: 'planning',
    currentLegIndex: 0,
    legs: initialLegs,
  };

  console.log('[gathering] trip scaffolded:', tripType, initialLegs.length, 'legs');
  return { modelPatch, continue: true };
}

// ── Flight time formatter ──────────────────────────────────────────────────────

function formatTime(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(' ');
  if (parts.length < 2) return null;
  const [h, m] = parts[1].split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const ampm = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')}${ampm}`;
}

// ── Fetch flights for a leg ────────────────────────────────────────────────────

async function executeFetchFlights({ model, messages, systemPrompt, sendFn, legIndex, isExit = false }) {
  const leg = model.legs[legIndex];
  sendFn({ type: 'fetching' });

  const origin      = isExit ? leg.city : model.origin;
  const destination = isExit ? (model.legs[legIndex + 1]?.city || model.origin) : leg.city;
  const depDate     = isExit ? leg.departureDate : leg.arrivalDate;
  const lastLeg     = model.legs.at(-1);
  const retDate     = lastLeg?.departureDate ?? null;

  console.log(`[fetch_flights] leg ${legIndex} | ${origin} → ${destination} | ${depDate}`);

  const flightsRaw = await fetchFlights(origin, destination, depDate, retDate, model.groupSize || 1)
    .catch(e => { console.error('[fetch_flights] error:', e.message); return []; });

  const preference = isExit ? leg.exitTransport?.flightPreference : leg.flightPreference;
  const sorted = preference ? sortFlightPoolByPreference(flightsRaw, preference) : flightsRaw;
  const flights = sorted.map((f, i) => ({ ...f, id: isExit ? `exit_flight_${legIndex}_${i}` : `flight_${legIndex}_${i}` }));

  const selText = await streamClaude(systemPrompt, [
    ...messages,
    { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nDo not respond to the user yet. Output only [SELECTED_FLIGHTS]{"ids":["id1","id2","id3"]}[/SELECTED_FLIGHTS] picking the top 3. Nothing else.` },
  ]);

  let flightCards = flights.slice(0, 3);
  const selM = selText.match(/\[SELECTED_FLIGHTS\]([\s\S]*?)\[\/SELECTED_FLIGHTS\]/);
  if (selM) {
    try {
      const { ids } = JSON.parse(selM[1].trim());
      const idMap = Object.fromEntries(flights.map(f => [f.id, f]));
      const ordered = ids.map(id => idMap[id]).filter(Boolean);
      if (ordered.length > 0) flightCards = ordered;
    } catch {}
  }

  const flightCardsReadable = flightCards.map(f => ({
    ...f, human_readable_departure: formatTime(f.departure_time), human_readable_arrival: formatTime(f.arrival_time),
  }));

  const legContext = buildLegContext(model);
  await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'assistant', content: isExit ? `Let me find the best options to get you from ${leg.city.split(',')[0]} to ${destination.split(',')[0]}.` : "Let me pull up the best flights for you!" },
      { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights: flightCardsReadable }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[FLIGHTS_SHOWN]\n\nPresent ONLY these 3 flights using their exact details. Ask which one they prefer.` },
    ],
    sendFn
  );

  const modelPatch = isExit
    ? { legs: [{ index: legIndex, exitTransport: { ...leg.exitTransport, flightsBank: flights, shownFlights: flightCards } }] }
    : { legs: [{ index: legIndex, flightsBank: flights, shownFlights: flightCards }] };

  sendFn({ type: 'knowledge_bank', data: { flights: flightCards, hotels: [], activities: [], flightsBankFull: flights } });
  return { modelPatch, continue: false };
}

// ── Select flight (user is choosing) ──────────────────────────────────────────

async function executeSelectFlight({ model, messages, systemPrompt, sendFn, legIndex, isExit = false }) {
  const leg = model.legs[legIndex];
  const bank = isExit ? (leg.exitTransport?.flightsBank || []) : (leg.flightsBank || []);
  const shown = isExit ? (leg.exitTransport?.shownFlights || bank.slice(0, 3)) : (leg.shownFlights || bank.slice(0, 3));
  const flightOptions = shown.map(f => `${f.id}: ${f.airline} $${f.price}`).join(' | ');

  const legContext = buildLegContext(model);
  // Non-streaming: we need the full text to extract [CONFIRM]/[CHANGE] signals before acting
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[FLIGHT_STAGE] The traveler has been shown these flight options: ${flightOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one — acknowledge it warmly, emit [CONFIRM]{"leg":${legIndex},"type":"${isExit ? 'exit_flight' : 'flight'}","id":"<exact_id>"}[/CONFIRM], emit [FLIGHT_CONFIRMED].\n- If they want DIFFERENT or MORE flights — emit [CHANGE]{"leg":${legIndex},"field":"${isExit ? 'exitTransport.flightPreference' : 'flightPreference'}","value":"<their preference>"}[/CHANGE] and acknowledge.\n- If genuinely undecided, help them decide.` },
    ]
  );

  const signals = extractSignals(chatText);
  const { cleaned: chatCleaned } = extractAndStripBlocks(chatText);
  if (chatCleaned) sendFn({ type: 'delta', text: chatCleaned });

  if (signals.change && (signals.change.field === 'flightPreference' || signals.change.field === 'exitTransport.flightPreference')) {
    const pref = signals.change.value;
    const patch = isExit
      ? { legs: [{ index: legIndex, exitTransport: { ...leg.exitTransport, flightsBank: [], flightPreference: pref } }] }
      : { legs: [{ index: legIndex, flightsBank: [], flightPreference: pref }] };
    return { modelPatch: patch, continue: true };
  }

  const confirmedId = signals.confirm?.id || (signals.flightConfirmed ? shown[0]?.id : null);
  if (!confirmedId) return { modelPatch: null, continue: false };

  const confirmedFlight = bank.find(f => f.id === confirmedId) || shown[0];
  sendFn({ type: 'marker', content: '[FLIGHT_CONFIRMED]' });
  sendFn({ type: 'flight_confirmed', data: { flight: confirmedFlight } });

  const patch = isExit
    ? { legs: [{ index: legIndex, exitTransport: { ...leg.exitTransport, confirmedFlight } }] }
    : { legs: [{ index: legIndex, confirmedFlight, step: 'hotel' }] };

  console.log(`[select_flight] leg ${legIndex} confirmed: ${confirmedFlight?.airline}`);
  return { modelPatch: patch, continue: true };
}
