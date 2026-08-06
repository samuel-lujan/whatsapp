import dotenv from "dotenv";
dotenv.config();

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
let isShuttingDown = false;
process.on("SIGINT", () => gracefulShutdown("SIGINT", isShuttingDown));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM", isShuttingDown));

process.on("uncaughtException", (err) => {
    server.log(`Excecao nao capturada: ${err.message}`, "FATAL");
    server.error(err.message, "FATAL", "", err);
    gracefulShutdown("uncaughtException", isShuttingDown);
});
