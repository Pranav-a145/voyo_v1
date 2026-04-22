import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// ─── Constants ────────────────────────────────────────────────────────────────

const PREFERENCE_TAGS = [
  'Food & Dining',
  'Adventure Sports',
  'Music Festivals',
  'History & Culture',
  'Nightlife',
  'Beach & Relaxation',
  'Hiking',
  'Luxury Travel',
  'Budget Travel',
  'Road Trips',
  'Wildlife & Nature',
  'Photography',
  'Spa & Wellness',
  'Shopping',
  'Art & Museums',
  'Sailing & Water Sports',
  'Skiing & Winter Sports',
  'Culinary Tours',
  'Backpacking',
  'Architecture',
]

const TRIP_ACTIVITY_TAGS = [
  'Beach',
  'Hiking',
  'Nightlife',
  'Food & Dining',
  'Museums',
  'Shopping',
  'Adventure Sports',
  'Spa & Wellness',
  'Sailing',
  'Skiing',
  'History & Culture',
  'Music & Festivals',
  'Photography',
  'Road Trip',
  'Wildlife',
  'Cooking Classes',
  'Architecture',
  'Local Markets',
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

const TOTAL_STEPS = 3

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProgressBar({ step }) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">Step {step} of {TOTAL_STEPS}</span>
        <span className="text-sm text-gray-400">
          {step === 1 ? 'Basic info' : step === 2 ? 'About you & preferences' : 'Past trips'}
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-1.5">
        <div
          className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
          style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
        />
      </div>
    </div>
  )
}

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
              {/* Empty star base */}
              <span className="text-xl text-gray-300 leading-none absolute inset-0 flex items-center justify-center pointer-events-none">
                ★
              </span>
              {/* Amber overlay — same size as base, clipped for half */}
              {(isFullFilled || isHalfFilled) && (
                <span
                  className="text-xl text-amber-400 leading-none absolute inset-0 flex items-center justify-center pointer-events-none"
                  style={{ clipPath: isHalfFilled ? 'inset(0 50% 0 0)' : 'none' }}
                >
                  ★
                </span>
              )}
              {/* Left half zone → X - 0.5 */}
              <button
                type="button"
                className="absolute left-0 top-0 w-1/2 h-full focus:outline-none cursor-pointer"
                onClick={() => onChange(star - 0.5)}
                onMouseEnter={() => setHovered(star - 0.5)}
                onMouseLeave={() => setHovered(0)}
                aria-label={`${star - 0.5} stars`}
              />
              {/* Right half zone → X */}
              <button
                type="button"
                className="absolute right-0 top-0 w-1/2 h-full focus:outline-none cursor-pointer"
                onClick={() => onChange(star)}
                onMouseEnter={() => setHovered(star)}
                onMouseLeave={() => setHovered(0)}
                aria-label={`${star} stars`}
              />
            </div>
          )
        })}
      </div>
      {rating > 0 && (
        <span className="text-xs text-gray-500 ml-1">{rating}/5</span>
      )}
    </div>
  )
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      >
        <option value="" disabled>Select one…</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

// ─── Steps ────────────────────────────────────────────────────────────────────

function Step1({ data, onChange }) {
  const fileInputRef = useRef(null)
  const [preview, setPreview] = useState(data.avatarPreview || null)

  function handleFileChange(e) {
    const file = e.target.files[0]
    if (!file) return
    onChange('avatarFile', file)
    const url = URL.createObjectURL(file)
    setPreview(url)
    onChange('avatarPreview', url)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Let's start with the basics</h2>
        <p className="text-sm text-gray-500 mt-1">Your name and a photo help personalise your experience.</p>
      </div>

      {/* Avatar upload */}
      <div className="flex flex-col items-center gap-3">
        <div
          onClick={() => fileInputRef.current.click()}
          className="w-24 h-24 rounded-full bg-gray-100 border-2 border-dashed border-gray-300 flex items-center justify-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors overflow-hidden"
        >
          {preview ? (
            <img src={preview} alt="Profile preview" className="w-full h-full object-cover" />
          ) : (
            <span className="text-3xl text-gray-400 select-none">+</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current.click()}
          className="text-sm text-blue-600 hover:underline"
        >
          {preview ? 'Change photo' : 'Upload photo'} (optional)
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* Full name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="fullName">
          Full name
        </label>
        <input
          id="fullName"
          type="text"
          required
          value={data.fullName}
          onChange={(e) => onChange('fullName', e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="Jane Smith"
        />
      </div>
    </div>
  )
}

function Step2({ data, onChange }) {
  const [customInput, setCustomInput] = useState('')

  function toggleTag(tag) {
    const current = data.preferences
    const updated = current.includes(tag)
      ? current.filter((t) => t !== tag)
      : [...current, tag]
    onChange('preferences', updated)
  }

  function addCustomTag() {
    const tag = customInput.trim()
    if (!tag) return
    if (!data.customTags.includes(tag)) {
      onChange('customTags', [...data.customTags, tag])
    }
    if (!data.preferences.includes(tag)) {
      onChange('preferences', [...data.preferences, tag])
    }
    setCustomInput('')
  }

  function removeCustomTag(tag) {
    onChange('customTags', data.customTags.filter((t) => t !== tag))
    onChange('preferences', data.preferences.filter((t) => t !== tag))
  }

  function handleCustomKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addCustomTag()
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Tell us about yourself</h2>
        <p className="text-sm text-gray-500 mt-1">Help Maya tailor every recommendation to you specifically.</p>
      </div>

      {/* About me + age + gender */}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            About you <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={data.aboutMe}
            onChange={(e) => onChange('aboutMe', e.target.value)}
            placeholder="Your travel vibe, what you're chasing, anything Maya should know about you…"
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Age <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="number"
              min="13" max="120"
              value={data.age}
              onChange={(e) => onChange('age', e.target.value)}
              placeholder="e.g. 28"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Gender <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={data.gender}
              onChange={(e) => onChange('gender', e.target.value)}
              placeholder="e.g. Male, Female, Non-binary…"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
      </div>

      {/* Preset preference tags */}
      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Interests</p>
        <div className="flex flex-wrap gap-2">
          {PREFERENCE_TAGS.map((tag) => {
            const selected = data.preferences.includes(tag)
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                  selected
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-300 text-gray-700 hover:border-blue-400 hover:text-blue-600'
                }`}
              >
                {tag}
              </button>
            )
          })}
        </div>
      </div>

      {/* Custom interest input */}
      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Add your own</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={handleCustomKeyDown}
            placeholder="e.g. Surfing, Street Art, Rock Climbing…"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            type="button"
            onClick={addCustomTag}
            disabled={!customInput.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            Add
          </button>
        </div>

        {/* Custom tags */}
        {data.customTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {data.customTags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium bg-blue-600 border border-blue-600 text-white"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => removeCustomTag(tag)}
                  className="ml-0.5 hover:text-blue-200 transition-colors leading-none"
                  aria-label={`Remove ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SelectField
          label="Budget category"
          value={data.budgetCategory}
          onChange={(v) => onChange('budgetCategory', v)}
          options={BUDGET_OPTIONS}
        />
        <SelectField
          label="Travel style"
          value={data.travelStyle}
          onChange={(v) => onChange('travelStyle', v)}
          options={TRAVEL_STYLE_OPTIONS}
        />
        <SelectField
          label="Group size"
          value={data.groupSize}
          onChange={(v) => onChange('groupSize', v)}
          options={GROUP_SIZE_OPTIONS}
        />
      </div>
    </div>
  )
}

function TripCard({ trip, index, onUpdate, onRemove }) {
  const [customInput, setCustomInput] = useState('')

  function toggleActivity(tag) {
    const current = trip.activities || []
    const updated = current.includes(tag)
      ? current.filter((t) => t !== tag)
      : [...current, tag]
    onUpdate(index, 'activities', updated)
  }

  function addCustomActivity() {
    const tag = customInput.trim()
    if (!tag) return
    const current = trip.activities || []
    if (!current.includes(tag)) {
      onUpdate(index, 'activities', [...current, tag])
    }
    setCustomInput('')
  }

  function removeCustomActivity(tag) {
    onUpdate(index, 'activities', (trip.activities || []).filter((t) => t !== tag))
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); addCustomActivity() }
  }

  const customActivities = (trip.activities || []).filter((t) => !TRIP_ACTIVITY_TAGS.includes(t))

  return (
    <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl space-y-3">

      {/* Destination + remove */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={trip.destination}
          onChange={(e) => onUpdate(index, 'destination', e.target.value)}
          placeholder="Destination (e.g. Tokyo, Japan)"
          className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <button
          type="button"
          onClick={() => onRemove(index)}
          className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none shrink-0"
          aria-label="Remove trip"
        >
          ×
        </button>
      </div>

      {/* Half-star rating */}
      <div>
        <p className="text-xs text-gray-500 mb-1">How was it?</p>
        <HalfStarRating
          rating={trip.rating}
          onChange={(r) => onUpdate(index, 'rating', r)}
        />
      </div>

      {/* Notes */}
      <textarea
        value={trip.notes}
        onChange={(e) => onUpdate(index, 'notes', e.target.value)}
        placeholder="Tell us about this trip — highlights, what you loved, what you'd skip next time, the vibe, anything that stands out…"
        rows={3}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
      />

      {/* Activity tags */}
      <div>
        <p className="text-xs text-gray-500 mb-2">What did you get up to?</p>
        <div className="flex flex-wrap gap-1.5">
          {TRIP_ACTIVITY_TAGS.map((tag) => {
            const selected = (trip.activities || []).includes(tag)
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleActivity(tag)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  selected
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600'
                }`}
              >
                {tag}
              </button>
            )
          })}
          {/* Custom activity chips */}
          {customActivities.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-600 border border-blue-600 text-white"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeCustomActivity(tag)}
                className="hover:text-blue-200 transition-colors leading-none"
                aria-label={`Remove ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        {/* Custom activity input */}
        <div className="flex gap-2 mt-2">
          <input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add your own (e.g. Paragliding, Wine Tasting…)"
            className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            type="button"
            onClick={addCustomActivity}
            disabled={!customInput.trim()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
          >
            Add
          </button>
        </div>
      </div>

    </div>
  )
}

function Step3({ data, onChange }) {
  function addTrip() {
    if (data.pastTrips.length >= 10) return
    onChange('pastTrips', [
      ...data.pastTrips,
      { destination: '', rating: 0, notes: '', activities: [] },
    ])
  }

  function removeTrip(index) {
    onChange('pastTrips', data.pastTrips.filter((_, i) => i !== index))
  }

  function updateTrip(index, field, value) {
    const updated = data.pastTrips.map((trip, i) =>
      i === index ? { ...trip, [field]: value } : trip
    )
    onChange('pastTrips', updated)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Where have you been?</h2>
        <p className="text-sm text-gray-500 mt-1">Add past trips to help us understand your travel experience. Up to 10.</p>
      </div>

      <div className="space-y-4">
        {data.pastTrips.map((trip, index) => (
          <TripCard
            key={index}
            trip={trip}
            index={index}
            onUpdate={updateTrip}
            onRemove={removeTrip}
          />
        ))}

        {data.pastTrips.length === 0 && (
          <p className="text-sm text-gray-400 italic">No trips added yet — skip this step if you prefer.</p>
        )}
      </div>

      {data.pastTrips.length < 10 && (
        <button
          type="button"
          onClick={addTrip}
          className="flex items-center gap-1.5 text-sm text-blue-600 hover:underline font-medium"
        >
          <span className="text-lg leading-none">+</span> Add a trip
        </button>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ProfileSetup() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState(1)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const [formData, setFormData] = useState({
    fullName: user?.user_metadata?.full_name || '',
    avatarFile: null,
    avatarPreview: null,
    aboutMe: '',
    age: '',
    gender: '',
    preferences: [],
    customTags: [],
    budgetCategory: '',
    travelStyle: '',
    groupSize: '',
    pastTrips: [],
  })

  function handleChange(field, value) {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  function canAdvance() {
    if (step === 1) return formData.fullName.trim().length > 0
    if (step === 2) return formData.budgetCategory && formData.travelStyle && formData.groupSize
    return true
  }

  function handleNext() {
    if (canAdvance()) setStep((s) => s + 1)
  }

  function handleBack() {
    setStep((s) => s - 1)
  }

  async function handleSubmit() {
    setError(null)
    setSubmitting(true)

    try {
      let avatarUrl = null

      if (formData.avatarFile) {
        const ext = formData.avatarFile.name.split('.').pop()
        const path = `${user.id}/avatar.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(path, formData.avatarFile, { upsert: true })

        if (uploadError) throw uploadError

        const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path)
        avatarUrl = urlData.publicUrl
      }

      const pastTrips = formData.pastTrips.filter(
        (t) => t.destination.trim().length > 0
      )

      const { error: upsertError } = await supabase.from('profiles').upsert({
        id: user.id,
        full_name: formData.fullName.trim(),
        avatar_url: avatarUrl,
        about_me: formData.aboutMe.trim() || null,
        age: formData.age ? parseInt(formData.age, 10) : null,
        gender: formData.gender.trim() || null,
        preferences: formData.preferences,
        budget_category: formData.budgetCategory,
        travel_style: formData.travelStyle,
        group_size: formData.groupSize,
        past_trips: pastTrips,
      })

      if (upsertError) throw upsertError

      navigate('/dashboard')
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <ProgressBar step={step} />

        {step === 1 && <Step1 data={formData} onChange={handleChange} />}
        {step === 2 && <Step2 data={formData} onChange={handleChange} />}
        {step === 3 && <Step3 data={formData} onChange={handleChange} />}

        {error && (
          <p className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between mt-8 pt-6 border-t border-gray-100">
          {step > 1 ? (
            <button
              type="button"
              onClick={handleBack}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
            >
              ← Back
            </button>
          ) : (
            <div />
          )}

          {step < TOTAL_STEPS ? (
            <button
              type="button"
              onClick={handleNext}
              disabled={!canAdvance()}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {submitting ? 'Saving…' : 'Complete setup'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
