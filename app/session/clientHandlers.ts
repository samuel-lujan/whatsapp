import type { Client, Message } from "whatsapp-web.js";
import { getAiResponse } from "../langchain/langchain";
import { safeDestroyClient, scheduleReconnect, Session } from ".";
import { PERMANENT_FAILURE_REASONS } from ".";
import { raceWithTimeout } from "../utils";

export function onQr(session: Session) {
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

export function onReady(session: Session) {
    return async () => {
        console.log(`✅ WhatsApp conectado para empresa: ${session.companySlug}`);
        if (session) {
            session.markAsReady();
            try {
                const info = session.client.info;
                console.log(`📱 Cliente ${session.companySlug} conectado como: ${info.wid._serialized}`);
            } catch (e) {
                console.log(`⚠️ Cliente ${session.companySlug} conectado mas sem info detalhada`);
            }
        }
    };
}

export function onDisconnected(session: Session) {
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

export function onChangeState(session: Session) {
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

export function onError(session: Session) {
    return async (error: Error) => {
        console.log(`[EVENT] ${session.companySlug} error: ${error.message}`);
        if (!session) return;

        session.ready = false;
        session.connecting = false;

        const browserErrors = ["Protocol error", "Target closed", "Session closed", "Navigation failed"];
        const isBrowserError = browserErrors.some(e => error.message.includes(e));

        if (isBrowserError) {
            session.lastDisconnectTime = Date.now();
            session.lastDisconnectReason = `error:${error.message.substring(0, 50)}`;
            await scheduleReconnect(session.companySlug, `error:${error.message.substring(0, 50)}`);
        }
    };
}

export function onChangeBattery(session: Session) {
    return (_batteryInfo: unknown) => {
        session.lastBatteryUpdate = Date.now();
    };
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
