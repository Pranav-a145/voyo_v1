import 'dotenv/config';
import { fetchFlights, fetchHotels, fetchActivities, sortFlightPoolByPreference, sortHotelPoolByStyle } from './fetchers.js';
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
  if (phase === 'itinerary')      return model.itineraryBuilt ? { type: 'post_itinerary' } : { type: 'itinerary' };
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
      if (!leg.hotelStyleAsked)      return { type: 'ask_hotel_style', legIndex: currentLegIndex };
      if (!leg.hotelsBank?.length)   return { type: 'fetch_hotels',    legIndex: currentLegIndex };
      if (!leg.confirmedHotel)       return { type: 'select_hotel',    legIndex: currentLegIndex };
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

    case 'exit_transport': {
      const isLastLeg = currentLegIndex === legs.length - 1;
      // Single-destination trip: arrival flight was round trip — no separate return needed
      if (legs.length === 1) {
        return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'complete' };
      }
      // Multi-city: inter-city transit is the NEXT leg's arrival flight (already one-way).
      // Non-last legs skip exit entirely. Only the last leg fetches a one-way return home.
      const isMultiCity = model.isMultiCity || (model.legs?.length > 1);
      if (isMultiCity) {
        if (!isLastLeg)
          return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'complete' };
        if (!leg.exitTransport?.flightsBank?.length)
          return { type: 'fetch_exit_flight',  legIndex: currentLegIndex };
        if (!leg.exitTransport?.confirmedFlight)
          return { type: 'select_exit_flight', legIndex: currentLegIndex };
        return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'complete' };
      }
      if (!leg.exitTransport?.type) {
        if (isLastLeg) {
          return leg.exitTransport?.flightsBank?.length
            ? { type: 'select_exit_flight', legIndex: currentLegIndex }
            : { type: 'fetch_exit_flight',  legIndex: currentLegIndex };
        }
        return { type: 'ask_exit_transport', legIndex: currentLegIndex };
      }
      if (leg.exitTransport.type === 'flight' && !leg.exitTransport.flightsBank?.length)
        return { type: 'fetch_exit_flight',   legIndex: currentLegIndex };
      if (leg.exitTransport.type === 'flight' && !leg.exitTransport.confirmedFlight)
        return { type: 'select_exit_flight',  legIndex: currentLegIndex };
      return { type: 'advance_step', legIndex: currentLegIndex, nextStep: 'complete' };
    }

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

  const { tripType, origin, groupSize, budgetPerPerson, budgetIsPerPerson, legs } = signals.tripUpdate;

  // If Claude emitted [TRIP_UPDATE] without a real origin, ignore it and keep gathering
  const resolvedOrigin = (origin && !/^unknown$/i.test(origin.trim())) ? origin : (model.origin || null);
  if (!resolvedOrigin) {
    console.warn('[gathering] [TRIP_UPDATE] emitted without origin — staying in gathering phase');
    return { modelPatch: null, continue: false };
  }

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
    isMultiCity: initialLegs.length > 1,
    origin: resolvedOrigin,
    groupSize: groupSize || model.groupSize,
    budgetPerPerson: budgetPerPerson || model.budgetPerPerson,
    budgetIsPerPerson: budgetIsPerPerson !== undefined ? budgetIsPerPerson : (model.budgetIsPerPerson ?? true),
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

  const isMultiCity = model.isMultiCity || (model.legs?.length > 1);
  // Multi-city: all flights are one-way. Single-city: round-trip arrival.
  const flightType = isMultiCity ? '2' : '1';

  // For arrival flights on legs 1+ in multi-city, origin is the previous leg's city (not home)
  let origin, destination;
  if (isExit) {
    origin      = leg.city;
    destination = model.legs[legIndex + 1]?.city || model.origin;
  } else if (isMultiCity && legIndex > 0) {
    origin      = model.legs[legIndex - 1].city;
    destination = leg.city;
  } else {
    origin      = model.origin;
    destination = leg.city;
  }

  const depDate = isExit ? leg.departureDate : leg.arrivalDate;
  const lastLeg = model.legs.at(-1);
  const retDate = flightType === '1' ? (lastLeg?.departureDate ?? null) : null;

  console.log(`[fetch_flights] leg ${legIndex} ${isExit ? '(exit)' : ''} | ${origin} → ${destination} | ${depDate} | type:${flightType}`);

  const flightsRaw = await fetchFlights(origin, destination, depDate, retDate, model.groupSize || 1, flightType)
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

  const modelPatch = isExit
    ? { legs: [{ index: legIndex, exitTransport: { type: 'flight', ...(leg.exitTransport || {}), flightsBank: flights, shownFlights: flightCards } }] }
    : { legs: [{ index: legIndex, flightsBank: flights, shownFlights: flightCards }] };

  // Send cards FIRST so the client creates a fresh message slot, then stream text into it
  sendFn({ type: 'knowledge_bank', data: { flights: flightCards, hotels: [], activities: [], flightsBankFull: flights } });

  const legContext = buildLegContext(model);
  await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'assistant', content: isExit ? `Let me find the best options to get you from ${leg.city.split(',')[0]} to ${destination.split(',')[0]}.` : "Let me pull up the best flights for you!" },
      { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights: flightCardsReadable }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[FLIGHTS_SHOWN]\n\nPresent ONLY these 3 flights using their exact details. Ask which one they prefer.${isExit ? ' IMPORTANT: This is their return flight home — do NOT mention hotels, activities, or any next booking steps after this. Just present the options and ask which they prefer.' : (isMultiCity && legIndex > 0) ? ` After presenting the flights, add 1-2 sentences from your own knowledge about any notable ground transport alternative (train, ferry, bus) between ${origin.split(',')[0]} and ${destination.split(',')[0]} — typical journey time, rough cost range, and when it might be worth considering. Do NOT invent specific prices or schedules. Keep it brief and natural, then ask which flight they prefer.` : ''}` },
    ],
    sendFn
  );

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
      { role: 'user', content: `[FLIGHT_STAGE] The traveler has been shown these flight options: ${flightOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one — acknowledge it warmly, emit [CONFIRM]{"leg":${legIndex},"type":"${isExit ? 'exit_flight' : 'flight'}","id":"<exact_id>"}[/CONFIRM], emit [FLIGHT_CONFIRMED].${isExit ? ' IMPORTANT: This is a return/departure flight home. After confirming their choice, do NOT mention hotels, activities, or any next booking steps. Just acknowledge their selection warmly and that is all.' : ''}\n- If they want MORE or DIFFERENT flights — emit [CHANGE]{"leg":${legIndex},"field":"${isExit ? 'exitTransport.flightPreference' : 'flightPreference'}","value":"<preference or 'more options'>"}[/CHANGE]. Use their stated preference (cheaper, direct, etc.) if given; otherwise use "more options". You may ask ONE clarifying question ONLY if this is clearly their first request and they gave zero indication of what they want. If they've already been asked or show any impatience, emit [CHANGE] immediately. CRITICAL: Never invent flight options yourself — always emit [CHANGE] so the system fetches real data.\n- If genuinely undecided, help them decide.` },
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

// ── Ask hotel style before fetching ───────────────────────────────────────────

async function executeAskHotelStyle({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex];
  const legContext = buildLegContext(model);
  await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[HOTEL_STYLE_STAGE] destination="${leg.city}"\n\nThe flight is already confirmed — do NOT acknowledge or repeat the flight selection again. Jump straight to asking ONE brief casual question about the hotel vibe they're after for ${leg.city.split(',')[0]} — e.g. boutique, luxury, budget-friendly, something with a pool, central location, etc. Keep it warm and conversational.` },
    ],
    sendFn
  );
  return { modelPatch: { legs: [{ index: legIndex, hotelStyleAsked: true }] }, continue: false };
}

// ── Fetch hotels for a leg ─────────────────────────────────────────────────────

async function executeFetchHotels({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex];
  sendFn({ type: 'fetching' });

  // Extract hotel style from conversation if not already set
  let hotelStyle = leg.hotelStyle;
  if (!hotelStyle) {
    try {
      const extractMsg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [
          ...messages.slice(-4),
          { role: 'user', content: `Based on what the traveler said about their hotel preference for ${leg.city.split(',')[0]}, output ONLY valid JSON: {"style": "value or null"}. Use one of: luxury, boutique, budget, resort, apartment. If not clearly specified, use null. No other text.` },
        ],
      });
      const raw = extractMsg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const { style } = JSON.parse(raw);
      if (style && style !== 'null') hotelStyle = style;
    } catch (e) { console.warn('[fetch_hotels] style extraction failed:', e.message); }
  }

  const hotelsRaw = await fetchHotels(
    leg.city, leg.arrivalDate, leg.departureDate,
    model.groupSize || 1, hotelStyle
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

  // Send cards FIRST so the client creates a fresh message slot, then stream text into it
  sendFn({ type: 'hotels_bank', data: { hotels: hotelCards, hotelsBankFull: hotels, checkIn: leg.arrivalDate, checkOut: leg.departureDate } });

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

  const allShownHotelIds = hotelCards.map(h => h.id);
  return { modelPatch: { legs: [{ index: legIndex, hotelsBank: hotels, shownHotels: hotelCards, hotelStyle: hotelStyle || null, allShownHotelIds }] }, continue: false };
}

// ── Select hotel (user is choosing) ───────────────────────────────────────────

async function executeSelectHotel({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex];
  const bank = leg.hotelsBank || [];
  const shown = leg.shownHotels || bank.slice(0, 3);
  const hotelOptions = shown.map((h, i) => `Option ${i + 1} (id:${h.id}): ${h.name}`).join(' | ');

  const legContext = buildLegContext(model);
  // Non-streaming: need full text to extract [CONFIRM]/[CHANGE] signals before acting
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[HOTEL_STAGE] The traveler has been shown these hotel options: ${hotelOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one — acknowledge warmly, emit [CONFIRM]{"leg":${legIndex},"type":"hotel","option":<1|2|3>,"id":"<id_from_list>"}[/CONFIRM], emit [HOTEL_CONFIRMED]. The "option" field is the 1-based position number (1, 2, or 3) of the hotel they chose — this is the most important field, use it to indicate which option was selected.\n- If they want MORE or DIFFERENT hotels — CRITICAL: emit [CHANGE]{"leg":${legIndex},"field":"hotelPreference","value":"<preference or 'more options'>"}[/CHANGE] IN THIS SAME RESPONSE, immediately. Do NOT say "Got it, let me pull up..." or any acknowledgement without also emitting [CHANGE] in the same message. ANY style preference word ("upscale", "cheaper", "boutique", "more central", "different", "more options") means emit [CHANGE] right now. If they stated a preference (e.g. "more upscale", "something with a pool"), use it as the value. If they just want more without specifics, use "more options". You may ask ONE clarifying question ONLY if this is clearly their very first request and they gave absolutely zero indication of what style they want — but if you ask, still emit [CHANGE] in that same response so the system starts fetching. CRITICAL: Never name or invent hotels yourself — always emit [CHANGE] so the system pulls real options from live data.\n- If they're changing GROUP SIZE — emit [CHANGE]{"leg":${legIndex},"field":"groupSize","value":<number>}[/CHANGE].\n- If genuinely undecided, help them decide.` },
    ]
  );

  const signals = extractSignals(chatText);
  const { cleaned: chatCleaned } = extractAndStripBlocks(chatText);
  if (chatCleaned) sendFn({ type: 'delta', text: chatCleaned });

  // Fallback: if Claude failed to emit [CHANGE] but user clearly wants different options
  if (!signals.change && !signals.confirm?.option && !signals.confirm?.id && !signals.hotelConfirmed) {
    const userMsg = (messages[messages.length - 1]?.content || '').toLowerCase();
    if (/more|different|other|upscale|luxury|budget|cheap|boutique|upmarket|nicer|fancier|higher.?end|5.?star/i.test(userMsg)) {
      let inferredPref = 'more options';
      if (/upscale|luxury|high.?end|5.?star|fancy|premium|nicer|fancier|upmarket/i.test(userMsg)) inferredPref = 'upscale luxury';
      else if (/budget|cheap|affordable/i.test(userMsg)) inferredPref = 'budget';
      else if (/boutique/i.test(userMsg)) inferredPref = 'boutique';
      console.log(`[select_hotel] inferred hotelPreference from user msg: "${inferredPref}"`);
      signals.change = { field: 'hotelPreference', value: inferredPref };
    }
  }

  if (signals.change?.field === 'hotelPreference') {
    const pref = signals.change.value;
    const prefIsUpscale = /luxury|high.?end|5.?star|upscale|fancy|premium/i.test(pref || '');
    const bankIsUpscale = /luxury|high.?end|5.?star|upscale|fancy|premium/i.test(leg.hotelStyle || '');

    // If user wants upscale but bank was fetched for something cheaper, skip the bank and refetch
    if (prefIsUpscale && !bankIsUpscale) {
      return { modelPatch: { legs: [{ index: legIndex, hotelsBank: [], hotelStyle: pref, allShownHotelIds: [] }] }, continue: true };
    }

    // Accumulate all IDs shown so far (current batch + previous batches)
    const allShownIds = new Set([
      ...(leg.allShownHotelIds || []),
      ...(leg.shownHotels || []).map(h => h.id),
    ]);
    const unshown = bank.filter(h => !allShownIds.has(h.id));

    if (unshown.length > 0) {
      // Show next batch from existing bank — no re-fetch needed
      const sortedUnshown = sortHotelPoolByStyle(unshown, pref);
      const selText = await streamClaude(systemPrompt, [
        ...messages,
        { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels: sortedUnshown }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nThe traveler wants "${pref}" options. Output only [SELECTED_HOTELS]{"ids":["id1","id2","id3"]}[/SELECTED_HOTELS] picking the 3 best matches for "${pref}" from these. Nothing else.` },
      ]);
      let nextShown = sortedUnshown.slice(0, 3);
      const selM2 = selText.match(/\[SELECTED_HOTELS\]([\s\S]*?)\[\/SELECTED_HOTELS\]/);
      if (selM2) {
        try {
          const { ids } = JSON.parse(selM2[1].trim());
          const idMap = Object.fromEntries(sortedUnshown.map(h => [h.id, h]));
          const ordered = ids.map(id => idMap[id]).filter(Boolean);
          if (ordered.length > 0) nextShown = ordered;
        } catch {}
      }

      // Cards first, then presentation text
      sendFn({ type: 'hotels_bank', data: { hotels: nextShown, checkIn: leg.arrivalDate, checkOut: leg.departureDate } });
      const legContext2 = buildLegContext(model);
      const presentText = await streamClaude(systemPrompt + (legContext2 ? '\n\n' + legContext2 : ''), [
        ...messages,
        { role: 'assistant', content: chatCleaned || '' },
        { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels: nextShown }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[HOTELS_SHOWN]\n\nPresent these ${nextShown.length} alternative hotels with personality. Ask which they prefer.` },
      ]);
      const { cleaned: pCleaned } = extractAndStripBlocks(presentText);
      if (pCleaned) sendFn({ type: 'delta', text: pCleaned });

      const newAllShownIds = [...allShownIds, ...nextShown.map(h => h.id)];
      return { modelPatch: { legs: [{ index: legIndex, shownHotels: nextShown, allShownHotelIds: newAllShownIds }] }, continue: false };
    }

    // Bank exhausted — refetch with the stated preference
    return { modelPatch: { legs: [{ index: legIndex, hotelsBank: [], hotelStyle: pref, allShownHotelIds: [] }] }, continue: true };
  }
  if (signals.change?.field === 'groupSize') {
    const newSize = parseInt(signals.change.value, 10);
    if (isNaN(newSize) || newSize < 1) return { modelPatch: null, continue: false };
    sendFn({ type: 'marker', content: `[GROUP_SIZE_UPDATE]{"passengers":${newSize}}` });
    return { modelPatch: { groupSize: newSize, legs: [{ index: legIndex, hotelsBank: [] }] }, continue: true };
  }

  if (!signals.confirm?.option && !signals.confirm?.id && !signals.hotelConfirmed) return { modelPatch: null, continue: false };

  // Primary: position from [CONFIRM] option field (most reliable — Claude picks 1, 2, or 3)
  let confirmedHotel = null;
  const pos = parseInt(signals.confirm?.option);
  if (pos >= 1 && pos <= shown.length) confirmedHotel = shown[pos - 1];

  // Secondary: exact ID match
  if (!confirmedHotel && signals.confirm?.id) confirmedHotel = bank.find(h => h.id === signals.confirm.id) || null;

  // Tertiary: hotel name in user's last message
  if (!confirmedHotel) {
    const userText = (messages[messages.length - 1]?.content || '').toLowerCase();
    confirmedHotel = shown.find(h => h.name && userText.includes(h.name.toLowerCase().split(/\s+/).slice(0, 2).join(' ')));
  }

  // Last resort: parse "option N" / ordinal from user message
  if (!confirmedHotel) {
    const userText = (messages[messages.length - 1]?.content || '').toLowerCase();
    const m = userText.match(/\boption\s*(\d+)\b|\b(first|1st|second|2nd|third|3rd)\b/);
    if (m) {
      const n = m[1] ? parseInt(m[1]) - 1
        : ['first', '1st'].includes(m[2]) ? 0
        : ['second', '2nd'].includes(m[2]) ? 1 : 2;
      confirmedHotel = shown[n] || null;
    }
  }

  if (!confirmedHotel) return { modelPatch: null, continue: false };
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

  // Extract activity types in user's stated order BEFORE the parallel fetch
  let orderedTypes = leg.activityPreferences || [];
  try {
    const extractMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [
        ...messages.slice(-6),
        { role: 'user', content: `Based on what the traveler said they want to do in ${leg.city.split(',')[0]}, output ONLY valid JSON: {"types":["term1","term2",...]}. List categories IN THE ORDER the traveler mentioned them — their first mention is their highest priority. Include every distinct activity type as a short search term. No other text.` },
      ],
    });
    const raw = extractMsg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const { types } = JSON.parse(raw);
    if (Array.isArray(types) && types.length > 0) orderedTypes = types;
  } catch (e) { console.warn('[show_must_sees] type extraction failed:', e.message); }

  // Kick off activity fetch in parallel while streaming must-sees
  const fetchPromise = (orderedTypes.length
    ? fetchActivities(leg.city, orderedTypes)
    : Promise.resolve(null)
  ).catch(() => null);

  await streamClaudeSSE(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[MUST_SEES_STAGE] destination="${leg.city}"\n\nThe traveler just told you their activity preferences for this leg. Acknowledge what they said, then present The Icons list (4-6 famous landmarks) and Hidden Gems list (3-5 underrated spots) as instructed. Ask which they want to hit on this part of the trip. IMPORTANT: Do NOT say what activity category is coming next — do not say "I'll pull up nightlife" or "food options are next" or name any specific category. Just end by asking which must-sees they want to include.` },
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

const ACTIVITY_CANDIDATE_SIZE = 6;

async function preSelectActivities(candidates, activityType, cityName) {
  if (candidates.length <= 2) return candidates.slice(0, 2);
  try {
    const selMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: `Pick the 2 best "${activityType}" options for a traveler visiting ${cityName}. Prefer locally authentic, traveler-relevant venues. Avoid: corporate/business event spaces, activities culturally irrelevant to the destination (e.g. an Indian restaurant when the query is for local food in Thailand), generic tourist traps with low engagement.\n\nOptions: ${candidates.map(a => `${a.id}: ${a.title} (${a.rating ?? 'N/A'}★, ${a.reviews ?? 0} reviews)`).join(' | ')}\n\nOutput ONLY valid JSON: {"ids":["id1","id2"]}`,
      }],
    });
    const raw = selMsg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const { ids } = JSON.parse(raw);
    const idMap = Object.fromEntries(candidates.map(a => [a.id, a]));
    const picked = ids.map(id => idMap[id]).filter(Boolean);
    if (picked.length > 0) return picked.slice(0, 2);
  } catch (e) { console.warn('[preSelectActivities] failed:', e.message); }
  return candidates.slice(0, 2);
}

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
        { role: 'user', content: `Based on what the traveler said they want to do in ${leg.city.split(',')[0]}, output ONLY valid JSON: {"types":["term1","term2",...]}. List categories IN THE ORDER the traveler mentioned them — their first mention is their highest priority. Include every distinct activity category as a short search term. No other text.` },
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
  const legContext = buildLegContext(model);

  const cityName = leg.city.split(',')[0];

  // ── Initial presentation: type has never been shown to the user yet ──────────
  const hasBeenShown = activityType in (leg.shownActivityOffsets || {});
  if (!hasBeenShown) {
    const candidates = pool.slice(0, ACTIVITY_CANDIDATE_SIZE);
    if (candidates.length === 0) {
      sendFn({ type: 'delta', text: `I couldn't find any ${activityType} options for ${cityName} — moving on.` });
      const updatedConfirmed = [...(leg.confirmedActivities || []), { activityType, skipped: true }];
      return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed }] }, continue: true };
    }

    const initialShown = await preSelectActivities(candidates, activityType, cityName);

    sendFn({ type: 'activities_bank', data: { activities: initialShown, activityType } });

    await streamClaudeSSE(
      systemPrompt + (legContext ? '\n\n' + legContext : ''),
      [
        ...messages,
        { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType, activities: initialShown }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nPresent these 2 "${activityType}" options for ${cityName} with personality. Ask the traveler which they'd like to include, or if they'd prefer different options. Do NOT mention what category comes next.` },
      ],
      sendFn
    );

    const offsets = { ...(leg.shownActivityOffsets || {}), [activityType]: ACTIVITY_CANDIDATE_SIZE };
    const shownIds = { ...(leg.shownActivityIds || {}), [activityType]: initialShown.map(a => a.id) };
    console.log(`[select_activity] leg ${legIndex} initial present: ${activityType}`);
    return { modelPatch: { legs: [{ index: legIndex, shownActivityOffsets: offsets, shownActivityIds: shownIds }] }, continue: false };
  }

  // ── Selection logic: user is responding to cards they've already seen ────────
  const shownIds = leg.shownActivityIds?.[activityType];
  const currentShown = shownIds
    ? shownIds.map(id => pool.find(a => a.id === id)).filter(Boolean)
    : pool.slice(0, 2);
  const activityOptions = currentShown.map(a => `${a.id}: ${a.title}`).join(' | ');

  // Non-streaming: need full text to extract [ACTIVITY_OK]/[ACTIVITY_MORE]/[ACTIVITY_SKIP] signals
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `[ACTIVITY_STAGE] The traveler was shown these 2 "${activityType}" options: ${activityOptions}. Read their message.\n\n- If they picked one or more — emit [ACTIVITY_OK] AND output [ACTIVITY_SELECTED]{"ids":["id_X"]}[/ACTIVITY_SELECTED].\n- If they want MORE different options — emit [ACTIVITY_MORE]. You may ask ONE clarifying question ONLY if this is clearly their first request for more and they gave zero indication of what they want. If they've already been asked or show any impatience, emit [ACTIVITY_MORE] immediately. CRITICAL: Never name venues yourself — always emit [ACTIVITY_MORE] so the system pulls real options.\n- If they want to SKIP — emit [ACTIVITY_SKIP].\n- Err on the side of [ACTIVITY_OK] for any positive reply.\n- CRITICAL: Do NOT mention, name, or preview what comes next (no "now let me pull up X", no "next we'll look at Y"). Just confirm the current selection warmly and stop. The system handles what comes next.` },
    ]
  );

  const signals = extractSignals(chatText);
  const { cleaned } = extractAndStripBlocks(chatText);

  if (!signals.activityOk && !signals.activityMore && !signals.activitySkip) {
    if (cleaned) sendFn({ type: 'delta', text: cleaned });
    return { modelPatch: null, continue: false };
  }

  if (signals.activitySkip) {
    if (cleaned) sendFn({ type: 'delta', text: cleaned });
    const updatedConfirmed = [...(leg.confirmedActivities || []), { activityType, skipped: true }];
    return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed }] }, continue: true };
  }

  if (signals.activityMore) {
    if (cleaned) sendFn({ type: 'delta', text: cleaned });
    const moreCandidates = pool.slice(offset, offset + ACTIVITY_CANDIDATE_SIZE);
    if (moreCandidates.length === 0) {
      sendFn({ type: 'delta', text: `That's all the ${activityType} options I have for ${cityName} — moving on to the next category.` });
      const updatedConfirmed = [...(leg.confirmedActivities || []), { activityType, skipped: true }];
      return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed }] }, continue: true };
    }

    const newShown = await preSelectActivities(moreCandidates, activityType, cityName);

    // Cards first so client creates new slot, then text streams into it
    sendFn({ type: 'activities_bank', data: { activities: newShown, activityType } });

    const presentText = await streamClaude(systemPrompt, [
      ...messages,
      { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType, activities: newShown }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nPresent these 2 "${activityType}" alternatives with personality. Ask if they work.` },
    ]);
    const { cleaned: pCleaned } = extractAndStripBlocks(presentText);
    if (pCleaned) sendFn({ type: 'delta', text: pCleaned });

    const newOffsets = { ...(leg.shownActivityOffsets || {}), [activityType]: offset + ACTIVITY_CANDIDATE_SIZE };
    const newShownIds = { ...(leg.shownActivityIds || {}), [activityType]: newShown.map(a => a.id) };
    return { modelPatch: { legs: [{ index: legIndex, shownActivityOffsets: newOffsets, shownActivityIds: newShownIds }] }, continue: false };
  }

  // ACTIVITY_OK — silently lock in and move on; confirmed card shows in final itinerary
  let selectedActivities = currentShown;
  if (signals.activitySelected?.ids) {
    const idMap = Object.fromEntries(pool.map(a => [a.id, a]));
    const picked = signals.activitySelected.ids.map(id => idMap[id]).filter(Boolean);
    if (picked.length > 0) selectedActivities = picked;
  }

  const updatedConfirmed = [...(leg.confirmedActivities || []), ...selectedActivities];
  const offsets = { ...(leg.shownActivityOffsets || {}), [activityType]: offset + currentShown.length };

  console.log(`[select_activity] leg ${legIndex} confirmed ${activityType}:`, selectedActivities.map(a => a.title));
  return { modelPatch: { legs: [{ index: legIndex, confirmedActivities: updatedConfirmed, shownActivityOffsets: offsets }] }, continue: true, didStream: false };
}

// ── Exit transport ─────────────────────────────────────────────────────────────

async function executeAskExitTransport({ model, messages, systemPrompt, sendFn, legIndex }) {
  const leg = model.legs[legIndex];
  const isLastLeg = legIndex === model.legs.length - 1;
  const nextCity = isLastLeg ? model.origin : model.legs[legIndex + 1]?.city;
  const legContext = buildLegContext(model);

  // Non-streaming: need [CHANGE] signal to know transport type before acting
  const chatText = await streamClaude(
    systemPrompt + (legContext ? '\n\n' + legContext : ''),
    [
      ...messages,
      { role: 'user', content: `The traveler has finished planning ${leg.city.split(',')[0]}. Now ask how they want to get to ${isLastLeg ? (model.origin + ' (their home)') : nextCity?.split(',')[0]}. If it is clearly a flight (e.g. any international leg), suggest it. If a train/ferry/bus is a common option, mention it. After the user tells you or you recommend the transport type, emit [CHANGE]{"leg":${legIndex},"field":"exitTransportType","value":"flight"}[/CHANGE] (or train/bus/ferry). For ground transport set fetchNeeded false in your thinking but still emit the [CHANGE] signal.` },
    ]
  );

  const signals = extractSignals(chatText);
  const { cleaned } = extractAndStripBlocks(chatText);
  if (cleaned) sendFn({ type: 'delta', text: cleaned });

  if (!signals.change || signals.change.field !== 'exitTransportType') {
    return { modelPatch: null, continue: false };
  }

  const transportType = signals.change.value || 'flight';
  const fetchNeeded = transportType === 'flight';

  return {
    modelPatch: { legs: [{ index: legIndex, exitTransport: { type: transportType, fetchNeeded, flightsBank: [], confirmedFlight: null } }] },
    continue: fetchNeeded,
  };
}

// ── Summary ────────────────────────────────────────────────────────────────────

function computeBudgetBreakdown(ctx) {
  const { groupSize, budgetPerPerson, budgetIsPerPerson, arrivalFlightIsRoundTrip } = ctx;
  const parseMoney = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    return parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0;
  };

  const totalBudget = budgetIsPerPerson
    ? parseMoney(budgetPerPerson) * groupSize
    : parseMoney(budgetPerPerson);

  const lines = [];
  let totalNights = 0;
  let totalActivities = 0;
  const ppl = groupSize > 1 ? ` × ${groupSize} people` : '';

  for (const leg of ctx.legs) {
    if (leg.confirmedFlight) {
      const ppx = parseMoney(leg.confirmedFlight.price_per_person);
      const route = leg.confirmedFlight.origin && leg.confirmedFlight.destination
        ? ` (${leg.confirmedFlight.origin} → ${leg.confirmedFlight.destination})`
        : '';
      lines.push({
        label: `${leg.confirmedFlight.airline || 'Flight'}${route}${arrivalFlightIsRoundTrip ? ' — round trip' : ''}`,
        amount: ppx * groupSize,
      });
    }

    if (leg.confirmedHotel) {
      const ppn = parseMoney(leg.confirmedHotel.price_per_night);
      const nights = leg.confirmedHotel.nights || 0;
      lines.push({
        label: `${leg.confirmedHotel.name} ($${ppn}/night × ${nights} nights${ppl})`,
        amount: ppn * nights * groupSize,
      });
      totalNights += nights;
    }

    if (leg.exitTransport) {
      const ppx = parseMoney(leg.exitTransport.price_per_person);
      lines.push({ label: `${leg.exitTransport.airline || 'Return flight'}`, amount: ppx * groupSize });
    }

    totalActivities += (leg.confirmedActivities || []).length;
  }

  const totalDays = Math.max(totalNights + 1, 1);
  if (totalActivities > 0) {
    lines.push({ label: `Activities (${totalActivities} × ~$40/person${ppl})`, amount: totalActivities * 40 * groupSize, isEstimate: true });
  }
  lines.push({ label: `Food ($50/day/person${ppl} × ${totalDays} days)`, amount: 50 * totalDays * groupSize, isEstimate: true });
  lines.push({ label: `Local transport ($20/day/person${ppl} × ${totalDays} days)`, amount: 20 * totalDays * groupSize, isEstimate: true });

  const total = lines.reduce((sum, l) => sum + (l.amount || 0), 0);
  return { lines, total, budget: totalBudget, leftOver: totalBudget - total, groupSize };
}

function buildTripSummaryContext(model) {
  const isSingleDestination = (model.legs || []).length === 1;
  return {
    origin: model.origin,
    groupSize: model.groupSize || 1,
    budgetPerPerson: model.budgetPerPerson,
    budgetIsPerPerson: model.budgetIsPerPerson ?? true,
    arrivalFlightIsRoundTrip: isSingleDestination,
    legs: (model.legs || []).map(l => ({
      city: l.city,
      arrivalDate: l.arrivalDate,
      departureDate: l.departureDate,
      durationNights: l.durationNights,
      confirmedFlight: l.confirmedFlight ? {
        airline: l.confirmedFlight.airline,
        price_per_person: l.confirmedFlight.price,
        origin: l.confirmedFlight.origin_airport,
        destination: l.confirmedFlight.destination_airport,
      } : null,
      confirmedHotel: l.confirmedHotel ? {
        name: l.confirmedHotel.name,
        price_per_night: l.confirmedHotel.price,
        nights: l.durationNights,
      } : null,
      confirmedActivities: (l.confirmedActivities || []).filter(a => !a.skipped).map(a => a.title).filter(Boolean),
      exitTransport: l.exitTransport?.confirmedFlight
        ? { type: 'flight', airline: l.exitTransport.confirmedFlight.airline, price_per_person: l.exitTransport.confirmedFlight.price }
        : null,
    })),
  };
}

async function executeSummary({ model, messages, systemPrompt, sendFn }) {
  const ctx = buildTripSummaryContext(model);

  if (!model.summaryShown) {
    // First turn: stream the summary, wait for user response
    const budgetNote = ctx.budgetIsPerPerson
      ? `Budget is PER PERSON ($${ctx.budgetPerPerson}/person). Show all costs per person and compare to the per-person budget.`
      : `Budget is FOR THE GROUP ($${ctx.budgetPerPerson} total for ${ctx.groupSize} people). Show group totals and compare to group budget.`;

    await streamClaudeSSE(systemPrompt, [
      ...messages,
      { role: 'user', content: `[PRE_ITINERARY_SUMMARY]\nConfirmed trip: ${JSON.stringify(ctx)}\n\nAll legs planned. Give the traveler a clean summary — list everything locked in ONCE:\n- Each arrival flight (airline, route, price${ctx.arrivalFlightIsRoundTrip ? ' — round trip, covers return' : ''})\n- Each hotel (name, price/night, nights)\n${ctx.legs.some(l => l.exitTransport) ? '- Each exit/return flight (airline, price)\n' : ''}- All confirmed activities per city\n\nThen include a BUDGET BREAKDOWN section:\n${budgetNote}\nGroup size: ${ctx.groupSize} ${ctx.groupSize > 1 ? 'people' : 'person'}.\n\nFormat it as a markdown table with EXACTLY this structure (use pipe syntax):\n\n| Item | Cost |\n|:-----|-----:|\n| [each line item] | [$amount] |\n| | |\n| **Total Estimated Spend** | **$X** |\n| Your Budget | $Y |\n| **Left Over** | **~$Z** |\n\nCalculate each row:\n• Arrival flights: price_per_person × groupSize for each leg${ctx.arrivalFlightIsRoundTrip ? ' (round trip — DO NOT add a separate return flight row)' : ''}\n${ctx.legs.some(l => l.exitTransport) ? '• Return/exit flights: price_per_person × groupSize for each leg\n' : ''}• Hotels: price_per_night × nights × groupSize for each leg\n• Activities: estimate $25–60 per activity per person × groupSize\n• Food: estimate $50/person/day × total trip days × groupSize\n• Local transport: estimate $20/person/day × total trip days × groupSize\n\nUse a blank row (| | |) to visually separate line items from the totals. Bold the Total and Left Over rows.\n\nEnd with: "Does everything look good to you? If you're happy with the plan, I'll build your full day-by-day itinerary right now — or just let me know if you'd like to swap anything out."` },
    ], sendFn);

    sendFn({ type: 'marker', content: '[PRE_ITINERARY_SUMMARY_SHOWN]' });
    return { modelPatch: { summaryShown: true }, continue: false };
  }

  // Second turn: user has responded — detect approval from their actual message
  // Non-streaming: need full text to check [ITINERARY_CONFIRMED] signal
  const chatText = await streamClaude(
    systemPrompt,
    [
      ...messages,
      { role: 'user', content: `[ITINERARY_STAGE] The traveler has responded to the pre-itinerary summary. Read their message.\n\n- If they approve (say it looks good, yes, let's do it, etc.) — emit [ITINERARY_CONFIRMED].\n- If they want to change something — acknowledge and help them, do NOT emit [ITINERARY_CONFIRMED].` },
    ]
  );

  const signals = extractSignals(chatText);
  const { cleaned } = extractAndStripBlocks(chatText);

  if (!signals.itineraryConfirmed) {
    if (cleaned) sendFn({ type: 'delta', text: cleaned });
    return { modelPatch: null, continue: false };
  }

  sendFn({ type: 'fetching' });
  return { modelPatch: { phase: 'itinerary' }, continue: true };
}

// ── Itinerary ──────────────────────────────────────────────────────────────────

async function executeItinerary({ model, messages, systemPrompt, sendFn }) {
  const ctx = buildTripSummaryContext(model);

  const allFlights    = (model.legs || []).flatMap(l => [l.confirmedFlight, l.exitTransport?.confirmedFlight].filter(Boolean));
  const allHotels     = (model.legs || []).map(l => l.confirmedHotel).filter(Boolean);
  const allActivities = (model.legs || []).flatMap(l => (l.confirmedActivities || []).filter(a => !a.skipped));

  // Cards first so client creates a new message slot, then the itinerary text streams into it
  const budget = computeBudgetBreakdown(ctx);
  sendFn({ type: 'itinerary_bank', data: { flights: allFlights, hotels: allHotels, activities: allActivities, isItinerary: true, budget } });
  sendFn({ type: 'delta', text: 'Give me 3–5 minutes while I combine everything into your final itinerary — I\'m laying out every day in detail so bear with me.\n\n' });

  const returnFlightNote = ctx.arrivalFlightIsRoundTrip
    ? '\n\nIMPORTANT: The arrival flight is a ROUND TRIP — DO NOT mention a return flight anywhere in the itinerary. There is no separate return flight. On the last day, simply note the departure time from the hotel (3hrs before flight) without saying "return flight".'
    : '';

  await streamClaudeSSE(systemPrompt, [
    ...messages,
    { role: 'user', content: `[ITINERARY_MODE]\nFull trip context: ${JSON.stringify(ctx)}\n\nBuild the traveler's complete day-by-day itinerary spanning all ${model.legs.length} ${model.legs.length > 1 ? 'legs' : 'leg'} of this trip.\n\nCRITICAL: Do NOT re-list confirmed flights, hotels, activities, or the budget breakdown — the traveler just saw all of that in the pre-itinerary summary. Jump straight into the day-by-day plan.${returnFlightNote}\n\nBEFORE WRITING — run these checks:\n1. What actual day of the week is each date? Label every day: date + day name.\n2. Arrival flight departure time → work backwards for hotel check-in. International = 3hrs early + real transit time.\n3. ${ctx.arrivalFlightIsRoundTrip ? 'Last day: note hotel checkout + airport transit time only. DO NOT write about a return flight.' : 'Return/departure flight on last day — same calculation.'}\n4. NIGHTLIFE SCHEDULING — Fri/Sat first, overflow to Sun, then weekdays last resort.\n5. Verify every confirmed must-see and activity appears by name on the correct day.\n\nSTRUCTURE:\n- Open with one warm sentence: you built this around their confirmed picks, invite pushback.\n- For each city leg: city header with dates, then day-by-day with date + day of week + one-word vibe.\n- Include travel days between cities with the confirmed transport.\n- Close with a short "Before You Go" section: reservations, pre-bookings, practical tips.\n\nDAILY RULES: Named places only (no "explore the area"). Every meal = specific restaurant + one-line reason. Max 3-4 major things/day. Clubs after 10:30pm. Realistic transit times between venues.` },
  ], sendFn);

  sendFn({ type: 'marker', content: '[ITINERARY_SHOWN]' });

  return { modelPatch: { phase: 'post_itinerary', itineraryBuilt: true }, continue: false };
}

async function executePostItinerary({ model, messages, systemPrompt, sendFn }) {
  await streamClaudeSSE(systemPrompt, messages, sendFn);
  return { modelPatch: null, continue: false };
}

// ── Action dispatcher ──────────────────────────────────────────────────────────

async function executeAction({ action, model, messages, systemPrompt, sendFn }) {
  const args = { model, messages, systemPrompt, sendFn };

  switch (action.type) {
    case 'gathering':          return executeGathering(args);
    case 'fetch_flights':      return executeFetchFlights({ ...args, legIndex: action.legIndex });
    case 'select_flight':      return executeSelectFlight({ ...args, legIndex: action.legIndex });
    case 'ask_hotel_style':    return executeAskHotelStyle({ ...args, legIndex: action.legIndex });
    case 'fetch_hotels':       return executeFetchHotels({ ...args, legIndex: action.legIndex });
    case 'select_hotel':       return executeSelectHotel({ ...args, legIndex: action.legIndex });
    case 'show_must_sees':     return executeShowMustSees({ ...args, legIndex: action.legIndex });
    case 'confirm_must_sees':  return executeConfirmMustSees({ ...args, legIndex: action.legIndex });
    case 'fetch_activities':   return executeFetchActivities({ ...args, legIndex: action.legIndex });
    case 'select_activity':    return executeSelectActivity({ ...args, legIndex: action.legIndex, activityType: action.activityType });
    case 'ask_exit_transport': return executeAskExitTransport({ ...args, legIndex: action.legIndex });
    case 'fetch_exit_flight':  return executeFetchFlights({ ...args, legIndex: action.legIndex, isExit: true });
    case 'select_exit_flight': return executeSelectFlight({ ...args, legIndex: action.legIndex, isExit: true });
    case 'advance_step':
      return { modelPatch: { legs: [{ index: action.legIndex, step: action.nextStep }] }, continue: true };
    case 'next_leg':
      return { modelPatch: { currentLegIndex: action.nextLegIndex }, continue: true };
    case 'transition_summary':
      return { modelPatch: { phase: 'summary' }, continue: true };
    case 'summary':            return executeSummary(args);
    case 'itinerary':          return executeItinerary(args);
    case 'post_itinerary':     return executePostItinerary(args);
    default:
      console.warn('[orchestrator] unknown action type:', action.type);
      return { modelPatch: null, continue: false };
  }
}

// ── Main entry point ───────────────────────────────────────────────────────────

const STREAMING_ACTIONS = new Set([
  'gathering', 'select_flight', 'ask_hotel_style', 'select_hotel',
  'show_must_sees', 'confirm_must_sees', 'select_activity',
  'ask_exit_transport', 'select_exit_flight', 'summary', 'post_itinerary',
]);

export async function executeRequest({ tripModel, messages, profile, sendFn }) {
  const systemPrompt = buildSystemPrompt(profile);
  let model = tripModel;

  let continueLoop = true;
  let iterations = 0;
  let prevDidStream = false;
  const MAX_ITERATIONS = 30; // 3-city trip has ~20 advance/transition iterations alone

  while (continueLoop && iterations < MAX_ITERATIONS) {
    iterations++;
    const action = resolveAction(model);
    console.log(`[orchestrator] iteration ${iterations} | action: ${action.type}`);

    const willStream = STREAMING_ACTIONS.has(action.type);
    if (prevDidStream && willStream) {
      sendFn({ type: 'new_message' });
    }

    // Errors propagate to the route handler in index.js which catches and sends { type: 'error' }
    const result = await executeAction({ action, model, messages, systemPrompt, sendFn });

    if (result.modelPatch) {
      model = applyPatch(model, result.modelPatch);
      sendFn({ type: 'trip_model_update', data: result.modelPatch });
    }

    prevDidStream = willStream && result.didStream !== false;
    continueLoop = result.continue === true;
  }
}
