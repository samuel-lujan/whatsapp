import {  Session } from "./session";
import { raceWithTimeout } from "../utils";
import { execSync } from "child_process";
import { Logger, server } from "../logging";
import { sessionManager } from "./sessionManager";

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

export function getSession(name: string): Session | null {
    server.log(`Obtendo sessão para empresa: ${name}`);
    const session: Session | undefined = sessionManager.getSession(name);
    server.log(sessionManager.keys().join(", "));
    return session || null;
}

export async function waitForQrCode(session: Session, timeout = 30000): Promise<void> {
    const logger: Logger = session.logger;
    const tag = "QR_CODE";
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            logger.log(`⏰ Timeout ao aguardar QR Code após ${timeout / 1000}s`, tag);
            reject(new Error(`Timeout ao gerar QR Code para ${session.name}. Tente novamente.`));
        }, timeout);

        const interval = setInterval(() => {
            if (session && (session.qrCode || session.ready)) {
                clearTimeout(timeoutId);
                clearInterval(interval);
                logger.log(`✅ QR Code gerado ou cliente conectado.`, tag);
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

export function killOrphanChromeProcesses(company: string, tag: string, logger: Logger): void {
    try {
        const sessionDir = `session-${company}`;
        const grepSessionDir = `pgrep -f "${sessionDir}" || true`;
        const result = execSync(grepSessionDir, { timeout: 5000 }).toString().trim();
        if (result) {
            const pids = result.split("\n").filter(Boolean);
            const killPIds = `kill -9 ${pids.join(" ")} || true`;
            logger.log(`matando ${pids.length} processos Chrome órfãos: ${pids.join(", ")}`, tag);
            execSync(killPIds, { timeout: 5000 });
            logger.log(`processos órfãos eliminados`, tag);
        } else {
            logger.log(`nenhum processo Chrome órfão encontrado`, tag);
        }
    } catch (e) {
        throw e;
    }
}

export async function safeDestroyClient(session: Session): Promise<void> {
    const company = session.name;
    const logger = session.logger;
    const tag = "DESTROY";
    if (!session?.client){
        sessionManager.removeSession(company);
    } else if (session?.destroying) {
        logger.log(`ja esta sendo destruido, ignorando`, tag);
    } else {
        session.destroying = true;

        if (session.reconnectTimer) {
            clearTimeout(session.reconnectTimer);
            session.reconnectTimer = null;
        }

        const client = session.client;



        try {
            await raceWithTimeout(client.destroy(), 10000, "destroy timeout");
            logger.log(`client.destroy() ok`);
        } catch (e: any) {
            logger.log(`client.destroy() falhou: ${e.message}`);

            try {
                if (client.pupBrowser) {
                    const browserProcess = client.pupBrowser.process();
                    if (browserProcess) {
                        logger.log(`forçando kill no Chrome PID ${browserProcess.pid}`, tag);
                        browserProcess.kill("SIGKILL");
                    }
                } else {
                    logger.log(`pupBrowser null, buscando processos Chrome órfãos...`, tag);
                    killOrphanChromeProcesses(company, tag, logger);
                }
            } catch (killErr) {
                throw killErr;
            }
        }

        sessionManager.removeSession(company);
        logger.log(`sessao removida da memoria`, tag);
    }

}

export async function scheduleReconnect(session: Session, reason: string): Promise<void> {
    const tag = "RECONNECT";
    if (session) {
        const attempt = session.reconnectAttempts || 0;

        if (attempt >= RECONNECT_CONFIG.maxAttempts) {
            session.logger.log(`max tentativas (${RECONNECT_CONFIG.maxAttempts}) atingido, desistindo`);
            await safeDestroyClient(session);
            return;
        }

        const attempt_delay =
            RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt);
        const delay = Math.min(attempt_delay, RECONNECT_CONFIG.maxDelayMs);
        session.logger.log(`tentativa ${attempt + 1}/${RECONNECT_CONFIG.maxAttempts} em ${delay / 1000}s (motivo: ${reason})`);
        session.reconnectAttempts = attempt;

        session.reconnectTimer = setTimeout(async () => {
            try {
                await safeDestroyClient(session);

                session.logger.log(`criando sessao nova...`);
                await createSession(session.name);

                await new Promise<void>((resolve) => setTimeout(resolve, 15000));

                if (sessionManager.getSession(session.name)?.ready) {
                    session.logger.log(`reconectou com sucesso!`);
                    sessionManager.getSession(session.name)!.reconnectAttempts = 0;
                    return;
                }
            } catch (err) {
                throw err;
            }
            if (sessionManager.getSession(session.name)) {
                sessionManager.getSession(session.name)!.reconnectAttempts = attempt + 1;
                session.reconnectAttempts = attempt + 1;
                await scheduleReconnect(session, reason);
            }
        }, delay);
    }
}

export async function createSession(name: string, hasAi: boolean = false): Promise<Session> {
    const isProduction = process.env.NODE_ENV === "production";
    const isHeadless = isProduction || process.env.HEADLESS === "true";

    server.log(`🖥️ Ambiente: ${isProduction ? "PRODUÇÃO" : "DESENVOLVIMENTO"}`);
    server.log(`🌐 Browser: ${isHeadless ? "HEADLESS (sem interface)" : "COM INTERFACE"}`);

    const session = await sessionManager.createSession(name, isHeadless, hasAi);
    server.log(`Sessões ativas: ${sessionManager.keys().join(", ")}`);
    await waitForQrCode(session, 60000,);

    return session;
}

export async function deleteSession(session: Session): Promise<{ success: boolean; message: string }> {
    const { logger } = session;
    const tag = "DELETE";

    const client = session.client;
    let logoutSuccess = false;

    logger.log(`Iniciando limpeza completa da sessão...`);

    if (client) {
        try {
            await raceWithTimeout(client.logout(), 10000, "Timeout no logout");
            logoutSuccess = true;
            logger.log(`logout ok`, tag);
        } catch (e) {
            logger.log(`logout falhou: ${e}`);
        }
    }

    await safeDestroyClient(session);

    return { success: true, message: logoutSuccess ? `Sessao ${session.name} limpa e logout realizado no WhatsApp` : `Sessao ${session.name} limpa (logout do WhatsApp pode ter falhado)` };
    //   return {
    //       success: true,
    //       message: logoutSuccess
    //           ? `Sessao ${company} limpa e logout realizado no WhatsApp`
    //           : `Sessao ${company} limpa (logout do WhatsApp pode ter falhado)`,
    //       details: { logoutSuccess, sessionRemoved: true },
    //       whatsappLoggedOut: logoutSuccess,
    //   };
};

export async function loadAllSessions(){
    await sessionManager.setup();
    return sessionManager.listSessions();
};

export async function listSessions(){
    return sessionManager.listSessions();
};

export async function clearAllSessions(){
    return sessionManager.clearAllSessions();
};
