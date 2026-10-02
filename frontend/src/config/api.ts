/**
 * Centralized API & WebSocket Endpoint Resolver for Production & Development
 * =========================================================================
 * Automatically adapts between:
 * 1. Local Vite dev mode (Vite at any port :5173, :5174, :5175, :3000 -> FastAPI at :8000)
 * 2. Production Docker / Nginx reverse proxy (standard origin, SSL/WSS, no hardcoded port)
 * 3. Environment overrides via VITE_API_BASE
 */

export const getApiBase = (): string => {
  // If explicitly specified in .env, prioritize it
  const envBase = (import.meta as any).env?.VITE_API_BASE;
  if (envBase) {
    return envBase.replace(/\/$/, "");
  }

  // Local development fallback: handles any dev port (5173, 5174, 5175, 3000, etc.) or DEV mode
  if (typeof window !== "undefined") {
    const port = window.location.port;
    const hostname = window.location.hostname;
    const isDev = (import.meta as any).env?.DEV;
    const isDevPort = port && port !== "80" && port !== "443" && port !== "8000";

    if (isDev || isDevPort) {
      return `http://${hostname}:8000`;
    }
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

  // Local dev mode with separate frontend/backend ports (5173, 5174, 5175, 3000, etc.)
  const port = window.location.port;
  const isDev = (import.meta as any).env?.DEV;
  const isDevPort = port && port !== "80" && port !== "443" && port !== "8000";

  if (isDev || isDevPort) {
    return `${wsProto}//${window.location.hostname}:8000${cleanPath}`;
  }

  // Production reverse-proxy deployment (routes via Nginx on standard port)
  return `${wsProto}//${window.location.host}${cleanPath}`;
};
