import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { executeRequest } from './orchestrator.js'

const app = express()
const PORT = process.env.PORT || 5000
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/', (req, res) => {
  res.json({ message: 'Waypoint API is running' })
})

// ── Recommendations ───────────────────────────────────────────────────────────

app.post('/api/recommendations', async (req, res) => {
  const { profile } = req.body

  if (!profile) return res.status(400).json({ error: 'profile is required' })

  const {
    full_name, preferences = [], budget_category, travel_style, group_size,
    past_trips = [], about_me, age, gender,
  } = profile

  const visited = past_trips.filter(t => t.destination?.trim()).map(t => t.destination)

  const pastTripDetails = past_trips
    .filter(t => t.destination?.trim())
    .map(t => {
      let info = t.destination
      if (t.rating) info += ` (rated ${t.rating}/5)`
      if (t.activities?.length) info += `, activities: ${t.activities.join(', ')}`
      if (t.notes?.trim()) info += `. Notes: "${t.notes.trim()}"`
      return info
    }).join('\n  - ') || 'None'

  const demographicLine = [age ? `Age: ${age}` : null, gender ? `Gender: ${gender}` : null]
    .filter(Boolean).join(', ')

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
]`

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
    })

    const raw = message.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const recommendations = JSON.parse(raw)
    res.json({ recommendations })
  } catch (err) {
    console.error('Recommendations error:', err.message)
    res.status(500).json({ error: 'Failed to generate recommendations' })
  }
})

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
    if (!res.writableEnded) send({ type: 'error', message: 'Something went wrong. Please try again.' })
  } finally {
    if (!res.writableEnded) {
      send({ type: 'done' })
      res.end()
    }
  }
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
