import { Router, Request, Response, NextFunction } from "express";
import Rollbar from "rollbar";
import { createWhatsappController } from "./controller";

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

export function createRouter(rollbar: Rollbar): Router {
    const router = Router();
    const ctrl = createWhatsappController(rollbar);

    router.get("/status/:companySlug", authenticateToken, ctrl.getStatus);
    router.post("/send-message/:companySlug", authenticateToken, ctrl.sendMessage);
    router.get("/companies", authenticateToken, ctrl.listCompanies);
    router.get("/debug/:companySlug", authenticateToken, ctrl.debugSession);
    router.get("/health/:companySlug", authenticateToken, ctrl.checkHealth);
    router.get("/search-number/:companySlug/:number", authenticateToken, ctrl.searchNumber);
    router.delete("/clear/:companySlug", authenticateToken, ctrl.clearSession);
    router.delete("/clear-all", authenticateToken, ctrl.clearAll);
    router.delete("/delete-all", authenticateToken, ctrl.deleteAll);

    return router;
}
