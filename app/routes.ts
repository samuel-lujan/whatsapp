import { Router, Request, Response, NextFunction } from "express";
import Rollbar from "rollbar";
import { createSessionController, deleteSessionController, getSessionController, listSessionsController, loadAllSessionsController, sendMessageController } from "./session-v2/controller";
import { createSessionController as createSessionControllerV3, deleteSessionController as deleteSessionControllerV3, getSessionController as getSessionControllerV3, listSessionsController as listSessionsControllerV3, loadAllSessionsController as loadAllSessionsControllerV3, sendMessageController as sendMessageControllerV3 } from "./session-v3/controller";
import { server } from "./logging";

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


    server.jumpLineLog("Rotas disponíveis:");
    server.log("    GET   /v2/session/:company - obter sessão");
    server.log("    POST  /v2/session/:company - criar sessão");
    server.log("    POST  /v2/ai/session/:company - criar sessão atrelada à IA");
    server.log("    POST /v2/session/:company/message - enviar mensagem");
    server.log("    DELETE /v2/session/:company - deletar sessão");
    server.log("    GET /v2/sessions/ - listar sessões");
    server.log("    GET /v2/sessions/load - carregar todas as sessões");
    return router;
}

export function createRouterV3(_rollbar: Rollbar): Router {
    const router = Router();

    router.get("/v3/session/:company", authenticateToken, getSessionControllerV3);
    router.post("/v3/session/:company", authenticateToken, createSessionControllerV3);
    router.post("/v3/session/:company/message", authenticateToken, sendMessageControllerV3);
    router.delete("/v3/session/:company", authenticateToken, deleteSessionControllerV3);
    router.get("/v3/sessions/", authenticateToken, listSessionsControllerV3);
    router.get("/v3/sessions/load", authenticateToken, loadAllSessionsControllerV3);

    server.jumpLineLog("Rotas v3 (Baileys) disponíveis:");
    server.log("    GET    /v3/session/:company");
    server.log("    POST   /v3/session/:company");
    server.log("    POST   /v3/session/:company/message");
    server.log("    DELETE /v3/session/:company");
    server.log("    GET    /v3/sessions/");
    server.log("    GET    /v3/sessions/load");
    return router;
}
