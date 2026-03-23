import dotenv from "dotenv";
dotenv.config();

import express from "express";
import Rollbar from "rollbar";
import { execSync } from "child_process";
import { createRouterV2 } from "./routes";
import { raceWithTimeout } from "./utils";
import { errorHandler } from "./session-v2/errorHandler";
import { clearAllSessions } from "./session-v2/service";
import { server } from "./logging";

const rollbar = new Rollbar({
    accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
    environment: process.env.NODE_ENV || "development",
    captureUncaught: true,
    captureUnhandledRejections: true,
    payload: {
        server: {
            root: __dirname,
        },
    },
});

const PORT = 8080;

const app = express();

app.use(express.json());
app.use(createRouterV2(rollbar));
app.use(errorHandler);

app.listen(PORT, () => {
    server.log(`Servidor multi-tenant WhatsApp rodando na porta ${PORT}`);
    server.jumpLineLog(`Pressione Ctrl+C para parar o servidor`);
});

// Graceful shutdown - limpa todas as sessoes/Chrome antes de sair
let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
    server.tag = "SHUTDOWN";
    if (isShuttingDown) return;
    isShuttingDown = true;

    server.jumpLineLog(`Recebido ${signal}, limpando todas as sessoes...`);

    try {
        await raceWithTimeout(clearAllSessions(), 30000, "shutdown timeout");
        server.log(`Sessoes limpas com sucesso`);
    } catch (err: any) {
        server.log(`Erro/timeout na limpeza: ${err.message}`);
    }

    // Ultimo recurso: mata processos Chrome orfaos
    try {
        execSync('pkill -f "chromium.*--no-sandbox" || true', { timeout: 5000 });
    } catch (e) {
        // pkill retorna non-zero se nenhum processo encontrado
    }

    server.log(`Saindo.`);
    process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
    server.log(`Excecao nao capturada: ${err.message}`, "FATAL");
    rollbar.error(err);
    gracefulShutdown("uncaughtException");
});
