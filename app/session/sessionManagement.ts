import fs from "fs";
import path from "path";
import type { WAState } from "whatsapp-web.js";
import type {
    ChatIdResult,
    ClearAllResult,
    ClearResult,
    ConnectionStatus,
    DeleteAllResult,
    HealthResult,
    StatusResult,
} from "../types";
import { Session } from "./session";
import { findCorrectChatId } from "../wppwebjs/number-utils";
import { sessions } from ".";
import { RECONNECT_CONFIG } from ".";
import { raceWithTimeout } from "../utils";
import { execSync } from "child_process";

// ─── Client Lifecycle ─────────────────────────────────────────────────────────

export async function safeDestroyClient(companySlug: string): Promise<void> {
    const session = sessions[companySlug];
    if (!session || !session.client) {
        delete sessions[companySlug];
        return;
    }

    if (session.destroying) {
        console.log(`[DESTROY] ${companySlug}: ja esta sendo destruido, ignorando`);
        return;
    }
    session.destroying = true;

    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
    }

    const client = session.client;

    try {
        await raceWithTimeout(client.destroy(), 10000, "destroy timeout");
        console.log(`[DESTROY] ${companySlug}: client.destroy() ok`);
    } catch (e) {
        console.log(`[DESTROY] ${companySlug}: client.destroy() falhou: ${(e as Error).message}`);

        try {
            if (client.pupBrowser) {
                const browserProcess = client.pupBrowser.process();
                if (browserProcess) {
                    console.log(
                        `[DESTROY] ${companySlug}: forçando kill no Chrome PID ${browserProcess.pid}`,
                    );
                    browserProcess.kill("SIGKILL");
                }
            } else {
                console.log(
                    `[DESTROY] ${companySlug}: pupBrowser null, buscando processos Chrome órfãos...`,
                );
                try {
                    const sessionDir = `session-${companySlug}`;
                    const result = execSync(`pgrep -f "${sessionDir}" || true`, { timeout: 5000 })
                        .toString()
                        .trim();
                    if (result) {
                        const pids = result.split("\n").filter(Boolean);
                        console.log(
                            `[DESTROY] ${companySlug}: encontrados ${pids.length} processos órfãos: ${pids.join(", ")}`,
                        );
                        execSync(`kill -9 ${pids.join(" ")} || true`, { timeout: 5000 });
                        console.log(`[DESTROY] ${companySlug}: processos órfãos eliminados`);
                    } else {
                        console.log(
                            `[DESTROY] ${companySlug}: nenhum processo Chrome órfão encontrado`,
                        );
                    }
                } catch (pgrepErr) {
                    console.log(
                        `[DESTROY] ${companySlug}: busca de processos órfãos falhou: ${(pgrepErr as Error).message}`,
                    );
                }
            }
        } catch (killErr) {
            console.log(
                `[DESTROY] ${companySlug}: force-kill falhou: ${(killErr as Error).message}`,
            );
        }
    }

    delete sessions[companySlug];
    console.log(`[DESTROY] ${companySlug}: sessao removida da memoria`);
}

export async function scheduleReconnect(companySlug: string, reason: string): Promise<void> {
    if (!sessions[companySlug]) {
        console.log(`[RECONNECT] ${companySlug}: sessao removida, cancelando reconnect`);
        return;
    }

    const session = sessions[companySlug];
    const attempt = session.reconnectAttempts || 0;

    if (attempt >= RECONNECT_CONFIG.maxAttempts) {
        console.log(
            `[RECONNECT] ${companySlug}: max tentativas (${RECONNECT_CONFIG.maxAttempts}) atingido, desistindo`,
        );
        await safeDestroyClient(companySlug);
        return;
    }

    const attempt_delay =
        RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt);
    const delay = Math.min(attempt_delay, RECONNECT_CONFIG.maxDelayMs);
    console.log(
        `[RECONNECT] ${companySlug}: tentativa ${attempt + 1}/${RECONNECT_CONFIG.maxAttempts} em ${delay / 1000}s (motivo: ${reason})`,
    );

    session.reconnectTimer = setTimeout(async () => {
        try {
            await safeDestroyClient(companySlug);

            console.log(`[RECONNECT] ${companySlug}: criando sessao nova...`);
            await createSession(companySlug);

            await new Promise<void>((resolve) => setTimeout(resolve, 15000));

            if (session?.ready) {
                console.log(`[RECONNECT] ${companySlug}: reconectou com sucesso!`);
                session.reconnectAttempts = 0;
            } else if (session) {
                session.reconnectAttempts = attempt + 1;
                await scheduleReconnect(session.companySlug, reason);
            }
        } catch (err) {
            console.log(`[RECONNECT] ${session.companySlug}: tentativa falhou: ${(err as Error).message}`);
            if (session) {
                session.reconnectAttempts = attempt + 1;
                await scheduleReconnect(session.companySlug, reason);
            }
        }
    }, delay);
}

// ─── Session Creation ─────────────────────────────────────────────────────────

export async function createSession(companySlug: string): Promise<void> {
    try {
        const sessionDir = `session-${companySlug}`;
        const orphanPids = execSync(`pgrep -f "${sessionDir}" || true`, { timeout: 5000 })
            .toString()
            .trim();
        if (orphanPids) {
            const pids = orphanPids.split("\n").filter(Boolean);
            console.log(
                `[CREATE] ${companySlug}: matando ${pids.length} processos Chrome órfãos antes de criar sessão: ${pids.join(", ")}`,
            );
            execSync(`kill -9 ${pids.join(" ")} || true`, { timeout: 5000 });
            await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        }
    } catch (e) {
        console.log(
            `[CREATE] ${companySlug}: falha ao verificar processos órfãos: ${(e as Error).message}`,
        );
    }

    const isProduction = process.env.NODE_ENV === "production";
    const isHeadless = isProduction || process.env.HEADLESS === "true";

    console.log(`🖥️ Ambiente: ${isProduction ? "PRODUÇÃO" : "DESENVOLVIMENTO"}`);
    console.log(`🌐 Browser: ${isHeadless ? "HEADLESS (sem interface)" : "COM INTERFACE"}`);

    const session = new Session(companySlug, isHeadless);
    sessions[companySlug] = session;
    await session.initialize();

}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function getStatus(companySlug: string): Promise<StatusResult> {
    const session = sessions[companySlug];
    if (session?.ready) {
        console.log(`✅ Cliente ${companySlug} já está conectado - não precisa de QR Code`);
        return { connected: true };
    }

    const client = session?.client;
    if (client) {
        console.log(`🔍 Verificando estado real do cliente ${companySlug}...`);

        try {
            const state = (await raceWithTimeout(client.getState(), 5000)) as WAState | null;

            console.log(`📱 Estado atual do cliente ${companySlug}:`, state);

            if (state === "CONNECTED") {
                console.log(
                    `🔧 Cliente ${companySlug} estava conectado mas não marcado como ready - corrigindo...`,
                );
                session.markAsReady();
                return { connected: true };
            }

            if (state == null) {
                console.log(
                    `🔍 Estado ambíguo para ${companySlug}, tentando verificação prática...`,
                );
                try {
                    const info = client.info;
                    if (info?.wid) {
                        console.log(
                            `🔧 Cliente ${companySlug} tem info válida - marcando como ready`,
                        );
                        session.markAsReady();
                        return { connected: true };
                    }
                } catch (e) {
                    console.log(
                        `⚠️ Verificação alternativa falhou para ${companySlug}:`,
                        (e as Error).message,
                    );
                }
            }
            return { connected: false };
        } catch (error) {
            const msg = (error as Error).message;
            console.log(`⚠️ Cliente ${companySlug} não está realmente conectado:`, msg);

            if (msg.includes("null") || msg.includes("destroyed") || msg === "timeout") {
                console.log(
                    `[ZOMBIE] ${companySlug}: sessão zumbi detectada (connecting=${session?.connecting}, ready=${session?.ready}) - destruindo...`,
                );
                await safeDestroyClient(companySlug);
            }
        }
    }

    if (session?.connecting && !session?.ready) {
        console.log(`⏳ Cliente ${companySlug} ainda está conectando...`);
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));

        if (session?.ready) {
            console.log(`✅ Cliente ${companySlug} finalizou conexão durante a espera`);
            return { connected: true };
        }

        const qrCode = session?.qrCode;
        if (qrCode) {
            console.log(`📱 Cliente ${companySlug} ainda conectando - QR Code disponível`);
            return { connected: false, qrCode, status: "connecting" };
        }
    }

    if (!session) {
        console.log(`🆕 Nenhuma sessão encontrada para ${companySlug} - criando nova...`);
        try {
            await createSession(companySlug);

            console.log(`⏳ Aguardando QR Code ou conexão automática para ${companySlug}...`);
            await waitForQrCode(companySlug, 20000);
        } catch (error) {
            console.log(
                `⚠️ Erro ao criar sessão/aguardar QR Code para ${companySlug}:`,
                (error as Error).message,
            );
            return {
                connected: false,
                error: (error as Error).message,
                suggestion: "Tente novamente - o WhatsApp pode estar inicializando",
            };
        }
    }

    if (session?.ready) {
        console.log(`✅ Cliente ${companySlug} conectou durante o processo`);
        return { connected: true };
    }

    const qrCode = session?.qrCode ?? null;
    console.log(
        `📱 Retornando status para ${companySlug} - QR Code: ${qrCode ? "Disponível" : "Não disponível"}`,
    );
    console.log(`🔍 Estado da sessão ${companySlug}:`, {
        exists: !!session,
        ready: session?.ready ?? false,
        connecting: session?.connecting ?? false,
        hasQrCode: !!qrCode,
    });

    return {
        connected: false,
        qrCode,
        message: qrCode ? "Escaneie o QR Code para conectar" : "Aguardando QR Code...",
    };
}

export function hasActiveSession(companySlug: string): boolean {
    const session = sessions[companySlug];
    return !!(session?.ready || session?.connecting);
}

export function checkConnectionStatus(companySlug: string): ConnectionStatus {
    const session = sessions[companySlug];
    if (session?.ready) {
        console.log(`✅ Verificação rápida: Cliente ${companySlug} está pronto`);
        return { connected: true };
    }

    if (session?.client) {
        console.log(
            `🔍 Verificação rápida: Cliente ${companySlug} existe mas não está marcado como ready`,
        );
        try {
            if (session.client.pupPage && !session.client.pupPage.isClosed()) {
                console.log(
                    `🤔 Cliente ${companySlug} pode estar conectado - recomendado verificação completa`,
                );
                return {
                    connected: false,
                    status: "needs_verification",
                    suggestion: "Use /status para verificação completa",
                };
            }
        } catch (e) {
            console.log(
                `⚠️ Erro na verificação rápida do cliente ${companySlug}:`,
                (e as Error).message,
            );
        }
    }

    if (session?.connecting) {
        console.log(`⏳ Verificação rápida: Cliente ${companySlug} ainda conectando`);
        return { connected: false, status: "connecting" };
    }

    console.log(`❌ Verificação rápida: Cliente ${companySlug} não conectado`);
    return { connected: false };
}

// ─── Health ───────────────────────────────────────────────────────────────────

export async function verifyClientHealth(companySlug: string): Promise<HealthResult> {
    const session = sessions[companySlug];
    if (!session || !session.client) {
        return { healthy: false, reason: "Sessão não existe" };
    }

    const client = session.client;

    try {
        if (client.pupPage) {
            try {
                const isClosed = client.pupPage.isClosed();
                if (isClosed) {
                    console.log(`❌ Cliente ${companySlug} - página do browser está fechada`);
                    return { healthy: false, reason: "Página do browser fechada", shouldReconnect: true };
                }
            } catch (e) {
                console.log(
                    `⚠️ Erro ao verificar página do browser para ${companySlug}:`,
                    (e as Error).message,
                );
            }
        }

        let state: WAState | null = null;
        try {
            state = (await raceWithTimeout(
                client.getState(),
                5000,
                "timeout-state",
            )) as WAState | null;
            console.log(`📊 Estado do cliente ${companySlug}: ${state}`);
        } catch (e) {
            console.log(
                `⚠️ Timeout ao obter estado do cliente ${companySlug}, tentando verificação alternativa...`,
            );
        }

        if (state === "CONNECTED") {
            console.log(`✅ Cliente ${companySlug} está CONNECTED`);
            return { healthy: true, state, info: "N/A" };
        }

        const disconnectedStates = [
            "CONFLICT",
            "UNPAIRED",
            "UNLAUNCHED",
            "PROXYBLOCK",
            "TOS_BLOCK",
            "SMB_TOS_BLOCK",
        ];
        if (state && disconnectedStates.includes(state as string)) {
            console.log(`❌ Cliente ${companySlug} está em estado de desconexão: ${state}`);
            return { healthy: false, reason: `Estado de desconexão: ${state}`, shouldReconnect: true };
        }

        console.log(
            `🔍 Estado ambíguo (${state}), tentando verificação prática para ${companySlug}...`,
        );

        try {
            const info = await raceWithTimeout(Promise.resolve(client.info), 3000, "timeout-info");
            if (info && info.wid) {
                console.log(`✅ Cliente ${companySlug} tem info válida: ${info.wid._serialized}`);
                return { healthy: true, state: state ?? "ASSUMED_CONNECTED", info: info.wid._serialized };
            }
        } catch (e) {
            console.log(
                `⚠️ Não conseguiu obter info do cliente ${companySlug}: ${(e as Error).message}`,
            );
        }

        try {
            console.log(`🔍 Tentativa final: listando chats para ${companySlug}...`);
            const chats = await raceWithTimeout(client.getChats(), 5000, "timeout-chats");
            if (chats && Array.isArray(chats)) {
                console.log(
                    `✅ Cliente ${companySlug} conseguiu listar ${chats.length} chats - está funcional`,
                );
                return { healthy: true, state: state ?? "FUNCTIONAL", info: `${chats.length} chats` };
            }
        } catch (e) {
            console.log(
                `❌ Cliente ${companySlug} não conseguiu listar chats: ${(e as Error).message}`,
            );
        }

        console.log(`❌ Cliente ${companySlug} falhou em todas as verificações de saúde`);
        return {
            healthy: false,
            reason: `Estado: ${state ?? "desconhecido"} - falhou nas verificações práticas`,
            shouldReconnect: true,
        };
    } catch (error) {
        console.log(
            `❌ Cliente ${companySlug} falhou na verificação de saúde:`,
            (error as Error).message,
        );
        return { healthy: false, reason: (error as Error).message, shouldReconnect: true };
    }
}

export async function zombieSessionMonitor(): Promise<void> {
    const slugs = Object.keys(sessions);
    if (slugs.length === 0) return;

    console.log(`[HEALTH] Verificando ${slugs.length} sessoes...`);

    for (const slug of slugs) {
        const session = sessions[slug];
        if (!session || !session.client) continue;
        if (session.connecting || session.destroying) continue;
        if (session.reconnectTimer) continue;

        try {
            const client = session.client;

            if (!client.pupPage || client.pupPage.isClosed()) {
                console.log(`[HEALTH] ${slug}: browser page fechada, limpando`);
                await safeDestroyClient(slug);
                continue;
            }

            if (client.pupBrowser) {
                const proc = client.pupBrowser.process();
                if (proc && proc.killed) {
                    console.log(`[HEALTH] ${slug}: processo Chrome morto, limpando`);
                    await safeDestroyClient(slug);
                    continue;
                }
            }

            if (session.ready) {
                try {
                    await raceWithTimeout(client.getState(), 8000, "health-check-timeout");
                } catch (e) {
                    console.log(
                        `[HEALTH] ${slug}: ready mas sem resposta (${(e as Error).message}), agendando reconnect`,
                    );
                    session.ready = false;
                    session.lastDisconnectTime = Date.now();
                    session.lastDisconnectReason = "health-check-failed";
                    await scheduleReconnect(slug, "health-check-failed");
                }
            }

            if (!session.ready && session.lastDisconnectTime) {
                const stuckDuration = Date.now() - session.lastDisconnectTime;
                if (stuckDuration > 600000) {
                    console.log(
                        `[HEALTH] ${slug}: desconectada ha ${Math.round(stuckDuration / 60000)}min, destruindo`,
                    );
                    await safeDestroyClient(slug);
                }
            }
        } catch (err) {
            console.log(`[HEALTH] ${slug}: erro durante verificacao: ${(err as Error).message}`);
        }
    }
}

// ─── Management ───────────────────────────────────────────────────────────────

export async function clearSession(companySlug: string): Promise<ClearResult> {
    if (!sessions[companySlug]) {
        console.log(`[CLEAR] Sessao ${companySlug} nao existe`);
        return { success: false, message: "Sessao nao existe" };
    }

    const client = sessions[companySlug].client;
    let logoutSuccess = false;

    console.log(`[CLEAR] Iniciando limpeza completa da sessao ${companySlug}...`);

    if (client) {
        try {
            await raceWithTimeout(client.logout(), 10000, "Timeout no logout");
            logoutSuccess = true;
            console.log(`[CLEAR] ${companySlug}: logout ok`);
        } catch (e) {
            console.log(`[CLEAR] ${companySlug}: logout falhou: ${(e as Error).message}`);
        }
    }

    await safeDestroyClient(companySlug);

    return {
        success: true,
        message: logoutSuccess
            ? `Sessao ${companySlug} limpa e logout realizado no WhatsApp`
            : `Sessao ${companySlug} limpa (logout do WhatsApp pode ter falhado)`,
        details: { logoutSuccess, sessionRemoved: true },
        whatsappLoggedOut: logoutSuccess,
    };
}

export async function clearAllSessions(): Promise<ClearAllResult> {
    const results: Record<string, ClearResult> = {};
    const sessionKeys = Object.keys(sessions);

    console.log(`🧹 Iniciando limpeza de todas as sessões (${sessionKeys.length} sessões)`);

    if (sessionKeys.length === 0) {
        return { success: true, message: "Nenhuma sessão ativa para limpar", sessions: {} };
    }

    await Promise.all(
        sessionKeys.map(async (companySlug) => {
            try {
                results[companySlug] = await clearSession(companySlug);
            } catch (error) {
                results[companySlug] = {
                    success: false,
                    message: `Erro ao limpar sessão: ${(error as Error).message}`,
                    error: (error as Error).message,
                };
            }
        }),
    );

    const successCount = Object.values(results).filter((r) => r.success).length;
    const logoutCount = Object.values(results).filter((r) => r.whatsappLoggedOut).length;

    console.log(
        `✅ Limpeza concluída: ${successCount}/${sessionKeys.length} sessões limpas, ${logoutCount} com logout do WhatsApp`,
    );

    return {
        success: true,
        message: `Processadas ${sessionKeys.length} sessões`,
        summary: {
            total: sessionKeys.length,
            successful: successCount,
            withLogout: logoutCount,
            failed: sessionKeys.length - successCount,
        },
        sessions: results,
    };
}

export async function deleteAllCompaniesAndSessions(): Promise<DeleteAllResult> {
    const results: {
        sessionsCleared: Record<string, ClearResult>;
        authDataDeleted: boolean;
        cacheDeleted: boolean;
        authDataError?: string;
        cacheError?: string;
    } = {
        sessionsCleared: {},
        authDataDeleted: false,
        cacheDeleted: false,
    };

    console.log(`🗑️ Iniciando exclusão de TODAS as empresas e sessões...`);

    const sessionKeys = Object.keys(sessions);
    console.log(`📋 Sessões ativas encontradas: ${sessionKeys.length}`);

    for (const companySlug of sessionKeys) {
        try {
            results.sessionsCleared[companySlug] = await clearSession(companySlug);
        } catch (error) {
            results.sessionsCleared[companySlug] = {
                success: false,
                message: (error as Error).message,
                error: (error as Error).message,
            };
        }
    }

    const authPath = path.resolve(__dirname, "..", ".wwebjs_auth");
    try {
        await fs.promises.rm(authPath, { recursive: true, force: true });
        results.authDataDeleted = true;
        console.log(`✅ Diretório de autenticação removido: ${authPath}`);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
            console.log(`⚠️ Erro ao remover diretório de autenticação: ${err.message}`);
            results.authDataError = err.message;
        } else {
            results.authDataDeleted = true;
            console.log(`ℹ️ Diretório de autenticação não existia`);
        }
    }

    const cachePath = path.resolve(__dirname, "..", ".wwebjs_cache");
    try {
        await fs.promises.rm(cachePath, { recursive: true, force: true });
        results.cacheDeleted = true;
        console.log(`✅ Diretório de cache removido: ${cachePath}`);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
            console.log(`⚠️ Erro ao remover diretório de cache: ${err.message}`);
            results.cacheError = err.message;
        } else {
            results.cacheDeleted = true;
            console.log(`ℹ️ Diretório de cache não existia`);
        }
    }

    const successCount = Object.values(results.sessionsCleared).filter((r) => r.success).length;

    return {
        success: true,
        message: `Todas as empresas e sessões foram deletadas`,
        summary: {
            totalSessions: sessionKeys.length,
            sessionsCleared: successCount,
            authDataDeleted: results.authDataDeleted,
            cacheDeleted: results.cacheDeleted,
        },
        details: results,
    };
}

export async function debugSessionState(companySlug: string): Promise<Record<string, unknown>> {
    if (!sessions[companySlug]) {
        return { exists: false, message: "Sessão não existe" };
    }

    const session = sessions[companySlug];
    const debug: Record<string, unknown> = {
        exists: true,
        ready: session.ready,
        connecting: session.connecting,
        hasQrCode: !!session.qrCode,
        hasClient: !!session.client,
        lastBatteryUpdate: session.lastBatteryUpdate ?? null,
    };

    if (session.client) {
        try {
            const state = await raceWithTimeout(session.client.getState(), 3000);
            debug.realState = state;
            debug.isReallyConnected = state === "CONNECTED";

            if (state === "CONNECTED" && !session.ready) {
                console.log(`🔧 CORREÇÃO: Marcando ${companySlug} como conectado`);
                session.ready = true;
                session.connecting = false;
                session.qrCode = null;
            }
        } catch (error) {
            debug.realState = "ERROR";
            debug.error = (error as Error).message;
        }
    }

    return debug;
}

export async function searchNumberInfo(
    companySlug: string,
    number: string,
): Promise<Record<string, unknown>> {
    if (!sessions[companySlug] || !sessions[companySlug].ready) {
        throw new Error(`Empresa ${companySlug} não está conectada ao WhatsApp`);
    }

    const client = sessions[companySlug].client;
    const cleanNumber = number.replace(/\D/g, "");

    console.log(`🔍 Buscando informações completas para número: ${cleanNumber}`);

    const info: {
        originalNumber: string;
        cleanNumber: string;
        searchResults: {
            chats: Record<string, unknown>[];
            contacts: Record<string, unknown>[];
            registrationStatus: boolean | string | null;
        };
        recommendedChatId?: ChatIdResult;
    } = {
        originalNumber: number,
        cleanNumber,
        searchResults: { chats: [], contacts: [], registrationStatus: null },
    };

    try {
        const chats = await client.getChats();
        for (const chat of chats) {
            if (chat.id.user === cleanNumber) {
                info.searchResults.chats.push({
                    id: chat.id._serialized,
                    name: chat.name,
                    isGroup: chat.isGroup,
                    isReadOnly: chat.isReadOnly,
                    unreadCount: chat.unreadCount,
                    timestamp: chat.timestamp,
                });
            }
        }

        const contacts = await client.getContacts();
        for (const contact of contacts) {
            if (contact.id.user === cleanNumber) {
                info.searchResults.contacts.push({
                    id: contact.id._serialized,
                    name: contact.name,
                    pushname: contact.pushname,
                    isMyContact: contact.isMyContact,
                    isUser: contact.isUser,
                    isWAContact: contact.isWAContact,
                });
            }
        }

        try {
            info.searchResults.registrationStatus = await client.isRegisteredUser(
                `${cleanNumber}@c.us`,
            );
        } catch (e) {
            info.searchResults.registrationStatus = `Erro: ${(e as Error).message}`;
        }

        info.recommendedChatId = await findCorrectChatId(client, number);

        return info;
    } catch (error) {
        throw new Error(`Erro ao buscar informações: ${(error as Error).message}`);
    }
}

export function getSession(companySlug: string): Session | null {
    return sessions[companySlug] ?? null;
}

export function listSessions(): Record<string, Record<string, unknown>> {
    const sessionList: Record<string, Record<string, unknown>> = {};
    for (const [companySlug, session] of Object.entries(sessions)) {
        sessionList[companySlug] = {
            ready: session.ready,
            connecting: session.connecting,
            hasQrCode: !!session.qrCode,
            lastBatteryUpdate: session.lastBatteryUpdate ?? null,
            reconnectAttempts: session.reconnectAttempts || 0,
            lastDisconnectReason: session.lastDisconnectReason ?? null,
            lastDisconnectTime: session.lastDisconnectTime
                ? new Date(session.lastDisconnectTime).toISOString()
                : null,
            hasPendingReconnect: !!session.reconnectTimer,
        };
    }
    return sessionList;
}

async function waitForQrCode(companySlug: string, timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            console.log(
                `⏰ Timeout ao aguardar QR Code para ${companySlug} após ${timeout / 1000}s`,
            );
            reject(new Error(`Timeout ao gerar QR Code para ${companySlug}. Tente novamente.`));
        }, timeout);

        const session = sessions[companySlug];

        const interval = setInterval(() => {
            if (
                session &&
                (session.qrCode || session.ready)
            ) {
                clearTimeout(timeoutId);
                clearInterval(interval);
                console.log(`✅ QR Code gerado ou cliente conectado para ${companySlug}`);
                resolve();
            }

            if (!sessions[companySlug]) {
                clearTimeout(timeoutId);
                clearInterval(interval);
                reject(new Error(`Sessão ${companySlug} foi removida durante a espera`));
            }
        }, 1000);
    });
}
