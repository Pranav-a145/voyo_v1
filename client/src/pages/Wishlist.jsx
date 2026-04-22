import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import AppLayout from '../components/AppLayout'
import DestinationCard from '../components/DestinationCard'

export default function Wishlist() {
  const { user }  = useAuth()
  const navigate  = useNavigate()

  const [bookmarks, setBookmarks] = useState([])
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    if (!user) return
    supabase.from('profiles').select('bookmarks').eq('id', user.id).single()
      .then(({ data }) => {
        setBookmarks(data?.bookmarks || [])
        setLoading(false)
      })
  }, [user])

  async function removeBookmark(destination) {
    const updated = bookmarks.filter(b => b.destination !== destination)
    setBookmarks(updated)
    await supabase.from('profiles').upsert({ id: user.id, bookmarks: updated })
  }

  return (
    <AppLayout>
      <main className="max-w-4xl mx-auto px-6 py-10">

        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900">Travel Wishlist</h1>
          <p className="text-sm text-gray-500 mt-1">
            {bookmarks.length > 0
              ? `${bookmarks.length} saved destination${bookmarks.length !== 1 ? 's' : ''}`
              : 'Your saved destinations will appear here'}
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
                <div className="h-36 bg-gray-200 animate-pulse" />
                <div className="p-5 space-y-3">
                  <div className="h-5 w-3/4 bg-gray-200 rounded animate-pulse" />
                  <div className="h-3.5 w-full bg-gray-200 rounded animate-pulse" />
                  <div className="h-3.5 w-2/3 bg-gray-200 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : bookmarks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <svg className="w-12 h-12 text-gray-200 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
            <p className="text-gray-500 font-medium">Nothing saved yet</p>
            <p className="text-sm text-gray-400 mt-1">
              Bookmark destinations from your recommendations and they'll live here.
            </p>
            <button
              onClick={() => navigate('/dashboard')}
              className="mt-6 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Browse recommendations →
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {bookmarks.map((b, i) => (
              <DestinationCard
                key={i}
                destination={b.destination}
                reason={b.reason}
                bestTime={b.bestTime}
                personalNote={b.personalNote || null}
                hearMeOut={b.hearMeOut || null}
                isExperimental={b.isExperimental || false}
                bookmarked={true}
                onBookmark={() => removeBookmark(b.destination)}
                onPlanNow={() => navigate('/chat/new', { state: { destination: b.destination } })}
              />
            ))}
          </div>
        )}

      </main>
    </AppLayout>
  )
}
