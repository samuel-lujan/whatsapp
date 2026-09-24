// Precisa ser o PRIMEIRO import: o tsx sobe todos os imports antes do corpo do arquivo, então um
// `dotenv.config()` chamado depois deles rodaria tarde demais para módulos que leem process.env
// no import (ex: logging.ts com o token do Rollbar).
import "dotenv/config";

import http from "node:http";
import express from "express";
import { createRouterV2, createRouterV3 } from "./routes";
import { errorHandler } from "./session-v2/errorHandler";
import { server } from "./logging";
import { gracefulShutdown } from "./utils";
import { initSocketServer } from "./socket";

const PORT = Number(process.env.PORT) || 8080;

const app = express();

app.use(express.json());
app.use(createRouterV2());
app.use(createRouterV3());
app.use(errorHandler);

const httpServer = http.createServer(app);
initSocketServer(httpServer);

httpServer.listen(PORT, () => {
    server.log(`Servidor multi-tenant WhatsApp rodando na porta ${PORT}`);
    server.jumpLineLog(`Pressione Ctrl+C para parar o servidor`);
});

// Graceful shutdown - limpa todas as sessoes/Chrome antes de sair
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
    server.log(`Excecao nao capturada: ${err.message}`, "FATAL");
    server.error(err.message, "FATAL", "", err);
    gracefulShutdown("uncaughtException");
});
