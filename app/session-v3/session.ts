import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    WASocket,
    WAVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";
import qrcode from "qrcode";
import pino from "pino";
import { Logger } from "../logging";
import { ContactInfo, MessageData } from "../types";
import { BAILEYS_AUTH_DIR, DISCONNECT_REASON_LABELS, PERMANENT_DISCONNECT_CODES } from "./constants";
import { safeDestroyClient, scheduleReconnect } from "./service";

let _cachedVersion: { version: WAVersion; expiresAt: number } | null = null;

async function getWAVersion(): Promise<WAVersion> {
    const now = Date.now();
    if (_cachedVersion && now < _cachedVersion.expiresAt) {
        return _cachedVersion.version;
    }
    const { version } = await fetchLatestBaileysVersion();
    _cachedVersion = { version, expiresAt: now + 60 * 60 * 1000 };
    return version;
}

export class Session {
    sock: WASocket | null = null;
    name: string;
    qrCode: string | null = null;
    ready: boolean = false;
    connecting: boolean = true;
    destroying: boolean = false;
    reconnectAttempts: number = 0;
    reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    lastDisconnectTime: number | null = null;
    lastDisconnectReason: string | null = null;
    logger: Logger;
    hasAi: false = false;
    trackingContacts: ContactInfo[] = [];

    constructor(name: string) {
        this.name = name;
        this.logger = new Logger(name);
    }

    async initialize(): Promise<void> {
        this.connecting = true;
        await this._createSocket();
    }

    private async _createSocket(): Promise<void> {
        const folder = path.resolve(process.cwd(), BAILEYS_AUTH_DIR, `session-${this.name}`);
        await fs.promises.mkdir(folder, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(folder);
        const version = await getWAVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: ["WhatsApp-Lujan", "Chrome", "1.0.0"],
            connectTimeoutMs: 60_000,
            defaultQueryTimeoutMs: 30_000,
            keepAliveIntervalMs: 25_000,
            markOnlineOnConnect: false,
        });

        // CRÍTICO: persiste auth no disco a cada atualização
        this.sock.ev.on("creds.update", saveCreds);

        this.sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    this.qrCode = await qrcode.toDataURL(qr);
                    this.logger.log("QR Code gerado", "onQR");
                } catch (e: any) {
                    this.logger.log(`Erro ao gerar QR Code: ${e.message}`, "onQR");
                }
            }

            if (connection === "open") {
                this.ready = true;
                this.connecting = false;
                this.qrCode = null;
                this.reconnectAttempts = 0;
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                this.logger.log("WhatsApp conectado", "onREADY");
            }

            if (connection === "close") {
                this.ready = false;
                this.qrCode = null;
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                this.lastDisconnectTime = Date.now();
                this.lastDisconnectReason = String(statusCode ?? "unknown");

                const reasonLabel = DISCONNECT_REASON_LABELS[statusCode] ?? "desconhecido";
                this.logger.log(
                    `Conexão fechada. Código: ${statusCode ?? "?"} (${reasonLabel})`,
                    "onDISCONNECTED",
                );

                const isPermanent = PERMANENT_DISCONNECT_CODES.includes(statusCode);

                if (isPermanent) {
                    this.logger.log(
                        `Falha permanente (${statusCode}), destruindo sem reconnect`,
                        "onDISCONNECTED",
                    );
                    await safeDestroyClient(this, true);
                } else {
                    await scheduleReconnect(this, this.lastDisconnectReason);
                }
            }
        });
    }

    async sendMessage(number: string, message: string, customName?: string): Promise<MessageData> {
        if (!this.ready || !this.sock) {
            throw new Error(`Sessão ${this.name} não está pronta`);
        }

        const { jid, originalNumber } = await this._validateNumber(number);

        const sent = await this.sock.sendMessage(jid, { text: message });

        // Aguarda ACK do servidor WhatsApp (status >= 2 = servidor recebeu)
        // Necessário pois sendMessage() resolve quando a mensagem é enfileirada localmente,
        // não quando o servidor confirma. Crítico em sessões novas (PreKey exchange).
        if (sent?.key) {
            await new Promise<void>((resolve, reject) => {
                const cleanup = (err?: Error) => {
                    clearTimeout(timeout);
                    this.sock?.ev.off("messages.update", handler);
                    err ? reject(err) : resolve();
                };
                const timeout = setTimeout(() => cleanup(new Error("Timeout aguardando ACK do servidor")), 15_000);
                const handler = (updates: any[]) => {
                    for (const u of updates) {
                        if (u.key?.id === sent.key.id && (u.update?.status ?? 0) >= 2) {
                            cleanup();
                            return;
                        }
                    }
                };
                this.sock!.ev.on("messages.update", handler);
            });
        }

        this.logger.log(`Mensagem enviada para ${jid}`);

        const existing = this.trackingContacts.findIndex((c) => c.number === jid);
        if (existing === -1) {
            this.trackingContacts.push({
                pushname: "Desconhecido",
                chatName: jid,
                number: jid,
                ...(customName ? { customName } : {}),
            });
        } else if (customName) {
            this.trackingContacts[existing].customName = customName;
        }

        return {
            companySlug: this.name,
            number,
            originalNumber,
            chatId: jid,
            content: message,
            timestamp: new Date().toISOString(),
        };
    }

    private async _validateNumber(
        number: string,
    ): Promise<{ jid: string; originalNumber: string }> {
        let clean = number.replace(/\D/g, "");

        if (!clean.startsWith("55")) {
            if (clean.length >= 10) {
                clean = "55" + clean;
            }
        }

        const variations = [clean];

        // Variação com/sem 9º dígito (Brasil)
        if (clean.length === 13 && clean.charAt(4) === "9") {
            variations.push(clean.substring(0, 4) + clean.substring(5));
        } else if (clean.length === 12 && clean.charAt(4) !== "9") {
            variations.push(clean.substring(0, 4) + "9" + clean.substring(4));
        }

        for (const variation of variations) {
            try {
                const [result] = await this.sock!.onWhatsApp(variation);
                if (result?.exists) {
                    return { jid: result.jid, originalNumber: variation };
                }
            } catch (e: any) {
                this.logger.log(`onWhatsApp falhou para ${variation}: ${e.message}`);
            }
        }

        // Fallback: usa número sem confirmação da API
        const fallback = `${clean}@s.whatsapp.net`;
        this.logger.log(`Usando fallback sem confirmação: ${fallback}`);
        return { jid: fallback, originalNumber: clean };
    }

    toJSON() {
        return {
            name: this.name,
            qrCode: this.qrCode,
            ready: this.ready,
            connecting: this.connecting,
            destroying: this.destroying,
            reconnectAttempts: this.reconnectAttempts,
            lastDisconnectTime: this.lastDisconnectTime,
            lastDisconnectReason: this.lastDisconnectReason,
            hasAi: false,
            trackingContacts: this.trackingContacts,
            isPuppeteerOpen: false,
            clientInfo: this.sock?.user
                ? { wid: this.sock.user.id, pushname: this.sock.user.name ?? "" }
                : null,
        };
    }

    getInfo(): string | null {
        return this.sock?.user?.id ?? null;
    }

    getState(): string {
        return this.ready ? "CONNECTED" : "DISCONNECTED";
    }

    getChatsLength(): null {
        return null;
    }
}
