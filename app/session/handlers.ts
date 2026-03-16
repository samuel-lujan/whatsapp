import type { Client, Message } from "whatsapp-web.js";
import { getAiResponse } from "../langchain";
import { safeDestroyClient, scheduleReconnect } from ".";
import { PERMANENT_FAILURE_REASONS } from ".";
import { sessions } from ".";
import { raceWithTimeout } from "../utils";
import type { SessionState } from "../types";

export function onQr(session: SessionState) {
    return (qr: string) => {
        console.log(`QR Code gerado para empresa: ${session.companySlug}`);
        session.qrCode = qr;
    };
}

export function onAuthenticated(companySlug: string) {
    return () => {
        console.log(`🔐 Cliente ${companySlug} autenticado - aguardando ready...`);
    };
}

export function onReady(session: SessionState) {
    return async () => {
        console.log(`✅ WhatsApp conectado para empresa: ${session.companySlug}`);
        if (session) {
            session.ready = true;
            session.connecting = false;
            session.qrCode = null;

            try {
                const info = session.client.info;
                console.log(`📱 Cliente ${session.companySlug} conectado como: ${info.wid._serialized}`);
            } catch (e) {
                console.log(`⚠️ Cliente ${session.companySlug} conectado mas sem info detalhada`);
            }
        }
    };
}

export function onDisconnected(session: SessionState) {
    return async (reason: string) => {
        console.log(`[EVENT] ${session.companySlug} disconnected: ${reason}`);
        if (!session) return;

        session.ready = false;
        session.qrCode = null;
        session.lastDisconnectTime = Date.now();
        session.lastDisconnectReason = reason;

        const shouldReconect = (reason) => {
            if (typeof reason === "string") {
                return !PERMANENT_FAILURE_REASONS.includes(reason);
            }
            return true;
        };

        if (shouldReconect(reason)) {
            await scheduleReconnect(session.companySlug, reason);
        } else {
            console.log(
                `[EVENT] ${session.companySlug}: falha permanente (${reason}), destruindo sem reconnect`,
            );
            await safeDestroyClient(session.companySlug);
        }
    };
}

export function onAuthFailure(companySlug: string) {
    return async (msg: string) => {
        console.log(`[EVENT] ${companySlug} auth_failure: ${msg}`);
        await safeDestroyClient(companySlug);
    };
}

export function onChangeState(session: SessionState) {
    return (state: string) => {
        console.log(`[EVENT] ${session.companySlug} state changed: ${state}`);
        if (!session) return;

        if (state === "CONNECTED") {
            session.ready = true;
            session.reconnectAttempts = 0;
        }
        const badStates = ["UNPAIRED", "UNLAUNCHED", "UNPAIRED_IDLE"];
        if (badStates.includes(state)) {
            session.ready = false;
            session.connecting = false;
        }
    };
}

export function onError(session: SessionState) {
    return async (error: Error) => {
        console.log(`[EVENT] ${session.companySlug} error: ${error.message}`);
        if (!session) return;

        session.ready = false;
        session.connecting = false;

        const isBrowserError =
            error.message.includes("Protocol error") ||
            error.message.includes("Target closed") ||
            error.message.includes("Session closed") ||
            error.message.includes("Navigation failed");

        if (isBrowserError) {
            session.lastDisconnectTime = Date.now();
            session.lastDisconnectReason = `error:${error.message.substring(0, 50)}`;
            await scheduleReconnect(session.companySlug, `error:${error.message.substring(0, 50)}`);
        }
    };
}

export function onChangeBattery(session: SessionState) {
    return (_batteryInfo: unknown) => {
        session.lastBatteryUpdate = Date.now();
    };
}

export async function waitForQrCode(companySlug: string, timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            console.log(
                `⏰ Timeout ao aguardar QR Code para ${companySlug} após ${timeout / 1000}s`,
            );
            reject(new Error(`Timeout ao gerar QR Code para ${companySlug}. Tente novamente.`));
        }, timeout);

        const interval = setInterval(() => {
            if (
                sessions[companySlug] &&
                (sessions[companySlug].qrCode || sessions[companySlug].ready)
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

export function onMessage(companySlug: string, client: Client) {
    return async (message: Message) => {
        try {
            console.log(
                `📩 Mensagem recebida de ${message.from}: "${message.body?.substring(0, 50)}..."`,
            );

            const isNewsletter = message.from.endsWith("@newsletter");

            const isChatMessage = !message.isStatus && !message.broadcast && !isNewsletter;
            if (!isChatMessage) {
                console.log(`⚠️ Ignorando mensagem de tipo ${message.type} de ${message.from}`);
                return;
            }

            const shouldRespond = message.from.endsWith("@g.us");

            if (shouldRespond) {
                const aiResponse = await getAiResponse(message, companySlug);

                if (aiResponse.success) {
                    await raceWithTimeout(
                        client.sendMessage(message.from, aiResponse.body!),
                        15000,
                        "Timeout ao enviar mensagem - cliente pode ter desconectado",
                    );
                    console.log(`✅ Mensagem enviada com sucesso pelo cliente ${companySlug}`);
                    return;
                }
            }

            const chat = await message.getChat();
            if (typeof chat.markUnread === "function") {
                await chat.markUnread();
                console.log(
                    `ℹ️ Mensagem marcada como não lida para atendimento humano - ${companySlug}`,
                );
            } else {
                console.log(
                    `ℹ️ Sem resposta da IA para ${companySlug}, método markUnread não disponível nesta versão`,
                );
            }
        } catch (error) {
            console.error(
                `❌ Erro ao processar mensagem para ${companySlug}:`,
                (error as Error).message,
            );
        }
    };
}
