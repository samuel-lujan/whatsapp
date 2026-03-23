import path from "path";
import fs from "fs";
import { Session } from "./session";

class SessionManager {
    static instace;
    private sessions: Record<string, Session> = {};

    constructor() {
        if (SessionManager.instace) {
            return SessionManager.instace;
        }
        SessionManager.instace = this;
    }

    async setup() {
        console.log(`SessionManager initialized`);
        const activeSessions = await this.listClientFolders();
        const isProduction = process.env.NODE_ENV === "production";
        const isHeadless = isProduction || process.env.HEADLESS === "true";
        for (const name of activeSessions) {
            return this.loadSession(name);
        }
    }

    async loadSession(name: string): Promise<Session | null> {
        console.log(`Restaurando sessão ${name}`);
        const session = new Session(name, false, false);
        this.sessions[name] = session;
        await session.initialize()
        return session;
    };

    getSession(name: string): Session | null {
        const session = this.sessions[name];
        if (!session) {
            console.error(`Error fetching metadata for missing session ${name}`);
            return null;
        }
        return session;
    }

    async createSession(name: string, isHeadless: boolean, hasAi: boolean): Promise<Session> {
        const session = new Session(name, isHeadless, hasAi);
        this.sessions[name] = session;
        await session.initialize();
        return session;
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
}

export const sessionManager = new SessionManager();
