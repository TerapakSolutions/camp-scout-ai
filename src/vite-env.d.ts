/// <reference types="vite/client" />

interface CampScoutRuntimeUser {
  email: string
  name?: string
  picture?: string
}

interface CampScoutRuntimeConfig {
  apiToken?: string | null
  user?: CampScoutRuntimeUser | null
}

interface Window {
  __CAMP_SCOUT_RUNTIME__?: CampScoutRuntimeConfig
}
