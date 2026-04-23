import { useState, useEffect } from 'react'

const FALLBACK_GRADIENTS = [
  'from-sky-400 to-blue-600',
  'from-violet-400 to-purple-600',
  'from-amber-400 to-orange-500',
  'from-emerald-400 to-teal-600',
  'from-rose-400 to-pink-600',
  'from-indigo-400 to-blue-600',
]

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000

function getCachedImage(city) {
  try {
    const raw = localStorage.getItem(`waypoint_img2_${city}`)
    if (!raw) return undefined
    const { url, ts } = JSON.parse(raw)
    if (Date.now() - ts > CACHE_TTL || url === '') { localStorage.removeItem(`waypoint_img2_${city}`); return undefined }
    return url
  } catch { return undefined }
}

function setCachedImage(city, url) {
  try { localStorage.setItem(`waypoint_img2_${city}`, JSON.stringify({ url: url || '', ts: Date.now() })) } catch {}
}

export default function DestinationCard({ destination, reason, bestTime, personalNote, hearMeOut, isExperimental, bookmarked, onBookmark, onPlanNow }) {
  const [imgSrc, setImgSrc]         = useState(null)
  const [imgLoading, setImgLoading] = useState(true)

  const fallbackGradient = FALLBACK_GRADIENTS[destination.length % FALLBACK_GRADIENTS.length]

  useEffect(() => {
    const city   = destination.split(',')[0].trim()
    const cached = getCachedImage(city)
    if (cached !== undefined) { setImgSrc(cached); setImgLoading(false); return }

    fetch(`http://localhost:5000/api/destination-image?city=${encodeURIComponent(city)}`)
      .then(r => r.json())
      .then(d => { setCachedImage(city, d.url); setImgSrc(d.url || null) })
      .catch(() => {})
      .finally(() => setImgLoading(false))
  }, [destination])

  return (
    <div className={`bg-white rounded-2xl overflow-hidden flex flex-col transition-all duration-200 shadow-sm hover:shadow-xl hover:-translate-y-0.5 ${
      isExperimental ? 'ring-1 ring-amber-200' : ''
    }`}>
      {/* Image */}
      <div className="h-44 overflow-hidden relative shrink-0">
        {imgLoading && <div className="w-full h-full bg-gray-200 animate-pulse" />}

        {!imgLoading && imgSrc && (
          <img
            src={imgSrc}
            alt={destination}
            className="w-full h-full object-cover"
            onError={() => setImgSrc(null)}
          />
        )}

        {!imgLoading && !imgSrc && (
          <div className={`w-full h-full bg-gradient-to-br ${fallbackGradient} flex items-center justify-center`}>
            <svg className="w-10 h-10 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
            </svg>
          </div>
        )}

        {/* Gradient overlay for text readability */}
        {!imgLoading && imgSrc && (
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
        )}

        {isExperimental && (
          <span className="absolute top-3 left-3 px-2.5 py-1 bg-amber-500 text-white text-[11px] font-semibold rounded-full shadow-md tracking-wide">
            Wild Card ✦
          </span>
        )}

        {/* Bookmark button */}
        <button
          onClick={onBookmark}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center hover:bg-black/50 transition-colors cursor-pointer"
          aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark'}
        >
          <svg
            className={`w-4 h-4 transition-colors ${bookmarked ? 'text-white' : 'text-white/70'}`}
            fill={bookmarked ? 'currentColor' : 'none'}
            viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="p-5 flex flex-col gap-2.5 flex-1">
        <h3 className="text-[15px] font-semibold text-gray-900 leading-snug">{destination}</h3>
        <p className="text-sm text-gray-500 leading-relaxed flex-1">{reason}</p>

        {personalNote && (
          <div className="pt-2.5 border-t border-blue-50">
            <p className="text-xs text-blue-700 leading-relaxed bg-blue-50 rounded-lg px-3 py-2">
              <span className="font-semibold">For you: </span>{personalNote}
            </p>
          </div>
        )}

        {hearMeOut && (
          <div className="pt-2.5 border-t border-amber-50">
            <p className="text-xs text-amber-700 leading-relaxed bg-amber-50 rounded-lg px-3 py-2">
              <span className="font-semibold">Hear me out: </span>{hearMeOut}
            </p>
          </div>
        )}

        <div className="flex items-center gap-1.5 text-xs text-gray-400 pt-1">
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>Best: <span className="font-medium text-gray-500">{bestTime}</span></span>
        </div>

        <button
          onClick={onPlanNow}
          className="mt-0.5 w-full py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 active:from-blue-800 active:to-indigo-800 text-white text-sm font-semibold rounded-xl transition-all shadow-sm hover:shadow-md flex items-center justify-center gap-1.5"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          Plan Now
        </button>
      </div>
    </div>
  )
}
