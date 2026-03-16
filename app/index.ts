import dotenv from "dotenv";
dotenv.config();

import express from "express";
import Rollbar from "rollbar";
import { execSync } from "child_process";
import * as whatsapp from "./wppwebjs/whatsapp";
import { createRouter } from "./routes";
import { raceWithTimeout } from "./utils";

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
app.use(createRouter(rollbar));

app.listen(PORT, () => {
    console.log(`Servidor multi-tenant WhatsApp rodando na porta ${PORT}`);
    console.log(`\nRotas disponíveis:`);
    console.log(`GET  /status/:companySlug - Verificar status e obter QR Code`);
    console.log(`POST /send-message/:companySlug - Enviar mensagem`);
    console.log(`GET  /companies - Listar empresas conectadas`);
    console.log(`GET  /debug/:companySlug - Debug de sessão específica`);
    console.log(`GET  /health/:companySlug - Verificar saúde do cliente`);
    console.log(`GET  /search-number/:companySlug/:number - Buscar info de número`);
    console.log(`DELETE /clear/:companySlug - Limpar sessão e desconectar WhatsApp`);
    console.log(`DELETE /clear-all - Limpar TODAS as sessões e desconectar`);
    console.log(
        `DELETE /delete-all - DELETAR todas as empresas e sessões (inclui dados persistidos)`,
    );
    console.log(`\nPressione Ctrl+C para parar o servidor`);
});

// Graceful shutdown - limpa todas as sessoes/Chrome antes de sair
let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[SHUTDOWN] Recebido ${signal}, limpando todas as sessoes...`);

    try {
        await raceWithTimeout(whatsapp.clearAllSessions(), 30000, "shutdown timeout");
        console.log(`[SHUTDOWN] Sessoes limpas com sucesso`);
    } catch (err: any) {
        console.log(`[SHUTDOWN] Erro/timeout na limpeza: ${err.message}`);
    }

    // Ultimo recurso: mata processos Chrome orfaos
    try {
        execSync('pkill -f "chromium.*--no-sandbox" || true', { timeout: 5000 });
    } catch (e) {
        // pkill retorna non-zero se nenhum processo encontrado
    }

    console.log(`[SHUTDOWN] Saindo.`);
    process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
    console.error("[FATAL] Excecao nao capturada:", err.message);
    rollbar.error(err);
    gracefulShutdown("uncaughtException");
});
