import { Router, Request, Response, NextFunction } from "express";
import Rollbar from "rollbar";
import { createSessionController, deleteSessionController, getSessionController, listSessionsController, loadAllSessionsController, sendMessageController } from "./session-v2/controller";
import { server } from "./logging";
import { getAllChatsController, getChatController, getTrackedChatsController, getMessagesController } from "./wppwebjs/chatController";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "sua-chave-secreta-aqui";

function authenticateToken(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

    if (!token) {
        res.status(401).json({
            error: "Token de acesso requerido",
            message: "Inclua o token no header: Authorization: Bearer SEU_TOKEN",
        });
        return;
    }

    if (token !== AUTH_TOKEN) {
        res.status(403).json({
            error: "Token inválido",
            message: "O token fornecido não é válido",
        });
        return;
    }

    next();
}

export function createRouterV2(rollbar: Rollbar): Router {
    const router = Router();

    router.get("/v2/session/:company", authenticateToken, getSessionController);
    router.post("/v2/session/:company", authenticateToken, (req, res) => 
        createSessionController(req, res, false));
    router.post("/v2/ai/session/:company", authenticateToken, (req, res) => 
        createSessionController(req, res, true));
    router.post("/v2/session/:company/message", authenticateToken, sendMessageController);
    router.delete("/v2/session/:company", authenticateToken, deleteSessionController);
    router.get("/v2/sessions/", authenticateToken, listSessionsController);
    router.get("/v2/sessions/load", authenticateToken, loadAllSessionsController);
    router.get("/v2/session/:company/chats/all", authenticateToken, getAllChatsController);
    router.get("/v2/session/:company/chats/tracked", authenticateToken, getTrackedChatsController);
    router.get("/v2/session/:company/chats/:chatId", authenticateToken, getChatController);
    router.get("/v2/session/:company/messages/:chatId", authenticateToken, getMessagesController);


    server.jumpLineLog("Rotas disponíveis:");
    server.log("    GET   /v2/session/:company - obter sessão");
    server.log("    POST  /v2/session/:company - criar sessão");
    server.log("    POST  /v2/ai/session/:company - criar sessão atrelada à IA");
    server.log("    POST /v2/session/:company/message - enviar mensagem");
    server.log("    DELETE /v2/session/:company - deletar sessão");
    server.log("    GET /v2/sessions/ - listar sessões");
    server.log("    GET /v2/sessions/load - carregar todas as sessões");
    server.log("    GET /v2/session/:company/chats/all - obter chats da sessão");
    server.log("    GET /v2/session/:company/chats/tracked - obter chats da sessão");
    server.log("    GET /v2/session/:company/chats/:chatId - obter chat específico da sessão");
    server.log("    GET /v2/session/:company/messages/:chatId - obter mensagens de um chat específico");
    return router;
}
