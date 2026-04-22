export const RECONNECT_CONFIG = {
    initialDelayMs: 5000,
    maxDelayMs: 20000,
    maxAttempts: 3,
    backoffMultiplier: 2,
};

// DisconnectReason.loggedOut=401, DisconnectReason.forbidden=403
export const PERMANENT_DISCONNECT_CODES = [401, 403];

export const BAILEYS_AUTH_DIR = '.baileys_auth';

export const QR_TIMEOUT_MS = 60_000;
