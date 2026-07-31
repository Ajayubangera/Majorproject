export interface UserInfo {
  email: string;
  name: string;
  org: string;
}

const TOKEN_KEY = "surveillance_jwt_token";
const USER_KEY = "surveillance_user_info";

export function saveSession(token: string, rememberMe: boolean) {
  if (rememberMe) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
  }
}

export function getSessionToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(USER_KEY);
}

export function decodeToken(token: string): UserInfo | null {
  try {
    const base64Url = token.split('.')[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      window.atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const parsed = JSON.parse(jsonPayload);
    return {
      email: parsed.sub,
      name: parsed.name,
      org: parsed.org
    };
  } catch (error) {
    console.error("Token decoding failed", error);
    return null;
  }
}

let cachedToken: string | null = null;
let cachedUser: UserInfo | null = null;

export function getCurrentUser(): UserInfo | null {
  const token = getSessionToken();
  if (!token) {
    cachedToken = null;
    cachedUser = null;
    return null;
  }
  if (token === cachedToken) {
    return cachedUser;
  }
  cachedToken = token;
  cachedUser = decodeToken(token);
  return cachedUser;
}
