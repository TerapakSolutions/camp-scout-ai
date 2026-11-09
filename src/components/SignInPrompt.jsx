import React from 'react'
import { startGoogleSignIn, useAuth } from '../contexts/AuthContext'

/**
 * Inline "Sign in to …" prompt for public pages, shown in place of a feature
 * that needs a session (AI, watches, official photos, distance filter).
 *
 * @param {{ action: string }} props  e.g. "see the AI summary"
 */
export default function SignInPrompt({ action }) {
  const { hasServer } = useAuth()

  return (
    <p className="text-sm text-gray-600">
      {hasServer ? (
        <button
          type="button"
          onClick={startGoogleSignIn}
          className="font-medium text-green-700 underline hover:text-green-900"
        >
          Sign in to {action}
        </button>
      ) : (
        <a href="https://campscout.terapak.com" className="font-medium text-green-700 underline">
          Sign in to {action}
        </a>
      )}
      .
    </p>
  )
}
