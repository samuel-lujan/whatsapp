import { Session } from "./session";
import { raceWithTimeout } from "../utils";
import { Logger, server } from "../logging";
import { sessionManager } from "./sessionManager";
import { BAILEYS_AUTH_DIR, QR_TIMEOUT_MS, RECONNECT_CONFIG } from "./constants";
import { MessageData } from "../types";
import path from "path";
import fs from "fs";

export function getSession(name: string): Session | null {
    server.log(`[v3] Obtendo sessão: ${name}`);
    return sessionManager.getSession(name) ?? null;
}

export async function waitForQrCode(session: Session, timeout = QR_TIMEOUT_MS): Promise<void> {
    const logger: Logger = session.logger;
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            logger.log(`Timeout ao aguardar QR Code após ${timeout / 1000}s`, "QR_CODE");
            reject(new Error(`Timeout ao gerar QR Code para ${session.name}. Tente novamente.`));
        }, timeout);

        const interval = setInterval(() => {
            if (session.qrCode || session.ready) {
                clearTimeout(timeoutId);
                clearInterval(interval);
                logger.log(`QR Code gerado ou cliente conectado`, "QR_CODE");
                resolve();
            }

            if (!sessionManager.getSession(session.name)) {
                clearTimeout(timeoutId);
                clearInterval(interval);
                reject(new Error(`Sessão ${session.name} foi removida durante a espera`));
            }
        }, 1000);
    });
}

export async function safeDestroyClient(session: Session): Promise<void> {
    const tag = "DESTROY";

    if (!session?.sock) {
        await sessionManager.removeSession(session.name);
        return;
    }

    if (session.destroying) {
        session.logger.log(`já está sendo destruído, ignorando`, tag);
        return;
    }

    session.destroying = true;

    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
    }

    try {
        session.sock.end(undefined);
        session.logger.log(`sock.end() ok`, tag);
    } catch (e: any) {
        session.logger.log(`sock.end() falhou: ${e.message}`, tag);
    }

    await sessionManager.removeSession(session.name);
    session.logger.log(`sessão removida da memória`, tag);
}

export async function scheduleReconnect(session: Session, reason: string): Promise<void> {
    const tag = "RECONNECT";

    if (!session) return;

    if (session.reconnectTimer) {
        session.logger.log(`reconnect já agendado, ignorando (${reason})`, tag);
        return;
    }

    const attempt = session.reconnectAttempts || 0;

    if (attempt >= RECONNECT_CONFIG.maxAttempts) {
        session.logger.log(`max tentativas (${RECONNECT_CONFIG.maxAttempts}) atingido, desistindo`, tag);
        await safeDestroyClient(session);
        return;
    }

    const delay = Math.min(
        RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt),
        RECONNECT_CONFIG.maxDelayMs,
    );

    session.logger.log(
        `tentativa ${attempt + 1}/${RECONNECT_CONFIG.maxAttempts} em ${delay / 1000}s (motivo: ${reason})`,
        tag,
    );
    session.reconnectAttempts = attempt;

    session.reconnectTimer = setTimeout(async () => {
        session.reconnectTimer = null;

        try {
            await safeDestroyClient(session);
            session.logger.log(`criando sessão nova...`, tag);
            await createSession(session.name);
            await new Promise<void>((resolve) => setTimeout(resolve, 15000));

            const reconnected = sessionManager.getSession(session.name);
            if (reconnected?.ready) {
                reconnected.reconnectAttempts = 0;
                session.logger.log(`reconectou com sucesso!`, tag);
                return;
            }
        } catch (err) {
            session.logger.log(
                `falha na tentativa de reconnect: ${err instanceof Error ? err.message : String(err)}`,
                tag,
            );
        }

        session.reconnectAttempts = attempt + 1;
        await scheduleReconnect(session, reason);
    }, delay);
}

export async function createSession(name: string): Promise<Session> {
    const session = await sessionManager.createSession(name);
    server.log(`[v3] Sessões ativas: ${sessionManager.keys().join(", ")}`);
    await waitForQrCode(session, QR_TIMEOUT_MS);
    return session;
}

export async function deleteSession(session: Session): Promise<{ success: boolean; message: string }> {
    const tag = "DELETE";
    let logoutSuccess = false;

    session.logger.log(`Iniciando limpeza da sessão...`, tag);

    if (session.sock) {
        try {
            await raceWithTimeout(session.sock.logout(), 10000, "Timeout no logout");
            logoutSuccess = true;
            session.logger.log(`logout ok`, tag);
        } catch (e: any) {
            session.logger.log(`logout falhou: ${e.message}`, tag);
        }
    }

    const authDir = path.resolve(process.cwd(), BAILEYS_AUTH_DIR, `session-${session.name}`);
    try {
        await fs.promises.rm(authDir, { recursive: true, force: true });
        session.logger.log(`Auth data removido: ${authDir}`, tag);
    } catch (e: any) {
        session.logger.log(`Erro ao remover auth data: ${e.message}`, tag);
    }

    await safeDestroyClient(session);

    return {
        success: true,
        message: logoutSuccess
            ? `Sessão ${session.name} limpa e logout realizado no WhatsApp`
            : `Sessão ${session.name} limpa (logout do WhatsApp pode ter falhado)`,
    };
}

export async function loadAllSessions(): Promise<string[]> {
    await sessionManager.setup();
    return sessionManager.listSessions();
}

export async function listSessions(): Promise<string[]> {
    return sessionManager.listSessions();
}

export async function clearAllSessions(): Promise<void> {
    return sessionManager.clearAllSessions();
}

export const sendMessageService = async (
    session: Session,
    number: string,
    message: string,
    customName?: string,
) => {
    server.log(`[v3] Enviando para ${session.name} (ready=${session.ready})`);

    try {
        const messageData: MessageData = await session.sendMessage(number, message, customName);
        return { success: true, message: "Mensagem enviada com sucesso", data: messageData };
    } catch (error: any) {
        session.logger.log(`Erro ao enviar: ${error.message}`);

        if (error.status === 400 || error.message.includes("não é um usuário válido")) {
            throw error;
        }

        const healthCheck = await sessionManager.verifySessionHealth(session.name);

        if (healthCheck.healthy) {
            session.logger.log(`Conexão saudável. Tentando novamente em 1s...`);
            await new Promise<void>((resolve) => setTimeout(resolve, 1000));

            try {
                const retryData: MessageData = await session.sendMessage(number, message);
                return {
                    success: true,
                    message: "Mensagem enviada com sucesso após retry",
                    data: retryData,
                };
            } catch (retryError: any) {
                session.logger.log(`Falha após retry: ${retryError.message}`);
                return {
                    success: false,
                    message: "Falha ao enviar mensagem após retry",
                    errorMessage: retryError instanceof Error ? retryError.message : String(retryError),
                    data: null,
                };
            }
        }

        await _destroyAndClean(session);
    }
};

const _destroyAndClean = async (session: Session) => {
    session.logger.log(`Envio e retry falharam. Destruindo sessão...`);

    await safeDestroyClient(session);

    const authDir = path.resolve(process.cwd(), BAILEYS_AUTH_DIR, `session-${session.name}`);
    try {
        await fs.promises.rm(authDir, { recursive: true, force: true });
        session.logger.log(`Auth data removido: ${authDir}`);
    } catch (e: any) {
        session.logger.log(`Erro ao limpar auth data: ${e.message}`);
    }

    throw new Error(
        `Falha ao enviar mensagem. Sessão ${session.name} foi encerrada. Acesse POST /v3/session/${session.name} para gerar novo QR Code.`,
    );
};
