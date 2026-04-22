import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import AppLayout from '../components/AppLayout'

function formatDateRange(dep, ret) {
  if (!dep) return null
  try {
    const d = new Date(dep + 'T12:00:00')
    const r = ret ? new Date(ret + 'T12:00:00') : null
    const fmt = date => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return r ? `${fmt(d)} – ${fmt(r)}` : fmt(d)
  } catch { return null }
}

function timeAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export default function ActiveTrips() {
  const { user }  = useAuth()
  const navigate  = useNavigate()

  const [sessions, setSessions] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [menuOpen, setMenuOpen] = useState(null) // sessionId of open menu
  const [renaming, setRenaming] = useState(null) // sessionId being renamed
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('chat_sessions').eq('id', user.id).single()
      .then(({ data }) => {
        const raw = data?.chat_sessions || []
        // Sort by most recently updated first
        setSessions([...raw].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)))
        setLoading(false)
      })
  }, [user])

  async function deleteSession(id) {
    const updated = sessions.filter(s => s.id !== id)
    setSessions(updated)
    await supabase.from('profiles').upsert({ id: user.id, chat_sessions: updated })
  }

  async function renameSession(id) {
    if (!renameValue.trim()) { setRenaming(null); return }
    const updated = sessions.map(s => s.id === id ? { ...s, title: renameValue.trim() } : s)
    setSessions(updated)
    await supabase.from('profiles').upsert({ id: user.id, chat_sessions: updated })
    setRenaming(null)
    setMenuOpen(null)
  }

  const atLimit = sessions.length >= 3

  return (
    <AppLayout>
      <div className="flex-1" onClick={() => setMenuOpen(null)}>
        <main className="max-w-2xl mx-auto px-6 py-10">

          <div className="mb-8 flex items-end justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">Active Trip Planning</h1>
              <p className="text-sm text-gray-500 mt-1">
                {sessions.length > 0
                  ? `${sessions.length} of 3 planning slots used`
                  : 'No active planning chats'}
              </p>
            </div>
            <button
              onClick={() => !atLimit && navigate('/chat/new')}
              disabled={atLimit}
              className={`px-4 py-2 text-sm font-medium rounded-xl transition-colors ${
                atLimit
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              + New Trip
            </button>
          </div>

          {atLimit && (
            <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800">
              All 3 planning slots are full. Delete or complete a trip below to start a new one.
            </div>
          )}

          {loading ? (
            <div className="space-y-3">
              {[1, 2].map(i => (
                <div key={i} className="bg-white border border-gray-200 rounded-2xl p-5">
                  <div className="h-5 w-48 bg-gray-200 rounded animate-pulse mb-2" />
                  <div className="h-3.5 w-32 bg-gray-100 rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <svg className="w-12 h-12 text-gray-200 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
              </svg>
              <p className="text-gray-500 font-medium">No trips in planning</p>
              <p className="text-sm text-gray-400 mt-1">Start planning your next adventure.</p>
              <button onClick={() => navigate('/chat/new')}
                className="mt-6 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
                Plan a Trip →
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {sessions.map(s => (
                <div key={s.id}
                  className="bg-white border border-gray-200 rounded-2xl p-5 hover:border-blue-200 hover:shadow-sm transition-all cursor-pointer relative"
                  onClick={() => navigate(`/chat/${s.id}`)}>

                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0 pr-8">
                      {renaming === s.id ? (
                        <input autoFocus value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onClick={e => e.stopPropagation()}
                          onBlur={() => renameSession(s.id)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') renameSession(s.id)
                            if (e.key === 'Escape') setRenaming(null)
                          }}
                          className="text-base font-semibold text-gray-900 border-b border-blue-500 outline-none bg-transparent w-full"
                        />
                      ) : (
                        <p className="text-base font-semibold text-gray-900 truncate">{s.title || 'New Trip'}</p>
                      )}
                      <div className="flex items-center gap-3 mt-1">
                        {formatDateRange(s.departureDate) && (
                          <span className="text-xs text-gray-400">
                            {formatDateRange(s.departureDate)}
                          </span>
                        )}
                        <span className="text-xs text-gray-300">·</span>
                        <span className="text-xs text-gray-400">Updated {timeAgo(s.updatedAt)}</span>
                      </div>
                    </div>

                    {/* 3-dot menu */}
                    <div className="absolute top-4 right-4" onClick={e => e.stopPropagation()}>
                      <button onClick={e => { e.stopPropagation(); setMenuOpen(menuOpen === s.id ? null : s.id) }}
                        className="w-8 h-8 flex items-center justify-center text-gray-300 hover:text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                        </svg>
                      </button>
                      {menuOpen === s.id && (
                        <div className="absolute right-0 top-9 bg-white border border-gray-200 rounded-xl shadow-lg py-1 w-36 z-10">
                          <button onClick={e => { e.stopPropagation(); setRenameValue(s.title || ''); setRenaming(s.id); setMenuOpen(null) }}
                            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                            Rename
                          </button>
                          <button onClick={e => { e.stopPropagation(); if (window.confirm('Delete this planning chat?')) deleteSession(s.id) }}
                            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-1.5 text-xs text-blue-600 font-medium">
                    Continue planning
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </AppLayout>
  )
}
