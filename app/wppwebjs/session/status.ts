import { execSync } from "child_process";
import type { WAState } from "whatsapp-web.js";
import { Client, LocalAuth } from "whatsapp-web.js";
import type { ConnectionStatus, StatusResult } from "../interfaces";
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
    waitForQrCode,
    safeDestroyClient,
} from "./handlers";
import { sessions } from ".";
import { raceWithTimeout } from "../../utils";

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
                markSessionAsReady(companySlug);
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
                        markSessionAsReady(companySlug);
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
            return {
                connected: false,
                qrCode: qrCode,
                status: "connecting",
            };
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
        `📱 Retornando status para ${companySlug} - QR Code: ${
            qrCode ? "Disponível" : "Não disponível"
        }`,
    );
    console.log(`🔍 Estado da sessão ${companySlug}:`, {
        exists: !!session,
        ready: session?.ready ?? false,
        connecting: session?.connecting ?? false,
        hasQrCode: !!qrCode,
    });

    return {
        connected: false,
        qrCode: qrCode,
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
        console.log(`🔍 Verificação rápida: Cliente ${companySlug} existe mas não está marcado como ready`);
        try {
            if (session.client.pupPage && !session.client.pupPage.isClosed()) {
                console.log(`🤔 Cliente ${companySlug} pode estar conectado - recomendado verificação completa`);
                return { connected: false, status: "needs_verification", suggestion: "Use /status para verificação completa" };
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

function markSessionAsReady(companySlug: string) {
    const session = sessions[companySlug];
    if (session) {
        session.ready = true;
        session.connecting = false;
        session.qrCode = null;
    }
}

