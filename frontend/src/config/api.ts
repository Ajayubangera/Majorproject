/**
 * Centralized API & WebSocket Endpoint Resolver for Production & Development
 * =========================================================================
 * Automatically adapts between:
 * 1. Local Vite dev mode (Vite at :5173 / :3000 -> FastAPI at :8000)
 * 2. Production Docker / Nginx reverse proxy (standard origin, SSL/WSS, no hardcoded port)
 * 3. Environment overrides via VITE_API_BASE
 */

export const getApiBase = (): string => {
  // If explicitly specified in .env, prioritize it
  const envBase = (import.meta as any).env?.VITE_API_BASE;
  if (envBase) {
    return envBase.replace(/\/$/, "");
  }

  // Local development fallback
  if (
    typeof window !== "undefined" &&
    (window.location.port === "5173" || window.location.port === "3000")
  ) {
    return `http://${window.location.hostname}:8000`;
  }

  // Production reverse proxy (Nginx routes /api directly to backend)
  return typeof window !== "undefined" ? window.location.origin : "http://localhost:8000";
};

export const API_BASE = getApiBase();

/**
 * Resolves full WebSocket URL with proper protocol (ws:// vs wss://)
 * and correct port / reverse-proxy path.
 */
export const getWsUrl = (path: string): string => {
  if (typeof window === "undefined") {
    return `ws://localhost:8000${path.startsWith("/") ? path : "/" + path}`;
  }

  const isSecure = window.location.protocol === "https:";
  const wsProto = isSecure ? "wss:" : "ws:";
  const cleanPath = path.startsWith("/") ? path : `/${path}`;

  const envBase = (import.meta as any).env?.VITE_API_BASE;
  if (envBase) {
    try {
      const url = new URL(envBase);
      const proto = url.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${url.host}${cleanPath}`;
    } catch {
      // Fall through to standard detection
    }
  }

  // Local dev mode with separate frontend/backend ports
  if (window.location.port === "5173" || window.location.port === "3000") {
    return `${wsProto}//${window.location.hostname}:8000${cleanPath}`;
  }

  // Production reverse-proxy deployment (routes via Nginx on standard port)
  return `${wsProto}//${window.location.host}${cleanPath}`;
};
