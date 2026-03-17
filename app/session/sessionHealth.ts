import type { WAState } from "whatsapp-web.js";
import type { HealthResult } from "../types";
import { sessions } from ".";
import { raceWithTimeout } from "../utils";
import { safeDestroyClient, scheduleReconnect } from "./sessionLifecycle";

export async function verifyClientHealth(companySlug: string): Promise<HealthResult> {
    const session = sessions[companySlug];
    if (!session || !session.client) {
        return { healthy: false, reason: "Sessão não existe" };
    }

    const client = session.client;

    try {
        if (client.pupPage) {
            try {
                const isClosed = client.pupPage.isClosed();
                if (isClosed) {
                    console.log(`❌ Cliente ${companySlug} - página do browser está fechada`);
                    return { healthy: false, reason: "Página do browser fechada", shouldReconnect: true };
                }
            } catch (e) {
                console.log(`⚠️ Erro ao verificar página do browser para ${companySlug}:`, (e as Error).message);
            }
        }

        let state: WAState | null = null;
        try {
            state = (await raceWithTimeout(client.getState(), 5000, "timeout-state")) as WAState | null;
            console.log(`📊 Estado do cliente ${companySlug}: ${state}`);
        } catch (e) {
            console.log(`⚠️ Timeout ao obter estado do cliente ${companySlug}, tentando verificação alternativa...`);
        }

        if (state === "CONNECTED") {
            console.log(`✅ Cliente ${companySlug} está CONNECTED`);
            return { healthy: true, state, info: "N/A" };
        }

        const disconnectedStates = ["CONFLICT", "UNPAIRED", "UNLAUNCHED", "PROXYBLOCK", "TOS_BLOCK", "SMB_TOS_BLOCK"];
        if (state && disconnectedStates.includes(state as string)) {
            console.log(`❌ Cliente ${companySlug} está em estado de desconexão: ${state}`);
            return { healthy: false, reason: `Estado de desconexão: ${state}`, shouldReconnect: true };
        }

        console.log(`🔍 Estado ambíguo (${state}), tentando verificação prática para ${companySlug}...`);

        try {
            const info = await raceWithTimeout(Promise.resolve(client.info), 3000, "timeout-info");
            if (info && info.wid) {
                console.log(`✅ Cliente ${companySlug} tem info válida: ${info.wid._serialized}`);
                return { healthy: true, state: state ?? "ASSUMED_CONNECTED", info: info.wid._serialized };
            }
        } catch (e) {
            console.log(`⚠️ Não conseguiu obter info do cliente ${companySlug}: ${(e as Error).message}`);
        }

        try {
            console.log(`🔍 Tentativa final: listando chats para ${companySlug}...`);
            const chats = await raceWithTimeout(client.getChats(), 5000, "timeout-chats");
            if (chats && Array.isArray(chats)) {
                console.log(`✅ Cliente ${companySlug} conseguiu listar ${chats.length} chats - está funcional`);
                return { healthy: true, state: state ?? "FUNCTIONAL", info: `${chats.length} chats` };
            }
        } catch (e) {
            console.log(`❌ Cliente ${companySlug} não conseguiu listar chats: ${(e as Error).message}`);
        }

        console.log(`❌ Cliente ${companySlug} falhou em todas as verificações de saúde`);
        return {
            healthy: false,
            reason: `Estado: ${state ?? "desconhecido"} - falhou nas verificações práticas`,
            shouldReconnect: true,
        };
    } catch (error) {
        console.log(`❌ Cliente ${companySlug} falhou na verificação de saúde:`, (error as Error).message);
        return { healthy: false, reason: (error as Error).message, shouldReconnect: true };
    }
}

export async function zombieSessionMonitor(): Promise<void> {
    const slugs = Object.keys(sessions);
    if (slugs.length === 0) return;

    console.log(`[HEALTH] Verificando ${slugs.length} sessoes...`);

    for (const slug of slugs) {
        const session = sessions[slug];
        if (!session || !session.client) continue;
        if (session.connecting || session.destroying) continue;
        if (session.reconnectTimer) continue;

        try {
            const client = session.client;

            if (!client.pupPage || client.pupPage.isClosed()) {
                console.log(`[HEALTH] ${slug}: browser page fechada, limpando`);
                await safeDestroyClient(slug);
                continue;
            }

            if (client.pupBrowser) {
                const proc = client.pupBrowser.process();
                if (proc && proc.killed) {
                    console.log(`[HEALTH] ${slug}: processo Chrome morto, limpando`);
                    await safeDestroyClient(slug);
                    continue;
                }
            }

            if (session.ready) {
                try {
                    await raceWithTimeout(client.getState(), 8000, "health-check-timeout");
                } catch (e) {
                    console.log(`[HEALTH] ${slug}: ready mas sem resposta (${(e as Error).message}), agendando reconnect`);
                    session.ready = false;
                    session.lastDisconnectTime = Date.now();
                    session.lastDisconnectReason = "health-check-failed";
                    await scheduleReconnect(slug, "health-check-failed");
                }
            }

            if (!session.ready && session.lastDisconnectTime) {
                const stuckDuration = Date.now() - session.lastDisconnectTime;
                if (stuckDuration > 600000) {
                    console.log(`[HEALTH] ${slug}: desconectada ha ${Math.round(stuckDuration / 60000)}min, destruindo`);
                    await safeDestroyClient(slug);
                }
            }
        } catch (err) {
            console.log(`[HEALTH] ${slug}: erro durante verificacao: ${(err as Error).message}`);
        }
    }
}
