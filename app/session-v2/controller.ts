import { Request, Response } from "express";
import { createSession, deleteSession, getSession, listSessions, loadAllSessions, loadSession, sendMessageService } from "./service";
import qrcodeTerminal from "qrcode-terminal";
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

export const createSessionController = async (req: Request, res: Response, hasAi: boolean = false) => {
  const { company } = req.params as { company: string };
  try {
    const alreadyExists = getSession(company);
    server.log(alreadyExists ? `✅ Sessão já existe para empresa ${company}` : `🔍 Nenhuma sessão existente para empresa ${company}`);
    if (alreadyExists) {
      await loadSession(company);
      return returnSuccess(res, alreadyExists, { message: `Sessão ${company} já estava ativa, retornando sessão existente` });
    }

    const session = await createSession(company, hasAi);
    const response: Record<string, unknown> = {};

    if (session.ready) {
      console.log(`✅ Empresa ${company} está conectada`);
      response.method = "full-check";
      response.connected = true;
    } else {
      console.log(`⚠️ Empresa ${company} não está conectada`);

      if (session.qrCode) {
        console.log(`📱 QR Code disponível para empresa ${company}`);
        qrcodeTerminal.generate(session.qrCode, { small: true });
        response.qrCode = session.qrCode;
        response.message = "Escaneie o QR Code com o WhatsApp para conectar";
      } else {
        response.message = "Aguardando geração do QR Code...";
      }
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
        server.log(`🧹 Solicitação de limpeza da sessão: ${company}`);
        const session = getSession(company);
        if (!session) {
          return returnError(404, res, `Session with name ${company} not found`);
        }

        const result = await deleteSession(session);

        if (result.success) {
            server.log(`✅ Sessão ${session.name} limpa: ${result.message}`);
            return returnSuccess(res, { message: result.message, company, timestamp});
        } else {
            server.log(`⚠️ Falha ao limpar sessão ${session.name}: ${result.message}`);
            return returnError(404, res, result.message, { company, timestamp });
        }
    } catch (error: any) {
        server.log(`❌ Erro ao limpar sessão ${company}: ${error.message}`);
        // rollbar.error(error, { company, route: "/clear/:companySlug" });
        return returnError(500, res, error instanceof Error ? error.message : "Internal server error", { company, timestamp });
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
  const { number, message, customName } = req.body as { number: string; message: string; customName?: string };

    try {
        const session = getSession(company);
    if (!session?.ready) {
      return returnError(422, res, `Empresa ${company} não está conectada ao WhatsApp. Acesse POST /session/${company} para reconectar.`);
    }
    const messageSent = await sendMessageService(session, number, message, customName);

    if (!messageSent.success) {
      throw Error(`Falha ao enviar mensagem para ${number} usando a sessão ${company}`);
    }

    return returnSuccess(res, { message: "Message sent successfully", messageSent });
  } catch (error) {
    return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
  }
};