import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

interface User {
  provider: 'github' | 'x'
  username: string
  avatarUrl?: string
  isAdmin: boolean
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  loginWithGitHub: () => void
  loginWithX: () => void
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data: { user: User | null }) => {
        setUser(data.user)
      })
      .catch(() => {
        // API not available — ignore
      })
      .finally(() => setLoading(false))
  }, [])

  const loginWithGitHub = () => {
    window.location.href = '/api/auth/github'
  }

  const loginWithX = () => {
    window.location.href = '/api/auth/x'
  }

  const logout = () => {
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, loginWithGitHub, loginWithX, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
