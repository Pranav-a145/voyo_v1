import 'dotenv/config';
import { fetchFlights, fetchHotels, fetchActivities, sortFlightPoolByPreference, sortHotelPoolByStyle, hotelStyleQuery } from './fetchers.js';
import { streamClaude, streamClaudeSSE, extractAndStripBlocks, anthropic } from './streaming.js';
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

// ── Fetch hotels for a leg ─────────────────────────────────────────────────────

async function executeFetchHotels({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex];
  sendFn({ type: 'fetching' });

  const hotelsRaw = await fetchHotels(
    leg.city, leg.arrivalDate, leg.departureDate,
    model.groupSize || 1, leg.hotelStyle
  ).catch(e => { console.error('[fetch_hotels] error:', e.message); return []; });

  const hotels = hotelsRaw.map((h, i) => ({ ...h, id: `hotel_${legIndex}_${i}` }));

  const selText = await streamClaude(systemPrompt, [
    ...messages,
    { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nOutput only [SELECTED_HOTELS]{"ids":["id1","id2","id3"]}[/SELECTED_HOTELS] picking the 3 best. Nothing else.` },
  ]);

  let hotelCards = hotels.slice(0, 3);
  const selM = selText.match(/\[SELECTED_HOTELS\]([\s\S]*?)\[\/SELECTED_HOTELS\]/);
  if (selM) {
    try {
      const { ids } = JSON.parse(selM[1].trim());
      const idMap = Object.fromEntries(hotels.map(h => [h.id, h]));
      const ordered = ids.map(id => idMap[id]).filter(Boolean);
      if (ordered.length > 0) hotelCards = ordered;
    } catch {}
  }

  const legContext = buildLegContext(model);
  await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'assistant', content: `Let me pull up the best hotels in ${leg.city.split(',')[0]} for you!` },
      { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels: hotelCards }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[HOTELS_SHOWN]\n\nPresent ONLY these 3 hotels using exact names and prices. Ask which they prefer.` },
    ],
    sendFn
  );

  sendFn({ type: 'hotels_bank', data: { hotels: hotelCards, hotelsBankFull: hotels } });
  return { modelPatch: { legs: [{ index: legIndex, hotelsBank: hotels, shownHotels: hotelCards }] }, continue: false };
}

// ── Select hotel (user is choosing) ───────────────────────────────────────────

async function executeSelectHotel({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex];
  const bank = leg.hotelsBank || [];
  const shown = leg.shownHotels || bank.slice(0, 3);
  const hotelOptions = shown.map(h => `${h.id}: ${h.name}`).join(' | ');

  const legContext = buildLegContext(model);
  // Non-streaming: need full text to extract [CONFIRM]/[CHANGE] signals before acting
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[HOTEL_STAGE] The traveler has been shown these hotel options: ${hotelOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one — acknowledge warmly, emit [CONFIRM]{"leg":${legIndex},"type":"hotel","id":"<exact_id>"}[/CONFIRM], emit [HOTEL_CONFIRMED].\n- If they want DIFFERENT options — emit [CHANGE]{"leg":${legIndex},"field":"hotelPreference","value":"<preference>"}[/CHANGE].\n- If they're changing GROUP SIZE — emit [CHANGE]{"leg":${legIndex},"field":"groupSize","value":<number>}[/CHANGE].\n- If genuinely undecided, help them decide.` },
    ]
  );

  const signals = extractSignals(chatText);
  const { cleaned: chatCleaned } = extractAndStripBlocks(chatText);
  if (chatCleaned) sendFn({ type: 'delta', text: chatCleaned });

  if (signals.change?.field === 'hotelPreference') {
    return { modelPatch: { legs: [{ index: legIndex, hotelsBank: [], hotelPreference: signals.change.value }] }, continue: true };
  }
  if (signals.change?.field === 'groupSize') {
    const newSize = parseInt(signals.change.value, 10);
    if (isNaN(newSize) || newSize < 1) return { modelPatch: null, continue: false };
    sendFn({ type: 'marker', content: `[GROUP_SIZE_UPDATE]{"passengers":${newSize}}` });
    return { modelPatch: { groupSize: newSize, legs: [{ index: legIndex, hotelsBank: [] }] }, continue: true };
  }

  const confirmedId = signals.confirm?.id || (signals.hotelConfirmed ? shown[0]?.id : null);
  if (!confirmedId) return { modelPatch: null, continue: false };

  const confirmedHotel = bank.find(h => h.id === confirmedId) || shown[0];
  sendFn({ type: 'marker', content: '[HOTEL_CONFIRMED]' });
  sendFn({ type: 'hotel_confirmed', data: { hotel: confirmedHotel } });

  // Ask about activity preferences before advancing to must_sees
  const updatedModel = { ...model, legs: model.legs.map((l, i) => i === legIndex ? { ...l, confirmedHotel } : l) };
  const askText = await streamClaude(
    systemPrompt + (buildLegContext(updatedModel) || ''),
    [
      ...messages,
      { role: 'assistant', content: chatCleaned || '' },
      { role: 'user', content: `[HOTEL_CONFIRMED]\n\nHotel is locked in for ${leg.city.split(',')[0]}. Ask the traveler ONE short conversational question about what they want to do there. Reference their profile interests. OUTPUT ONLY THE QUESTION — stop after asking.` },
    ]
  );
  const { cleaned: askCleaned } = extractAndStripBlocks(askText);
  if (askCleaned) sendFn({ type: 'delta', text: askCleaned });

  console.log(`[select_hotel] leg ${legIndex} confirmed: ${confirmedHotel?.name}`);
  return { modelPatch: { legs: [{ index: legIndex, confirmedHotel, step: 'must_sees' }] }, continue: false };
}

// ── Must-sees ──────────────────────────────────────────────────────────────────

async function executeShowMustSees({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex];
  const legContext = buildLegContext(model);

  // Kick off activity fetch in parallel while streaming must-sees
  const fetchPromise = (leg.activityPreferences?.length
    ? fetchActivities(leg.city, leg.activityPreferences)
    : Promise.resolve(null)
  ).catch(() => null);

  await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[MUST_SEES_STAGE] destination="${leg.city}"\n\nThe traveler just told you their activity preferences for this leg. Acknowledge what they said, then present The Icons list (4-6 famous landmarks) and Hidden Gems list (3-5 underrated spots) as instructed. Ask which they want to hit on this part of the trip.` },
    ],
    sendFn
  );

  const bank = await fetchPromise;
  if (bank) {
    sendFn({ type: 'activity_bank_ready', data: bank });
  }

  return {
    modelPatch: { legs: [{ index: legIndex, mustSeesShown: true, activitiesBank: bank }] },
    continue: false,
  };
}

async function executeConfirmMustSees({ model, messages, systemPrompt, sendFn, legIndex }) {
  const legContext = buildLegContext(model);
  // Non-streaming: need full text to check [MUST_SEES_CONFIRMED] signal
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[MUST_SEES_STAGE] The traveler has been shown The Icons and Hidden Gems lists. Read their latest message. If they picked any attractions or gave any substantive reply — acknowledge their picks and emit [MUST_SEES_CONFIRMED]. Only stay if they are genuinely asking follow-up questions.` },
    ]
  );

  const signals = extractSignals(chatText);
  const { cleaned } = extractAndStripBlocks(chatText);
  if (cleaned) sendFn({ type: 'delta', text: cleaned });

  if (!signals.mustSeesConfirmed) return { modelPatch: null, continue: false };

  sendFn({ type: 'marker', content: '[MUST_SEES_CONFIRMED]' });
  return { modelPatch: { legs: [{ index: legIndex, mustSeesConfirmed: true, step: 'activities' }] }, continue: true };
}

// ── Activities ─────────────────────────────────────────────────────────────────

async function executeFetchActivities({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex];
  sendFn({ type: 'fetching' });

  let activityTypes = leg.activityPreferences || [];
  try {
    const extractMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [
        ...messages.slice(-4),
        { role: 'user', content: `Based on what the traveler said they want to do in ${leg.city.split(',')[0]}, output ONLY valid JSON: {"types":["term1","term2",...]}. Include every distinct activity category as a short search term. No other text.` },
      ],
    });
    const raw = extractMsg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const { types } = JSON.parse(raw);
    if (Array.isArray(types) && types.length > 0) activityTypes = types;
  } catch (e) { console.warn('[fetch_activities] type extraction failed:', e.message); }

  const bank = await fetchActivities(leg.city, activityTypes);
  sendFn({ type: 'activity_bank_ready', data: bank });

  return { modelPatch: { legs: [{ index: legIndex, activitiesBank: bank }] }, continue: true };
}

async function executeSelectActivity({ model, messages, systemPrompt, sendFn, legIndex, activityType }) {
  const leg = model.legs[legIndex];
  const bank = leg.activitiesBank;
  const offset = leg.shownActivityOffsets?.[activityType] ?? 0;
  const pool = bank.byType[activityType] || [];
  const currentShown = pool.slice(offset, offset + 2);
  const activityOptions = currentShown.map(a => `${a.id}: ${a.title}`).join(' | ');

  const legContext = buildLegContext(model);
  // Non-streaming: need full text to extract [ACTIVITY_OK]/[ACTIVITY_MORE]/[ACTIVITY_SKIP] signals
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[ACTIVITY_STAGE] The traveler was shown these 2 "${activityType}" options: ${activityOptions}. Read their message.\n\n- If they picked one or more — emit [ACTIVITY_OK] AND output [ACTIVITY_SELECTED]{"ids":["id_X"]}[/ACTIVITY_SELECTED].\n- If they want MORE different options for the same category — emit [ACTIVITY_MORE].\n- If they want to SKIP — emit [ACTIVITY_SKIP].\n- Err on the side of [ACTIVITY_OK] for any positive reply.\n- Do NOT name venues for the next category yet.` },
    ]
  );

  const signals = extractSignals(chatText);
  const { cleaned } = extractAndStripBlocks(chatText);
  if (cleaned) sendFn({ type: 'delta', text: cleaned });

  if (!signals.activityOk && !signals.activityMore && !signals.activitySkip) {
    return { modelPatch: null, continue: false };
  }

  if (signals.activitySkip) {
    const updatedConfirmed = [...(leg.confirmedActivities || []), { activityType, skipped: true }];
    return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed }] }, continue: true };
  }

  if (signals.activityMore) {
    const newOffset = offset + 2;
    const newShown = pool.slice(newOffset, newOffset + 2);
    if (newShown.length === 0) {
      sendFn({ type: 'delta', text: `That's all the ${activityType} options I have for ${leg.city.split(',')[0]} — moving on to the next category.` });
      const updatedConfirmed = [...(leg.confirmedActivities || []), { activityType, skipped: true }];
      return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed }] }, continue: true };
    }

    sendFn({ type: 'activities_bank', data: { activities: newShown, activityType } });

    const presentText = await streamClaude(systemPrompt, [
      ...messages,
      { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType, activities: newShown }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nPresent these 2 "${activityType}" alternatives with personality. Ask if they work.` },
    ]);
    const { cleaned: pCleaned } = extractAndStripBlocks(presentText);
    if (pCleaned) sendFn({ type: 'delta', text: pCleaned });

    const offsets = { ...(leg.shownActivityOffsets || {}), [activityType]: newOffset };
    return { modelPatch: { legs: [{ index: legIndex, shownActivityOffsets: offsets }] }, continue: false };
  }

  // ACTIVITY_OK — confirm selected activities
  let selectedActivities = currentShown;
  if (signals.activitySelected?.ids) {
    const idMap = Object.fromEntries(pool.map(a => [a.id, a]));
    const picked = signals.activitySelected.ids.map(id => idMap[id]).filter(Boolean);
    if (picked.length > 0) selectedActivities = picked;
  }

  sendFn({ type: 'activities_bank', data: { activities: selectedActivities, activityType } });
  sendFn({ type: 'activity_confirmed', data: { activities: selectedActivities } });

  const updatedConfirmed = [...(leg.confirmedActivities || []), ...selectedActivities];
  const offsets = { ...(leg.shownActivityOffsets || {}), [activityType]: offset + currentShown.length };

  console.log(`[select_activity] leg ${legIndex} confirmed ${activityType}:`, selectedActivities.map(a => a.title));
  return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed, shownActivityOffsets: offsets }] }, continue: true };
}
