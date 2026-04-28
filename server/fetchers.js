import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function withRetry(fn, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isOverloaded = err?.status === 529 || err?.error?.type === 'overloaded_error';
      if (!isOverloaded || attempt === maxAttempts) throw err;
      const delay = 1000 * 2 ** (attempt - 1);
      console.warn(`[retry] overloaded, attempt ${attempt}/${maxAttempts}, waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── Private helper ───────────────────────────────────────────────────────────

async function resolveIataCodes(origin, destination) {
  const msg = await withRetry(() => anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: `Convert this origin city to its best IATA airport code for international/long-haul travel, and this destination city to its best IATA airport code. If a city has multiple airports, pick the main one most travelers use (e.g. New York = JFK for international, London = LHR, Paris = CDG, Chicago = ORD). Return ONLY a JSON object like: {"origin_code": "JFK", "destination_code": "ATH"}. No other text. Origin: ${origin}. Destination: ${destination}.`,
    }],
  }));
  const raw = msg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  console.log('\n─── resolveIataCodes RESPONSE ──────────────────────────');
  console.log(raw);
  console.log('────────────────────────────────────────────────────────\n');
  return JSON.parse(raw);
}

// ─── Exported fetchers ────────────────────────────────────────────────────────

export async function fetchFlights(origin, destination, departureDate, returnDate, passengers, flightType = '1') {
  const { origin_code, destination_code } = await resolveIataCodes(origin, destination);
  console.log(`\n─── IATA codes resolved: ${origin} → ${origin_code}, ${destination} → ${destination_code}`);

  const paramObj = {
    engine: 'google_flights',
    departure_id: origin_code,
    arrival_id: destination_code,
    outbound_date: departureDate,
    adults: '1',
    type: flightType,
    api_key: process.env.SERPAPI_KEY,
  };
  if (flightType === '1' && returnDate) paramObj.return_date = returnDate;

  const params = new URLSearchParams(paramObj);

  const url = `https://serpapi.com/search?${params}`;
  console.log('\n─── fetchFlights REQUEST ───────────────────────────────');
  console.log('URL:', url);
  console.log('Params:', Object.fromEntries(params));

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SerpAPI flights error ${res.status}: ${errText}`);
  }
  const data = await res.json();

  console.log('─── fetchFlights RESPONSE (HTTP', res.status, ')────────────');
  console.log(JSON.stringify(data, null, 2));
  console.log('────────────────────────────────────────────────────────\n');

  console.log('FULL FIRST FLIGHT OBJECT:', JSON.stringify(data.best_flights?.[0], null, 2));
  const combined = [...(data.best_flights || []), ...(data.other_flights || [])];
  console.log('RAW FLIGHT PRICES:', (data.best_flights || []).slice(0, 3).map(f => ({ airline: f.flights?.[0]?.airline, price: f.price, type: f.type })));
  if (combined[0]) {
    console.log('[fetchFlights] raw price field on first result:', combined[0].price, '(type:', typeof combined[0].price, ')');
  }
  const searchUrl = data.search_metadata?.google_flights_url ?? null;
  combined.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  return combined.slice(0, 10).map((f) => {
    const firstLeg = f.flights?.[0] || {};
    const lastLeg  = f.flights?.at(-1) || {};
    const layoverAirport = f.flights?.length > 1 ? f.flights[0].arrival_airport?.id : null;
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
      isRoundTrip: flightType === '1',
    };
  });
}

export function hotelStyleQuery(cityName, style) {
  if (!style) return `hotels in ${cityName}`;
  const s = style.toLowerCase();
  if (/luxury|high.?end|5.?star|upscale|fancy|premium|boutique luxury/.test(s)) return `luxury 5 star hotels in ${cityName}`;
  if (/boutique/.test(s)) return `boutique hotels in ${cityName}`;
  if (/cheap|budget|affordable|hostel/.test(s)) return `cheap budget hotels in ${cityName}`;
  if (/resort/.test(s)) return `resorts in ${cityName}`;
  if (/apartment|airbnb/.test(s)) return `apartment hotels in ${cityName}`;
  return `hotels in ${cityName}`;
}

export function sortFlightPoolByPreference(pool, preference) {
  if (!preference) return pool;
  const p = preference.toLowerCase();
  const withPrice = [...pool].filter(f => f.price != null);
  const noPrice   = pool.filter(f => f.price == null);
  if (/cheap|budget|affordable|cheapest|lowest/.test(p)) {
    withPrice.sort((a, b) => a.price - b.price);
  } else if (/expensive|premium|business|first.?class|luxury/.test(p)) {
    withPrice.sort((a, b) => b.price - a.price);
  } else if (/direct|non.?stop/.test(p)) {
    return [...pool].sort((a, b) => (a.stops ?? 99) - (b.stops ?? 99));
  } else if (/fast|short|quick/.test(p)) {
    return [...pool].sort((a, b) => (a.duration_minutes ?? 9999) - (b.duration_minutes ?? 9999));
  }
  return [...withPrice, ...noPrice];
}

export function sortHotelPoolByStyle(pool, style) {
  if (!style) return pool;
  const s = style.toLowerCase();
  const parsePrice = (p) => {
    if (p == null) return 0;
    if (typeof p === 'number') return p;
    return parseFloat(String(p).replace(/[^0-9.]/g, '')) || 0;
  };
  const byPrice = [...pool].filter(h => h.price != null);
  const noPricePool = pool.filter(h => h.price == null);
  if (/luxury|high.?end|5.?star|upscale|fancy|premium/.test(s)) {
    byPrice.sort((a, b) => parsePrice(b.price) - parsePrice(a.price));
  } else if (/cheap|budget|affordable/.test(s)) {
    byPrice.sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
  }
  return [...byPrice, ...noPricePool];
}

export async function fetchHotels(city, checkinDate, checkoutDate, guests, style) {
  const cityName = city.split(',')[0].trim();

  const doFetch = async (query) => {
    const params = new URLSearchParams({
      engine: 'google_hotels',
      q: query,
      check_in_date: checkinDate,
      check_out_date: checkoutDate,
      adults: String(guests),
      api_key: process.env.SERPAPI_KEY,
    });
    const url = `https://serpapi.com/search?${params}`;
    console.log('\n─── fetchHotels REQUEST ────────────────────────────────');
    console.log('URL:', url);
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`SerpAPI hotels error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    console.log('─── fetchHotels RESPONSE (HTTP', res.status, ')─────────────');
    console.log(JSON.stringify(data, null, 2));
    console.log('────────────────────────────────────────────────────────\n');
    return data.properties || [];
  };

  let properties = await doFetch(hotelStyleQuery(cityName, style));

  // Fallback to generic query if styled query returns empty
  if (properties.length === 0 && style) {
    console.log(`[fetchHotels] styled query empty, retrying with generic query for ${cityName}`);
    properties = await doFetch(`hotels in ${cityName}`);
  }

  const mapped = properties
    .filter((h) => h.link)
    .slice(0, 15)
    .map((h, i) => {
      const thumbnail =
        h.images?.[0]?.original_image ??
        h.images?.[0]?.thumbnail ??
        h.thumbnail ??
        h.serpapi_thumbnail ??
        null;
      console.log(`[hotel thumbnail] ${h.name}: ${thumbnail ? thumbnail.slice(0, 80) : 'NULL'}`);
      return {
        id: `hotel_${i}`,
        name: h.name,
        price: h.rate_per_night?.lowest ?? null,
        rating: h.overall_rating ?? null,
        link: h.link,
        address: h.address ?? null,
        thumbnail,
      };
    });
  return sortHotelPoolByStyle(mapped, style);
}

export async function fetchActivities(destination, activityTypes) {
  const types = (activityTypes || []).length > 0 ? activityTypes : ['things to do'];

  const parseReviews = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    return parseInt(String(v).replace(/[^0-9]/g, ''), 10) || 0;
  };

  const popularityScore = (a) =>
    a.rating * Math.log(parseReviews(a.reviews) + 1);

  const sortByPopularity = (items) => {
    const withRating = items.filter(a => a.rating != null);
    const noRating   = items.filter(a => a.rating == null);
    withRating.sort((a, b) => popularityScore(b) - popularityScore(a));
    return [...withRating, ...noRating];
  };

  const fetchOne = async (type) => {
    const params = new URLSearchParams({
      engine: 'google_maps',
      q: `${type} in ${destination}`,
      type: 'search',
      api_key: process.env.SERPAPI_KEY,
    });
    try {
      const res = await fetch(`https://serpapi.com/search?${params}`);
      const data = await res.json();
      const results = (data.local_results || []).slice(0, 20);
      if (results[0]) {
        console.log(`[fetchActivities] raw first result for "${type}":`, JSON.stringify(results[0], null, 2));
      }
      return results;
    } catch { return []; }
  };

  const allResults = await Promise.all(types.map(fetchOne));

  let idCounter = 0;
  const byType = {};
  for (let i = 0; i < types.length; i++) {
    const mapped = allResults[i].map(r => {
      const lat = r.gps_coordinates?.latitude;
      const lng = r.gps_coordinates?.longitude;
      const mapsUrl = r.place_id
        ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}`
        : (lat && lng ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null);

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
      };
    });
    byType[types[i]] = sortByPopularity(mapped);
  }

  console.log('[fetchActivities]', types.map(t => `${t}:${byType[t].length}`).join(', '));
  return { types, byType };
}
