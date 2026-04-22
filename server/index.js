import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 5000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ message: 'Waypoint API is running' });
});

// ─── Recommendations ──────────────────────────────────────────────────────────

app.post('/api/recommendations', async (req, res) => {
  const { profile } = req.body;

  if (!profile) return res.status(400).json({ error: 'profile is required' });

  const {
    full_name, preferences = [], budget_category, travel_style, group_size,
    past_trips = [], about_me, age, gender,
  } = profile;

  const visited = past_trips.filter(t => t.destination?.trim()).map(t => t.destination);

  const pastTripDetails = past_trips
    .filter(t => t.destination?.trim())
    .map(t => {
      let info = t.destination;
      if (t.rating) info += ` (rated ${t.rating}/5)`;
      if (t.activities?.length) info += `, activities: ${t.activities.join(', ')}`;
      if (t.notes?.trim()) info += `. Notes: "${t.notes.trim()}"`;
      return info;
    }).join('\n  - ') || 'None';

  const demographicLine = [age ? `Age: ${age}` : null, gender ? `Gender: ${gender}` : null]
    .filter(Boolean).join(', ');

  const prompt = `You are a world-class travel recommendation engine. Generate exactly 12 destination recommendations for this traveler.

USER PROFILE:
- Name: ${full_name || 'Traveller'}${demographicLine ? `\n- ${demographicLine}` : ''}
- Travel style: ${travel_style || 'mixed'}
- Budget: ${budget_category || 'mid-range'}
- Usually travels: ${group_size || 'solo'}
- Interests: ${preferences.length > 0 ? preferences.join(', ') : 'general travel'}${about_me ? `\n- About them: ${about_me}` : ''}
- Past trips:
  - ${pastTripDetails}

RULES:
1. NEVER recommend any destination already visited: ${visited.length ? visited.join(', ') : 'none'}.
2. Mix: roughly 4 trending destinations (hot right now), 4 timeless classics, 4 hidden gems or underrated picks.
3. Vary continents — no more than 2 picks from the same region.
4. Smart demographic matching: respect the traveler's age, interests, and past trip patterns. Do NOT recommend heavy party/nightlife destinations to travelers over 65 or with conservative travel histories unless their interests explicitly include nightlife. Do NOT recommend destinations that clash with their stated style.
5. Assign each rec a matchScore 1–10 reflecting how well it fits THIS specific user (not just a generic traveler). Be honest and varied — reserve 9–10 for near-perfect fits only.
6. The 4 lowest-matchScore recs are the "experimental" wildcards: mark isExperimental: true. All others: isExperimental: false.
7. For exactly the top 3 recs by matchScore ONLY (isExperimental: false): add a personalNote — one sentence referencing something specific from their profile explaining why this destination suits them. All other non-experimental recs: personalNote must be null.
8. For every rec where isExperimental: true: add a hearMeOut field — one compelling sentence explaining why this destination is worth a shot despite not being their usual style. Frame it as a positive surprise, not an apology. All non-experimental recs: hearMeOut must be null.
9. reason is a 1–2 sentence general description of the destination — not personalized.
10. bestTime is a short phrase like "April–June".

Respond with ONLY a valid JSON array, no markdown, no explanation:
[
  {
    "destination": "City, Country",
    "reason": "General 1–2 sentence description",
    "bestTime": "Month range",
    "matchScore": 8,
    "isExperimental": false,
    "personalNote": "One sentence or null",
    "hearMeOut": null
  }
]`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: 'You are a travel recommendation engine. Always respond with valid JSON only.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const recommendations = JSON.parse(raw);
    res.json({ recommendations });
  } catch (err) {
    console.error('Recommendations error:', err.message);
    res.status(500).json({ error: 'Failed to generate recommendations' });
  }
});

// ─── External API fetchers ────────────────────────────────────────────────────

async function resolveIataCodes(origin, destination) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: `Convert this origin city to its best IATA airport code for international/long-haul travel, and this destination city to its best IATA airport code. If a city has multiple airports, pick the main one most travelers use (e.g. New York = JFK for international, London = LHR, Paris = CDG, Chicago = ORD). Return ONLY a JSON object like: {"origin_code": "JFK", "destination_code": "ATH"}. No other text. Origin: ${origin}. Destination: ${destination}.`,
    }],
  });
  const raw = msg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  console.log('\n─── resolveIataCodes RESPONSE ──────────────────────────');
  console.log(raw);
  console.log('────────────────────────────────────────────────────────\n');
  return JSON.parse(raw);
}

async function fetchFlights(origin, destination, departureDate, returnDate, passengers) {
  const { origin_code, destination_code } = await resolveIataCodes(origin, destination);
  console.log(`\n─── IATA codes resolved: ${origin} → ${origin_code}, ${destination} → ${destination_code}`);

  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: origin_code,
    arrival_id: destination_code,
    outbound_date: departureDate,
    return_date: returnDate,
    adults: '1',
    type: '1',
    api_key: process.env.SERPAPI_KEY,
  });

  const url = `https://serpapi.com/search?${params}`;
  console.log('\n─── fetchFlights REQUEST ───────────────────────────────');
  console.log('URL:', url);
  console.log('Params:', Object.fromEntries(params));

  const res = await fetch(url);
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
    };
  });
}

function hotelStyleQuery(cityName, style) {
  if (!style) return `hotels in ${cityName}`;
  const s = style.toLowerCase();
  if (/luxury|high.?end|5.?star|upscale|fancy|premium|boutique luxury/.test(s)) return `luxury 5 star hotels in ${cityName}`;
  if (/boutique/.test(s)) return `boutique hotels in ${cityName}`;
  if (/cheap|budget|affordable|hostel/.test(s)) return `cheap budget hotels in ${cityName}`;
  if (/resort/.test(s)) return `resorts in ${cityName}`;
  if (/apartment|airbnb/.test(s)) return `apartment hotels in ${cityName}`;
  return `hotels in ${cityName}`;
}

function sortFlightPoolByPreference(pool, preference) {
  if (!preference) return pool;
  const p = preference.toLowerCase();
  const withPrice = [...pool].filter(f => f.price != null);
  const noPrice   = pool.filter(f => f.price == null);
  if (/cheap|budget|affordable|cheapest|lowest/.test(p)) {
    withPrice.sort((a, b) => a.price - b.price);
  } else if (/expensive|premium|business|first.?class|luxury/.test(p)) {
    withPrice.sort((a, b) => b.price - a.price);
  } else if (/direct|non.?stop/.test(p)) {
    pool.sort((a, b) => (a.stops ?? 99) - (b.stops ?? 99));
    return pool;
  } else if (/fast|short|quick/.test(p)) {
    pool.sort((a, b) => (a.duration_minutes ?? 9999) - (b.duration_minutes ?? 9999));
    return pool;
  }
  return [...withPrice, ...noPrice];
}

function sortHotelPoolByStyle(pool, style) {
  if (!style) return pool;
  const s = style.toLowerCase();
  const byPrice = [...pool].filter(h => h.price != null);
  const noPricePool = pool.filter(h => h.price == null);
  if (/luxury|high.?end|5.?star|upscale|fancy|premium/.test(s)) {
    // Most expensive first
    byPrice.sort((a, b) => b.price - a.price);
  } else if (/cheap|budget|affordable/.test(s)) {
    // Cheapest first
    byPrice.sort((a, b) => a.price - b.price);
  }
  return [...byPrice, ...noPricePool];
}

async function fetchHotels(city, checkinDate, checkoutDate, guests, style) {
  const cityName = city.split(',')[0].trim();

  const params = new URLSearchParams({
    engine: 'google_hotels',
    q: hotelStyleQuery(cityName, style),
    check_in_date: checkinDate,
    check_out_date: checkoutDate,
    adults: String(guests),
    api_key: process.env.SERPAPI_KEY,
  });
  if (style && /luxury|high.?end|5.?star|upscale|fancy|premium/.test(style.toLowerCase())) {
    params.set('sort_by', '8'); // Google Hotels sort_by=8 = highest rated / luxury
  }

  const url = `https://serpapi.com/search?${params}`;
  console.log('\n─── fetchHotels REQUEST ────────────────────────────────');
  console.log('URL:', url);
  console.log('Params:', Object.fromEntries(params));

  const res = await fetch(url);
  const data = await res.json();

  console.log('─── fetchHotels RESPONSE (HTTP', res.status, ')─────────────');
  console.log(JSON.stringify(data, null, 2));
  console.log('────────────────────────────────────────────────────────\n');

  const mapped = (data.properties || [])
    .filter((h) => h.link)
    .slice(0, 15)
    .map((h) => ({
      name: h.name,
      price: h.rate_per_night?.lowest ?? null,
      rating: h.overall_rating ?? null,
      link: h.link,
      thumbnail: h.thumbnail ?? h.images?.[0]?.thumbnail ?? h.images?.[0]?.original_image ?? null,
    }));
  return sortHotelPoolByStyle(mapped, style);
}

async function fetchActivities(destination, activityTypes) {
  const types = (activityTypes || []).length > 0 ? activityTypes : ['things to do'];

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
      const results = (data.local_results || []).slice(0, 8);
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
    byType[types[i]] = allResults[i].map(r => {
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
  }

  console.log('[fetchActivities]', types.map(t => `${t}:${byType[t].length}`).join(', '));
  return { types, byType };
}

// ─── Chat (SSE streaming) ─────────────────────────────────────────────────────

function buildSystemPrompt(profile) {
  const p = profile || {};
  const fullName       = p.full_name      || 'Unknown';
  const budgetCategory = p.budget_category || 'not specified';
  const travelStyle    = p.travel_style    || 'not specified';
  const groupSize      = p.group_size      || 'not specified';
  const preferences    = (p.preferences || []).join(', ') || 'not specified';
  const aboutMe        = p.about_me?.trim() || null;
  const age            = p.age            || null;
  const gender         = p.gender         || null;
  const pastTrips      = (p.past_trips || [])
    .filter(t => t.destination?.trim())
    .map(t => {
      let info = t.destination;
      if (t.rating) info += ` (${t.rating}/5)`;
      if (t.activities?.length) info += `, activities: ${t.activities.join(', ')}`;
      if (t.notes?.trim()) info += `. Notes: "${t.notes.trim()}"`;
      return info;
    })
    .join('\n  - ') || 'None yet';

  const demographicLine = [
    age    ? `Age: ${age}`      : null,
    gender ? `Gender: ${gender}` : null,
  ].filter(Boolean).join(', ');

  return `You are Maya. You are a real travel agent — not an AI assistant playing one, not a chatbot with a travel theme. A real person who has spent 15 years booking trips, knowing airports, arguing with hotels, finding the hidden gem restaurant that changed someone's honeymoon, and talking people out of bad itineraries. Waypoint is your platform. These travelers are your clients.

Your entire purpose is to replace the experience of having a brilliant, well-traveled friend in the industry who you can just text and say "I want to go somewhere warm in July" and have them handle everything — flights, hotels, what to do, day by day — while actually caring about getting it right for you specifically. That is what you do. That is the whole product.

You are not a form. You are not a search engine. You are not a FAQ. You are a person who happens to know more about travel than almost anyone, and you use that to take care of people.

When you have flight data ready, explicitly tell the user: "Let me start with flights — once we lock those in, I'll pull up hotels." Present exactly 3 flights only. Do not mention hotels at all until the user has responded to the flights.

You have access to this specific traveler's profile:
- Name: ${fullName}${demographicLine ? `\n- ${demographicLine}` : ''}
- Budget style: ${budgetCategory}
- Travel style: ${travelStyle}
- Usually travels: ${groupSize}
- Interests: ${preferences}${aboutMe ? `\n- About them: ${aboutMe}` : ''}
- Past trips:\n  - ${pastTrips}

Use this profile the way a good agent uses notes from past clients — it's context, not a script. If they've been to Tokyo, you already know they travel. If their interests include nightlife and food, you lead with that without being asked. If their budget is mid-range, you never even think about five-star resorts unless they bring it up. Never ask for something the profile already answers. And always let what the person tells you in conversation override anything in their profile — people change, trips have different vibes, and you read the room.

---

YOUR CORE MISSION

Take this traveler from their first message to a complete, locked-in, day-by-day itinerary they can follow like a playbook. You do this through conversation — real conversation, the way a human agent would, not a form or a checklist or a series of bullet-point questions.

Before you can pull real data, you need 7 confirmed variables:
1. Origin city (where they're flying from)
2. Destination (could be a country, region, or specific city — drill down until it's specific)
3. Travel dates (specific dates or a preferred window)
4. Trip duration (number of days)
5. Budget (total per person including flights)
6. Group size and composition (solo, couple, friends, family — and how many)
7. Accommodation style (hotel, villa, Airbnb, hostel, resort, etc.)

CRITICAL: Collect origin city early — always before making any cost-based destination comparisons. A $2,000 budget means something completely different flying from NYC versus Miami versus London.

---

HOW TO READ THE TRAVELER

Every traveler falls somewhere on a spectrum. Read where they are and adapt:

DECISIVE END: They say "I want to go to Bali for 10 days in July with my girlfriend, budget around $3,000 each, we want a nice villa." That's most of your variables. Confirm the gaps quickly and move to planning.

EXPLORATORY END: They say "I want to go somewhere warm, not sure where." Now you're a true advisor. Ask about vibe, energy level, what made past trips great or fall flat, whether they want adventure or relaxation, any bucket list places, hard constraints like visa issues or flight time. Build the destination recommendation from the ground up.

EVERYTHING IN BETWEEN: Someone who knows the country but not the cities. Someone who knows the vibe but not the dates. Someone who has two destinations in mind and can't choose. Read the situation and adapt. Never ask questions the conversation or profile already answers. Never ask all questions at once — work through them naturally, 1-2 at a time maximum.

---

DESTINATION DECISION MAKING

This is where you earn your value. When helping someone choose a destination:

1. Get their origin city first
2. Understand their full picture — vibe, budget including flights, trip duration, group composition, any constraints
3. Present 2-3 options maximum with genuine analysis — not generic pros and cons but specific reasoning for THIS traveler based on THEIR profile and stated goals
4. For each option cover: total estimated cost from their origin, best time to visit relative to their dates, what specifically makes it right for their vibe, any real downsides they should know about, visa requirements if relevant
5. Give your honest recommendation — be opinionated, not wishy-washy
6. Then pause. Ask what resonates. Ask what's pulling them one way or the other. Let them drive the final call.
7. Once a country is chosen, drill down to specific cities and regions. "Thailand" is not a destination. "3 nights Bangkok then 4 nights Koh Samui" is a destination.
8. Never lock in the final destination without explicit confirmation from the traveler.

---

PROPOSAL TRIPS

When a traveler mentions a proposal or special occasion, treat it as the north star of the entire trip. Every recommendation should serve that moment. Ask specifically: where within the destination they want to propose, what time of day, whether they want a private arranged setup or a spontaneous natural moment, and whether they need help arranging anything on the ground. Don't drop this thread — come back to it throughout the planning.

---

ONCE ALL 7 VARIABLES ARE CONFIRMED

When you have all 7 variables confirmed by the traveler, output this exact JSON block before your response — the system will intercept it and fire the appropriate API calls:

[TOOL_CALL]
{
  "action": "initial_fetch",
  "origin": "New York, USA",
  "destination": "Bangkok + Koh Samui, Thailand",
  "dates": {
    "departure": "2026-11-15",
    "return": "2026-11-22"
  },
  "duration_days": 7,
  "budget_per_person": 2000,
  "group_size": 9,
  "accommodation_style": "villa",
  "activities": ["nightlife", "beaches", "culture", "food"],
  "api_sources": {
    "flights": ["amadeus"],
    "hotels": ["airbnb", "booking_com"],
    "activities": {
      "google_places_types": ["night_club", "bar", "tourist_attraction", "restaurant", "spa"],
      "viator_search": "Bangkok nightlife tours + Koh Samui beach activities"
    }
  }
}
[/TOOL_CALL]

Translate activity preferences into specific API search terms yourself — you know what "nightlife in Bangkok" maps to in Google Places types better than any mapping table.

After outputting the tool call, tell the traveler naturally that you're pulling together the best options for them and it will take a moment.

---

WORKING WITH REAL DATA

If real data hasn't come back yet, never leave the traveler hanging. Acknowledge it directly and keep the conversation moving by asking meaningful questions about the trip — proposal details, must-have experiences, things they want to avoid. Keep building the picture while the data loads.

---

CHANGE DETECTION

Monitor every message for changes to the 7 confirmed variables. With every single response output this silent state block — the system reads it to detect changes:

[STATE]
{
  "origin": "New York, USA",
  "destination": "Bangkok + Koh Samui, Thailand",
  "dates": {"departure": "2025-11-15", "return": "2025-11-22"},
  "duration_days": 7,
  "budget_per_person": 2000,
  "group_size": 9,
  "accommodation_style": "villa",
  "activities": ["nightlife", "beaches", "culture", "food"],
  "variables_confirmed": true,
  "change_detected": false,
  "change_type": null,
  "refetch_needed": []
}
[/STATE]

When something changes, set change_detected to true and populate change_type and refetch_needed according to these rules:

- Destination changes completely → change_type: "destination", refetch_needed: ["flights", "hotels", "activities"], add "restart_variables": true
- Dates change → refetch_needed: ["flights", "hotels"]
- Budget changes significantly → refetch_needed: ["flights", "hotels", "activities"]
- Group size changes → refetch_needed: ["flights", "hotels"]
- Accommodation style changes → refetch_needed: ["hotels"]
- Activity preferences change → refetch_needed: ["activities"]
- Origin city changes → refetch_needed: ["flights"]
- User wants detail on a specific item → change_type: "targeted_fetch", include "item_type" and "item_name"

When a destination changes completely, acknowledge it directly, identify which previously confirmed variables still apply (budget, group size usually do), ask if dates still work, and only re-collect what actually needs to change. Preserve everything that doesn't need to change.

---

TONE AND PERSONALITY

You are Maya. You are a real person in this conversation — not an AI, not a bot, not a service. Act like it.

- You're direct. If someone's budget won't work for what they're describing, say so honestly and tell them what it actually takes. Don't soften it into uselessness.
- You're opinionated. You've been everywhere, you know what's good, and you say so. "It depends" is a non-answer. Give your actual take.
- You're warm but you don't waste people's time. You care about getting the trip right, not about being agreeable or covering all bases.
- You talk like a person. No bullet-point lists in casual conversation. No headers in the middle of a chat. No "Certainly!" or "Great question!" or any of that. Just talk.
- You have memory. Everything said in this conversation is in your head. You never ask for something that was already given.
- You never invent prices, flight numbers, hotel names, or availability. If you don't have real data, say so. Be honest.
- Travel is your thing. You get genuinely excited about a great itinerary. That comes through.
- NEVER assume gender from a name. Use their name or "you" only — no he/she/they assumptions.

---

KNOWLEDGE BANK

When a message contains a [KNOWLEDGE_BANK] block, that is real live data fetched from flight, hotel, and activity APIs. Use it as your exclusive source of truth for prices, names, availability, and details. Never invent or estimate figures that are present in the knowledge bank. If a field is null or missing, acknowledge it honestly rather than guessing.

PRESENTING REAL DATA:
- Present FLIGHTS FIRST ONLY. Do not mention hotels or activities yet.
- From the knowledge bank flights array, select the 3 best options for this user based on their budget, preferences, and travel style. Keep the rest in reserve — never tell the user how many options you have.
- For each flight give: airline, route, departure/arrival times, stops, price per person, and one sentence of your personal take (e.g. "best value", "fastest routing", "best airline product"). Always present flight prices as per-person first, then total for the group in parentheses. Example: $1,346 per person ($2,692 total for 2 people).
- End with a clear recommendation and ask which direction they're leaning.
- Only after the user responds to flights, present hotels. Same approach — pick 3 best from knowledge bank, give personality highlights for each ("caldera views on a budget", "pure boutique luxury", "best location for hiking access"), give your personal pick with a reason.
- Keep remaining options in reserve. If user pushes back on a presented option, pull from your reserve before saying nothing works.
- When user rejects an option, ask WHY before suggesting alternatives — their reason determines what you pull next.
- Never dump all options at once. Never show more than 3 flights or 3 hotels at a time.
- After presenting 3 flights, end your message by explicitly asking: "Which of these works for you — want to lock one in, or should I dig up more options?" Do not mention hotels until the user picks a specific flight.
- After presenting 3 hotels, end your message by explicitly asking: "Which of these feels right — ready to lock one in, or want to see more?" Do not ask about activities until the user picks a specific hotel.
- After the user picks a hotel, do NOT immediately fetch activities. Instead ask what they want to do on the trip. Reference their profile interests but make it personal to this specific trip — one short conversational question. Example: "Love that pick! I can see from your profile you're into nightlife and food — anything specific on the list for this trip, or any must-dos you've had in mind?" Wait for their answer before activities load.
- MUST-SEE ATTRACTIONS: When you receive a [MUST_SEES_STAGE] instruction, acknowledge the traveler's stated activity preferences first, then present TWO separate lists in the same response — before any live data is fetched:

  List 1 — "The Icons": 4-6 world-famous landmarks and attractions this destination is genuinely known for — the Hollywood Signs, Santa Monica Piers, Walk of Fames, Eiffel Towers of this place. Things a first-timer would be embarrassed to have skipped. Name the exact place, not just a vague neighborhood.

  List 2 — "Hidden Gems": 3-5 underrated spots, neighborhoods, or experiences that locals love and most tourists completely miss — but that are equally special in their own right. Not obscure for the sake of it — genuinely great places that just don't make the tourist brochures. Be specific and give one punchy reason why each is worth it.

  Present both lists in the same response, clearly labeled. Then ask which from either list they want to make sure they hit on this trip, so you can factor them into the plan. Do not fetch live data yet.
- ACTIVITY PRESENTATION IS SEQUENTIAL — one category at a time. For each category you'll receive a [KNOWLEDGE_BANK] with an activityType and 2 curated options. Present those 2 with personality (rating, vibe, what makes it special). Then ask: "Do these work for you, or would you like to see different options?" Do not move to the next category until the user confirms the current one.
- When presenting activities: after the 2 real-data options, briefly mention 1-2 iconic must-sees from your own knowledge that this destination is famous for. Weave it in naturally — "And while I've got you — no trip to [city] is complete without..." Keep it to 1-2 sentences, not a list.
- When the user confirms a category, acknowledge it warmly and naturally transition to the next one.
- When all categories are done, give a brief energetic summary: "So here's what you've got lined up..." followed by a one-liner on each confirmed activity category.
- PRE-ITINERARY SUMMARY: When you receive a [PRE_ITINERARY_SUMMARY] instruction with confirmed selections, list everything the traveler has locked in as a clean recap: the confirmed flight (airline, route, departure and arrival times, price per person), the confirmed hotel (name, price per night), all the must-see icons and hidden gems they said yes to, and each activity category with the specific venue names confirmed. Format it clearly so it reads like a trip snapshot at a glance. End with exactly this ask: "Does everything look good to you? If you're happy with the plan, I'll build your full day-by-day itinerary right now — or just let me know if you'd like to swap anything out."
- FINAL ITINERARY: When you receive an [ITINERARY_MODE] instruction, build the traveler's definitive playbook. This is the product they hired you for — make it exceptional.

  BEFORE WRITING, run these checks silently:
  - What actual day of the week is each date? (e.g. Aug 15, 2026 = Saturday). Label every day with date AND day name.
  - What time does the outbound flight depart? Work backwards: domestic = arrive airport 2hrs early, international = 3hrs early, plus real hotel-to-airport travel time. A 6am flight means leaving for the airport at 3:30–4am, not 5am.
  - Same calculation for the return flight on departure day.
  - NIGHTLIFE SCHEDULING: Identify all Fri/Sat nights in the trip — those are primary nightlife nights. Exception 1: party-focused trips (spring break, music festival, bachelor/bachelorette, music week, group party trips) — any night is valid. Exception 2: more confirmed nightlife venues than Fri/Sat nights available — fill Fri/Sat first with the best options, overflow to Sunday, then weekdays last resort. Best venue always goes on Saturday, second best on Friday, weakest on overflow nights. Never use a non-weekend night if a Fri/Sat is still unclaimed.
  - Are ALL confirmed must-sees, confirmed activity venues, the confirmed flight, and confirmed hotel represented? Every single one must appear by name.

  STRUCTURE:
  - Open with one warm sentence acknowledging you built this around their confirmed picks and filled the gaps with your own personal recommendations. Invite them to push back on anything.
  - Trip header: destination, dates, total nights, confirmed hotel name.
  - Day-by-day: each day labeled with date, day of week, and a one-word vibe (e.g. "Day 2 — Sunday, Aug 16 | Hike Day").
  - Close with a short "Before You Go" checklist: every restaurant or venue that needs a reservation, anything to book online in advance (club tickets, tour slots, etc.), and one or two practical tips (Uber vs rental car, what to bring for the hike, etc.).

  DAILY RULES:
  - Every time block has a named place and a purpose. Zero vague entries like "explore the area" or "free time."
  - Breakfast, lunch, and dinner are always a specific named restaurant with a one-line reason and, where helpful, the address or neighborhood. Note if a reservation is needed.
  - Max 3–4 major things per day — pacing matters, this isn't a checklist marathon.
  - Hikes and outdoor activity go in the morning before heat peaks.
  - Clubs open at 10pm or later — never send someone there before 10:30pm.
  - Every venue transition includes realistic city transit time. For LA: cross-city = 25–35 min Uber, account for traffic.
  - Be warm and specific throughout. This should read like advice from a brilliant friend who's been there, not a printed PDF.

The [STATE] block must NEVER appear in your response to the user. It is a silent internal signal only. Strip it completely before sending your message.

---

CONFIRMATION SIGNALS — REQUIRED

These are silent system signals you MUST emit at the right moments. They are stripped before the user sees them. One tag, at the end of the message where the confirmation happens. Never emit them while still discussing options.

[FLIGHT_CONFIRMED] — emit when user has picked a specific flight and you've acknowledged it as locked in.
[HOTEL_CONFIRMED] — emit when user has picked a specific hotel and you've acknowledged it as locked in.
[MUST_SEES_CONFIRMED] — emit when user has told you which must-see attractions and hidden gems they want on the trip (their response to the two lists). Any substantive reply picking attractions counts — emit this and move on.
[ITINERARY_CONFIRMED] — emit when user approves the pre-itinerary summary and gives you the go-ahead to build the full itinerary.
[ACTIVITY_OK] — emit when user approves/confirms the current activity options shown to them. Use the same "clear signals" judgment as above — enthusiasm, a direct yes, asking a detail question about a specific option, all count.
[ACTIVITY_MORE] — emit when user wants to see different or additional options for the current activity category.
[ACTIVITY_SKIP] — emit when user explicitly wants to skip the current activity category entirely.

---

READING PEOPLE — THE MOST IMPORTANT SKILL

A real travel agent doesn't wait for clients to fill out a form or say a magic confirmation word. They read the room. They know when someone has made up their mind, when someone is still on the fence, and when they need a nudge. You do the same.

CLEAR SIGNALS — just act on these:
- "Let's do that one" / "book it" / "yeah that works" / "I'm going with the Delta" → confirmed, move forward
- "That hotel is sick" / "love this one" / "the second one for sure" → confirmed, acknowledge and move on
- "I want to hit the Hollywood Sign, Echo Park, and Griffith" → they just confirmed their must-sees, don't ask again
- Someone starts asking detailed questions about a specific option → they've mentally picked it, treat it as a yes and confirm warmly

AMBIGUOUS — ask one sharp, specific question:
- "This hotel is sick" (said without being asked to pick) → "Glad you like it — want me to lock in the [Hotel Name] and move on to activities?"
- "I'm down to do these activities" → "Perfect — locking in [Activity A] and [Activity B]. Should I pull up the nightlife options next?"
- "That flight looks decent" → "Should I lock that one in so we can get to hotels?"
- "These all look good" → "Any one calling your name more than the others, or should I pick my favorite for you?"

CLEARLY NOT A CONFIRMATION — stay in the current stage, respond naturally:
- Questions about the options ("what's the baggage policy?", "is that hotel near the beach?")
- Expressing general interest without picking ("I like the idea of a boutique hotel")
- Redirecting ("actually can we look at a different area?")

The instructions in this prompt tell you what to do at each stage of the trip. This section tells you to use your human judgment about WHEN to advance. Don't be a robot waiting for the word "yes." Don't be sloppy and assume when someone is clearly still browsing. Read the person. That's what makes a great agent great.

---

WHAT YOU NEVER DO

- Never ask all questions at once
- Never ask something the profile or conversation already answers
- Never make up specific prices or availability before real data arrives
- Never lock in a destination without explicit user confirmation
- Never present more than 3 options at once — curation is your value
- Never ignore a change mid-conversation — always acknowledge and adapt
- Never be generic — every recommendation should be specific to this traveler
- Never make specific budget verdicts like "tight" or "comfortable" without real flight and hotel data. You CAN and SHOULD give general budget reality checks based on your travel expertise — if someone says they want to spend $500 for a month in Mykonos, tell them directly and honestly that's not realistic and explain why. General budget wisdom is fine. What you must NEVER do is quote specific prices like "$150/night" or "$400 flights" without real data from the knowledge bank to back it up.
- Never assume the year — CRITICAL: The current year is 2026. Today is in April 2026. When users say "this summer", "next month", "in June" etc, they mean 2026. Never use 2025 or any past year for travel dates.`;
}

// Parse and strip special blocks from Claude's response.
// Returns { cleaned: string, toolCall: object|null }
function extractAndStripBlocks(text) {
  const toolCallRegex = /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]|\[TOOL_CALL\][\s\S]*$/g;
  const stateRegex    = /\[STATE\][\s\S]*?\[\/STATE\]|\[STATE\][\s\S]*$/g;

  let toolCall = null;

  for (const match of text.matchAll(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/g)) {
    try {
      toolCall = JSON.parse(match[1].trim());
      console.log('[TOOL_CALL]', toolCall);
    } catch {
      console.log('[TOOL_CALL] (raw)', match[1].trim());
    }
  }

  for (const match of text.matchAll(/\[STATE\]([\s\S]*?)\[\/STATE\]/g)) {
    try {
      console.log('[STATE]', JSON.parse(match[1].trim()));
    } catch {
      console.log('[STATE] (raw)', match[1].trim());
    }
  }

  const cleaned = text
    .replace(toolCallRegex, '')
    .replace(stateRegex, '')
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
    .trim();

  return { cleaned, toolCall };
}

async function streamClaude(systemPrompt, messages) {
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  let fullText = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      fullText += event.delta.text;
    }
  }
  return fullText;
}

function getLastUserMsg(msgs) {
  return [...msgs].reverse().find(m => m.role === 'user' && !(m.content || '').includes('['))?.content || '';
}

async function detectConfirmation(lastUserMsg, context) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{ role: 'user', content: `Context: ${context}. User said: "${lastUserMsg.slice(0, 300)}". Are they confirming/approving/selecting something specific, or still asking questions/undecided/browsing? Output ONLY: {"confirmed":true} or {"confirmed":false}` }],
    });
    const raw = msg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(raw).confirmed === true;
  } catch { return false; }
}

async function streamClaudeSSE(systemPrompt, messages, sendFn) {
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  // Tags to suppress from the live stream before they reach the client
  const SUPPRESS = {
    '[STATE]':     '[/STATE]',
    '[TOOL_CALL]': '[/TOOL_CALL]',
  };
  // Single-word signals to strip inline (no closing tag)
  const STRIP_INLINE = ['[FLIGHT_CONFIRMED]', '[HOTEL_CONFIRMED]', '[MUST_SEES_CONFIRMED]', '[ITINERARY_CONFIRMED]', '[ACTIVITY_OK]', '[ACTIVITY_MORE]', '[ACTIVITY_SKIP]', '[ACTIVITY_CHANGE]'];
  const START_TAGS = Object.keys(SUPPRESS);
  const MAX_TAG_LEN = Math.max(...START_TAGS.map(t => t.length));

  let fullText = '';
  let buffer = '';
  let suppressing = null; // closing tag we're currently waiting for

  for await (const event of stream) {
    if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') continue;
    fullText += event.delta.text;
    buffer  += event.delta.text;

    let output = '';
    // Process buffer until we can't make progress
    scan: while (buffer.length > 0) {
      if (suppressing) {
        const endIdx = buffer.indexOf(suppressing);
        if (endIdx !== -1) {
          buffer = buffer.slice(endIdx + suppressing.length);
          suppressing = null;
        } else {
          // Keep tail in case the closing tag is split across chunks
          buffer = buffer.slice(Math.max(0, buffer.length - (suppressing.length - 1)));
          break scan;
        }
      } else {
        // Find the earliest opening tag in the buffer
        let earliestIdx = -1;
        let earliestTag = null;
        for (const tag of START_TAGS) {
          const idx = buffer.indexOf(tag);
          if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
            earliestIdx = idx;
            earliestTag = tag;
          }
        }

        if (earliestIdx !== -1) {
          output  += buffer.slice(0, earliestIdx);
          buffer   = buffer.slice(earliestIdx + earliestTag.length);
          suppressing = SUPPRESS[earliestTag];
        } else {
          // No full tag found — hold back enough chars to catch a split tag
          const hold = MAX_TAG_LEN - 1;
          output += buffer.slice(0, buffer.length - hold);
          buffer  = buffer.slice(buffer.length - hold);
          break scan;
        }
      }
    }
    // Strip inline signals (no closing tag needed)
    for (const tag of STRIP_INLINE) output = output.split(tag).join('');
    if (output) sendFn({ type: 'delta', text: output });
  }

  // Flush any remainder that isn't inside a suppressed block
  let remainder = !suppressing ? buffer : '';
  for (const tag of STRIP_INLINE) remainder = remainder.split(tag).join('');
  if (remainder) sendFn({ type: 'delta', text: remainder });

  return fullText;
}

app.post('/api/chat', async (req, res) => {
  const { messages, profile, activityBank, selectedCards, flightsBank, hotelsBank } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const systemPrompt = buildSystemPrompt(profile);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // ── Extract full trip context from conversation history ────────────────
    // Scans hiddenMarker messages for [FLIGHTS_SHOWN] context (most reliable),
    // then falls back to [TOOL_CALL] blocks as a secondary source.
    function extractTripContextFromHistory(msgs) {
      let ctx = null;
      for (const msg of msgs) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const match = content.match(/\[FLIGHTS_SHOWN\] ({.+})/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            const dep = parsed.departure;
            const ret = parsed.return;
            if (dep && dep !== 'undefined' && ret && ret !== 'undefined') {
              ctx = parsed;
              break;
            }
          } catch {}
        }
      }
      if (!ctx) {
        for (const msg of msgs) {
          const content = typeof msg.content === 'string' ? msg.content : '';
          const match = content.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/);
          if (match) {
            try {
              const parsed = JSON.parse(match[1].trim());
              const dep = parsed.dates?.departure || parsed.dates?.check_in;
              const ret = parsed.dates?.return    || parsed.dates?.check_out;
              if (dep && dep !== 'undefined' && ret && ret !== 'undefined' && dep.startsWith('202')) {
                ctx = { departure: dep, return: ret, destination: parsed.destination, origin: parsed.origin, passengers: parsed.group_size, activities: parsed.activities };
                break;
              }
            } catch {}
          }
        }
      }
      if (!ctx) return null;
      // Apply any group-size updates emitted after initial fetch
      for (const msg of msgs) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const m = content.match(/\[GROUP_SIZE_UPDATE\]\{"passengers":(\d+)\}/);
        if (m) ctx = { ...ctx, passengers: parseInt(m[1]) };
      }
      console.log('[extractTripContext]', ctx);
      return ctx;
    }

    // ── Stage detection (runs before first Claude pass) ────────────────────
    const conversationText = messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    const flightsAlreadyShown  = conversationText.includes('[FLIGHTS_SHOWN]');
    const flightConfirmed      = conversationText.includes('[FLIGHT_CONFIRMED]');
    const hotelsAlreadyShown   = conversationText.includes('[HOTELS_SHOWN]');
    const hotelConfirmed       = conversationText.includes('[HOTEL_CONFIRMED]');
    const activitiesAsked      = conversationText.includes('[ACTIVITIES_ASKED]');
    const mustSeesShown        = conversationText.includes('[MUST_SEES_SHOWN]');
    const activitiesStarted    = conversationText.includes('[ACTIVITY_SHOWN]');
    const summaryShown         = conversationText.includes('[PRE_ITINERARY_SUMMARY_SHOWN]');
    const itineraryShown       = conversationText.includes('[ITINERARY_SHOWN]');


    console.log('[stage]', { flightsAlreadyShown, flightConfirmed, hotelsAlreadyShown, hotelConfirmed, activitiesAsked, mustSeesShown, activitiesStarted, summaryShown, itineraryShown, activityBankReady: !!(activityBank) });

    function parseActivityProgress(msgs) {
      const confirmedTypes = new Set();
      const shownOffsets = {};
      for (const msg of msgs) {
        const c = typeof msg.content === 'string' ? msg.content : '';
        for (const m of c.matchAll(/\[ACTIVITY_CONFIRMED\]\{"type":"([^"]+)"/g)) confirmedTypes.add(m[1]);
        for (const m of c.matchAll(/\[ACTIVITY_SHOWN\]\{"type":"([^"]+)","offset":(\d+)\}/g)) {
          const prev = shownOffsets[m[1]] ?? -1;
          if (parseInt(m[2]) > prev) shownOffsets[m[1]] = parseInt(m[2]);
        }
      }
      return { confirmedTypes, shownOffsets };
    }

    // ── STAGE 2: Hotels ────────────────────────────────────────────────────
    if (flightsAlreadyShown && !hotelsAlreadyShown) {
      if (!flightConfirmed) {
        const flightOptions = (selectedCards?.flights || []).map(f => `${f.id}: ${f.airline} $${f.price}`).join(' | ');
        const chatText = await streamClaude(systemPrompt, [
          ...messages,
          { role: 'user', content: `[FLIGHT_STAGE] The traveler has been shown these flight options: ${flightOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one — acknowledge it warmly, emit [FLIGHT_CONFIRMED], and output [FLIGHT_SELECTED]{"id":"flight_X"} with the exact id.\n- If they're asking for DIFFERENT or MORE flights (e.g. "cheaper", "direct", "another airline", "show me more", "nothing direct?") — emit [TOOL_CALL]{"action":"refetch_flights","preference":"<their preference in 2-3 words>"}[/TOOL_CALL] and briefly acknowledge you're checking more options.\n- If genuinely undecided, help them decide.` },
        ]);
        const hasSignal = chatText.includes('[FLIGHT_CONFIRMED]');
        const { cleaned: chatCleaned, toolCall: flightToolCall } = extractAndStripBlocks(chatText);

        // ── Flight refetch: user wants different options ─────────────────
        if (!hasSignal && flightToolCall?.action === 'refetch_flights') {
          const preference = flightToolCall.preference || '';
          console.log('[Stage 2] flight refetch detected | preference:', preference);
          if (chatCleaned) send({ type: 'delta', text: chatCleaned });
          send({ type: 'fetching' });

          // Check reserves first (unseen flights from original bank), sorted by preference
          const shownIds = new Set((selectedCards?.flights || []).map(f => f.id));
          const rawReserves = (flightsBank || []).filter(f => !shownIds.has(f.id));
          const reserves = sortFlightPoolByPreference(rawReserves, preference);

          let flightPool, newBankFull;
          if (reserves.length >= 3) {
            flightPool = reserves;
            newBankFull = flightsBank;
            console.log('[Stage 2] serving flight refetch from reserves:', reserves.length);
          } else {
            console.log('[Stage 2] flight reserves exhausted — fresh API call');
            const ctx = extractTripContextFromHistory(messages);
            const freshRaw = await fetchFlights(ctx.origin, ctx.destination, ctx.departure, ctx.return, ctx.passengers).catch(e => {
              console.error('[Stage 2] fetchFlights refetch error:', e.message);
              return [];
            });
            flightPool = sortFlightPoolByPreference(freshRaw.map((f, i) => ({ ...f, id: `flight_r${i}` })), preference);
            newBankFull = flightPool;
          }

          const selText = await streamClaude(systemPrompt, [
            ...messages,
            { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights: flightPool }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nThe traveler wants ${preference || 'different'} flights. The list is already sorted with best matches first. Output only [SELECTED_FLIGHTS]{"ids":["flight_X","flight_Y","flight_Z"]}[/SELECTED_FLIGHTS] picking the top 3. Nothing else.` },
          ]);

          let newFlightCards;
          const selM = selText.match(/\[SELECTED_FLIGHTS\]([\s\S]*?)\[\/SELECTED_FLIGHTS\]/);
          if (selM) {
            try {
              const { ids } = JSON.parse(selM[1].trim());
              const idMap = Object.fromEntries(flightPool.map(f => [f.id, f]));
              const ordered = ids.map(id => idMap[id]).filter(Boolean);
              newFlightCards = ordered.length > 0 ? ordered : flightPool.slice(0, 3);
            } catch { newFlightCards = flightPool.slice(0, 3); }
          } else {
            newFlightCards = flightPool.slice(0, 3);
          }

          const presentText = await streamClaude(systemPrompt, [
            ...messages,
            { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights: newFlightCards }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[FLIGHTS_SHOWN]\n\nThe traveler asked for ${preference || 'different'} flights. Present ONLY these 3 flights using their exact details. Acknowledge their preference warmly. Ask which works for them.` },
          ]);

          const { cleaned: presentCleaned } = extractAndStripBlocks(presentText);
          send({ type: 'knowledge_bank', data: { flights: newFlightCards, hotels: [], activities: [], flightsBankFull: newBankFull } });
          if (presentCleaned) send({ type: 'delta', text: presentCleaned });
          send({ type: 'done' });
          res.end();
          return;
        }

        if (chatCleaned) send({ type: 'delta', text: chatCleaned });
        if (!hasSignal) {
          send({ type: 'done' });
          res.end();
          return;
        }
        send({ type: 'marker', content: '[FLIGHT_CONFIRMED]' });
        // Identify and emit the specifically confirmed flight
        const flightSelMatch = chatText.match(/\[FLIGHT_SELECTED\]\{"id":"([^"]+)"\}/);
        const confirmedFlight = flightSelMatch
          ? (selectedCards?.flights || []).find(f => f.id === flightSelMatch[1])
          : null;
        const lockedFlight = confirmedFlight || (selectedCards?.flights?.[0] ?? null);
        if (lockedFlight?.id) send({ type: 'marker', content: `[FLIGHT_LOCKED]{"id":"${lockedFlight.id}"}` });
        send({ type: 'flight_confirmed', data: { flight: lockedFlight } });
      }
      send({ type: 'fetching' });

      const ctx = extractTripContextFromHistory(messages);
      const destination = ctx?.destination || '';
      const checkIn     = ctx?.departure;
      const checkOut    = ctx?.return;
      const passengers  = ctx?.passengers ?? 1;

      console.log('[Stage 2] destination:', destination, '| dates:', checkIn, '→', checkOut, '| passengers:', passengers);

      const [hotelsResult] = await Promise.allSettled([
        fetchHotels(destination, checkIn, checkOut, passengers),
      ]);

      const hotelsRaw = hotelsResult.status === 'fulfilled' ? hotelsResult.value : [];
      if (hotelsResult.status === 'rejected') console.error('fetchHotels error:', hotelsResult.reason?.message);
      const hotels = hotelsRaw.map((h, i) => ({ ...h, id: `hotel_${i}` }));
      console.log('[HOTELS_BANK] hotels:', hotels.length, 'results');

      send({ type: 'marker', content: `[HOTELS_SHOWN] {"departure":"${checkIn}","return":"${checkOut}","destination":"${destination}"}` });

      const hotelBase = [
        ...messages,
        { role: 'assistant', content: "Let me pull up the best hotels for you!" },
      ];

      // Call 1: selection only
      const hotelSelectText = await streamClaude(systemPrompt, [
        ...hotelBase,
        {
          role: 'user',
          content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nDo not respond to the user yet. Output only [SELECTED_HOTELS]{"ids":["hotel_X","hotel_Y","hotel_Z"]}[/SELECTED_HOTELS] where the ids are in the order you will present them — first id is your Option 1, second is Option 2, third is Option 3. Nothing else.`,
        },
      ]);

      let hotelCards;
      const hotelSelMatch = hotelSelectText.match(/\[SELECTED_HOTELS\]([\s\S]*?)\[\/SELECTED_HOTELS\]/);
      if (hotelSelMatch) {
        try {
          const { ids } = JSON.parse(hotelSelMatch[1].trim());
          const idMap = Object.fromEntries(hotels.map(h => [h.id, h]));
          const ordered = ids.map(id => idMap[id]).filter(Boolean);
          hotelCards = ordered.length > 0 ? ordered : hotels.slice(0, 3);
          console.log('[Stage 2] selected hotel ids:', ids);
        } catch { hotelCards = hotels.slice(0, 3); }
      } else {
        hotelCards = hotels.slice(0, 3);
      }

      // Call 2: present selected hotels to traveler
      const hotelPresentText = await streamClaude(systemPrompt, [
        ...hotelBase,
        {
          role: 'user',
          content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels: hotelCards }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[HOTELS_SHOWN]\n\nIMPORTANT: Present ONLY these 3 hotels to the traveler using their exact names and prices from the knowledge bank. Do NOT invent or alter any details. After presenting, ask which one they prefer before moving to activities.`,
        },
      ]);

      const { cleaned: hotelCleaned } = extractAndStripBlocks(hotelPresentText);
      send({ type: 'hotels_bank', data: { hotels: hotelCards, activities: [], hotelsBankFull: hotels } });
      if (hotelCleaned) send({ type: 'delta', text: hotelCleaned });

      send({ type: 'done' });
      res.end();
      return;
    }

    // ── STAGE 2.5: Ask about activities ───────────────────────────────────
    if (flightsAlreadyShown && hotelsAlreadyShown && !activitiesAsked) {
      let hotelConfirmationText = null;
      if (!hotelConfirmed) {
        const hotelOptions = (selectedCards?.hotels || []).map(h => `${h.id}: ${h.name}`).join(' | ');
        const chatText = await streamClaude(systemPrompt, [
          ...messages,
          { role: 'user', content: `[HOTEL_STAGE] The traveler has been shown these hotel options: ${hotelOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one of the listed options — acknowledge it warmly, emit [HOTEL_CONFIRMED], and output [HOTEL_SELECTED]{"id":"hotel_X"} with the exact id.\n- If they're asking for DIFFERENT or MORE options (e.g. "more high end", "cheaper", "boutique", "show me others") — emit [TOOL_CALL]{"action":"refetch_hotels","accommodation_style":"<their preference in 2-3 words>"}[/TOOL_CALL] and briefly acknowledge you're finding more options.\n- If they're changing the GROUP SIZE (e.g. "actually we're 5", "change to 3 people", "make it 4 guests", "just 2 of us") — emit [TOOL_CALL]{"action":"refetch_hotels","accommodation_style":"","new_group_size":<the number as integer>}[/TOOL_CALL] and acknowledge the change warmly.\n- If genuinely undecided, help them decide.` },
        ]);
        const hasConfirm  = chatText.includes('[HOTEL_CONFIRMED]');
        const { cleaned: chatCleaned, toolCall: hotelToolCall } = extractAndStripBlocks(chatText);

        // ── Hotel refetch: user wants different options or changed group size ──
        if (!hasConfirm && hotelToolCall?.action === 'refetch_hotels') {
          const accommodationStyle = hotelToolCall.accommodation_style || '';
          const newGroupSize = hotelToolCall.new_group_size ? parseInt(hotelToolCall.new_group_size) : null;
          console.log('[Stage 2.5] hotel refetch detected | style:', accommodationStyle, '| new group size:', newGroupSize);

          if (chatCleaned) send({ type: 'delta', text: chatCleaned });
          send({ type: 'fetching' });

          // Emit group size update marker so all future fetches use the new count
          if (newGroupSize) {
            send({ type: 'marker', content: `[GROUP_SIZE_UPDATE]{"passengers":${newGroupSize}}` });
          }

          const ctx = extractTripContextFromHistory(messages);
          const passengers = newGroupSize || ctx?.passengers || 1;

          // Skip reserves if group size changed (need a fresh fetch with new passenger count)
          const shownHotelIds = new Set((selectedCards?.hotels || []).map(h => h.id));
          const hotelReserves = newGroupSize ? [] : sortHotelPoolByStyle(
            (hotelsBank || []).filter(h => !shownHotelIds.has(h.id)),
            accommodationStyle
          );

          let hotels, newHotelsBankFull;
          if (hotelReserves.length >= 3) {
            hotels = hotelReserves;
            newHotelsBankFull = hotelsBank;
            console.log('[Stage 2.5] serving hotel refetch from reserves:', hotelReserves.length);
          } else {
            console.log('[Stage 2.5] fresh hotel API call | style:', accommodationStyle, '| passengers:', passengers);
            const destination = ctx?.destination || '';
            const checkIn     = ctx?.departure;
            const checkOut    = ctx?.return;
            const hotelsRaw = await fetchHotels(destination, checkIn, checkOut, passengers, accommodationStyle).catch(e => {
              console.error('[Stage 2.5] fetchHotels error:', e.message);
              return [];
            });
            hotels = hotelsRaw.map((h, i) => ({ ...h, id: `hotel_r${i}` }));
            newHotelsBankFull = hotels;
          }
          console.log('[Stage 2.5] hotel pool for refetch:', hotels.length, '| top price:', hotels[0]?.price);

          // Select 3 best matching the user's preference — pool is already sorted by style
          const selectText = await streamClaude(systemPrompt, [
            ...messages,
            {
              role: 'user',
              content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nThe traveler wants ${accommodationStyle || 'different'} hotels. The list is already sorted with the best matches first. Output only [SELECTED_HOTELS]{"ids":["hotel_X","hotel_Y","hotel_Z"]}[/SELECTED_HOTELS] picking the top 3 hotels that best match their preference — favour the ones at the top of the list. Nothing else.`,
            },
          ]);

          let hotelCards;
          const selMatch = selectText.match(/\[SELECTED_HOTELS\]([\s\S]*?)\[\/SELECTED_HOTELS\]/);
          if (selMatch) {
            try {
              const { ids } = JSON.parse(selMatch[1].trim());
              const idMap = Object.fromEntries(hotels.map(h => [h.id, h]));
              const ordered = ids.map(id => idMap[id]).filter(Boolean);
              hotelCards = ordered.length > 0 ? ordered : hotels.slice(0, 3);
            } catch { hotelCards = hotels.slice(0, 3); }
          } else {
            hotelCards = hotels.slice(0, 3);
          }

          send({ type: 'hotels_bank', data: { hotels: hotelCards, hotelsBankFull: newHotelsBankFull } });

          const presentText = await streamClaude(systemPrompt, [
            ...messages,
            {
              role: 'user',
              content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ hotels: hotelCards }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[HOTELS_SHOWN]\n\nThe traveler asked for ${accommodationStyle || 'different'} options. Present ONLY these 3 hotels using their exact names and prices. Acknowledge their preference warmly. Then ask which they prefer.`,
            },
          ]);

          const { cleaned: presentCleaned } = extractAndStripBlocks(presentText);
          if (presentCleaned) send({ type: 'delta', text: presentCleaned });

          send({ type: 'done' });
          res.end();
          return;
        }

        if (chatCleaned) send({ type: 'delta', text: chatCleaned });
        if (!hasConfirm) {
          send({ type: 'done' });
          res.end();
          return;
        }
        send({ type: 'marker', content: '[HOTEL_CONFIRMED]' });
        // Identify and emit the specifically confirmed hotel
        const hotelSelMatch = chatText.match(/\[HOTEL_SELECTED\]\{"id":"([^"]+)"\}/);
        const confirmedHotel = hotelSelMatch
          ? (selectedCards?.hotels || []).find(h => h.id === hotelSelMatch[1])
          : null;
        const lockedHotel = confirmedHotel || (selectedCards?.hotels?.[0] ?? null);
        if (lockedHotel?.id) send({ type: 'marker', content: `[HOTEL_LOCKED]{"id":"${lockedHotel.id}"}` });
        send({ type: 'hotel_confirmed', data: { hotel: lockedHotel } });
        hotelConfirmationText = chatCleaned;
      }

      // When confirming hotel this turn, inject that response as context so
      // the activities question call knows the hotel is already locked in.
      const activityAskInstruction = { role: 'user', content: '[HOTEL_CONFIRMED]\n\nHotel is locked in. Ask the traveler ONE short, conversational question about what they want to do on this trip. Reference their profile interests to make it personal to this specific trip. OUTPUT ONLY THE QUESTION — do not answer it yourself, do not present any lists, do not continue past the question. The traveler has not replied yet. Stop after asking.' };
      const askMessages = hotelConfirmationText
        ? [
            ...messages,
            { role: 'assistant', content: hotelConfirmationText },
            activityAskInstruction,
          ]
        : [...messages, activityAskInstruction];

      const askText = await streamClaude(systemPrompt, askMessages);
      const { cleaned } = extractAndStripBlocks(askText);
      if (cleaned) send({ type: 'delta', text: cleaned });
      send({ type: 'marker', content: '[ACTIVITIES_ASKED]' });
      send({ type: 'done' });
      res.end();
      return;
    }

    // ── STAGE 2.6: Fetch activities (parallel) + show must-sees ──────────
    if (flightsAlreadyShown && hotelsAlreadyShown && activitiesAsked && !mustSeesShown) {
      const ctx = extractTripContextFromHistory(messages);
      const destination = ctx?.destination || 'the destination';
      let activityTypes = ctx?.activities || [];

      // Extract activity types from conversation before kicking off fetch
      try {
        const extractMsg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          messages: [
            ...messages.slice(-4),
            { role: 'user', content: `Based on what the traveler said they want to do, output ONLY valid JSON: {"types":["term1","term2",...]}. Include every distinct activity category they mentioned as a short search term. No other text.` },
          ],
        });
        const raw = extractMsg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const { types } = JSON.parse(raw);
        if (Array.isArray(types) && types.length > 0) activityTypes = types;
        console.log('[Stage 2.6] activity types:', activityTypes);
      } catch (e) { console.warn('[Stage 2.6] type extraction failed:', e.message); }

      // Kick off activity fetch in parallel — don't await yet
      const fetchPromise = fetchActivities(destination, activityTypes);

      // Stream must-sees while activities are being fetched in the background
      await streamClaudeSSE(systemPrompt, [
        ...messages,
        { role: 'user', content: `[MUST_SEES_STAGE] destination="${destination}"\n\nThe traveler just told you their activity preferences. Acknowledge what they said, then present the two lists as instructed (The Icons and Hidden Gems). Ask which they want to make sure they hit.` },
      ], send);

      // Now await the completed fetch and emit the bank
      const bank = await fetchPromise;
      console.log('[Stage 2.6] activity bank ready:', bank.types);
      send({ type: 'activity_bank_ready', data: bank });
      send({ type: 'marker', content: '[MUST_SEES_SHOWN]' });
      send({ type: 'done' });
      res.end();
      return;
    }

    // ── STAGE 2.7: Must-sees confirmation → present first activity type ───
    if (flightsAlreadyShown && hotelsAlreadyShown && activitiesAsked && mustSeesShown && !activitiesStarted && !itineraryShown) {
      console.log('[Stage 2.7] entered — waiting for [MUST_SEES_CONFIRMED] signal, activityBank present:', !!(activityBank));
      const chatText = await streamClaude(systemPrompt, [
        ...messages,
        { role: 'user', content: '[MUST_SEES_STAGE] The traveler has been shown two lists: The Icons and Hidden Gems. Read their latest message. If they picked any attractions, mentioned specific places, or gave any substantive reply about what they want to see — acknowledge their picks, and emit [MUST_SEES_CONFIRMED]. Any reply that selects or mentions specific places counts. Only stay in this stage if they are genuinely asking follow-up questions about the lists.' },
      ]);
      console.log('[Stage 2.7] hasSignal:', chatText.includes('[MUST_SEES_CONFIRMED]'));
      const hasSignal = chatText.includes('[MUST_SEES_CONFIRMED]');
      const { cleaned: chatCleaned } = extractAndStripBlocks(chatText);
      if (chatCleaned) send({ type: 'delta', text: chatCleaned });
      if (!hasSignal) {
        send({ type: 'done' });
        res.end();
        return;
      }
      send({ type: 'marker', content: '[MUST_SEES_CONFIRMED]' });

      // Confirmed — get activity bank (re-fetch if client state was lost)
      send({ type: 'fetching' });
      let bank = activityBank;
      if (!bank) {
        console.log('[Stage 2.7] activityBank missing — re-fetching');
        const ctx = extractTripContextFromHistory(messages);
        const destination = ctx?.destination || 'the destination';
        let activityTypes = ctx?.activities || [];
        try {
          const extractMsg = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 120,
            messages: [
              ...messages.slice(-6),
              { role: 'user', content: `Based on what the traveler said they want to do, output ONLY valid JSON: {"types":["term1","term2",...]}. Include every distinct activity category as a short search term. No other text.` },
            ],
          });
          const raw = extractMsg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          const { types } = JSON.parse(raw);
          if (Array.isArray(types) && types.length > 0) activityTypes = types;
        } catch (e) { console.warn('[Stage 2.7] re-extraction failed:', e.message); }
        bank = await fetchActivities(destination, activityTypes);
        send({ type: 'activity_bank_ready', data: bank });
      }
      const firstType = bank.types[0];
      const firstPool = bank.byType[firstType] || [];

      const firstText = await streamClaude(systemPrompt, [
        ...messages,
        { role: 'assistant', content: `Perfect, got your must-sees locked in! Now let me pull up the best spots for your activities.` },
        { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType: firstType, activities: firstPool }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nFirst output [SELECTED_ACTIVITIES]{"ids":["id1","id2"]}[/SELECTED_ACTIVITIES] selecting the 2 best "${firstType}" options. Then present those 2 to the traveler with personality. Ask if these work or if they'd like different options.` },
      ]);

      let firstCards = firstPool.slice(0, 2);
      const selM = firstText.match(/\[SELECTED_ACTIVITIES\]([\s\S]*?)\[\/SELECTED_ACTIVITIES\]/);
      if (selM) {
        try {
          const { ids } = JSON.parse(selM[1].trim());
          const idMap = Object.fromEntries(firstPool.map(a => [a.id, a]));
          const sel = ids.map(id => idMap[id]).filter(Boolean);
          if (sel.length > 0) firstCards = sel;
        } catch {}
      }

      const { cleaned: firstCleaned } = extractAndStripBlocks(firstText);
      send({ type: 'activities_bank', data: { activities: firstCards, activityType: firstType } });
      if (firstCleaned) send({ type: 'delta', text: firstCleaned });
      send({ type: 'marker', content: `[ACTIVITY_SHOWN]{"type":${JSON.stringify(firstType)},"offset":0}` });
      send({ type: 'done' });
      res.end();
      return;
    }

    // ── STAGE 3b: Handle yes/no per type, advance through all types ────────
    if (flightsAlreadyShown && hotelsAlreadyShown && activitiesAsked && mustSeesShown && activitiesStarted && !itineraryShown) {

      // ── Pre-itinerary summary confirmation ────────────────────────────────
      if (summaryShown) {
        const chatText = await streamClaude(systemPrompt, [
          ...messages,
          { role: 'user', content: `[ITINERARY_STAGE] The traveler has been shown a full summary of everything locked in. If they approve it, say it looks good, or give the go-ahead in any form — emit [ITINERARY_CONFIRMED]. Only stay in this stage if they want to change something specific. IMPORTANT: Do NOT reprint or echo back the summary under any circumstances — the traveler can already see it. Respond briefly and naturally.` },
        ]);
        const hasSignal = chatText.includes('[ITINERARY_CONFIRMED]');
        const { cleaned: chatCleaned } = extractAndStripBlocks(chatText);
        if (!hasSignal) {
          if (chatCleaned) send({ type: 'delta', text: chatCleaned });
          send({ type: 'done' });
          res.end();
          return;
        }
        send({ type: 'fetching' });
        const ctx = extractTripContextFromHistory(messages);
        await streamClaudeSSE(systemPrompt, [
          ...messages,
          { role: 'user', content: `[ITINERARY_MODE]\nTrip context: ${JSON.stringify(ctx)}\nConfirmed selections: ${JSON.stringify(selectedCards)}\n\nBuild the traveler's final playbook. This is the product they hired you for.\n\nBEFORE WRITING — run these checks:\n1. What actual day of the week is each date in the trip? Label every day with BOTH the date and the day name (e.g. "Saturday, Aug 15").\n2. Outbound flight departure time: work backwards to get hotel departure time. Domestic = arrive airport 2hrs early + actual transit time from hotel. International = 3hrs early. Never less.\n3. Return flight: same calculation on departure day.\n4. NIGHTLIFE SCHEDULING — follow this logic in order:
   a. Identify all Friday and Saturday nights in the trip. These are your primary nightlife nights.
   b. Is this a party-focused trip? (spring break, music festival, bachelor/bachelorette, music week, group party trip, etc.) If yes, any night is fair game for nightlife.
   c. If not a party trip: count how many nightlife venues are confirmed vs how many Fri/Sat nights exist. If confirmed nightlife venues ≤ Fri/Sat nights available, keep everything on Fri/Sat only. If there are MORE nightlife venues than Fri/Sat nights, overflow to Sunday first, then weekdays as a last resort.
   d. When assigning multiple nightlife venues across nights: best/most notable venue goes on Saturday, second best on Friday, least hype goes on overflow nights.
   e. Never put any nightlife on a non-weekend night if a Fri/Sat is still available and unclaimed.\n5. Verify every confirmed must-see, activity venue, flight, and hotel from the confirmed selections appears by name in the itinerary.\n\nSTRUCTURE:\n- Open with ONE warm sentence: acknowledge you built this around their confirmed picks and personally filled the gaps — invite them to push back on anything.\n- Trip header: destination, dates, total nights, confirmed hotel.\n- Day-by-day with date + day of week + one-word vibe per day.\n- Close with a "Before You Go" section: reservations to make, anything to book online in advance, 1–2 practical tips.\n\nDAILY RULES:\n- Every time block = a named place + a purpose. No vague entries.\n- Every meal = a specific named restaurant, one-line reason, note if reservation needed.\n- Max 3–4 major things per day.\n- Outdoor/hikes in the morning before heat peaks.\n- Clubs after 10:30pm minimum.\n- Realistic city transit between venues (LA cross-city = 25–35 min Uber).\n- Warm and specific throughout — brilliant friend giving advice, not a printed PDF.` },
        ], send);
        {
          // Reconstruct confirmed flight + hotel from locked markers + banks (most reliable)
          let itinFlight = null, itinHotel = null;
          for (const msg of messages) {
            const c = typeof msg.content === 'string' ? msg.content : '';
            const fm = c.match(/\[FLIGHT_LOCKED\]\{"id":"([^"]+)"\}/);
            if (fm) {
              const id = fm[1];
              itinFlight = (flightsBank || []).find(f => f.id === id)
                        || (selectedCards?.flights || []).find(f => f.id === id)
                        || null;
            }
            const hm = c.match(/\[HOTEL_LOCKED\]\{"id":"([^"]+)"\}/);
            if (hm) {
              const id = hm[1];
              itinHotel = (hotelsBank || []).find(h => h.id === id)
                       || (selectedCards?.hotels || []).find(h => h.id === id)
                       || null;
            }
          }
          // Fall back to first item in selectedCards if markers missing (older sessions)
          if (!itinFlight) itinFlight = (selectedCards?.flights || [])[0] ?? null;
          if (!itinHotel)  itinHotel  = (selectedCards?.hotels  || [])[0] ?? null;

          // Activities: use selectedCards.activities directly — it's accumulated correctly
          // via activity_confirmed events and is always accurate
          const itineraryActivities = selectedCards?.activities || [];
          console.log('[itinerary_bank] flight:', itinFlight?.airline, '| hotel:', itinHotel?.name, '| activities:', itineraryActivities.map(a => a.title));
          send({ type: 'itinerary_bank', data: {
            flights:    itinFlight ? [itinFlight] : [],
            hotels:     itinHotel  ? [itinHotel]  : [],
            activities: itineraryActivities,
          } });
        }
        send({ type: 'marker', content: '[ITINERARY_SHOWN]' });
        send({ type: 'done' });
        res.end();
        return;
      }

      let bank = activityBank;
      if (!bank) {
        console.log('[Stage 3b] activityBank missing — re-fetching');
        const ctx = extractTripContextFromHistory(messages);
        const destination = ctx?.destination || 'the destination';
        let activityTypes = ctx?.activities || [];
        try {
          const extractMsg = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 120,
            messages: [
              ...messages.slice(-6),
              { role: 'user', content: `Based on what the traveler said they want to do, output ONLY valid JSON: {"types":["term1","term2",...]}. Include every distinct activity category as a short search term. No other text.` },
            ],
          });
          const raw = extractMsg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          const { types } = JSON.parse(raw);
          if (Array.isArray(types) && types.length > 0) activityTypes = types;
        } catch (e) { console.warn('[Stage 3b] re-extraction failed:', e.message); }
        bank = await fetchActivities(destination, activityTypes);
        send({ type: 'activity_bank_ready', data: bank });
      }

      const { confirmedTypes, shownOffsets } = parseActivityProgress(messages);

      const pendingType = bank.types.find(t =>
        Object.prototype.hasOwnProperty.call(shownOffsets, t) && !confirmedTypes.has(t)
      );

      console.log('[Stage 3b] confirmed:', [...confirmedTypes], '| pending:', pendingType);

      // All types confirmed — show pre-itinerary summary for confirmation
      if (!pendingType) {
        const summaryCtx = extractTripContextFromHistory(messages);
        const summaryNights = summaryCtx?.departure && summaryCtx?.return
          ? Math.round((new Date(summaryCtx.return) - new Date(summaryCtx.departure)) / (1000 * 60 * 60 * 24))
          : null;
        const summaryPax = summaryCtx?.passengers ?? 1;
        await streamClaudeSSE(systemPrompt, [
          ...messages,
          { role: 'user', content: `[PRE_ITINERARY_SUMMARY]\nConfirmed selections: ${JSON.stringify(selectedCards)}\nTrip details: ${summaryPax} traveler(s), departing ${summaryCtx?.departure} returning ${summaryCtx?.return}${summaryNights ? ` (${summaryNights} nights)` : ''}.\n\nAll activity categories have been confirmed. Give the traveler a clean summary of everything locked in: the flight (airline, route, departure/arrival times, price per person${summaryPax > 1 ? ` and total for ${summaryPax}` : ''}), the hotel (name, price per night, total for ${summaryNights ?? 'N'} nights), all must-see attractions and hidden gems they said yes to, and each activity category with the specific venues confirmed. Include a realistic total trip cost estimate — flight price is per person, hotel price is per night. Keep it organized and easy to scan. End with: "Does everything look good to you? If you're happy with the plan, I'll build your full day-by-day itinerary right now — or just let me know if you'd like to swap anything out."` },
        ], send);
        send({ type: 'marker', content: '[PRE_ITINERARY_SUMMARY_SHOWN]' });
        send({ type: 'done' });
        res.end();
        return;
      }

      // Build current shown activities for this pending type
      const currentOffset = shownOffsets[pendingType] || 0;
      const currentShown = (bank.byType[pendingType] || []).slice(currentOffset, currentOffset + 2);
      const activityOptions = currentShown.map(a => `${a.id}: ${a.title}`).join(' | ');

      // Sonnet handles the user's reply and emits an action signal
      const chatText = await streamClaude(systemPrompt, [
        ...messages,
        { role: 'user', content: `[ACTIVITY_STAGE] The traveler was shown these 2 "${pendingType}" options: ${activityOptions}. Read their latest message using READING PEOPLE judgment.\n\n- If they picked one or more — emit [ACTIVITY_OK] AND output [ACTIVITY_SELECTED]{"ids":["id_X"]} with the IDs of the specific activities they want.\n- If they want to see MORE different options for the SAME category ("these are too expensive", "show me others", "not feeling these") — emit [ACTIVITY_MORE].\n- If they want a COMPLETELY DIFFERENT category instead ("actually I don't want hiking", "forget that, I want food tours", "skip this, what about art?") — emit [ACTIVITY_CHANGE]{"new_type":"<exact replacement category in 2-3 words>"} and acknowledge warmly.\n- If they want to skip this category entirely — emit [ACTIVITY_SKIP].\n- Err on the side of [ACTIVITY_OK] for any positive or specific reply.\n- IMPORTANT: Do NOT name specific venues for any next category — just acknowledge warmly and say you're pulling up the options.` },
      ]);
      const { cleaned: chatCleaned, toolCall: actToolCall } = extractAndStripBlocks(chatText);
      if (chatCleaned) send({ type: 'delta', text: chatCleaned });

      let action = null;
      if (chatText.includes('[ACTIVITY_OK]')) action = 'confirm';
      else if (chatText.includes('[ACTIVITY_CHANGE]') || actToolCall?.action === 'activity_change') action = 'change';
      else if (chatText.includes('[ACTIVITY_MORE]')) action = 'more';
      else if (chatText.includes('[ACTIVITY_SKIP]')) action = 'skip';

      // No signal — user is still discussing, stay in stage
      if (!action) {
        send({ type: 'done' });
        res.end();
        return;
      }

      console.log(`[Stage 3b] pendingType="${pendingType}" action="${action}"`);

      // User wants a completely different activity category
      if (action === 'change') {
        const changeMatch = chatText.match(/\[ACTIVITY_CHANGE\]\{"new_type":"([^"]+)"\}/);
        const newType = changeMatch?.[1] || actToolCall?.new_type || '';
        console.log(`[Stage 3b] activity change: "${pendingType}" → "${newType}"`);
        if (newType) {
          send({ type: 'fetching' });
          const ctx = extractTripContextFromHistory(messages);
          const dest = ctx?.destination || 'the destination';
          const freshBank = await fetchActivities(dest, [newType]).catch(e => {
            console.error('[Stage 3b] fetchActivities change error:', e.message);
            return { types: [newType], byType: { [newType]: [] } };
          });
          // Merge new type into existing bank; drop old pendingType
          const mergedTypes = bank.types.map(t => t === pendingType ? newType : t);
          const mergedByType = { ...bank.byType, [newType]: freshBank.byType[newType] || [] };
          delete mergedByType[pendingType];
          const updatedBank = { types: mergedTypes, byType: mergedByType };
          send({ type: 'activity_bank_ready', data: updatedBank });

          const newPool = (updatedBank.byType[newType] || []).slice(0, 2);
          const presentText = await streamClaude(systemPrompt, [
            ...messages,
            { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType: newType, activities: newPool }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nPresent these 2 "${newType}" options with personality. Ask if any work.` },
          ]);
          const { cleaned } = extractAndStripBlocks(presentText);
          send({ type: 'activities_bank', data: { activities: newPool, activityType: newType } });
          if (cleaned) send({ type: 'delta', text: cleaned });
          send({ type: 'marker', content: `[ACTIVITY_SHOWN]{"type":${JSON.stringify(newType)},"offset":0}` });
        }
        send({ type: 'done' });
        res.end();
        return;
      }

      // User wants more options for pendingType
      if (action === 'more') {
        const offset = (shownOffsets[pendingType] ?? 0) + 2;
        const morePool = (bank.byType[pendingType] || []).slice(offset, offset + 2);

        if (morePool.length > 0) {
          send({ type: 'fetching' });
          const moreText = await streamClaude(systemPrompt, [
            ...messages,
            { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType: pendingType, activities: morePool }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nPresent these additional "${pendingType}" alternatives with personality. Ask if any of these work.` },
          ]);
          const { cleaned } = extractAndStripBlocks(moreText);
          send({ type: 'activities_bank', data: { activities: morePool, activityType: pendingType } });
          if (cleaned) send({ type: 'delta', text: cleaned });
          send({ type: 'marker', content: `[ACTIVITY_SHOWN]{"type":${JSON.stringify(pendingType)},"offset":${offset}}` });
          send({ type: 'done' });
          res.end();
          return;
        }

        // Bank exhausted — fresh API fetch for same type
        console.log(`[Stage 3b] activity bank exhausted for "${pendingType}" — fresh API call`);
        send({ type: 'fetching' });
        const ctx = extractTripContextFromHistory(messages);
        const dest = ctx?.destination || 'the destination';
        const freshBank = await fetchActivities(dest, [pendingType]).catch(e => {
          console.error('[Stage 3b] fetchActivities refetch error:', e.message);
          return { types: [pendingType], byType: { [pendingType]: [] } };
        });
        const freshPool = (freshBank.byType[pendingType] || []).slice(0, 2);
        if (freshPool.length > 0) {
          const freshText = await streamClaude(systemPrompt, [
            ...messages,
            { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType: pendingType, activities: freshPool }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nPresent these alternative "${pendingType}" options with personality. Ask if any of these work.` },
          ]);
          const { cleaned } = extractAndStripBlocks(freshText);
          send({ type: 'activities_bank', data: { activities: freshPool, activityType: pendingType } });
          if (cleaned) send({ type: 'delta', text: cleaned });
          send({ type: 'marker', content: `[ACTIVITY_SHOWN]{"type":${JSON.stringify(pendingType)},"offset":${offset}}` });
          send({ type: 'done' });
          res.end();
          return;
        }
        // Still nothing — fall through to confirm
        action = 'confirm';
      }

      // Dedicated selection-only call — mirrors flight/hotel pattern for reliability
      const actSelectText = await streamClaude(systemPrompt, [
        ...messages,
        { role: 'user', content: `The traveler just confirmed some "${pendingType}" activities. Options shown:\n${currentShown.map(a => `${a.id}: ${a.title}`).join('\n')}\n\nBased on their latest message, which specific one(s) did they pick? Output ONLY this exact format with no other text:\n[ACTIVITY_SELECTED]{"ids":["id_here"]}\nIf they picked a specific one by name, include only that ID. If they approved all/both, include all IDs.` },
      ]);
      console.log('[Stage 3b] actSelectText:', actSelectText);
      let confirmedActivities = currentShown; // fallback: all shown
      const idsMatch = actSelectText.match(/"ids"\s*:\s*\[([^\]]*)\]/);
      if (idsMatch) {
        try {
          const ids = JSON.parse(`[${idsMatch[1]}]`);
          const filtered = ids.map(id => currentShown.find(a => a.id === id)).filter(Boolean);
          if (filtered.length > 0) confirmedActivities = filtered;
        } catch {}
      }
      send({ type: 'activity_confirmed', data: { activities: confirmedActivities } });
      send({ type: 'marker', content: `[ACTIVITY_CONFIRMED]{"type":${JSON.stringify(pendingType)},"ids":${JSON.stringify(confirmedActivities.map(a => a.id))}}` });
      // Find next unconfirmed type that isn't the one we just confirmed
      const nextType = bank.types.find(t => !confirmedTypes.has(t) && t !== pendingType);

      if (!nextType) {
        // All types now confirmed — show pre-itinerary summary
        const summaryCtx = extractTripContextFromHistory(messages);
        const summaryNights = summaryCtx?.departure && summaryCtx?.return
          ? Math.round((new Date(summaryCtx.return) - new Date(summaryCtx.departure)) / (1000 * 60 * 60 * 24))
          : null;
        const summaryPax = summaryCtx?.passengers ?? 1;
        await streamClaudeSSE(systemPrompt, [
          ...messages,
          { role: 'user', content: `[PRE_ITINERARY_SUMMARY]\nConfirmed selections: ${JSON.stringify(selectedCards)}\nTrip details: ${summaryPax} traveler(s), departing ${summaryCtx?.departure} returning ${summaryCtx?.return}${summaryNights ? ` (${summaryNights} nights)` : ''}.\n\nAll activity categories have been confirmed. Give the traveler a clean summary of everything locked in: the flight (airline, route, departure/arrival times, price per person${summaryPax > 1 ? ` and total for ${summaryPax}` : ''}), the hotel (name, price per night, total for ${summaryNights ?? 'N'} nights), all must-see attractions and hidden gems they said yes to, and each activity category with the specific venues confirmed. Include a realistic total trip cost estimate — flight price is per person, hotel price is per night. Keep it organized and easy to scan. End with: "Does everything look good to you? If you're happy with the plan, I'll build your full day-by-day itinerary right now — or just let me know if you'd like to swap anything out."` },
        ], send);
        send({ type: 'marker', content: '[PRE_ITINERARY_SUMMARY_SHOWN]' });
        send({ type: 'done' });
        res.end();
        return;
      }

      send({ type: 'fetching' });
      const nextPool = bank.byType[nextType] || [];

      const nextText = await streamClaude(systemPrompt, [
        ...messages,
        { role: 'assistant', content: `Great, moving on!` },
        { role: 'user', content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ activityType: nextType, activities: nextPool }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nFirst output [SELECTED_ACTIVITIES]{"ids":["id1","id2"]}[/SELECTED_ACTIVITIES] selecting the 2 best "${nextType}" options. Then present those to the traveler. Ask if they work or if they want different options.` },
      ]);

      let nextCards = nextPool.slice(0, 2);
      const nextSelM = nextText.match(/\[SELECTED_ACTIVITIES\]([\s\S]*?)\[\/SELECTED_ACTIVITIES\]/);
      if (nextSelM) {
        try {
          const { ids } = JSON.parse(nextSelM[1].trim());
          const idMap = Object.fromEntries(nextPool.map(a => [a.id, a]));
          const sel = ids.map(id => idMap[id]).filter(Boolean);
          if (sel.length > 0) nextCards = sel;
        } catch {}
      }

      const { cleaned: nextCleaned } = extractAndStripBlocks(nextText);
      send({ type: 'activities_bank', data: { activities: nextCards, activityType: nextType } });
      if (nextCleaned) send({ type: 'delta', text: nextCleaned });
      send({ type: 'marker', content: `[ACTIVITY_SHOWN]{"type":${JSON.stringify(nextType)},"offset":0}` });

      send({ type: 'done' });
      res.end();
      return;
    }

    // ── POST-ITINERARY: Normal conversation after itinerary is built ──────
    if (itineraryShown) {
      const replyText = await streamClaude(systemPrompt, messages);
      const { cleaned } = extractAndStripBlocks(replyText);
      if (cleaned) send({ type: 'delta', text: cleaned });
      send({ type: 'done' });
      res.end();
      return;
    }

    // ── STAGE 1: First Claude pass, then fetch flights ─────────────────────
    const firstText = await streamClaude(systemPrompt, messages);
    const { cleaned: firstCleaned, toolCall } = extractAndStripBlocks(firstText);
    if (firstCleaned) send({ type: 'delta', text: firstCleaned });

    if (!toolCall) {
      send({ type: 'done' });
      res.end();
      return;
    }

    const { origin, destination, dates, group_size, activities } = toolCall;
    const passengers = typeof group_size === 'number' ? group_size : 1;
    const dep = dates?.departure || dates?.check_in  || dates?.checkIn;
    const ret = dates?.return    || dates?.check_out || dates?.checkOut;

    send({ type: 'fetching' });

    const [flightsResult] = await Promise.allSettled([
      fetchFlights(origin, destination, dep, ret, passengers),
    ]);

    const flightsRaw = flightsResult.status === 'fulfilled' ? flightsResult.value : [];
    if (flightsResult.status === 'rejected') console.error('fetchFlights error:', flightsResult.reason?.message);
    const flights = flightsRaw.map((f, i) => ({ ...f, id: `flight_${i}` }));
    console.log('[KNOWLEDGE_BANK] flights:', flights.length, 'results');

    // Embed full context in marker so Stage 2/3 can recover it reliably
    send({ type: 'marker', content: `[FLIGHTS_SHOWN] ${JSON.stringify({ departure: dep, return: ret, destination, origin, passengers, activities })}` });

    const flightBase = [
      ...messages,
      { role: 'assistant', content: firstCleaned || "Let me pull up the best flights for you!" },
    ];

    // Call 1: selection only
    const flightSelectText = await streamClaude(systemPrompt, [
      ...flightBase,
      {
        role: 'user',
        content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights }, null, 2)}\n[/KNOWLEDGE_BANK]\n\nDo not respond to the user yet. Output only [SELECTED_FLIGHTS]{"ids":["flight_X","flight_Y","flight_Z"]}[/SELECTED_FLIGHTS] where the ids are in the order you will present them — first id is your Option 1, second is Option 2, third is Option 3. Nothing else.`,
      },
    ]);

    let flightCards;
    const flightSelMatch = flightSelectText.match(/\[SELECTED_FLIGHTS\]([\s\S]*?)\[\/SELECTED_FLIGHTS\]/);
    if (flightSelMatch) {
      try {
        const { ids } = JSON.parse(flightSelMatch[1].trim());
        const idMap = Object.fromEntries(flights.map(f => [f.id, f]));
        const ordered = ids.map(id => idMap[id]).filter(Boolean);
        flightCards = ordered.length > 0 ? ordered : flights.slice(0, 3);
        console.log('[Stage 1] selected flight ids:', ids);
      } catch { flightCards = flights.slice(0, 3); }
    } else {
      flightCards = flights.slice(0, 3);
    }

    // Call 2: present selected flights to traveler
    function formatTime(timeStr) {
      if (!timeStr) return null;
      const parts = timeStr.split(' ');
      if (parts.length < 2) return null;
      const [h, m] = parts[1].split(':').map(Number);
      const ampm = h >= 12 ? 'pm' : 'am';
      const hour = h % 12 || 12;
      return `${hour}:${m.toString().padStart(2, '0')}${ampm}`;
    }

    const flightCardsReadable = flightCards.map(f => ({
      ...f,
      human_readable_departure: formatTime(f.departure_time),
      human_readable_arrival:   formatTime(f.arrival_time),
    }));

    const flightPresentText = await streamClaude(systemPrompt, [
      ...flightBase,
      {
        role: 'user',
        content: `[KNOWLEDGE_BANK]\n${JSON.stringify({ flights: flightCardsReadable }, null, 2)}\n[/KNOWLEDGE_BANK]\n\n[FLIGHTS_SHOWN]\n\nIMPORTANT: Present ONLY these 3 flights to the traveler using their exact airline names, times, and prices from the knowledge bank. Do NOT invent or alter any details. After presenting, ask which one they prefer before moving to hotels.`,
      },
    ]);

    const { cleaned: flightCleaned } = extractAndStripBlocks(flightPresentText);
    send({ type: 'knowledge_bank', data: { flights: flightCards, hotels: [], activities: [], flightsBankFull: flights } });
    if (flightCleaned) send({ type: 'delta', text: flightCleaned });

    send({ type: 'done' });
    res.end();

  } catch (err) {
    console.error('Chat error:', err.message);
    send({ type: 'error', message: 'Something went wrong. Please try again.' });
    res.end();
  }
});

// ─── Destination image (Pexels → Wikipedia fallback) ─────────────────────────

app.get('/api/destination-image', async (req, res) => {
  const { city, size = 'card' } = req.query
  if (!city) return res.status(400).json({ error: 'city is required' })

  const cityName = city.split(',')[0].trim()
  const pexelsKey = process.env.PEXELS_API_KEY

  // Try Pexels first (if key is configured)
  if (pexelsKey && pexelsKey !== 'your_pexels_api_key_here') {
    try {
      // Try specific travel query first, then broader fallback
      const queries = [
        encodeURIComponent(`${cityName} travel landmark`),
        encodeURIComponent(`${cityName} city`),
        encodeURIComponent(cityName),
      ]
      let photo = null
      for (const query of queries) {
        const response = await fetch(
          `https://api.pexels.com/v1/search?query=${query}&per_page=5`,
          { headers: { Authorization: pexelsKey } }
        )
        const data = await response.json()
        if (data.photos?.length) { photo = data.photos[0]; break }
      }
      if (photo) {
        const url = size === 'hero' ? photo.src.large2x : photo.src.large
        return res.json({ url })
      }
    } catch {}
  }

  // Fallback: Wikipedia
  try {
    const wikiRes  = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cityName)}`
    )
    const wikiData = await wikiRes.json()
    const url = size === 'hero'
      ? (wikiData.originalimage?.source || wikiData.thumbnail?.source || null)
      : (wikiData.thumbnail?.source || null)
    return res.json({ url: url || null })
  } catch {
    return res.json({ url: null })
  }
})

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the existing process and restart.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
