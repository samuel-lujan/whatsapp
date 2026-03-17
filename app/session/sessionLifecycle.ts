import { Session } from "./session";
import { sessions, RECONNECT_CONFIG } from ".";
import { raceWithTimeout } from "../utils";
import { killOrphanChromeProcesses } from "./utils";

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
                    console.log(`[DESTROY] ${companySlug}: forçando kill no Chrome PID ${browserProcess.pid}`);
                    browserProcess.kill("SIGKILL");
                }
            } else {
                console.log(`[DESTROY] ${companySlug}: pupBrowser null, buscando processos Chrome órfãos...`);
                killOrphanChromeProcesses(companySlug, "DESTROY");
            }
        } catch (killErr) {
            console.log(`[DESTROY] ${companySlug}: force-kill falhou: ${(killErr as Error).message}`);
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
        console.log(`[RECONNECT] ${companySlug}: max tentativas (${RECONNECT_CONFIG.maxAttempts}) atingido, desistindo`);
        await safeDestroyClient(companySlug);
        return;
    }

    const attempt_delay = RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt);
    const delay = Math.min(attempt_delay, RECONNECT_CONFIG.maxDelayMs);
    console.log(`[RECONNECT] ${companySlug}: tentativa ${attempt + 1}/${RECONNECT_CONFIG.maxAttempts} em ${delay / 1000}s (motivo: ${reason})`);

    session.reconnectTimer = setTimeout(async () => {
        try {
            await safeDestroyClient(companySlug);

            console.log(`[RECONNECT] ${companySlug}: criando sessao nova...`);
            await createSession(companySlug);

            await new Promise<void>((resolve) => setTimeout(resolve, 15000));

            if (sessions[companySlug]?.ready) {
                console.log(`[RECONNECT] ${companySlug}: reconectou com sucesso!`);
                sessions[companySlug].reconnectAttempts = 0;
            } else if (sessions[companySlug]) {
                sessions[companySlug].reconnectAttempts = attempt + 1;
                await scheduleReconnect(companySlug, reason);
            }
        } catch (err) {
            console.log(`[RECONNECT] ${companySlug}: tentativa falhou: ${(err as Error).message}`);
            if (sessions[companySlug]) {
                sessions[companySlug].reconnectAttempts = attempt + 1;
                await scheduleReconnect(companySlug, reason);
            }
        }
    }, delay);
}

export async function createSession(companySlug: string, hasAi: boolean = false): Promise<void> {
    killOrphanChromeProcesses(companySlug, "CREATE");
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));

    const isProduction = process.env.NODE_ENV === "production";
    const isHeadless = isProduction || process.env.HEADLESS === "true";

    console.log(`🖥️ Ambiente: ${isProduction ? "PRODUÇÃO" : "DESENVOLVIMENTO"}`);
    console.log(`🌐 Browser: ${isHeadless ? "HEADLESS (sem interface)" : "COM INTERFACE"}`);

    const session = new Session(companySlug, isHeadless, hasAi);
    sessions[companySlug] = session;
    await session.initialize();
}
