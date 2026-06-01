// API base URL — dev uses Vite proxy to Express backend, prod hits the real API domain
// Set VITE_API_BASE at build time for custom deployment targets
export const API_BASE: string = import.meta.env.PROD
  ? (import.meta.env.VITE_API_BASE as string | undefined) || 'https://api.transcircle.org'
  : '/v1'
