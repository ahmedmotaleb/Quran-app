/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin, e.g. https://api.example.com. Unset → demo mode. */
  readonly VITE_API_BASE_URL?: string;
}
