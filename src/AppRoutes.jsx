import React, { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import AppShell from './components/AppShell'
import SignInGate from './components/SignInGate'
import CampgroundsPage from './pages/CampgroundsPage'
import CampgroundDetailPage from './pages/CampgroundDetailPage'
import SettingsPage from './pages/SettingsPage'
import WatchesPage from './pages/WatchesPage'
import RetrievalPlaygroundPage from './pages/RetrievalPlaygroundPage'
import DonationSuccessPage from './pages/DonationSuccessPage'
import DonationCancelPage from './pages/DonationCancelPage'
import SupportPage from './pages/SupportPage'
import { useAuth } from './contexts/AuthContext'
import { applyPageSeo, SITE_NAME } from './utils/seo'

/**
 * Paths a signed-out visitor may browse. An ALLOW-list: any route not matched here
 * (including every route added later) shows the SignInGate when signed out.
 * Public pages must not call session/token-gated APIs when signed out.
 */
const PUBLIC_PATH_PATTERNS = [/^\/$/, /^\/campgrounds\/?$/, /^\/campgrounds\/[^/]+\/?$/, /^\/support\/?$/]

/** @param {string} pathname */
export function isPublicPath(pathname) {
  return PUBLIC_PATH_PATTERNS.some((re) => re.test(pathname))
}

/**
 * Visible signed out but never indexed: Stripe's donation return pages. A signed-out
 * visitor can donate from Support, so they must not land on the sign-in screen.
 */
const SIGNED_OUT_NOINDEX_PATTERNS = [/^\/donation-(success|cancel)\/?$/]

/** @param {string} pathname */
function isVisibleSignedOut(pathname) {
  return isPublicPath(pathname) || SIGNED_OUT_NOINDEX_PATTERNS.some((re) => re.test(pathname))
}

/** Route table + sign-in gate. Must be mounted inside a router. */
export default function AppRoutes() {
  const { isAuthenticated } = useAuth()
  const { pathname } = useLocation()
  const isPublic = isPublicPath(pathname)

  // Public pages set their own head tags. Everything else is never indexed.
  useEffect(() => {
    if (isPublic) return
    const signInShown = !isAuthenticated && !isVisibleSignedOut(pathname)
    applyPageSeo({ title: signInShown ? `Sign in — ${SITE_NAME}` : SITE_NAME, noindex: true })
  }, [pathname, isPublic, isAuthenticated])

  if (!isAuthenticated && !isVisibleSignedOut(pathname)) return <SignInGate />

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/campgrounds" />} />
        <Route path="/campgrounds" element={<CampgroundsPage />} />
        <Route path="/campgrounds/:id" element={<CampgroundDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/watches" element={<WatchesPage />} />
        <Route path="/retrieval" element={<RetrievalPlaygroundPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/donation-success" element={<DonationSuccessPage />} />
        <Route path="/donation-cancel" element={<DonationCancelPage />} />
      </Routes>
    </AppShell>
  )
}
