export const RECONNECT_CONFIG = {
    initialDelayMs: 5000, // 5 segundos
    maxDelayMs: 20000, // 20 segundos
    maxAttempts: 3, // 3 tentativas (5s, 10s, 20s)
    backoffMultiplier: 2,
};

export const PERMANENT_FAILURE_REASONS = [
    "LOGOUT",
    "TOS_BLOCK",
    "SMB_TOS_BLOCK",
    "DEPRECATED_VERSION",
];

export const KNOWN_LIBRARY_BUGS = [
    "markedUnread",
    "isNewMsg",
    "Cannot read properties of undefined",
];

export const TIMEOUT_ERRORS = [
    "timed out",
    "timeout",
    "Protocol error",
    "Target closed",
    "Session closed",
    "Navigation failed",
];

export const CONNECTION_ERRORS = [
    "getChat",
    "perdeu conexão",
    "not connected",
    "UNPAIRED",
    "UNLAUNCHED",
];

export const DISCONNECTED_STATES = ['CONFLICT', 'UNPAIRED', 'UNLAUNCHED', 'PROXYBLOCK', 'TOS_BLOCK', 'SMB_TOS_BLOCK'];