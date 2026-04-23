import { useState, useEffect, useCallback, useRef } from 'react'

const STEPS = [
  {
    target: 'plan-trip',
    title: 'Meet Maya, your personal AI travel agent',
    body: "Maya plans your entire trip from scratch — flights, hotels, activities, and a full day-by-day itinerary. Every conversation is personalized to your profile and what you've told her, so the more you share, the smarter she gets.",
    placement: 'bottom',
  },
  {
    target: 'active-trips',
    title: 'Your active planning sessions',
    body: "This is where your ongoing trips with Maya live. You can run up to 3 simultaneous planning sessions — each one saved exactly where you left off, ready to pick back up anytime.",
    placement: 'right',
  },
  {
    target: 'upcoming-trips',
    title: 'Your confirmed itineraries',
    body: "Once you finalize a plan with Maya and save it, your complete day-by-day itinerary moves here — ready to view and book from.",
    placement: 'right',
  },
  {
    target: 'recommendations',
    title: 'Destinations picked just for you',
    body: "These are tailored to your taste — give them a few seconds to load as they're generated fresh from your profile. Wild Cards are bold, unexpected picks that refresh daily. The rest update weekly. Tap the bookmark to save to your Wishlist, or hit Plan Now to start building a trip with Maya.",
    placement: 'bottom',
  },
  {
    target: 'wishlist',
    title: 'Your travel wishlist',
    body: "Every destination you bookmark lives here. When you're ready to make it happen, jump straight into planning with Maya.",
    placement: 'right',
  },
  {
    target: 'profile',
    title: 'Help Maya know you better',
    body: "The more Maya knows — your travel style, budget, past trips, and interests — the sharper your recommendations get. Keep your profile updated as your tastes evolve.",
    placement: 'top',
  },
]

const TOOLTIP_W = 292
const PAD = 10

function getTooltipStyle(rect, placement) {
  const vw = window.innerWidth
  const vh = window.innerHeight

  if (placement === 'right') {
    let left = rect.right + PAD + 14
    if (left + TOOLTIP_W > vw - 8) left = rect.left - TOOLTIP_W - PAD - 14
    let top = rect.top + rect.height / 2
    return { left, top, transform: 'translateY(-50%)' }
  }

  if (placement === 'bottom') {
    let top = rect.bottom + PAD + 14
    let left = rect.left + rect.width / 2
    // clamp horizontally
    const clamped = Math.max(TOOLTIP_W / 2 + 8, Math.min(left, vw - TOOLTIP_W / 2 - 8))
    return { top, left: clamped, transform: 'translateX(-50%)' }
  }

  if (placement === 'top') {
    let top = rect.top - PAD - 14
    let left = rect.left + rect.width / 2
    const clamped = Math.max(TOOLTIP_W / 2 + 8, Math.min(left, vw - TOOLTIP_W / 2 - 8))
    return { top, left: clamped, transform: 'translate(-50%, -100%)' }
  }

  return { top: rect.bottom + 14, left: rect.left }
}

export default function ProductTour({ onDone }) {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)
  const audioRef = useRef(null)

  useEffect(() => {
    const audio = new Audio('/Daft Punk - Around the World (Official Audio).mp3')
    audio.currentTime = 65
    audio.volume = 0.5
    audio.play().catch(() => {})
    audioRef.current = audio
    return () => { audio.pause(); audio.src = '' }
  }, [])

  function fadeOutAndDone() {
    const audio = audioRef.current
    if (!audio) { onDone(); return }
    const tick = setInterval(() => {
      if (audio.volume <= 0.05) {
        clearInterval(tick)
        audio.pause()
        onDone()
      } else {
        audio.volume = Math.max(0, audio.volume - 0.05)
      }
    }, 80)
  }

  const current = STEPS[step]

  const measure = useCallback(() => {
    const el = document.querySelector(`[data-tour="${current.target}"]`)
    if (el) setRect(el.getBoundingClientRect())
  }, [current.target])

  useEffect(() => {
    const el = document.querySelector(`[data-tour="${current.target}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(measure, 300)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [current.target, measure])

  function next() {
    if (step < STEPS.length - 1) setStep(s => s + 1)
    else fadeOutAndDone()
  }

  return (
    <>
      {/* Click blocker — sits under spotlight, blocks interaction with the page */}
      <div className="fixed inset-0 z-[9995]" />

      {/* Spotlight hole */}
      {rect && (
        <div
          className="fixed z-[9996] pointer-events-none transition-all duration-300"
          style={{
            top:    rect.top    - PAD,
            left:   rect.left   - PAD,
            width:  rect.width  + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 14,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)',
          }}
        />
      )}

      {/* Tooltip */}
      {rect && (
        <div
          className="fixed z-[9997] bg-white rounded-2xl shadow-2xl overflow-hidden pointer-events-auto transition-all duration-300"
          style={{ width: TOOLTIP_W, ...getTooltipStyle(rect, current.placement) }}
        >
          {/* Top accent bar */}
          <div className="h-1 bg-gradient-to-r from-blue-500 via-cyan-500 to-teal-500" />

          {/* Progress pips */}
          <div className="flex items-center gap-1 px-5 pt-4 mb-0.5">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                  i < step ? 'bg-blue-300' : i === step ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              />
            ))}
          </div>

          <div className="px-5 pt-3 pb-2">
            <p className="text-[10px] font-bold text-blue-500 uppercase tracking-widest mb-1.5">
              {step + 1} of {STEPS.length}
            </p>
            <h3 className="text-sm font-bold text-gray-900 leading-snug mb-2">
              {current.title}
            </h3>
            <p className="text-[12px] text-gray-500 leading-relaxed">
              {current.body}
            </p>
          </div>

          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-50">
            <button
              onClick={fadeOutAndDone}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Skip tour
            </button>
            <button
              onClick={next}
              className="px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-xs font-semibold rounded-xl transition-all shadow-sm flex items-center gap-1.5"
            >
              {step < STEPS.length - 1 ? (
                <>Next <span aria-hidden>→</span></>
              ) : (
                <>Let&apos;s go <span aria-hidden>✓</span></>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
