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

// ─── VOYO avatar icon ──────────────────────────────────────────────────────────

function WaypointAvatar() {
  return (
    <img src="/voyo-logo.png" alt="VOYO" className="w-7 h-7 rounded-full object-cover shrink-0 mt-0.5" />
  )
}

function useInjectKeyframes() {
  useEffect(() => {
    const id = 'waypoint-plane-keyframes'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      @keyframes waypointPlaneFly {
        0%   { transform: translate(0px, 5px) rotate(-35deg); }
        20%  { transform: translate(4px, 0px) rotate(20deg); }
        45%  { transform: translate(9px, -5px) rotate(8deg); }
        70%  { transform: translate(13px, 0px) rotate(-18deg); }
        100% { transform: translate(0px, 5px) rotate(-35deg); }
      }
    `
    document.head.appendChild(style)
  }, [])
}

const planeStyle = { display: 'inline-block', animation: 'waypointPlaneFly 2.4s ease-in-out infinite' }

function PlaneSVG() {
  return (
    <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
      <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
    </svg>
  )
}

function TypingDots() {
  useInjectKeyframes()
  return (
    <div className="flex items-end gap-3 px-4">
      <WaypointAvatar />
      <div className="bg-white rounded-2xl rounded-bl-sm px-4 py-3.5 shadow-sm flex items-center gap-3">
        <span className="text-blue-500" style={planeStyle}><PlaneSVG /></span>
        <span className="text-xs text-gray-400 font-medium tracking-wide">Planning your trip…</span>
      </div>
    </div>
  )
}

function FetchingSkeleton() {
  useInjectKeyframes()
  return (
    <div className="flex items-end gap-3 px-4">
      <WaypointAvatar />
      <div className="bg-white rounded-2xl rounded-bl-sm px-4 py-3.5 shadow-sm min-w-[220px]">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-blue-500" style={planeStyle}><PlaneSVG /></span>
          <span className="text-xs font-medium text-gray-500">Finding flights, hotels &amp; activities…</span>
        </div>
        <div className="space-y-2">
          {[80, 58, 70].map((w, i) => (
            <div key={i} className="h-2 rounded-full bg-gradient-to-r from-blue-100 to-indigo-50 animate-pulse"
              style={{ width: `${w}%`, animationDelay: `${i * 0.2}s` }} />
          ))}
        </div>
        <p className="text-xs font-semibold text-red-500 mt-2.5">Please don't exit, close, or refresh this page</p>
      </div>
    </div>
  )
}

const mdComponents = {
  h1: ({ children }) => <h1 className="text-base font-bold text-gray-900 mb-2 mt-3 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-bold text-gray-900 mb-1.5 mt-3 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-800 mb-1 mt-2.5 first:mt-0">{children}</h3>,
  p:  ({ children }) => <p className="text-sm text-gray-700 leading-relaxed mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="text-sm text-gray-700 mb-2 pl-4 space-y-0.5 list-disc marker:text-blue-400 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="text-sm text-gray-700 mb-2 pl-4 space-y-0.5 list-decimal marker:text-blue-500 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
  em: ({ children }) => <em className="italic text-gray-500">{children}</em>,
  code: ({ children, className }) => className
    ? <code className="block bg-slate-50 text-slate-700 px-3 py-2 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre">{children}</code>
    : <code className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>,
  pre: ({ children }) => <pre className="mb-2 last:mb-0 rounded-lg overflow-hidden">{children}</pre>,
  hr: () => <hr className="border-gray-100 my-3" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-blue-200 pl-3 my-2 text-sm text-gray-500 italic">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-3 rounded-xl overflow-hidden border border-gray-200 shadow-sm">
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gradient-to-r from-blue-50 to-indigo-50">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-gray-100">{children}</tbody>,
  tr: ({ children }) => <tr className="transition-colors hover:bg-gray-50/60">{children}</tr>,
  th: ({ children }) => (
    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2.5 text-gray-700 last:text-right last:font-medium last:tabular-nums">{children}</td>
  ),
}

function ThreeDots() {
  return (
    <div className="flex items-center gap-1.5 py-0.5">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-2 h-2 bg-gray-300 rounded-full animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
        />
      ))}
    </div>
  )
}

function MessageBubble({ role, content }) {
  const isUser = role === 'user'
  if (isUser) {
    return (
      <div className="flex justify-end px-4">
        <div className="max-w-[75%] bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-2xl rounded-br-sm px-4 py-3 shadow-sm">
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    )
  }
  if (!content) {
    return (
      <div className="flex items-end gap-3 px-4">
        <WaypointAvatar />
        <div className="bg-white rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
          <ThreeDots />
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-end gap-3 px-4">
      <WaypointAvatar />
      <div className="max-w-[75%] bg-white rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</ReactMarkdown>
      </div>
    </div>
  )
}

function ItineraryBubble({ content, hasBookingCards }) {
  return (
    <div className="px-4">
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-3 flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <svg width="14" height="14" className="text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
            </svg>
          </div>
          <span className="text-white text-sm font-semibold">Your Itinerary</span>
        </div>
        <div className="px-6 py-6">
          {hasBookingCards && (
            <div className="mb-6 pb-5 border-b border-gray-100 flex items-center gap-2 text-sm text-blue-600">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
              Your confirmed flight, hotel and activity picks are saved at the bottom
            </div>
          )}
          <ItineraryContent content={content} />
        </div>
      </div>
    </div>
  )
}

function HowItWorksCard({ onDismiss }) {
  const steps = [
    {
      icon: (
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      step: '01',
      title: 'Tell Maya your plans',
      desc: "Share your destination, dates, and vibe — or just a rough idea, she'll help you figure it out. Your profile shapes everything from the start",
    },
    {
      icon: (
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
        </svg>
      ),
      step: '02',
      title: 'Get curated live picks',
      desc: 'Maya searches real flights, hotels, and activities — then shows only the best fits for you. No endless scrolling, just the right options',
    },
    {
      icon: (
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      step: '03',
      title: 'Your itinerary, your way',
      desc: "Pick what you want, skip what you don't — Maya builds a personalized day-by-day plan with booking links, ready to go",
      disclaimer: 'Please allow 2–3 minutes for the final itinerary to generate and do not exit the page during this time.',
    },
  ]

  return (
    <div className="px-4 pt-2 pb-1">
      <div className="relative bg-gradient-to-br from-sky-600 via-cyan-600 to-teal-500 rounded-2xl shadow-lg overflow-hidden">

        {/* Subtle wave texture overlay */}
        <div className="absolute inset-0 opacity-10 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(ellipse at 20% 50%, white 1px, transparent 1px), radial-gradient(ellipse at 80% 20%, white 1px, transparent 1px)', backgroundSize: '60px 60px' }} />

        {/* Header */}
        <div className="relative flex items-center justify-between px-5 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <img src="/voyo-logo.png" alt="VOYO" className="w-5 h-5 rounded object-cover" />
            <p className="text-xs font-semibold text-white">How VOYO works</p>
          </div>
          <button onClick={onDismiss} className="w-6 h-6 flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-white/10 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="relative h-px bg-white/15 mx-5" />

        {/* Steps */}
        <div className="relative grid grid-cols-3 divide-x divide-white/15 px-1 py-5">
          {steps.map(({ icon, step, title, desc, disclaimer }) => (
            <div key={step} className="flex flex-col gap-2 px-4">
              <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center shrink-0">
                {icon}
              </div>
              <p className="text-[13px] font-bold text-white/40 tracking-widest">{step}</p>
              <p className="text-[15px] font-semibold text-white leading-snug">{title}</p>
              <p className="text-[13px] text-white/65 leading-relaxed">{desc}</p>
              {disclaimer && <p className="text-[13px] font-bold text-white leading-relaxed">{disclaimer}</p>}
            </div>
          ))}
        </div>

        {/* Tagline */}
        <div className="relative h-px bg-white/15 mx-5" />
        <div className="relative px-5 py-3">
          <p className="text-center text-xs text-white/80 italic tracking-wide">
            A travel agent that knows you — not another search engine
          </p>
        </div>

      </div>
    </div>
  )
}

// ─── Budget fallback (for sessions saved before server-side budget was added) ──

function deriveBudget(model) {
  const groupSize = model.groupSize || 1
  const budgetIsPerPerson = model.budgetIsPerPerson ?? true
  const isSingleDest = (model.legs || []).length === 1
  const parseMoney = (v) => {
    if (!v) return 0
    if (typeof v === 'number') return v
    return parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0
  }
  const totalBudget = budgetIsPerPerson
    ? parseMoney(model.budgetPerPerson) * groupSize
    : parseMoney(model.budgetPerPerson)
  const ppl = groupSize > 1 ? ` × ${groupSize} people` : ''
  const lines = []
  let totalNights = 0
  let totalActivities = 0

  for (const leg of model.legs || []) {
    if (leg.confirmedFlight?.price) {
      const ppx = parseMoney(leg.confirmedFlight.price)
      const route = leg.confirmedFlight.origin_airport && leg.confirmedFlight.destination_airport
        ? ` (${leg.confirmedFlight.origin_airport} → ${leg.confirmedFlight.destination_airport})` : ''
      lines.push({
        label: `${leg.confirmedFlight.airline || 'Flight'}${route}${isSingleDest ? ' — round trip' : ''}`,
        amount: ppx * groupSize,
      })
    }
    if (leg.confirmedHotel?.price) {
      const ppn = parseMoney(leg.confirmedHotel.price)
      const nights = leg.durationNights || 0
      lines.push({ label: `${leg.confirmedHotel.name} ($${ppn}/night × ${nights} nights${ppl})`, amount: ppn * nights * groupSize })
      totalNights += nights
    }
    if (leg.exitTransport?.confirmedFlight?.price) {
      const ppx = parseMoney(leg.exitTransport.confirmedFlight.price)
      lines.push({ label: `${leg.exitTransport.confirmedFlight.airline || 'Return flight'}`, amount: ppx * groupSize })
    }
    totalActivities += (leg.confirmedActivities || []).filter(a => !a.skipped).length
  }

  const totalDays = Math.max(totalNights + 1, 1)
  if (totalActivities > 0) {
    lines.push({ label: `Activities (${totalActivities} × ~$40/person${ppl})`, amount: totalActivities * 40 * groupSize, isEstimate: true })
  }
  lines.push({ label: `Food ($50/day/person${ppl} × ${totalDays} days)`, amount: 50 * totalDays * groupSize, isEstimate: true })
  lines.push({ label: `Local transport ($20/day/person${ppl} × ${totalDays} days)`, amount: 20 * totalDays * groupSize, isEstimate: true })

  const total = lines.reduce((sum, l) => sum + (l.amount || 0), 0)
  if (lines.length === 0 || total === 0) return null
  return { lines, total, budget: totalBudget, leftOver: totalBudget - total, groupSize }
}

// ─── Main component ───────────────────────────────────────────────────────────

const WELCOME_MESSAGE = {
  role: 'assistant',
  content: "Hi! I'm Maya, your personal travel agent from VOYO. I'm here to help you plan an amazing trip from start to finish. Where are you dreaming of going?",
}

export default function Chat() {
  const { user }   = useAuth()
  const navigate   = useNavigate()
  const location   = useLocation()
  const { sessionId: routeSessionId } = useParams()

  const prefilledDestination = location.state?.destination || null
  const isNew = !routeSessionId || routeSessionId === 'new'

  // Stable session ID for this chat's lifetime
  const sessionIdRef = useRef(isNew ? crypto.randomUUID() : routeSessionId)
  const sessionId = sessionIdRef.current

  // ── Core state ────────────────────────────────────────────────────────────────
  const [profile, setProfile]   = useState(null)
  const [messages, setMessages] = useState(prefilledDestination ? [] : [WELCOME_MESSAGE])
  const [input, setInput]       = useState('')
  const [streaming, setStreaming] = useState(false)
  const [waiting, setWaiting]   = useState(false)
  const [fetching, setFetching] = useState(false)
  const [messageCards, setMessageCards] = useState({})

  // Trip model — replaces activityBank, selectedCards, flightsBankFull, hotelsBankFull, hiddenMarkers
  const [tripModel, setTripModel] = useState(() => initialTripModel())
  const tripModelRef = useRef(initialTripModel())  // mutable ref for use inside async callbacks

  // Session UI state
  const [sessionLoaded, setSessionLoaded] = useState(isNew)
  const [sessionTitle, setSessionTitle]   = useState('New Trip')
  const [menuOpen, setMenuOpen]           = useState(false)
  const [renaming, setRenaming]           = useState(false)
  const [renameValue, setRenameValue]     = useState('')
  const [showHowItWorks, setShowHowItWorks] = useState(true)

  // Complete planning state
  const [itineraryShown, setItineraryShown] = useState(false)
  const [completedSaved, setCompletedSaved] = useState(false)
  const [showSavedModal, setShowSavedModal] = useState(false)
  const [savedDestination, setSavedDestination] = useState('')

  const bottomRef       = useRef(null)
  const scrollRef       = useRef(null)
  const inputRef        = useRef(null)
  const abortRef        = useRef(null)
  const autoFiredRef    = useRef(false)
  const saveTimerRef    = useRef(null)
  const streamingRef    = useRef(false)
  const userScrolledRef = useRef(false)

  // ── Load existing session ──────────────────────────────────────────────────
  useEffect(() => {
    if (isNew || !user) return

    // Hydrate from sessionStorage immediately for instant restore
    const cached = loadTripModelFromSession(sessionId)
    if (cached) {
      tripModelRef.current = cached
      setTripModel(cached)
    }

    supabase.from('profiles').select('chat_sessions').eq('id', user.id).single()
      .then(({ data }) => {
        const session = (data?.chat_sessions || []).find(s => s.id === sessionId)
        if (session) {
          setMessages(session.messages || [WELCOME_MESSAGE])
          setMessageCards(session.messageCards || {})
          setSessionTitle(session.title || 'New Trip')

          let restoredModel
          if (session.tripModel) {
            restoredModel = session.tripModel
          } else {
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

  // ── Fetch profile ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('*').eq('id', user.id).single()
      .then(({ data }) => {
        if (data) {
          setProfile(data)
          setShowHowItWorks(!data.how_it_works_dismissed)
        }
      })
  }, [user])

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (userScrolledRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, waiting])

  function handleChatScroll() {
    const el = scrollRef.current
    if (!el) return
    userScrolledRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 100
  }

  // ── Auto-fire prefilled destination ───────────────────────────────────────
  useEffect(() => {
    if (!prefilledDestination || !isNew || !sessionLoaded || autoFiredRef.current) return
    autoFiredRef.current = true
    sendMessage(`I want to plan a trip to ${prefilledDestination}`)
  }, [prefilledDestination, sessionLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Session save ───────────────────────────────────────────────────────────
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
      tripModel:     model,
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

  // ── Complete planning & save itinerary ────────────────────────────────────
  async function handleCompleteTrip() {
    const itinEntries = Object.entries(messageCards).filter(([, v]) => v?.isItinerary)
    const itinEntry = itinEntries[itinEntries.length - 1]
    const itinIdx   = itinEntry ? parseInt(itinEntry[0]) : -1
    const itinText  = itinIdx >= 0 ? messages[itinIdx]?.content || '' : ''
    const bookCards = itinEntry?.[1] || {}

    const ctx  = deriveSessionCtx(tripModel)
    const dest = ctx?.destination || sessionTitle

    const cards = deriveSelectedCards(tripModel)
    const budget = bookCards.budget ?? deriveBudget(tripModel)

    const trip = {
      id:            crypto.randomUUID(),
      source:        'inapp',
      destination:   dest,
      departureDate: ctx?.departure || '',
      returnDate:    ctx?.return    || '',
      itineraryText: itinText,
      bookingCards:  { ...bookCards, ...cards, ...(budget ? { budget } : {}) },
      savedAt:       new Date().toISOString(),
    }

    const { data } = await supabase.from('profiles').select('upcoming_trips').eq('id', user.id).single()
    const trips    = data?.upcoming_trips || []
    await supabase.from('profiles').upsert({ id: user.id, upcoming_trips: [...trips, trip] })

    setCompletedSaved(true)
    setSavedDestination(dest.split(',')[0])
    setShowSavedModal(true)
  }

  async function handleDeleteSession() {
    const { data } = await supabase.from('profiles').select('chat_sessions').eq('id', user.id).single()
    const sessions = (data?.chat_sessions || []).filter(s => s.id !== sessionId)
    await supabase.from('profiles').upsert({ id: user.id, chat_sessions: sessions })
    navigate('/trips')
  }

  async function handleRenameSession() {
    if (!renameValue.trim()) { setRenaming(false); return }
    const { data } = await supabase.from('profiles').select('chat_sessions').eq('id', user.id).single()
    const sessions = (data?.chat_sessions || []).map(s =>
      s.id === sessionId ? { ...s, title: renameValue.trim() } : s
    )
    await supabase.from('profiles').upsert({ id: user.id, chat_sessions: sessions })
    setSessionTitle(renameValue.trim())
    setRenaming(false)
    setMenuOpen(false)
  }

  // ── Send message ───────────────────────────────────────────────────────────
  async function sendMessage(overrideText = null) {
    const text = overrideText ?? input.trim()
    if (!text || streaming || streamingRef.current) return
    streamingRef.current = true

    const userMessage  = { role: 'user', content: text }
    const nextMessages = [...messages, userMessage]

    setMessages(nextMessages)
    if (!overrideText) setInput('')
    setWaiting(true)
    setStreaming(true)
    userScrolledRef.current = false

    const startsWithWelcome = nextMessages[0]?.role === 'assistant'
    const apiMessages = nextMessages
      .slice(startsWithWelcome ? 1 : 0)
      .map(({ role, content }) => ({ role, content }))

    const controller = new AbortController()
    abortRef.current = controller

    let finalMessages  = nextMessages
    let finalCards     = messageCards
    let finalTripModel = tripModelRef.current
    // Index where the new assistant message will live for this turn's cards
    const assistantMsgIdx = nextMessages.length

    try {
      const res = await fetch('http://localhost:5000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          profile,
          tripModel: tripModelRef.current,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Server error')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let assistantText = ''

      finalMessages = [...finalMessages, { role: 'assistant', content: '' }]
      setMessages(finalMessages)
      setWaiting(false)

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw) continue
          let event
          try { event = JSON.parse(raw) } catch { continue }

          if (event.type === 'delta') {
            assistantText += event.text
            const updated = [...finalMessages]
            updated[updated.length - 1] = { role: 'assistant', content: assistantText }
            finalMessages = updated
            setMessages(finalMessages)

          } else if (event.type === 'trip_model_update') {
            const newModel = mergeTripModelPatch(finalTripModel, event.data)
            finalTripModel = newModel
            tripModelRef.current = newModel
            setTripModel(newModel)
            saveTripModelToSession(newModel, sessionId)

          } else if (event.type === 'knowledge_bank') {
            setFetching(false)
            assistantText = ''
            const lastMsg = finalMessages[finalMessages.length - 1]
            const reuseSlot = lastMsg?.role === 'assistant' && !lastMsg.content
            const idx = reuseSlot ? finalMessages.length - 1 : finalMessages.length
            finalCards = { ...finalCards, [idx]: event.data }
            setMessageCards(finalCards)
            if (!reuseSlot) finalMessages = [...finalMessages, { role: 'assistant', content: '' }]
            setMessages([...finalMessages])

          } else if (event.type === 'hotels_bank') {
            setFetching(false)
            assistantText = ''
            const lastMsg = finalMessages[finalMessages.length - 1]
            const reuseSlot = lastMsg?.role === 'assistant' && !lastMsg.content
            const idx = reuseSlot ? finalMessages.length - 1 : finalMessages.length
            finalCards = { ...finalCards, [idx]: { hotels: event.data.hotels, checkIn: event.data.checkIn, checkOut: event.data.checkOut } }
            setMessageCards(finalCards)
            if (!reuseSlot) finalMessages = [...finalMessages, { role: 'assistant', content: '' }]
            setMessages([...finalMessages])

          } else if (event.type === 'activity_bank_ready') {
            // activity bank stored in tripModel via trip_model_update

          } else if (event.type === 'activities_bank') {
            setFetching(false)
            assistantText = ''
            const lastMsg = finalMessages[finalMessages.length - 1]
            const reuseSlot = lastMsg?.role === 'assistant' && !lastMsg.content
            const idx = reuseSlot ? finalMessages.length - 1 : finalMessages.length
            finalCards = { ...finalCards, [idx]: { activities: event.data.activities, activityType: event.data.activityType } }
            setMessageCards(finalCards)
            if (!reuseSlot) finalMessages = [...finalMessages, { role: 'assistant', content: '' }]
            setMessages([...finalMessages])

          } else if (event.type === 'itinerary_bank') {
            setFetching(false)
            assistantText = ''
            const lastMsg = finalMessages[finalMessages.length - 1]
            const reuseSlot = lastMsg?.role === 'assistant' && !lastMsg.content
            const idx = reuseSlot ? finalMessages.length - 1 : finalMessages.length
            finalCards = { ...finalCards, [idx]: { ...event.data, isItinerary: true } }
            setMessageCards(finalCards)
            if (!reuseSlot) finalMessages = [...finalMessages, { role: 'assistant', content: '' }]
            setMessages([...finalMessages])

          } else if (event.type === 'flight_confirmed') {
            // visual confirmation — tripModel already updated via trip_model_update

          } else if (event.type === 'hotel_confirmed') {
            // same

          } else if (event.type === 'activity_confirmed') {
            // same

          } else if (event.type === 'new_message') {
            assistantText = ''
            finalMessages = [...finalMessages, { role: 'assistant', content: '' }]
            setMessages(finalMessages)

          } else if (event.type === 'fetching') {
            setFetching(true)

          } else if (event.type === 'marker') {
            if (event.content?.includes('[ITINERARY_SHOWN]')) setItineraryShown(true)

          } else if (event.type === 'fetch_error') {
            setFetching(false)
            console.error('[fetch_error] leg:', event.leg, 'type:', event.fetchType)

          } else if (event.type === 'done') {
            setFetching(false)

          } else if (event.type === 'error') {
            setFetching(false)
            const updated = [...finalMessages]
            updated[updated.length - 1] = { role: 'assistant', content: event.message || 'Something went wrong. Please try again.' }
            finalMessages = updated
            setMessages(finalMessages)
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      setWaiting(false)
      finalMessages = [...finalMessages, { role: 'assistant', content: 'Sorry, I ran into a problem. Please try again.' }]
      setMessages(finalMessages)
    } finally {
      streamingRef.current = false
      setStreaming(false)
      setWaiting(false)
      abortRef.current = null
      inputRef.current?.focus()
      // Auto-save after every exchange
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveSession(finalMessages, finalCards, finalTripModel)
      }, 600)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(null) }
  }

  if (!sessionLoaded) {
    return (
      <div className="flex flex-col h-screen bg-stone-50 items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-stone-50">

      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between shrink-0 z-10 shadow-sm">
        <button onClick={() => navigate('/trips')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Trips
        </button>

        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-sm">
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
            </svg>
          </div>
          {renaming ? (
            <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
              onBlur={handleRenameSession}
              onKeyDown={e => { if (e.key === 'Enter') handleRenameSession(); if (e.key === 'Escape') setRenaming(false) }}
              className="text-sm font-semibold text-gray-900 border-b border-blue-500 outline-none bg-transparent w-48 text-center" />
          ) : (
            <span className="text-sm font-semibold text-gray-900 max-w-[180px] truncate">{sessionTitle}</span>
          )}
        </div>

        {/* 3-dot menu */}
        <div className="relative">
          <button onClick={() => setMenuOpen(o => !o)}
            className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-10 bg-white border border-gray-200 rounded-xl shadow-lg py-1 w-36 z-20">
              <button onClick={() => { setRenameValue(sessionTitle); setRenaming(true); setMenuOpen(false) }}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                Rename
              </button>
              <button onClick={() => { if (window.confirm('Delete this planning chat?')) handleDeleteSession() }}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                Delete chat
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-6 space-y-5" onScroll={handleChatScroll} onClick={() => setMenuOpen(false)}>
        {showHowItWorks && (
          <HowItWorksCard onDismiss={() => {
            setShowHowItWorks(false)
            supabase.from('profiles').upsert({ id: user.id, how_it_works_dismissed: true })
          }} />
        )}
        {messages.map((msg, i) => {
          const rawCards = msg.role === 'assistant' ? messageCards[i] : null
          const isItinerary = rawCards?.isItinerary === true
          const cards = isItinerary && rawCards && !rawCards.budget
            ? { ...rawCards, budget: deriveBudget(tripModel) }
            : rawCards
          const hasBookingCards = isItinerary && (
            cards?.flights?.length > 0 || cards?.hotels?.length > 0 || cards?.activities?.length > 0
          )
          return (
            <div key={i}>
              {isItinerary
                ? <ItineraryBubble content={msg.content} hasBookingCards={hasBookingCards} />
                : <MessageBubble role={msg.role} content={msg.content} />
              }
              {cards && (
                <div className="mt-3 px-4"><TravelCards cards={cards} /></div>
              )}
            </div>
          )
        })}
        {waiting  && <TypingDots />}
        {fetching && <FetchingSkeleton />}

        {/* Complete Planning button — appears after itinerary */}
        {itineraryShown && !completedSaved && !streaming && (
          <div className="px-4 pt-2">
            <button onClick={handleCompleteTrip}
              className="w-full py-3.5 bg-green-600 hover:bg-green-700 active:bg-green-800 text-white text-sm font-semibold rounded-2xl shadow-sm transition-colors flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Complete Planning &amp; Save Itinerary
            </button>
          </div>
        )}
        {completedSaved && (
          <p className="text-center text-xs text-green-600 px-4">
            Itinerary saved to Upcoming Trips ✓
          </p>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="bg-white border-t border-gray-100 px-4 py-3 shrink-0 shadow-[0_-1px_8px_rgba(0,0,0,0.04)]">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <textarea ref={inputRef} value={input}
            onChange={e => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            placeholder="Message Maya…"
            rows={1}
            className="flex-1 resize-none rounded-2xl border border-gray-200 bg-stone-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 leading-relaxed transition-shadow"
            style={{ minHeight: '42px', maxHeight: '120px' }}
          />
          <button onClick={sendMessage} disabled={!input.trim() || streaming}
            className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-all shadow-sm hover:shadow-md shrink-0"
            aria-label="Send message">
            <svg className="w-4 h-4 text-white translate-x-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Post-save modal */}
      {showSavedModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">
                  Itinerary for {savedDestination} saved!
                </p>
                <p className="text-xs text-gray-500 mt-0.5">Added to your Upcoming Trips.</p>
              </div>
            </div>
            <p className="text-sm text-gray-700">Would you like to delete this planning chat to free up a slot?</p>
            <div className="flex gap-3">
              <button onClick={handleDeleteSession}
                className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-xl transition-colors">
                Yes, delete
              </button>
              <button onClick={() => setShowSavedModal(false)}
                className="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-xl transition-colors">
                Keep it
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
