import fs from "fs";
import path from "path";
import type { AppError, SendResult } from "./interfaces";
import { verifyClientHealth } from "./session/health";
import { safeDestroyClient } from "./session/handlers";
import { validateWhatsAppNumber } from "./number-utils";
import { sessions } from "./session/sessions";

export async function sendMessage(
  companySlug: string,
  number: string,
  message: string,
): Promise<SendResult> {
  if (!sessions[companySlug]) {
    const err = new Error(
      `Empresa ${companySlug} não existe. Acesse /status/${companySlug} para criar sessão.`,
    ) as AppError;
    err.shouldRetry = false;
    err.statusCode = 422;
    throw err;
  }

  if (!sessions[companySlug].ready) {
    const err = new Error(
      `Empresa ${companySlug} não está conectada ao WhatsApp. Acesse /status/${companySlug} para reconectar.`,
    ) as AppError;
    err.shouldRetry = false;
    err.statusCode = 422;
    throw err;
  }

  console.log(
    `📤 Iniciando envio para ${companySlug} (ready=${sessions[companySlug].ready})`,
  );

  try {
    const client = sessions[companySlug].client;

    console.log(`🔍 Validando número ${number}...`);
    const validation = await validateWhatsAppNumber(client, number);

    if (!validation.isValid) {
      console.log(`❌ Número ${number} não é válido no WhatsApp`);
      throw new Error(`Número ${number} não é um usuário válido do WhatsApp`);
    }

    const chatId = validation.numberId!;
    const validationInfo = validation.wasFallback
      ? " (fallback - não confirmado pela API)"
      : validation.wasAlternative
        ? " (versão alternativa)"
        : "";
    console.log(`✅ Número validado: ${chatId}${validationInfo}`);

    console.log(`📤 Enviando mensagem do cliente ${companySlug} para ${chatId}`);
    await client.sendMessage(chatId, message);
    console.log(`✅ Mensagem enviada com sucesso!`);

    let contactInfo: {
      pushname: string;
      chatName: string;
      isMyContact?: boolean;
    } = {
      pushname: "Desconhecido",
      chatName: chatId,
    };

    try {
      const chat = await client.getChatById(chatId);
      const contact = await chat.getContact();
      contactInfo = {
        pushname: contact.pushname || "Sem nome",
        chatName: chat.name || chatId,
        isMyContact: contact.isMyContact,
      };
      console.log(`👤 Informações do contato: ${contactInfo.pushname}`);
    } catch (e) {
      console.log(
        `⚠️ Não foi possível obter informações do contato: ${(e as Error).message}`,
      );
    }

    return {
      success: true,
      message: "Mensagem enviada com sucesso",
      data: {
        companySlug,
        number: chatId,
        originalNumber: number,
        validatedNumber: validation.validatedNumber,
        wasAlternative: validation.wasAlternative,
        chatName: contactInfo.chatName,
        userPushname: contactInfo.pushname,
        content: message,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    const err = error as AppError;
    console.error(
      `❌ Erro ao enviar mensagem pelo cliente ${companySlug}:`,
      err.message,
    );

    if (err.statusCode === 400 || err.message.includes("não é um usuário válido")) {
      err.shouldRetry = false;
      throw err;
    }

    const knownLibraryBugs = [
      "markedUnread",
      "isNewMsg",
      "Cannot read properties of undefined",
    ];

    const isKnownLibraryBug = knownLibraryBugs.some((bug) =>
      err.message.includes(bug),
    );

    if (isKnownLibraryBug) {
      console.log(
        `⚠️ Erro interno da biblioteca whatsapp-web.js (não é desconexão): ${err.message}`,
      );
      console.log(`🔄 Tentando enviar novamente em 1 segundo...`);

      await new Promise<void>((resolve) => setTimeout(resolve, 1000));

      try {
        const client = sessions[companySlug].client;
        const validation = await validateWhatsAppNumber(client, number);

        if (validation.isValid) {
          console.log(`📤 Reenviando mensagem para ${validation.numberId}...`);
          await client.sendMessage(validation.numberId!, message);
          console.log(`✅ Mensagem reenviada com sucesso!`);

          return {
            success: true,
            message: "Mensagem enviada com sucesso (após retry)",
            data: {
              companySlug,
              number: validation.numberId!,
              originalNumber: number,
              content: message,
              timestamp: new Date().toISOString(),
              wasRetry: true,
            },
          };
        }
      } catch (retryError) {
        console.error(`❌ Erro no retry:`, (retryError as Error).message);
      }

      console.log(
        `❌ Envio e retry falharam para ${companySlug}. Destruindo sessão e limpando auth para forçar novo QR Code...`,
      );

      await safeDestroyClient(companySlug);

      try {
        const authDir = path.resolve(
          __dirname,
          "..",
          ".wwebjs_auth",
          `session-${companySlug}`,
        );
        await fs.promises.rm(authDir, { recursive: true, force: true });
        console.log(`🗑️ Auth data removido: ${authDir}`);
      } catch (cleanErr) {
        console.log(
          `⚠️ Erro ao limpar auth data de ${companySlug}: ${(cleanErr as Error).message}`,
        );
      }

      const connErr = new Error(
        `Falha ao enviar mensagem. Sessão ${companySlug} foi encerrada. Acesse /status/${companySlug} para escanear novo QR Code.`,
      ) as AppError;
      connErr.shouldRetry = false;
      connErr.statusCode = 422;
      throw connErr;
    }

    const timeoutErrors = [
      "timed out",
      "timeout",
      "Protocol error",
      "Target closed",
      "Session closed",
      "Navigation failed",
    ];

    const isTimeoutError = timeoutErrors.some((t) =>
      err.message.toLowerCase().includes(t.toLowerCase()),
    );

    if (isTimeoutError) {
      console.log(
        `⏱️ Erro de timeout detectado para ${companySlug}: ${err.message}`,
      );
      console.log(
        `🔍 Verificando saúde do cliente ${companySlug} após erro de timeout...`,
      );
      const healthCheck = await verifyClientHealth(companySlug);

      if (!healthCheck.healthy) {
        console.log(
          `❌ Cliente ${companySlug} confirmado como não saudável: ${healthCheck.reason}`,
        );
        if (sessions[companySlug]) {
          sessions[companySlug].ready = false;
        }

        const connErr = new Error(
          `Cliente ${companySlug} perdeu conexão (timeout). Acesse /status/${companySlug} para reconectar.`,
        ) as AppError;
        connErr.shouldRetry = false;
        connErr.statusCode = 422;
        throw connErr;
      } else {
        console.log(
          `✅ Cliente ${companySlug} ainda está saudável após timeout - erro temporário`,
        );
        const tempErr = new Error(
          `Timeout temporário ao enviar mensagem. A conexão está OK - tente novamente.`,
        ) as AppError;
        tempErr.shouldRetry = true;
        tempErr.statusCode = 422;
        throw tempErr;
      }
    }

    const connectionErrors = [
      "getChat",
      "perdeu conexão",
      "not connected",
      "UNPAIRED",
      "UNLAUNCHED",
    ];

    const isConnectionError = connectionErrors.some((c) =>
      err.message.includes(c),
    );

    if (isConnectionError) {
      console.log(`🔌 Erro de conexão definitivo para ${companySlug}`);
      if (sessions[companySlug]) {
        sessions[companySlug].ready = false;
      }

      const connErr = new Error(
        `Cliente ${companySlug} perdeu conexão com WhatsApp Web. Acesse /status/${companySlug} para reconectar.`,
      ) as AppError;
      connErr.shouldRetry = false;
      connErr.statusCode = 422;
      throw connErr;
    }

    console.log(
      `⚠️ Erro desconhecido ao enviar para ${companySlug}: ${err.message}`,
    );
    const unknownErr = new Error(
      `Erro ao enviar mensagem: ${err.message}`,
    ) as AppError;
    unknownErr.shouldRetry = true;
    unknownErr.statusCode = 422;
    throw unknownErr;
  }
}
