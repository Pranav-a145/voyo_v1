import { useState } from 'react'

function SectionHeader({ title, count, onAdd }) {
  return (
    <div className="flex items-center justify-between mt-5 mb-2">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</p>
      <button type="button" onClick={onAdd}
        className="text-xs text-blue-600 hover:text-blue-700 font-medium">
        + Add {count > 0 ? 'another' : title.toLowerCase().replace(/s$/, '')}
      </button>
    </div>
  )
}

function Field({ label, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400" />
    </div>
  )
}

const emptyFlight  = () => ({ airline: '', depDate: '', depTime: '', arrDate: '', arrTime: '', cost: '', link: '' })
const emptyHotel   = () => ({ name: '', checkIn: '', checkOut: '', cost: '', link: '' })
const emptyActivity = () => ({ name: '', date: '', cost: '', link: '' })

export default function AddManualTripModal({ onSave, onClose }) {
  const [destination, setDestination] = useState('')
  const [depDate,     setDepDate]     = useState('')
  const [retDate,     setRetDate]     = useState('')
  const [budget,      setBudget]      = useState('')
  const [flights,     setFlights]     = useState([emptyFlight()])
  const [hotels,      setHotels]      = useState([emptyHotel()])
  const [activities,  setActivities]  = useState([emptyActivity()])
  const [saving,      setSaving]      = useState(false)

  function updateFlight(i, field, val) {
    setFlights(prev => prev.map((f, idx) => idx === i ? { ...f, [field]: val } : f))
  }
  function updateHotel(i, field, val) {
    setHotels(prev => prev.map((h, idx) => idx === i ? { ...h, [field]: val } : h))
  }
  function updateActivity(i, field, val) {
    setActivities(prev => prev.map((a, idx) => idx === i ? { ...a, [field]: val } : a))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!destination.trim() || !depDate) return
    setSaving(true)
    await onSave({
      destination: destination.trim(),
      departureDate: depDate,
      returnDate: retDate,
      budget: budget.trim(),
      manualFlights:    flights.filter(f => f.airline || f.link),
      manualHotels:     hotels.filter(h => h.name || h.link),
      manualActivities: activities.filter(a => a.name || a.link),
    })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 px-0 sm:px-4">
      <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">Add Trip Manually</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-5 py-4 space-y-3">

          {/* Trip basics */}
          <Field label="Destination *" value={destination} onChange={setDestination} placeholder="e.g. Tokyo, Japan" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Departure Date *" type="date" value={depDate} onChange={setDepDate} />
            <Field label="Return Date" type="date" value={retDate} onChange={setRetDate} />
          </div>
          <Field label="Budget / Cost" value={budget} onChange={setBudget} placeholder="e.g. $3,000 total" />

          {/* Flights */}
          <SectionHeader title="Flights" count={flights.length} onAdd={() => setFlights(p => [...p, emptyFlight()])} />
          {flights.map((f, i) => (
            <div key={i} className="bg-gray-50 rounded-xl p-3 space-y-2 relative">
              {flights.length > 1 && (
                <button type="button" onClick={() => setFlights(p => p.filter((_, idx) => idx !== i))}
                  className="absolute top-2 right-2 text-gray-300 hover:text-red-400 text-xs">✕</button>
              )}
              <Field label="Airline" value={f.airline} onChange={v => updateFlight(i, 'airline', v)} placeholder="e.g. Japan Airlines" />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Departure Date" type="date" value={f.depDate} onChange={v => updateFlight(i, 'depDate', v)} />
                <Field label="Departure Time" type="time" value={f.depTime} onChange={v => updateFlight(i, 'depTime', v)} />
                <Field label="Arrival Date" type="date" value={f.arrDate} onChange={v => updateFlight(i, 'arrDate', v)} />
                <Field label="Arrival Time" type="time" value={f.arrTime} onChange={v => updateFlight(i, 'arrTime', v)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Cost" value={f.cost} onChange={v => updateFlight(i, 'cost', v)} placeholder="e.g. $850" />
                <Field label="Booking Link" value={f.link} onChange={v => updateFlight(i, 'link', v)} placeholder="https://..." />
              </div>
            </div>
          ))}

          {/* Hotels */}
          <SectionHeader title="Hotels" count={hotels.length} onAdd={() => setHotels(p => [...p, emptyHotel()])} />
          {hotels.map((h, i) => (
            <div key={i} className="bg-gray-50 rounded-xl p-3 space-y-2 relative">
              {hotels.length > 1 && (
                <button type="button" onClick={() => setHotels(p => p.filter((_, idx) => idx !== i))}
                  className="absolute top-2 right-2 text-gray-300 hover:text-red-400 text-xs">✕</button>
              )}
              <Field label="Hotel Name" value={h.name} onChange={v => updateHotel(i, 'name', v)} placeholder="e.g. Park Hyatt Tokyo" />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Check-in" type="date" value={h.checkIn} onChange={v => updateHotel(i, 'checkIn', v)} />
                <Field label="Check-out" type="date" value={h.checkOut} onChange={v => updateHotel(i, 'checkOut', v)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Cost / Night" value={h.cost} onChange={v => updateHotel(i, 'cost', v)} placeholder="e.g. $200/night" />
                <Field label="Booking Link" value={h.link} onChange={v => updateHotel(i, 'link', v)} placeholder="https://..." />
              </div>
            </div>
          ))}

          {/* Activities */}
          <SectionHeader title="Activities" count={activities.length} onAdd={() => setActivities(p => [...p, emptyActivity()])} />
          {activities.map((a, i) => (
            <div key={i} className="bg-gray-50 rounded-xl p-3 space-y-2 relative">
              {activities.length > 1 && (
                <button type="button" onClick={() => setActivities(p => p.filter((_, idx) => idx !== i))}
                  className="absolute top-2 right-2 text-gray-300 hover:text-red-400 text-xs">✕</button>
              )}
              <Field label="Activity Name" value={a.name} onChange={v => updateActivity(i, 'name', v)} placeholder="e.g. teamLab Borderless" />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Date" type="date" value={a.date} onChange={v => updateActivity(i, 'date', v)} />
                <Field label="Cost" value={a.cost} onChange={v => updateActivity(i, 'cost', v)} placeholder="e.g. $30" />
              </div>
              <Field label="Booking Link" value={a.link} onChange={v => updateActivity(i, 'link', v)} placeholder="https://..." />
            </div>
          ))}

          <div className="pb-2" />
        </form>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 flex gap-3 shrink-0">
          <button type="button" onClick={onClose}
            className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-xl transition-colors">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving || !destination.trim() || !depDate}
            className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-semibold rounded-xl transition-colors">
            {saving ? 'Saving…' : 'Save Trip'}
          </button>
        </div>
      </div>
    </div>
  )
}
