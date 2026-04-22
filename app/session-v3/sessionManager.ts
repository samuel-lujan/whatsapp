import path from "path";
import fs from "fs";
import { Session } from "./session";
import { HealthResult } from "../types";
import { server } from "../logging";
import { BAILEYS_AUTH_DIR } from "./constants";

class SessionManager {
    static instance: SessionManager;
    private sessions: Record<string, Session> = {};
    private pendingSessions: Record<string, Promise<Session>> = {};

    constructor() {
        if (SessionManager.instance) {
            return SessionManager.instance;
        }
        SessionManager.instance = this;
    }

    async setup(): Promise<void> {
        const activeSessions = await this.listClientFolders();
        server.log(
            `[v3] Sessões encontradas: ${activeSessions.length > 0 ? activeSessions.join(", ") : "Nenhuma"}`,
        );

        const valid = activeSessions.filter((name): name is string => Boolean(name));
        for (const name of valid) {
            await this.loadSession(name);
            await new Promise((resolve) => setTimeout(resolve, 8000));
        }
    }

    async loadSession(name: string): Promise<void> {
        const existing = this.sessions[name];
        if (existing?.ready) {
            server.log(`[v3] Sessão ${name} já está pronta, ignorando`);
            return;
        }

        server.log(`[v3] Restaurando sessão ${name}`);
        const session = new Session(name);
        this.sessions[name] = session;

        try {
            await session.initialize();
        } catch (error) {
            delete this.sessions[name];
            throw error;
        }
    }

    getSession(name: string): Session | null {
        const session = this.sessions[name];
        if (!session) {
            server.log(`[v3] Sessão não encontrada: ${name}`);
            return null;
        }
        return session;
    }

    async createSession(name: string): Promise<Session> {
        const existing = this.sessions[name];
        if (existing) {
            existing.logger.log(`Sessão já existe, reutilizando`, "CREATE");
            return existing;
        }

        const pending = this.pendingSessions[name];
        if (pending) {
            server.log(`[v3] Criação de ${name} já em andamento, aguardando`);
            return pending;
        }

        const createPromise = (async () => {
            const session = new Session(name);
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
        await Promise.all(Object.keys(this.sessions).map((name) => this.removeSession(name)));
    }

    keys(): string[] {
        return Object.keys(this.sessions);
    }

    async listSessions(): Promise<string[]> {
        return Object.keys(this.sessions);
    }

    async listClientFolders(): Promise<string[]> {
        const authPath = path.resolve(process.cwd(), BAILEYS_AUTH_DIR);
        await fs.promises.mkdir(authPath, { recursive: true });
        const entries = await fs.promises.readdir(authPath, { withFileTypes: true });
        return entries
            .filter((e) => e.isDirectory() && e.name.startsWith("session-"))
            .map((e) => e.name.replace("session-", ""));
    }

    async verifySessionHealth(companySlug: string): Promise<HealthResult> {
        const session = this.sessions[companySlug];

        if (!session) {
            return { healthy: false, shouldReconnect: false, reason: "Sessão não existe" };
        }

        if (session.ready && session.sock?.user) {
            return { healthy: true, state: "CONNECTED", info: session.sock.user.id };
        }

        if (session.connecting) {
            return { healthy: false, shouldReconnect: false, reason: "Conectando..." };
        }

        return {
            healthy: false,
            shouldReconnect: true,
            reason: `Estado desconhecido (ready=${session.ready})`,
        };
    }
}

export const sessionManager = new SessionManager();
