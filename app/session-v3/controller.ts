import { Request, Response } from "express";
import {
    createSession,
    deleteSession,
    getSession,
    listSessions,
    loadAllSessions,
    sendMessageService,
} from "./service";
import { server } from "../logging";
import { returnError, returnSuccess } from "../utils";

export const getSessionController = (req: Request, res: Response) => {
    const { company } = req.params as { company: string };
    try {
        const session = getSession(company);
        if (!session) {
            return returnError(404, res, `Session with name ${company} not found`);
        }
        return returnSuccess(res, session);
    } catch (error) {
        return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
    }
};

export const createSessionController = async (req: Request, res: Response) => {
    const { company } = req.params as { company: string };
    try {
        const alreadyExists = getSession(company);
        server.log(
            alreadyExists
                ? `[v3] Sessão já existe: ${company}`
                : `[v3] Criando sessão: ${company}`,
        );

        if (alreadyExists) {
            return returnSuccess(res, alreadyExists, {
                message: `Sessão ${company} já estava ativa`,
            });
        }

        const session = await createSession(company);
        const response: Record<string, unknown> = {};

        if (session.ready) {
            response.connected = true;
        } else if (session.qrCode) {
            response.qrCode = session.qrCode;
            response.message = "Escaneie o QR Code com o WhatsApp para conectar";
        } else {
            response.message = "Aguardando geração do QR Code...";
        }

        return returnSuccess(res, session, { response });
    } catch (error) {
        return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
    }
};

export const deleteSessionController = async (req: Request, res: Response) => {
    const { company } = req.params as { company: string };
    const timestamp = new Date().toISOString();
    try {
        const session = getSession(company);
        if (!session) {
            return returnError(404, res, `Session with name ${company} not found`);
        }

        const result = await deleteSession(session);

        if (result.success) {
            return returnSuccess(res, { message: result.message, company, timestamp });
        } else {
            return returnError(404, res, result.message, { company, timestamp });
        }
    } catch (error: any) {
        return returnError(
            500,
            res,
            error instanceof Error ? error.message : "Internal server error",
            { company, timestamp },
        );
    }
};

export const loadAllSessionsController = async (req: Request, res: Response) => {
    try {
        const sessions = await loadAllSessions();
        return returnSuccess(res, sessions);
    } catch (error) {
        return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
    }
};

export const listSessionsController = async (req: Request, res: Response) => {
    try {
        const sessions = await listSessions();
        return returnSuccess(res, sessions);
    } catch (error) {
        return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
    }
};

export const sendMessageController = async (req: Request, res: Response) => {
    const { company } = req.params as { company: string };
    const { number, message, customName } = req.body as {
        number: string;
        message: string;
        customName?: string;
    };

    try {
        const session = getSession(company);
        if (!session?.ready) {
            return returnError(
                422,
                res,
                `Empresa ${company} não está conectada ao WhatsApp. Acesse POST /v3/session/${company} para reconectar.`,
            );
        }

        const messageSent = await sendMessageService(session, number, message, customName);

        if (!messageSent?.success) {
            throw new Error(
                `Falha ao enviar mensagem para ${number} usando a sessão ${company}: ${messageSent?.errorMessage}`,
            );
        }

        return returnSuccess(res, { message: "Message sent successfully", messageSent });
    } catch (error) {
        return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
    }
};
