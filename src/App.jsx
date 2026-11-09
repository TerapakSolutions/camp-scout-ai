import React from 'react'
import { BrowserRouter } from 'react-router-dom'
import PageViewTracker from './components/PageViewTracker'
import AppRoutes from './AppRoutes'
import { AuthProvider } from './contexts/AuthContext'

const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename={basename || undefined}>
        <PageViewTracker />
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}
