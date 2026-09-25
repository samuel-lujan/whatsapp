import path from "path";
import fs from "fs";
import { Session } from "./session";
import { DISCONNECTED_STATES } from "./constants";
import { info } from "console";
import { HealthResult } from "../types";
import { raceWithTimeout } from "../utils";
import { server } from "../logging";

class SessionManager {
    static instace;
    private sessions: Record<string, Session> = {};
    private pendingSessions: Record<string, Promise<Session>> = {};

    constructor() {
        if (SessionManager.instace) {
            return SessionManager.instace;
        }
        SessionManager.instace = this;
    }

    async setup() {
        console.log(`SessionManager initialized`);
        const activeSessions = await this.listClientFolders();
        server.log(`Sessões ativas encontradas: ${activeSessions.length > 0 ? activeSessions.join(", ") : "Nenhuma"}`);
        const isProduction = process.env.NODE_ENV === "production";
        const isHeadless = isProduction || process.env.HEADLESS === "true";

        await Promise.all(
            activeSessions
                .filter((name): name is string => Boolean(name))
                .map((name) => this.loadSession(name, isHeadless)),
        );
    }

    async loadSession(name: string, isHeadless: boolean = false): Promise<void> {
        const existingSession = this.sessions[name];
        if (existingSession) {
            const isPuppeteerOpen = await existingSession.checkPupPage();

            if (existingSession.ready && isPuppeteerOpen) {
                server.log(`Sessão ${name} já está carregada com o Puppeteer ativo, ignorando restauração duplicada`);
                return;
            }

            existingSession.logger.log(`⚠️ Sessão em memória, mas com Puppeteer fechado. Recriando...`, "LOAD");
        }

        server.log(`Restaurando sessão ${name}`);
        const session = new Session(name, isHeadless, false);
        this.sessions[name] = session;
        server.log(`Sessões atuais: ${Object.keys(this.sessions)}`);

        try {
            await session.initialize();
            session.ready = true;
            session.logger.log(`Sessão ${name} restaurada e pronta para uso`);
        } catch (error) {
            throw error;
        }
    };

    getSession(name: string): Session | null {
        const session = this.sessions[name];
        if (!session) {
            server.log(`Error fetching metadata for missing session ${name} - ${Object.keys(this.sessions)}`);
            return null;
        }
        return session;
    }

    async createSession(name: string, isHeadless: boolean, hasAi: boolean): Promise<Session> {
        const existingSession = this.sessions[name];
        if (existingSession) {
            existingSession.logger.log(`Sessão já existe em memória, reutilizando instância`, "CREATE");
            return existingSession;
        }

        const pendingSession = this.pendingSessions[name];
        if (pendingSession) {
            server.log(`Criação da sessão ${name} já está em andamento, aguardando a instância existente`);
            return pendingSession;
        }

        const createPromise = (async () => {
            const session = new Session(name, isHeadless, hasAi);
            this.sessions[name] = session;

            try {
                await session.initialize();
                return session;
            } catch (error) {
                delete this.sessions[name];
                throw error;
            }
        })();

        this.pendingSessions[name] = createPromise;

        try {
            return await createPromise;
        } finally {
            delete this.pendingSessions[name];
        }
    }

    async removeSession(name: string): Promise<void> {
        delete this.sessions[name];
    }

    async clearAllSessions(): Promise<void> {
        const sessionNames = Object.keys(this.sessions);
        const promises = sessionNames.map(async (name) => {
            await this.removeSession(name);
        });
        await Promise.all(promises);
    }

    keys (): string[] {
        return Object.keys(this.sessions);
    }

    async listSessions(): Promise<string[]> {
        return Object.keys(this.sessions);
    }

    async listClientFolders(): Promise<string[]> {
        const authPath = path.resolve(__dirname, '..', '..', '.wwebjs_auth');
        const entries = await fs.promises.readdir(authPath, { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => {
            if (e.name.includes("session-")) {
                return e.name.replace("session-", "");
            }
        });
    }

    async verifySessionHealth(companySlug: string) {
        let response: HealthResult = { healthy: false, shouldReconnect: false };
        if (!this.sessions[companySlug]?.client) {
            response.reason = "Sessão não existe";
        } else {
            const session = this.sessions[companySlug];

            try {
                // Primeiro verifica se a página do puppeteer ainda está ativa
                const isPuppeteerOpen = await session.checkPupPage();
                if (!isPuppeteerOpen) {
                    response.reason = "Página do browser fechada";
                    response.shouldReconnect = true;
                    return response;
                }

                // Tenta obter o estado do cliente
                const state = await session.getState();

                // Se o estado é CONNECTED, está saudável
                if (state === 'CONNECTED') {
                    console.log(`✅ Cliente ${companySlug} está CONNECTED`);
                    response.healthy = true;
                    response.state = state;
                } else if (DISCONNECTED_STATES.includes(state)) {
                    // Se o estado é explicitamente desconectado, não está saudável
                    console.log(`❌ Cliente ${companySlug} está em estado de desconexão: ${state}`);
                    response.reason = `Estado de desconexão: ${state}`;
                    response.shouldReconnect = true;
                }

                // Para outros estados (null, undefined, OPENING, PAIRING, etc.),
                // tenta uma verificação prática: obter info do cliente
                session.logger.log(`🔍 Estado ambíguo (${state}), tentando verificação prática...`);
                const infoSerialized = await session.getInfo();

                if (infoSerialized) {
                    session.logger.log(`✅ Cliente ${session.name} tem info válida: ${infoSerialized}`);
                    response.healthy = true;
                    response.state = state || 'ASSUMED_CONNECTED';
                    response.info = infoSerialized;
                }


                // Última tentativa: verificar se consegue listar chats (operação leve)
                const chatsLength = await session.getChatsLength();
                if (typeof chatsLength === 'number') {
                    session.logger.log(`✅ Foi possível listar ${chatsLength} chats - está funcional`);
                    response.healthy = true;
                    response.state = state || 'FUNCTIONAL';
                    response.info = `${chatsLength} chats`;
                }

                // Se chegou aqui, não está saudável
                session.logger.log(`❌ Falha em todas as verificações de saúde`);
                response.reason = `Estado: ${state || 'desconhecido'} - falhou nas verificações práticas`;
                response.shouldReconnect = true;
            } catch (error) {
                session.logger.log(`❌ Falha na verificação de saúde: ${error.message}`);
                response.reason = `Erro na verificação: ${error.message}`;
                response.shouldReconnect = true;
            }
        }
        return response;
    }
}

export const sessionManager = new SessionManager();
