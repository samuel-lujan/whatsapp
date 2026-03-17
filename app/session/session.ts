import { Client, LocalAuth } from "whatsapp-web.js";
import { onQr, onAuthenticated, onReady, onDisconnected, onAuthFailure, onChangeState, onError, onChangeBattery, onMessage } from "./clientHandlers";

export class Session {
    client: Client;
    companySlug: string;
    qrCode: string | null = null;
    ready: boolean = false;
    connecting: boolean = false;
    destroying: boolean = false;
    reconnectAttempts: number = 0;
    reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    lastDisconnectTime: number | null = null;
    lastDisconnectReason: string | null = null;
    lastBatteryUpdate?: number;

    constructor(companySlug: string, isHeadless: boolean, hasAi: boolean) {
        this.companySlug = companySlug;

        const client = new Client({
            authStrategy: new LocalAuth({ clientId: companySlug }),
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
    
        client.on("qr", onQr(this));
        client.on("authenticated", onAuthenticated(companySlug));
        client.on("ready", onReady(this));
        client.on("disconnected", onDisconnected(this));
        client.on("auth_failure", onAuthFailure(companySlug));
        client.on("change_state", onChangeState(this));
        client.on("error", onError(this));
        client.on("change_battery", onChangeBattery(this));
        if(hasAi){
            client.on("message", onMessage(this.companySlug, client));
        }

        this.client = client;
  }

    async initialize(): Promise<void> {
        this.connecting = true;
        await this.client.initialize();
    }

    markAsReady(): void {
        this.ready = true;
        this.connecting = false;
        this.qrCode = null;
    }
}
