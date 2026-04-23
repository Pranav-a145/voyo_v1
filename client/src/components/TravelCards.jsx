import { useState } from 'react'

// ─── Flight Card ──────────────────────────────────────────────────────────────

function formatFlightTime(raw) {
  if (!raw) return null
  const timePart = raw.includes(' ') ? raw.split(' ')[1] : raw
  if (!timePart || !timePart.includes(':')) return raw
  const [h, m] = timePart.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`
}

function formatFlightDate(raw) {
  if (!raw) return null
  const datePart = raw.includes(' ') ? raw.split(' ')[0] : raw
  try {
    return new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return null }
}

function formatHotelDates(checkIn, checkOut) {
  if (!checkIn) return null
  try {
    const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return checkOut ? `${fmt(checkIn)} – ${fmt(checkOut)}` : fmt(checkIn)
  } catch { return null }
}

function formatMins(mins) {
  if (!mins) return null
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function StopBadge({ stops }) {
  if (stops === 0) return <span className="text-xs font-medium text-green-600">Nonstop</span>
  return <span className="text-xs font-medium text-amber-600">{stops} stop{stops > 1 ? 's' : ''}</span>
}

function FlightCard({ flight }) {
  const [logoFailed, setLogoFailed] = useState(false)
  const {
    airline, price, duration_minutes, stops,
    departure_time, arrival_time,
    origin_airport, destination_airport, layover_airport,
    search_url, isRoundTrip,
  } = flight

  const bookingUrl = search_url ?? 'https://www.google.com/travel/flights'

  return (
    <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5 shadow-sm flex items-center gap-4">
      {/* Airline logo */}
      <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center shrink-0 overflow-hidden">
        {!logoFailed ? (
          <img
            src={`https://logo.clearbit.com/${airline?.toLowerCase().replace(/\s+/g, '')}.com`}
            alt={airline}
            className="w-8 h-8 object-contain"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span className="text-xs font-bold text-gray-500 flex items-center justify-center w-full h-full">
            {airline?.slice(0, 2).toUpperCase()}
          </span>
        )}
      </div>

      {/* Times + route */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <div className="text-center">
            {formatFlightDate(departure_time) && (
              <div className="text-[10px] text-gray-400 font-medium mb-0.5">{formatFlightDate(departure_time)}</div>
            )}
            <div className="text-sm font-semibold text-gray-900">{formatFlightTime(departure_time) ?? '—'}</div>
            {origin_airport && <div className="text-xs text-gray-400">{origin_airport}</div>}
          </div>
          <div className="flex-1 flex flex-col items-center gap-0.5 mx-1">
            <span className="w-full border-t border-dashed border-gray-300" />
            <div className="flex items-center gap-1">
              <StopBadge stops={stops ?? 0} />
              {layover_airport && (
                <span className="text-xs text-gray-400">via {layover_airport}</span>
              )}
            </div>
          </div>
          <div className="text-center">
            {formatFlightDate(arrival_time) && (
              <div className="text-[10px] text-gray-400 font-medium mb-0.5">{formatFlightDate(arrival_time)}</div>
            )}
            <div className="text-sm font-semibold text-gray-900">{formatFlightTime(arrival_time) ?? '—'}</div>
            {destination_airport && <div className="text-xs text-gray-400">{destination_airport}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-gray-500 truncate">{airline}</span>
          {duration_minutes && (
            <span className="text-xs text-gray-400">· {formatMins(duration_minutes)}</span>
          )}
        </div>
      </div>

      {/* Price + CTA */}
      <div className="shrink-0 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <div className="text-base font-bold text-gray-900">{price ?? 'N/A'}</div>
          {isRoundTrip && (
            <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 border border-blue-200 rounded px-1 py-0.5 whitespace-nowrap">Round Trip</span>
          )}
        </div>
        <a
          href={bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-xs font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap"
        >
          Book on Google Flights →
        </a>
      </div>
    </div>
  )
}

// ─── Hotel Card ───────────────────────────────────────────────────────────────

function StarRating({ rating }) {
  const filled = Math.round(rating ?? 0)
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <svg
          key={i}
          className={`w-3 h-3 ${i <= filled ? 'text-amber-400' : 'text-gray-200'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
      {rating && <span className="text-xs text-gray-500 ml-1">{Number(rating).toFixed(1)}</span>}
    </div>
  )
}

function HotelCard({ hotel, checkIn, checkOut }) {
  const [imgFailed, setImgFailed] = useState(false)
  const { name, price, price_per_night, rating, link, thumbnail, address } = hotel
  const displayPrice = price_per_night ?? price
  const dateRange = formatHotelDates(checkIn, checkOut)
  const showImg = thumbnail && !imgFailed

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm w-56 shrink-0 flex flex-col">
      {/* Thumbnail */}
      <div className="h-32 bg-gray-100 overflow-hidden relative">
        {showImg ? (
          <img
            src={thumbnail}
            alt={name}
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gray-100">
            <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              <polyline strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} points="9 22 9 12 15 12 15 22" />
            </svg>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-3 flex flex-col flex-1">
        <h3 className="text-sm font-semibold text-gray-900 leading-tight line-clamp-1">{name}</h3>
        {dateRange && <p className="text-[10px] font-medium text-blue-500 mt-0.5">{dateRange}</p>}
        {address && <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{address}</p>}
        <StarRating rating={rating} />

        <div className="mt-auto pt-2 flex items-end justify-between">
          <div>
            {displayPrice ? (
              <>
                <span className="text-base font-bold text-gray-900">{displayPrice}</span>
                <span className="text-xs text-gray-400"> /night</span>
              </>
            ) : (
              <span className="text-xs text-gray-400">Price unavailable</span>
            )}
          </div>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
            >
              Book
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Activity Card ────────────────────────────────────────────────────────────

function ActivityCard({ activity }) {
  const [imgFailed, setImgFailed] = useState(false)
  const { title, description, rating, reviews, link, thumbnail } = activity
  const showImg = thumbnail && !imgFailed

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm w-52 shrink-0 flex flex-col">
      {/* Thumbnail */}
      <div className="h-28 bg-gray-100 overflow-hidden relative">
        {showImg ? (
          <img
            src={thumbnail}
            alt={title}
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gray-100">
            <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-3 flex flex-col flex-1">
        <h3 className="text-sm font-semibold text-gray-900 leading-tight line-clamp-1">{title}</h3>

        {(rating || reviews) && (
          <div className="flex items-center gap-1.5 mt-1">
            {rating && (
              <div className="flex items-center gap-0.5">
                <svg className="w-3 h-3 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                <span className="text-xs font-medium text-gray-700">{rating}</span>
              </div>
            )}
            {reviews && <span className="text-xs text-gray-400">({reviews})</span>}
          </div>
        )}

        {description && (
          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed line-clamp-2">{description}</p>
        )}

        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto pt-2 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            View More →
          </a>
        )}
      </div>
    </div>
  )
}

// ─── Budget Collapsible ───────────────────────────────────────────────────────

function BudgetCollapsible({ budget }) {
  const [open, setOpen] = useState(false)
  const { lines, total, budget: totalBudget, leftOver } = budget
  const overBudget = leftOver < 0
  const fmt = (n) => `$${Math.round(Math.abs(n)).toLocaleString()}`

  return (
    <div className="border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-800">Budget Breakdown</span>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${overBudget ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
            {overBudget ? `${fmt(leftOver)} over` : `${fmt(leftOver)} left over`}
          </span>
        </div>
        <div className="flex items-center gap-1 text-gray-400">
          <span className="text-xs font-medium">{open ? 'Collapse' : 'Expand'}</span>
          <svg
            className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          <table className="w-full text-sm">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-2.5 text-gray-600">{line.label}</td>
                  <td className="px-4 py-2.5 text-right font-medium text-gray-800 tabular-nums whitespace-nowrap">
                    {line.isEstimate ? '~' : ''}{fmt(line.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={2} className="px-4 pt-0.5"><div className="border-t-2 border-gray-200" /></td></tr>
              <tr>
                <td className="px-4 py-2.5 font-semibold text-gray-900">Total Estimated Spend</td>
                <td className="px-4 py-2.5 text-right font-bold text-gray-900 tabular-nums whitespace-nowrap">{fmt(total)}</td>
              </tr>
              <tr>
                <td className="px-4 py-1.5 text-xs text-gray-400">Your Budget</td>
                <td className="px-4 py-1.5 text-right text-xs text-gray-400 tabular-nums whitespace-nowrap">{fmt(totalBudget)}</td>
              </tr>
              <tr className={overBudget ? 'bg-red-50' : 'bg-green-50'}>
                <td className={`px-4 py-3 font-semibold text-sm ${overBudget ? 'text-red-700' : 'text-green-700'}`}>
                  {overBudget ? 'Over Budget' : 'Left Over'}
                </td>
                <td className={`px-4 py-3 text-right font-bold text-sm tabular-nums whitespace-nowrap ${overBudget ? 'text-red-700' : 'text-green-700'}`}>
                  {overBudget ? '-' : '~'}{fmt(leftOver)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── TravelCards (combined) ───────────────────────────────────────────────────

export default function TravelCards({ cards }) {
  const flights      = (cards.flights    || []).slice(0, 3)
  const hotels       = (cards.hotels     || []).slice(0, 3)
  const { checkIn, checkOut } = cards
  const activities   = (cards.activities || []).slice(0, 20)
  const activityLabel = cards.isItinerary
    ? 'Activities'
    : cards.activityType
      ? cards.activityType.replace(/\b\w/g, c => c.toUpperCase())
      : 'Things to Do'

  const hasFlights    = flights.length > 0
  const hasHotels     = hotels.length > 0
  const hasActivities = activities.length > 0

  if (!hasFlights && !hasHotels && !hasActivities) return null

  return (
    <div className="px-4 space-y-4 mt-1">
      {cards.isItinerary && (
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-0.5 border-t border-gray-100 pt-3">
          Booking Summary — Book & Reserve Below
        </p>
      )}
      {/* Flights — stacked vertically */}
      {hasFlights && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-0.5">Flights</p>
          <div className="space-y-2">
            {flights.map((f, i) => <FlightCard key={i} flight={f} />)}
          </div>
        </div>
      )}

      {/* Hotels — horizontal scroll */}
      {hasHotels && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-0.5">Hotels</p>
          <div className={`flex gap-3 overflow-x-auto pb-2 ${hotels.length >= 3 ? '[&::-webkit-scrollbar]:block [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-track]:bg-gray-200 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-400 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:hover:bg-gray-500' : '[&::-webkit-scrollbar]:hidden [scrollbar-width:none]'}`}>
            {hotels.map((h, i) => <HotelCard key={i} hotel={h} checkIn={checkIn} checkOut={checkOut} />)}
          </div>
        </div>
      )}

      {/* Activities — horizontal scroll */}
      {hasActivities && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-0.5">{activityLabel}</p>
          <div className={`flex gap-3 overflow-x-auto pb-2 ${activities.length >= 3 ? '[&::-webkit-scrollbar]:block [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-track]:bg-gray-200 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-400 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:hover:bg-gray-500' : '[&::-webkit-scrollbar]:hidden [scrollbar-width:none]'}`}>
            {activities.map((a, i) => <ActivityCard key={i} activity={a} />)}
          </div>
        </div>
      )}

      {/* Budget breakdown — collapsible, itinerary only */}
      {cards.isItinerary && cards.budget && (
        <BudgetCollapsible budget={cards.budget} />
      )}
    </div>
  )
}
