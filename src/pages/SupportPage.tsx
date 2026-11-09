import React, { useEffect } from 'react'
import DonationCard from '../components/DonationCard'
import { applyPageSeo, SITE_NAME } from '../utils/seo'

export default function SupportPage() {
  useEffect(() => {
    applyPageSeo({
      title: `Support CampScout.ai — ${SITE_NAME}`,
      description:
        'CampScout.ai is free for everyone. Support hosting, campground data and future improvements.',
      path: '/support',
    })
  }, [])

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Support</h2>
        <p className="mt-1 text-gray-600 dark:text-gray-300">
          CampScout.ai is free for everyone. Your support helps cover hosting, campground data, and
          future improvements.
        </p>
      </div>

      <DonationCard />
    </div>
  )
}
