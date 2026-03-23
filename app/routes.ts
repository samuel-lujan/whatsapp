import { Router, Request, Response, NextFunction } from "express";
import Rollbar from "rollbar";
import { createSessionController, deleteSessionController, getSessionController, listSessionsController, loadAllSessionsController } from "./session-v2/controller";
import { Logger } from "./session-v2/logging";

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

export function createRouterV2(rollbar: Rollbar, logger: Logger): Router {
    const router = Router();

    router.get("/v2/session/:company", authenticateToken, getSessionController);
    router.post("/v2/session/:company", authenticateToken, (req, res) => 
        createSessionController(req, res, false));
    router.post("/v2/ai/session/:company", authenticateToken, (req, res) => 
        createSessionController(req, res, true));
    router.delete("/v2/session/:company", authenticateToken, deleteSessionController);
    router.get("/v2/sessions/", authenticateToken, listSessionsController);
    router.get("/v2/sessions/load", authenticateToken, loadAllSessionsController);

    logger.jumpLineLog("Rotas disponíveis:");
    logger.log("    GET   /v2/session/:company - obter sessão");
    logger.log("    POST  /v2/session/:company - criar sessão");
    logger.log("    POST  /v2/ai/session/:company - criar sessão atrelada à IA");
    logger.log("    DELETE /v2/session/:company - deletar sessão");
    logger.log("    GET /v2/sessions/ - listar sessões");
    logger.log("    GET /v2/sessions/load - carregar todas as sessões");

    return router;
}
