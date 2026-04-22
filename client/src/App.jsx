import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import ProfileSetup from './pages/ProfileSetup'
import Chat from './pages/Chat'
import Wishlist from './pages/Wishlist'
import ActiveTrips from './pages/ActiveTrips'
import UpcomingTrips from './pages/UpcomingTrips'
import SavedItinerary from './pages/SavedItinerary'

function ProtectedRoute({ children }) {
  const { user } = useAuth()

  // Still resolving session — render nothing to avoid flash
  if (user === undefined) return null

  return user ? children : <Navigate to="/login" replace />
}

function AppRoutes() {
  const { user } = useAuth()

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route path="/signup" element={user ? <Navigate to="/profile-setup" replace /> : <Signup />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/profile-setup"
        element={
          <ProtectedRoute>
            <ProfileSetup />
          </ProtectedRoute>
        }
      />
      <Route path="/chat/new" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
      <Route path="/chat/:sessionId" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
      <Route path="/chat" element={<Navigate to="/chat/new" replace />} />
      <Route path="/wishlist" element={<ProtectedRoute><Wishlist /></ProtectedRoute>} />
      <Route path="/trips" element={<ProtectedRoute><ActiveTrips /></ProtectedRoute>} />
      <Route path="/upcoming" element={<ProtectedRoute><UpcomingTrips /></ProtectedRoute>} />
      <Route path="/upcoming/:id" element={<ProtectedRoute><SavedItinerary /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
