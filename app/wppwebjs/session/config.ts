// === Configuracao de reconnect ===
export const HEALTH_CHECK_INTERVAL_MS = 60000; // 1 minuto

export const RECONNECT_CONFIG = {
    initialDelayMs: 5000, // 5 segundos
    maxDelayMs: 20000, // 20 segundos
    maxAttempts: 3, // 3 tentativas (5s, 10s, 20s)
    backoffMultiplier: 2,
};

// Motivos que NAO devem disparar auto-reconnect
export const PERMANENT_FAILURE_REASONS = [
    "LOGOUT",
    "TOS_BLOCK",
    "SMB_TOS_BLOCK",
    "DEPRECATED_VERSION",
];
