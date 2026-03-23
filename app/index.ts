import dotenv from "dotenv";
dotenv.config();

import express from "express";
import Rollbar from "rollbar";
import { execSync } from "child_process";
import { createRouterV2 } from "./routes";
import { raceWithTimeout } from "./utils";
import { errorHandler } from "./session-v2/errorHandler";
import { Logger } from "./session-v2/logging";
import { clearAllSessions } from "./session-v2/service";

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

const logger = new Logger();

const PORT = 8080;

const app = express();

app.use(express.json());
app.use(createRouterV2(rollbar, logger));
app.use(errorHandler);

app.listen(PORT, () => {
    logger.log(`Servidor multi-tenant WhatsApp rodando na porta ${PORT}`);
    // console.log(`POST /send-message/:companySlug - Enviar mensagem`);
    // console.log(`GET  /companies - Listar empresas conectadas`);
    // console.log(`GET  /debug/:companySlug - Debug de sessão específica`);
    // console.log(`GET  /health/:companySlug - Verificar saúde do cliente`);
    // console.log(`GET  /search-number/:companySlug/:number - Buscar info de número`);
    // console.log(`DELETE /clear/:companySlug - Limpar sessão e desconectar WhatsApp`);
    // console.log(`DELETE /clear-all - Limpar TODAS as sessões e desconectar`);
    // console.log(
    //     `DELETE /delete-all - DELETAR todas as empresas e sessões (inclui dados persistidos)`,
    // );
    logger.jumpLineLog(`Pressione Ctrl+C para parar o servidor`);
});

// Graceful shutdown - limpa todas as sessoes/Chrome antes de sair
let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
    logger.tag = "SHUTDOWN";
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.jumpLineLog(`Recebido ${signal}, limpando todas as sessoes...`);

    try {
        await raceWithTimeout(clearAllSessions(), 30000, "shutdown timeout");
        logger.log(`Sessoes limpas com sucesso`);
    } catch (err: any) {
        logger.log(`Erro/timeout na limpeza: ${err.message}`);
    }

    // Ultimo recurso: mata processos Chrome orfaos
    try {
        execSync('pkill -f "chromium.*--no-sandbox" || true', { timeout: 5000 });
    } catch (e) {
        // pkill retorna non-zero se nenhum processo encontrado
    }

    logger.log(`Saindo.`);
    process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
    logger.tagLog("FATAL", `Excecao nao capturada: ${err.message}`);
    rollbar.error(err);
    gracefulShutdown("uncaughtException");
});
