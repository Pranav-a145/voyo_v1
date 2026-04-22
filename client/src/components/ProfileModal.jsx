import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

// ─── Shared constants ─────────────────────────────────────────────────────────

const PREFERENCE_TAGS = [
  'Food & Dining', 'Adventure Sports', 'Music Festivals', 'History & Culture',
  'Nightlife', 'Beach & Relaxation', 'Hiking', 'Luxury Travel', 'Budget Travel',
  'Road Trips', 'Wildlife & Nature', 'Photography', 'Spa & Wellness', 'Shopping',
  'Art & Museums', 'Sailing & Water Sports', 'Skiing & Winter Sports',
  'Culinary Tours', 'Backpacking', 'Architecture',
]

const TRIP_ACTIVITY_TAGS = [
  'Beach', 'Hiking', 'Nightlife', 'Food & Dining', 'Museums', 'Shopping',
  'Adventure Sports', 'Spa & Wellness', 'Sailing', 'Skiing', 'History & Culture',
  'Music & Festivals', 'Photography', 'Road Trip', 'Wildlife', 'Cooking Classes',
  'Architecture', 'Local Markets',
]

const BUDGET_OPTIONS = [
  { value: 'budget', label: 'Budget' },
  { value: 'mid-range', label: 'Mid-range' },
  { value: 'luxury', label: 'Luxury' },
  { value: 'flexible', label: 'Flexible' },
]

const TRAVEL_STYLE_OPTIONS = [
  { value: 'slow travel', label: 'Slow Travel' },
  { value: 'fast paced', label: 'Fast Paced' },
  { value: 'adventure', label: 'Adventure' },
  { value: 'relaxation', label: 'Relaxation' },
  { value: 'mixed', label: 'Mixed' },
]

const GROUP_SIZE_OPTIONS = [
  { value: 'solo', label: 'Solo' },
  { value: 'couple', label: 'Couple' },
  { value: 'small group', label: 'Small Group' },
  { value: 'large group', label: 'Large Group' },
  { value: 'varies', label: 'Varies' },
]

// ─── Half-star rating ─────────────────────────────────────────────────────────

function HalfStarRating({ rating, onChange }) {
  const [hovered, setHovered] = useState(0)
  const display = hovered || rating

  return (
    <div className="flex items-center gap-1">
      <div className="flex">
        {[1, 2, 3, 4, 5].map((star) => {
          const isFullFilled = display >= star
          const isHalfFilled = !isFullFilled && display >= star - 0.5
          return (
            <div key={star} className="relative w-6 h-6 select-none">
              <span className="text-xl text-gray-300 leading-none absolute inset-0 flex items-center justify-center pointer-events-none">★</span>
              {(isFullFilled || isHalfFilled) && (
                <span
                  className="text-xl text-amber-400 leading-none absolute inset-0 flex items-center justify-center pointer-events-none"
                  style={{ clipPath: isHalfFilled ? 'inset(0 50% 0 0)' : 'none' }}
                >★</span>
              )}
              <button type="button" className="absolute left-0 top-0 w-1/2 h-full focus:outline-none cursor-pointer"
                onClick={() => onChange(star - 0.5)} onMouseEnter={() => setHovered(star - 0.5)} onMouseLeave={() => setHovered(0)} />
              <button type="button" className="absolute right-0 top-0 w-1/2 h-full focus:outline-none cursor-pointer"
                onClick={() => onChange(star)} onMouseEnter={() => setHovered(star)} onMouseLeave={() => setHovered(0)} />
            </div>
          )
        })}
      </div>
      {rating > 0 && <span className="text-xs text-gray-500 ml-1">{rating}/5</span>}
    </div>
  )
}

// ─── Trip card ────────────────────────────────────────────────────────────────

function TripCard({ trip, index, onUpdate, onRemove }) {
  const [customInput, setCustomInput] = useState('')

  function toggleActivity(tag) {
    const current = trip.activities || []
    const updated = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag]
    onUpdate(index, 'activities', updated)
  }

  function addCustomActivity() {
    const tag = customInput.trim()
    if (!tag) return
    const current = trip.activities || []
    if (!current.includes(tag)) onUpdate(index, 'activities', [...current, tag])
    setCustomInput('')
  }

  function removeCustomActivity(tag) {
    onUpdate(index, 'activities', (trip.activities || []).filter(t => t !== tag))
  }

  const customActivities = (trip.activities || []).filter(t => !TRIP_ACTIVITY_TAGS.includes(t))

  return (
    <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl space-y-3">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={trip.destination}
          onChange={(e) => onUpdate(index, 'destination', e.target.value)}
          placeholder="Destination (e.g. Tokyo, Japan)"
          className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <button type="button" onClick={() => onRemove(index)}
          className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none shrink-0">×</button>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">How was it?</p>
        <HalfStarRating rating={trip.rating} onChange={(r) => onUpdate(index, 'rating', r)} />
      </div>

      <textarea
        value={trip.notes || ''}
        onChange={(e) => onUpdate(index, 'notes', e.target.value)}
        placeholder="Highlights, what you loved, what you'd skip next time…"
        rows={3}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
      />

      <div>
        <p className="text-xs text-gray-500 mb-2">What did you get up to?</p>
        <div className="flex flex-wrap gap-1.5">
          {TRIP_ACTIVITY_TAGS.map((tag) => {
            const selected = (trip.activities || []).includes(tag)
            return (
              <button key={tag} type="button" onClick={() => toggleActivity(tag)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  selected ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600'
                }`}>
                {tag}
              </button>
            )
          })}
          {customActivities.map((tag) => (
            <span key={tag} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-600 border border-blue-600 text-white">
              {tag}
              <button type="button" onClick={() => removeCustomActivity(tag)} className="hover:text-blue-200 transition-colors leading-none">×</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          <input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomActivity() } }}
            placeholder="Add your own (e.g. Paragliding, Wine Tasting…)"
            className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button type="button" onClick={addCustomActivity} disabled={!customInput.trim()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors">
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">{title}</h3>
      {children}
    </div>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function ProfileModal({ profile, userId, onClose, onSave }) {
  const customPreset = (profile?.preferences || []).filter(t => !PREFERENCE_TAGS.includes(t))

  const [form, setForm] = useState({
    preferences:    profile?.preferences    || [],
    customTags:     customPreset,
    budgetCategory: profile?.budget_category || '',
    travelStyle:    profile?.travel_style    || '',
    groupSize:      profile?.group_size      || '',
    pastTrips:      (profile?.past_trips     || []).map(t => ({
      destination: t.destination || '',
      rating:      t.rating      || 0,
      notes:       t.notes       || '',
      activities:  t.activities  || [],
    })),
    aboutMe: profile?.about_me || '',
    age:     profile?.age      || '',
    gender:  profile?.gender   || '',
  })

  const [customInput, setCustomInput] = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)
  const [avatarFile, setAvatarFile]       = useState(null)
  const [avatarPreview, setAvatarPreview] = useState(profile?.avatar_url || null)
  const fileInputRef = useRef(null)

  function handleAvatarChange(e) {
    const file = e.target.files[0]
    if (!file) return
    setAvatarFile(file)
    setAvatarPreview(URL.createObjectURL(file))
  }

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  // ── Interests ──
  function toggleTag(tag) {
    const updated = form.preferences.includes(tag)
      ? form.preferences.filter(t => t !== tag)
      : [...form.preferences, tag]
    set('preferences', updated)
  }

  function addCustomTag() {
    const tag = customInput.trim()
    if (!tag) return
    if (!form.customTags.includes(tag)) set('customTags', [...form.customTags, tag])
    if (!form.preferences.includes(tag)) set('preferences', [...form.preferences, tag])
    setCustomInput('')
  }

  function removeCustomTag(tag) {
    set('customTags', form.customTags.filter(t => t !== tag))
    set('preferences', form.preferences.filter(t => t !== tag))
  }

  // ── Past trips ──
  function addTrip() {
    if (form.pastTrips.length >= 10) return
    set('pastTrips', [...form.pastTrips, { destination: '', rating: 0, notes: '', activities: [] }])
  }

  function removeTrip(index) {
    set('pastTrips', form.pastTrips.filter((_, i) => i !== index))
  }

  function updateTrip(index, field, value) {
    set('pastTrips', form.pastTrips.map((t, i) => i === index ? { ...t, [field]: value } : t))
  }

  // ── Save ──
  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      let avatar_url = profile?.avatar_url || null

      if (avatarFile) {
        const ext  = avatarFile.name.split('.').pop()
        const path = `${userId}/avatar.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(path, avatarFile, { upsert: true })
        if (uploadError) throw uploadError
        const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path)
        avatar_url = urlData.publicUrl
      }

      const pastTrips = form.pastTrips.filter(t => t.destination.trim())
      const payload = {
        id:              userId,
        avatar_url,
        preferences:     form.preferences,
        budget_category: form.budgetCategory,
        travel_style:    form.travelStyle,
        group_size:      form.groupSize,
        past_trips:      pastTrips,
        about_me:        form.aboutMe.trim() || null,
        age:             form.age ? parseInt(form.age, 10) : null,
        gender:          form.gender.trim() || null,
      }
      const { error: err } = await supabase.from('profiles').upsert(payload)
      if (err) throw err
      onSave({ ...profile, ...payload, past_trips: pastTrips })
    } catch (err) {
      setError(err.message || 'Could not save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="relative w-10 h-10 rounded-full shrink-0 group"
              title="Change profile photo"
            >
              {avatarPreview ? (
                <img src={avatarPreview} alt={profile?.full_name} className="w-10 h-10 rounded-full object-cover border border-gray-200" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-semibold select-none">
                  {(profile?.full_name || 'T').charAt(0).toUpperCase()}
                </div>
              )}
              <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
            </button>
            <div>
              <p className="text-sm font-semibold text-gray-900">{profile?.full_name || 'Your Profile'}</p>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="text-xs text-blue-500 hover:underline">
                {avatarPreview ? 'Change photo' : 'Add photo'}
              </button>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors text-2xl leading-none">×</button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-7">

          {/* About */}
          <Section title="About You">
            <textarea
              value={form.aboutMe}
              onChange={(e) => set('aboutMe', e.target.value)}
              placeholder="A brief description of yourself as a traveller — your vibe, what you're chasing, anything Maya should know about you…"
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Age <span className="text-gray-400">(optional)</span></label>
                <input
                  type="number"
                  min="13" max="120"
                  value={form.age}
                  onChange={(e) => set('age', e.target.value)}
                  placeholder="e.g. 28"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Gender <span className="text-gray-400">(optional)</span></label>
                <input
                  type="text"
                  value={form.gender}
                  onChange={(e) => set('gender', e.target.value)}
                  placeholder="e.g. Male, Female, Non-binary…"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </Section>

          {/* Interests */}
          <Section title="Interests">
            <div className="flex flex-wrap gap-2">
              {PREFERENCE_TAGS.map((tag) => {
                const selected = form.preferences.includes(tag)
                return (
                  <button key={tag} type="button" onClick={() => toggleTag(tag)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                      selected ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:border-blue-400 hover:text-blue-600'
                    }`}>
                    {tag}
                  </button>
                )
              })}
              {form.customTags.map((tag) => (
                <span key={tag} className="flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium bg-blue-600 border border-blue-600 text-white">
                  {tag}
                  <button type="button" onClick={() => removeCustomTag(tag)} className="hover:text-blue-200 transition-colors leading-none">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag() } }}
                placeholder="Add your own interest…"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button type="button" onClick={addCustomTag} disabled={!customInput.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors">
                Add
              </button>
            </div>
          </Section>

          {/* Travel preferences */}
          <Section title="Travel Preferences">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { label: 'Budget', field: 'budgetCategory', options: BUDGET_OPTIONS },
                { label: 'Travel style', field: 'travelStyle', options: TRAVEL_STYLE_OPTIONS },
                { label: 'Group size', field: 'groupSize', options: GROUP_SIZE_OPTIONS },
              ].map(({ label, field, options }) => (
                <div key={field}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  <select
                    value={form[field]}
                    onChange={(e) => set(field, e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="" disabled>Select…</option>
                    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </Section>

          {/* Past trips */}
          <Section title="Past Trips">
            <div className="space-y-3">
              {form.pastTrips.map((trip, i) => (
                <TripCard key={i} trip={trip} index={i} onUpdate={updateTrip} onRemove={removeTrip} />
              ))}
              {form.pastTrips.length === 0 && (
                <p className="text-sm text-gray-400 italic">No trips added yet.</p>
              )}
            </div>
            {form.pastTrips.length < 10 && (
              <button type="button" onClick={addTrip}
                className="flex items-center gap-1.5 text-sm text-blue-600 hover:underline font-medium">
                <span className="text-lg leading-none">+</span> Add a trip
              </button>
            )}
          </Section>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 shrink-0 space-y-2">
          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
