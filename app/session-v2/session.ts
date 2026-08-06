import { Client, ClientInfo, LocalAuth, Message, WAState } from "whatsapp-web.js";
import { Logger } from "../logging";
import { getAiResponse } from "../langchain/langchain";
import { raceWithTimeout, errMsg } from "../utils";
import { scheduleReconnect, safeDestroyClient } from "./service";
import { validateWhatsAppNumber } from "../wppwebjs";
import { ContactInfo, MessageData } from "../types";
import { PERMANENT_FAILURE_REASONS } from "./constants";
import { io } from "../socket";

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
    trackingContacts: ContactInfo[] = [];

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
        // client.on("message", (message) => {
        //     this.logger.log(`📩 Mensagem recebida de ${message.from}: "${message.body?.substring(0, 50)}..."`, "onMESSAGE");
        //     io?.to(this.name).emit("newMessage", message);
        // });
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

                const shouldRespond = message.from.endsWith("@c.us");

                if (shouldRespond) {
                    const aiResponse = await getAiResponse(message, this.name, this.logger);

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

              this.logger.log(`ℹ️ Mensagem IA indisponível, ignorando.`, tag);
            } catch (error) {
                this.logger.log(`❌ Erro ao processar mensagem: ${errMsg(error)}`, tag);
            }
        };
    }

    toJSON() {
        let isPuppeteerOpen = false;

        try {
            isPuppeteerOpen = !!this.client?.pupPage && !this.client.pupPage.isClosed();
        } catch {
            isPuppeteerOpen = false;
        }

        return {
            name: this.name,
            qrCode: this.qrCode,
            ready: this.ready,
            connecting: this.connecting,
            destroying: this.destroying,
            reconnectAttempts: this.reconnectAttempts,
            lastDisconnectTime: this.lastDisconnectTime,
            lastDisconnectReason: this.lastDisconnectReason,
            lastBatteryUpdate: this.lastBatteryUpdate ?? null,
            hasAi: this.hasAi,
            trackingContacts: this.trackingContacts,
            isPuppeteerOpen,
            clientInfo: this.client?.info
                ? {
                    wid: this.client.info.wid._serialized,
                    pushname: this.client.info.pushname,
                }
                : null,
        };
    }

    sendMessage = async (number: string, message: string, customName?: string): Promise<MessageData> => {
        if (!this.ready) {
            throw new Error(`Sessão ${this.name} não está pronta para enviar mensagens`);
        }
        const pageOk = await this.checkPupPage();
        if (!pageOk) {
            throw new Error(`Sessão ${this.name} - browser desconectado, não é possível enviar mensagem`);
        }

        this.logger.log(`🔍 Validando número ${number}...`);
        const validation = await validateWhatsAppNumber(this.client, number, this.logger);

        if (!validation.isValid) {
            this.logger.log(`❌ Número ${number} não é válido no WhatsApp`);
            throw new Error(`Número ${number} não é um usuário válido do WhatsApp`);
        }

        let messageData: MessageData = {
            companySlug: this.name,
            number: validation.originalNumber,
            originalNumber: validation.validatedNumber,
            wasAlternative: validation.wasAlternative,
            chatId: validation.numberId!,
            content: message,
            timestamp: new Date().toISOString(),
        }

        const validationInfo = validation.wasFallback
            ? " (fallback - não confirmado pela API)"
            : validation.wasAlternative
                ? " (versão alternativa)"
                : "";
        this.logger.log(`✅ Número validado: ${messageData.chatId}${validationInfo}`);

        this.logger.log(`📤 Enviando mensagem do cliente ${this.name} para ${messageData.chatId}`);
        await this.client.sendMessage(messageData.chatId, message);
        this.logger.log(`✅ Mensagem enviada com sucesso!`);

        let contactInfo: ContactInfo = {
            pushname: "Desconhecido",
            chatName: messageData.chatId,
            number: messageData.chatId,
        };

        try {
            const chat = await this.client.getChatById(messageData.chatId!);
            const contact = await chat.getContact();
            contactInfo = {
                pushname: contact.pushname || "Sem nome",
                chatName: chat.name || messageData.chatId,
                number: messageData.chatId,
                isMyContact: contact.isMyContact,
            };
            this.logger.log(`👤 Informações do contato: ${contactInfo.pushname}`);
        } catch (e) {
            this.logger.log(`⚠️ Não foi possível obter informações do contato: ${e.message}`);
        }

        const existingIndex = this.trackingContacts.findIndex(c => c.number === messageData.chatId);
        if (existingIndex === -1) {
            this.trackingContacts.push({ ...contactInfo, ...(customName ? { customName } : {}) });
        } else if (customName) {
            this.trackingContacts[existingIndex].customName = customName;
        }

        return messageData;
    }

    checkPupPage = async (): Promise<boolean> => {
        if (this.client.pupPage) {
            try {
                const isClosed = this.client.pupPage.isClosed();
                if (isClosed) {
                    this.logger.log(`❌ Cliente ${this.name} - página do browser está fechada`);
                    return false;
                }
            } catch (e) {
                this.logger.log(`⚠️ Erro ao verificar página do browser para ${this.name}: ${e.message}`);
                return false;
            }
        }
        return true;
    }

    getState = async (): Promise<WAState> => {
        try {
            const state = await raceWithTimeout(this.client.getState(), 5000, "getState timeout");
            this.logger.log(`📊 Estado do cliente: ${state}`);
            return state;
        } catch (e) {
            this.logger.log(`⚠️ Timeout ao obter estado do cliente, tentando verificação alternativa...`);
            return null;
        }
    }

    getInfo = async (): Promise<string> => {
        try {
            // Tenta obter informações básicas do cliente - isso só funciona se conectado
            const info = await raceWithTimeout(Promise.resolve(this.client.info), 3000, 'timeout-info')
            return info?.wid._serialized || null;
            } catch (e) {
                this.logger.log(`⚠️ Não foi possível obter info do cliente: ${e.message}`);
                return null;
            }
        }
    
    getChatsLength = async (): Promise<number> => {
                        try {
                this.logger.log(`🔍 Tentativa final: listando chats...`);
                const chats = await raceWithTimeout(this.client.getChats(), 5000, 'timeout-chats');

                if (chats && Array.isArray(chats)) {
                    this.logger.log(`✅ Foi possível listar ${chats.length} chats - está funcional`);
                    return chats.length;
                }
                } catch (e) {
                    this.logger.log(`❌ Não foi possível listar chats: ${e.message}`);
                    return null;
                }
            }
}