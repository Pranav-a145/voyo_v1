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
  return leg.activitiesBank.types.find(t => !confirmed.has(t)) || null;
}

// ── Action resolver ────────────────────────────────────────────────────────────

export function resolveAction(model) {
  const { phase, currentLegIndex, legs } = model;

  if (phase === 'gathering')      return { type: 'gathering' };
  if (phase === 'summary')        return { type: 'summary' };
  if (phase === 'itinerary')      return { type: 'itinerary' };
  if (phase === 'post_itinerary') return { type: 'post_itinerary' };

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
