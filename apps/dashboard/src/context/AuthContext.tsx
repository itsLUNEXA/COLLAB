/**
 * @file AuthContext.tsx
 * Authentication and environment context for the Collaborative Dashboard.
 * Stores and manages Project ID, Device ID, Bearer Tokens, and Network Online/Offline state.
 */

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { DashboardApiClient } from '../api/client';

export interface AuthContextType {
  projectId: string;
  setProjectId: (id: string, newToken?: string) => void;
  token: string;
  setToken: (token: string) => void;
  userId: string;
  setUserId: (id: string) => void;
  deviceId: string;
  setDeviceId: (id: string) => void;
  isOnline: boolean;
  isDev: boolean;
  apiClient: DashboardApiClient;
  generateDevToken: () => Promise<string>;
  authError: string | null;
}

const DEFAULT_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000002';
const DEFAULT_DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function isTokenExpired(t: string): boolean {
  if (!t) return true;
  try {
    const parts = t.split('.');
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const payload = JSON.parse(jsonStr);
    if (!payload.exp) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return payload.exp <= nowSec + 30; // Expired or expiring within 30s
  } catch {
    return true;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getStoredUuid(key: string, fallback: string): string {
  try {
    const val = localStorage.getItem(key);
    if (val && UUID_REGEX.test(val)) {
      return val;
    }
    // Clean up invalid or legacy non-UUID entries
    localStorage.setItem(key, fallback);
  } catch {}
  return fallback;
}

let inFlightTokenPromise: Promise<string> | null = null;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [projectId, setProjectIdState] = useState<string>(() => {
    return getStoredUuid('collab_project_id', DEFAULT_PROJECT_ID);
  });

  const [userId, setUserIdState] = useState<string>(() => {
    return getStoredUuid('collab_user_id', DEFAULT_USER_ID);
  });

  const [deviceId, setDeviceIdState] = useState<string>(() => {
    return getStoredUuid('collab_device_id', DEFAULT_DEVICE_ID);
  });

  const [token, setTokenState] = useState<string>(() => {
    return localStorage.getItem('collab_token') || '';
  });

  const [authError, setAuthError] = useState<string | null>(null);

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const setToken = useCallback((t: string) => {
    setTokenState(t);
    if (t) {
      localStorage.setItem('collab_token', t);
    } else {
      localStorage.removeItem('collab_token');
    }
  }, []);

  const setProjectId = useCallback((id: string, newToken?: string) => {
    const valid = UUID_REGEX.test(id) ? id : DEFAULT_PROJECT_ID;
    setProjectIdState(valid);
    localStorage.setItem('collab_project_id', valid);
    if (newToken) {
      setToken(newToken);
    } else {
      setTokenState('');
      localStorage.removeItem('collab_token');
    }
  }, [setToken]);

  const setUserId = useCallback((id: string) => {
    const valid = UUID_REGEX.test(id) ? id : DEFAULT_USER_ID;
    setUserIdState(valid);
    localStorage.setItem('collab_user_id', valid);
  }, []);

  const setDeviceId = useCallback((id: string) => {
    const valid = UUID_REGEX.test(id) ? id : DEFAULT_DEVICE_ID;
    setDeviceIdState(valid);
    localStorage.setItem('collab_device_id', valid);
  }, []);

  const isDev = Boolean(import.meta.env?.DEV);

  const generateDevToken = useCallback(async () => {
    if (inFlightTokenPromise) {
      return inFlightTokenPromise;
    }

    inFlightTokenPromise = (async () => {
      const effectiveUserId = UUID_REGEX.test(userId) ? userId : DEFAULT_USER_ID;
      const effectiveDeviceId = UUID_REGEX.test(deviceId) ? deviceId : DEFAULT_DEVICE_ID;
      const effectiveProjectId = UUID_REGEX.test(projectId) ? projectId : DEFAULT_PROJECT_ID;
      const apiBaseUrl = (import.meta.env?.VITE_API_URL as string) || '';
      try {
        const resp = await fetch(`${apiBaseUrl}/api/v1/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: effectiveUserId,
            deviceId: effectiveDeviceId,
            projectId: effectiveProjectId,
            deviceSecret: localStorage.getItem('collab_device_secret') || 'collab-dev-device-secret-key',
          }),
        });

        if (resp.ok) {
          const data = await resp.json();
          if (data?.token) {
            setToken(data.token);
            setAuthError(null);
            return data.token;
          }
        }

        let errMsg = `Authentication error HTTP ${resp.status}`;
        try {
          const errBody = await resp.json();
          errMsg = errBody?.error || errMsg;
        } catch {}
        setAuthError(errMsg);
        setToken(''); // Never retain poisoned token
        throw new Error(errMsg);
      } catch (err: any) {
        console.warn('Authentication token error:', err);
        const msg = err?.message || 'Authentication failed';
        setAuthError(msg);
        setToken(''); // Never retain poisoned token
        throw err;
      }
    })();

    try {
      return await inFlightTokenPromise;
    } finally {
      inFlightTokenPromise = null;
    }
  }, [userId, deviceId, projectId, setToken]);

  // Ensure default dev token is generated if none exists or is expired in DEV mode
  useEffect(() => {
    if (isDev && (!token || isTokenExpired(token))) {
      generateDevToken().catch((err) => console.warn('Could not auto-generate token:', err));
    }
  }, [isDev, token, generateDevToken]);

  const tokenRef = useRef(token);
  tokenRef.current = token;

  const apiBaseUrl = (import.meta.env?.VITE_API_URL as string) || '';
  const apiClient = useMemo(() => {
    return new DashboardApiClient(apiBaseUrl, () => tokenRef.current, generateDevToken);
  }, [apiBaseUrl, generateDevToken]);

  return (
    <AuthContext.Provider
      value={{
        projectId,
        setProjectId,
        token,
        setToken,
        userId,
        setUserId,
        deviceId,
        setDeviceId,
        isOnline,
        isDev,
        apiClient,
        generateDevToken,
        authError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
