import { execSync } from "child_process";
import { Client, LocalAuth } from "whatsapp-web.js";
import { sessions } from "./sessions";
import {
    onQr,
    onAuthenticated,
    onReady,
    onDisconnected,
    onAuthFailure,
    onChangeState,
    onError,
    onChangeBattery,
    onMessage,
} from "./handlers";

export async function createSession(companySlug: string): Promise<void> {
    try {
        const sessionDir = `session-${companySlug}`;
        const orphanPids = execSync(`pgrep -f "${sessionDir}" || true`, {
            timeout: 5000,
        })
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

    sessions[companySlug] = {
        client,
        qrCode: null,
        ready: false,
        connecting: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        lastDisconnectTime: null,
        lastDisconnectReason: null,
        destroying: false,
    };

    client.on("qr", onQr(companySlug));
    client.on("authenticated", onAuthenticated(companySlug));
    client.on("ready", onReady(companySlug, client));
    client.on("disconnected", onDisconnected(companySlug));
    client.on("auth_failure", onAuthFailure(companySlug));
    client.on("change_state", onChangeState(companySlug));
    client.on("error", onError(companySlug));
    client.on("change_battery", onChangeBattery(companySlug));
    client.on("message", onMessage(companySlug, client));

    sessions[companySlug].connecting = true;
    await client.initialize();
}
