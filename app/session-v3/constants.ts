export const RECONNECT_CONFIG = {
    initialDelayMs: 5000,
    maxDelayMs: 60000,
    maxAttempts: 8,
    backoffMultiplier: 1.5,
};

// DisconnectReason.loggedOut=401, DisconnectReason.forbidden=403
export const PERMANENT_DISCONNECT_CODES = [401, 403];

export const BAILEYS_AUTH_DIR = '.baileys_auth';

export const QR_TIMEOUT_MS = 60_000;

export const DISCONNECT_REASON_LABELS: Record<number, string> = {
    401: "Deslogado (usuário saiu em outro dispositivo)",
    403: "Acesso negado (conta bloqueada pelo WhatsApp)",
    408: "Timeout (keepalive sem resposta)",
    428: "Conexão não disponível",
    440: "Sessão substituída por outro dispositivo",
    500: "Erro interno do servidor WhatsApp",
    515: "Stream reiniciado pelo servidor",
};
