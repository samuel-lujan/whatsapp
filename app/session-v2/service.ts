import {  Session } from "./session";
import { raceWithTimeout } from "../utils";
import { execSync } from "child_process";
import { Logger, server } from "../logging";
import { sessionManager } from "./sessionManager";
import { CONNECTION_ERRORS, KNOWN_LIBRARY_BUGS, RECONNECT_CONFIG, TIMEOUT_ERRORS } from "./constants";
import { MessageData } from "../types";
import path from "path";
import fs from "fs";

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
    if (!session) {
        return;
    }

    if (session.reconnectTimer) {
        session.logger.log(`reconnect já agendado, ignorando novo gatilho (${reason})`, tag);
        return;
    }

    const attempt = session.reconnectAttempts || 0;

    if (attempt >= RECONNECT_CONFIG.maxAttempts) {
        session.logger.log(`max tentativas (${RECONNECT_CONFIG.maxAttempts}) atingido, desistindo`, tag);
        await safeDestroyClient(session);
        return;
    }

    const attempt_delay =
        RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt);
    const delay = Math.min(attempt_delay, RECONNECT_CONFIG.maxDelayMs);
    session.logger.log(`tentativa ${attempt + 1}/${RECONNECT_CONFIG.maxAttempts} em ${delay / 1000}s (motivo: ${reason})`, tag);
    session.reconnectAttempts = attempt;

    session.reconnectTimer = setTimeout(async () => {
        session.reconnectTimer = null;

        try {
            await safeDestroyClient(session);

            session.logger.log(`criando sessao nova...`, tag);
            await createSession(session.name, session.hasAi);

            await new Promise<void>((resolve) => setTimeout(resolve, 15000));

            const reconnectedSession = sessionManager.getSession(session.name);
            if (reconnectedSession?.ready) {
                reconnectedSession.reconnectAttempts = 0;
                session.reconnectAttempts = 0;
                session.logger.log(`reconectou com sucesso!`, tag);
                return;
            }
        } catch (err) {
            session.logger.log(`falha na tentativa de reconnect: ${err instanceof Error ? err.message : String(err)}`, tag);
        }

        session.reconnectAttempts = attempt + 1;
        await scheduleReconnect(session, reason);
    }, delay);
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

export async function loadSession(company: string){
    await sessionManager.loadSession(company, process.env.HEADLESS === "true");
    return sessionManager.listSessions();
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

export const sendMessageService = async (session: Session, number: string, message: string, customName?: string) => {
    server.log(`📤 Iniciando envio para ${session.name} (ready=${session.ready})`);

    try {
        const messageData: MessageData = await session.sendMessage(number, message, customName);

        return {
            success: true,
            message: "Mensagem enviada com sucesso",
            data: messageData,
        };
    } catch (error: any) {
        session.logger.log(`❌ Erro ao enviar mensagem pelo cliente ${session.name}: ${error.message}`);

        if (error.status === 400 || error.message.includes("não é um usuário válido")) {
            throw error;
        }

        const isKnownLibraryBug = KNOWN_LIBRARY_BUGS.some((bug) => error.message.includes(bug));
        const isTimeoutError = TIMEOUT_ERRORS.some((t) =>
            error.message.toLowerCase().includes(t.toLowerCase()),
        );
        const isConnectionError = CONNECTION_ERRORS.some((c) => error.message.includes(c));
        let verifyHealth = false;
        let shouldRetry = false;


        switch (true) {
            case isKnownLibraryBug:
                session.logger.log(`⚠️ Erro conhecido da biblioteca detectado: ${error.message}`);
                verifyHealth = true;
                break;
            case isTimeoutError:
                session.logger.log(`⏱️ Erro de timeout detectado: ${error.message}`);
                verifyHealth = true;
                break;
            case isConnectionError:
                session.logger.log(`🔌 Erro de conexão detectado: ${error.message}`);
                break;
            default:
                verifyHealth = true;
                session.logger.log(`⚠️ Erro desconhecido ao enviar mensagem: ${error.message}`);
                break;
        }

        if (verifyHealth) {
            const healthCheck = await sessionManager.verifySessionHealth(session.name);
            if (healthCheck.healthy) {
                session.logger.log(`🔄 Conexão saudável. Tentando enviar novamente em 1 segundo...`);
                await new Promise<void>((resolve) => setTimeout(resolve, 1000));
                shouldRetry = true;
            }
        } 
        
        if (shouldRetry) {
            try {
                const retryData: MessageData = await session.sendMessage(number, message);
                return {
                    success: true,
                    message: "Mensagem enviada com sucesso após retry",
                    data: retryData,
                };
            } catch (retryError: any) {
                session.logger.log(`❌ Erro ao enviar mensagem após retry pelo cliente ${session.name}: ${retryError.message}`);
                return {
                    success: false,
                    message: "Falha ao enviar mensagem após retry",
                    errorMessage: retryError instanceof Error ? retryError.message : String(retryError),
                    data: null,
                };
            }


        }
        destroy(session);
    }
};

const destroy = async (session: Session) => {
    session.logger.log(
        `❌ Envio e retry falharam. Destruindo sessão e limpando auth para forçar novo QR Code...`,
    );

    await safeDestroyClient(session);

    try {
        const authDir = path.resolve(
            __dirname,
            "..",
            ".wwebjs_auth",
            `session-${session.name}`,
        );
        await fs.promises.rm(authDir, { recursive: true, force: true });
        session.logger.log(`🗑️ Auth data removido: ${authDir}`);
    } catch (cleanErr) {
        session.logger.log(`⚠️ Erro ao limpar auth data de ${session.name}: ${cleanErr.message}`);
    }

    throw new Error(
        `Falha ao enviar mensagem. Sessão ${session.name} foi encerrada. Acesse /status/${session.name} para escanear novo QR Code.`,
    );
};