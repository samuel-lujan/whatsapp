import fs from "fs";
import path from "path";
import type { WAState } from "whatsapp-web.js";
import type {
    ChatIdResult,
    ClearAllResult,
    ClearResult,
    ConnectionStatus,
    DeleteAllResult,
    StatusResult,
} from "../types";
import { Session } from "./session";
import { findCorrectChatId } from "../wppwebjs/number-utils";
import { sessions } from ".";
import { raceWithTimeout } from "../utils";
import { safeDestroyClient, createSession } from "./sessionLifecycle";
import { waitForQrCode } from "./utils";

// ─── Status ───────────────────────────────────────────────────────────────────

async function createIfMissing(companySlug: string): Promise<StatusResult> {
    console.log(`🆕 Nenhuma sessão encontrada para ${companySlug} - criando nova...`);
    try {
        await createSession(companySlug);
        console.log(`⏳ Aguardando QR Code ou conexão automática para ${companySlug}...`);
        await waitForQrCode(companySlug, 20000);
    } catch (error) {
        console.log(`⚠️ Erro ao criar sessão/aguardar QR Code para ${companySlug}:`, (error as Error).message);
        return {
            connected: false,
            error: (error as Error).message,
            suggestion: "Tente novamente - o WhatsApp pode estar inicializando",
        };
    }
}

function returnQRCodeStatus(session: Session) {
    const qrCode = session?.qrCode ?? null;
    console.log(`📱 Retornando status para ${session.companySlug} - QR Code: ${qrCode ? "Disponível" : "Não disponível"}`);
    console.log(`🔍 Estado da sessão ${session.companySlug}:`, {
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

export async function getStatus(companySlug: string): Promise<StatusResult> {
    const session = sessions[companySlug];
    if (session?.ready) {
        console.log(`✅ Cliente ${companySlug} está conectado - não precisa de QR Code`);
        return { connected: true };
    }

    const client = session?.client;
    if (client) {
        console.log(`🔍 Verificando estado real do cliente ${companySlug}...`);

        try {
            const state = (await raceWithTimeout(client.getState(), 5000)) as WAState | null;
            console.log(`📱 Estado atual do cliente ${companySlug}:`, state);

            try {
                if (state === "CONNECTED" || client?.info?.wid) {
                    console.log(`🔧 Cliente ${companySlug} estava conectado mas não marcado como ready - corrigindo...`);
                    session.markAsReady();
                    return { connected: true };
                }
            } catch (e) {
                console.log(`⚠️ Verificação alternativa falhou para ${companySlug}:`, (e as Error).message);
            }
            return { connected: false };
        } catch (error) {
            const msg = (error as Error).message;
            console.log(`⚠️ Cliente ${companySlug} não está realmente conectado:`, msg);

            if (msg.includes("null") || msg.includes("destroyed") || msg === "timeout") {
                console.log(`[ZOMBIE] ${companySlug}: sessão zumbi detectada (connecting=${session?.connecting}, ready=${session?.ready}) - destruindo...`);
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
        return createIfMissing(companySlug);
    }

    if (session?.ready) {
        console.log(`✅ Cliente ${companySlug} conectou durante o processo`);
        return { connected: true };
    }

    return returnQRCodeStatus(session);
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
        console.log(`🔍 Verificação rápida: Cliente ${companySlug} existe mas não está marcado como ready`);
        try {
            if (session.client.pupPage && !session.client.pupPage.isClosed()) {
                console.log(`🤔 Cliente ${companySlug} pode estar conectado - recomendado verificação completa`);
                return {
                    connected: false,
                    status: "needs_verification",
                    suggestion: "Use /status para verificação completa",
                };
            }
        } catch (e) {
            console.log(`⚠️ Erro na verificação rápida do cliente ${companySlug}:`, (e as Error).message);
        }
    }

    if (session?.connecting) {
        console.log(`⏳ Verificação rápida: Cliente ${companySlug} ainda conectando`);
        return { connected: false, status: "connecting" };
    }

    console.log(`❌ Verificação rápida: Cliente ${companySlug} não conectado`);
    return { connected: false };
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

    console.log(`✅ Limpeza concluída: ${successCount}/${sessionKeys.length} sessões limpas, ${logoutCount} com logout do WhatsApp`);

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
            info.searchResults.registrationStatus = await client.isRegisteredUser(`${cleanNumber}@c.us`);
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
