import { createContext } from 'react'

/** Context for exposing the errorId to deeply nested form controls */
const FieldErrorContext = createContext<string | null>(null)

export { FieldErrorContext }
