// API base URL — dev uses Vite proxy to Express backend, prod hits the real API domain
const API_BASE: string = import.meta.env.PROD
  ? 'https://api.transcircle.org'
  : '/v1'

export default API_BASE
