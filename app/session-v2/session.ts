import { Client, LocalAuth, Message } from "whatsapp-web.js";
import { Logger } from "../logging";
import { getAiResponse } from "../langchain/langchain";
import { raceWithTimeout, errMsg } from "../utils";
import { PERMANENT_FAILURE_REASONS, scheduleReconnect, safeDestroyClient } from "./service";

export class Session {
    client: Client;
    name: string;
    qrCode: string | null = null;
    ready: boolean = false;
    connecting: boolean = true;
    destroying: boolean = false;
    reconnectAttempts: number = 0;
    reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    lastDisconnectTime: number | null = null;
    lastDisconnectReason: string | null = null;
    lastBatteryUpdate?: number;
    logger: Logger;
    hasAi: boolean = false;

    constructor(name: string, isHeadless: boolean, hasAi: boolean) {
        this.name = name;
        this.logger = new Logger(name);
        this.hasAi = hasAi;

        const client = new Client({
            authStrategy: new LocalAuth({ clientId: name }),
            puppeteer: {
                headless: isHeadless,
                protocolTimeout: 120000,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-accelerated-2d-canvas",
                    "--no-first-run",
                    "--no-zygote",
                    "--disable-gpu",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--disable-default-apps",
                    "--disable-sync",
                    "--disable-translate",
                    "--metrics-recording-only",
                    "--mute-audio",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding",
                    "--disable-component-update",
                ],
            },
        });

        client.on("qr", this.onQr());
        client.on("authenticated", this.onAuthenticated());
        client.on("ready", this.onReady());
        client.on("disconnected", this.onDisconnected());
        client.on("auth_failure", this.onAuthFailure());
        client.on("change_state", this.onChangeState());
        client.on("error", this.onError());
        client.on("change_battery", this.onChangeBattery());
        if (this.hasAi) {
            client.on("message", this.onMessage(client));
        }

        this.client = client;
    }

    async initialize(): Promise<void> {
        this.connecting = true;
        await this.client.initialize();
    }

    onQr() {
        return async (qr: string) => {
            this.qrCode = qr;
            this.logger.log(`QR Code gerado.`, "onQR");
        };
    }

    onAuthenticated() {
        return () => {
            this.logger.log(`🔐 Cliente autenticado - aguardando ready...`, "onAUTH");
        };
    }

    onReady() {
        return async () => {
            const tag = "onREADY";
            this.logger.log(`✅ WhatsApp conectado.`, tag);
            if (this) {
                this.ready = true;
                this.connecting = false;
                try {
                    const info = this.client.info;
                    this.logger.log(`📱 Cliente conectado como: ${info.wid._serialized}`, tag);
                } catch (e) {
                    this.logger.log(`⚠️ Cliente conectado mas sem info detalhada`, tag);
                }
            }
        };
    }

    onDisconnected() {
        return async (reason: string) => {
            const tag = "onDISCONNECTED";
            this.logger.log(`🔌 Cliente desconectado: ${reason}`, tag);
            if (!this) return;

            this.ready = false;
            this.qrCode = null;
            this.lastDisconnectTime = Date.now();
            this.lastDisconnectReason = reason;

            const shouldReconnect =
                typeof reason !== "string" || !PERMANENT_FAILURE_REASONS.includes(reason);

            if (shouldReconnect) {
                this.lastDisconnectTime = this.lastDisconnectTime;
                this.lastDisconnectReason = this.lastDisconnectReason;
                await scheduleReconnect(this, reason);
            } else {
                this.logger.log(`⚠️ Falha permanente (${reason}), destruindo sem reconnect`, tag);
                await safeDestroyClient(this);
            }
        };
    }

    onAuthFailure() {
        return async (msg: string) => {
            const tag = "onAUTH_FAILURE";
            this.logger.log(`⚠️ Auth_failure: ${msg}`, tag);
            if (!this) {
                return;
            }

            this.lastDisconnectTime = Date.now();
            this.lastDisconnectReason = `auth_failure: ${msg}`;
            await safeDestroyClient(this);
        };
    }

    onChangeState() {
        const logger = this.logger;
        return async (state: string) => {
            const tag = "onCHANGE_STATE";
            logger.log(`ℹ️ State changed: ${state}`, tag);
            if (!this) return;

            if (state === "CONNECTED") {
                this.ready = true;
                this.reconnectAttempts = 0;
            }
            const badStates = ["UNPAIRED", "UNLAUNCHED", "UNPAIRED_IDLE"];
            if (badStates.includes(state)) {
                this.ready = false;
                this.connecting = false;
            }
        };
    }

    onError() {
        return async (error: Error) => {
            const tag = "onERROR";
            this.logger.log(`❌ Error: ${error.message}`, tag);
            if (!this) return;

            this.ready = false;
            this.connecting = false;

            const browserErrors = [
                "Protocol error",
                "Target closed",
                "Session closed",
                "Navigation failed",
            ];
            const isBrowserError = browserErrors.some((e) => error.message.includes(e));

            if (isBrowserError) {
                const disconnectReason = `Browser error: ${error.message.substring(0, 50)}`;
                this.lastDisconnectTime = Date.now();
                this.lastDisconnectReason = disconnectReason;
                await scheduleReconnect(this, disconnectReason);
            }
        };
    }

    onChangeBattery() {
        return (_batteryInfo: unknown) => {
            this.lastBatteryUpdate = Date.now();
        };
    }

    onMessage(client: Client) {
        return async (message: Message) => {
            const tag = "onMESSAGE";
            try {
                this.logger.log(`📩 Mensagem recebida de ${message.from}: "${message.body?.substring(0, 50)}..."`, tag);

                const isNewsletter = message.from.endsWith("@newsletter");

                const isChatMessage = !message.isStatus && !message.broadcast && !isNewsletter;
                if (!isChatMessage) {
                    this.logger.log(`⚠️ Ignorando mensagem de tipo ${message.type} de ${message.from}`, tag);
                    return;
                }

                const shouldRespond = message.from.endsWith("@g.us");

                if (shouldRespond) {
                    const aiResponse = await getAiResponse(message, this.name);

                    if (aiResponse.success) {
                        await raceWithTimeout(
                            client.sendMessage(message.from, aiResponse.body!),
                            15000,
                            "Timeout ao enviar mensagem - cliente pode ter desconectado",
                        );
                        this.logger.log(`✅ Mensagem enviada com sucesso pelo cliente ${this.name}`, tag);
                        return;
                    }
                }

                const chat = await message.getChat();
                if (typeof chat.markUnread === "function") {
                    await chat.markUnread();
                    this.logger.log(`ℹ️ Mensagem marcada como não lida para atendimento humano - ${this.name}`, tag);
                } else {
                    this.logger.log(`ℹ️ Sem resposta da IA para ${this.name}, método markUnread não disponível nesta versão`, tag);
                }
            } catch (error) {
                this.logger.log(`❌ Erro ao processar mensagem: ${errMsg(error)}`, tag);
            }
        };
    }
}