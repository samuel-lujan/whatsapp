// ─── Types ────────────────────────────────────────────────────────────────────

import { Client } from "whatsapp-web.js";

export interface SessionState {
  client: Client;
  qrCode: string | null;
  ready: boolean;
  connecting: boolean;
  destroying: boolean;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastDisconnectTime: number | null;
  lastDisconnectReason: string | null;
  lastBatteryUpdate?: number;
}

export interface AppError extends Error {
  shouldRetry?: boolean;
  statusCode?: number;
}

export interface ConnectionStatus {
  connected: boolean;
  status?: string;
  suggestion?: string;
}

export interface StatusResult {
  connected: boolean;
  qrCode?: string | null;
  message?: string;
  status?: string;
  error?: string;
  suggestion?: string;
}

export interface HealthResult {
  healthy: boolean;
  reason?: string;
  shouldReconnect?: boolean;
  state?: string | null;
  info?: string;
}

export interface ValidationResult {
  isValid: boolean;
  numberId: string | null;
  originalNumber: string;
  validatedNumber?: string;
  wasAlternative?: boolean;
  wasFallback?: boolean;
  error?: string;
}

export interface ChatIdResult {
  chatId: string;
  isExistingChat: boolean;
  chatName?: string;
  isGroup?: boolean;
  contactName?: string;
  isContact?: boolean;
  isRegistered?: boolean;
  warning?: string;
  error?: string;
}

export interface SendResult {
  success: boolean;
  message: string;
  data: {
    companySlug: string;
    number: string;
    originalNumber: string;
    validatedNumber?: string;
    wasAlternative?: boolean;
    chatName?: string;
    userPushname?: string;
    content: string;
    timestamp: string;
    wasRetry?: boolean;
  };
}

export interface ClearResult {
  success: boolean;
  message: string;
  details?: { logoutSuccess: boolean; sessionRemoved: boolean };
  whatsappLoggedOut?: boolean;
  error?: string;
}

export interface ClearAllResult {
  success: boolean;
  message: string;
  summary?: {
    total: number;
    successful: number;
    withLogout: number;
    failed: number;
  };
  sessions: Record<string, ClearResult>;
}

export interface DeleteAllResult {
  success: boolean;
  message: string;
  summary: {
    totalSessions: number;
    sessionsCleared: number;
    authDataDeleted: boolean;
    cacheDeleted: boolean;
  };
  details: {
    sessionsCleared: Record<string, ClearResult>;
    authDataDeleted: boolean;
    cacheDeleted: boolean;
    authDataError?: string;
    cacheError?: string;
  };
}