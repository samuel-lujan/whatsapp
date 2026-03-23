import fs from "fs";
import path from "path";
import type { AppError, SendResult } from "../types";
import { verifyClientHealth, safeDestroyClient, Session } from "../session";
import { validateWhatsAppNumber } from "./number-utils";
import { errMsg } from "../utils";

function makeAppError(message: string, statusCode: number, shouldRetry: boolean): AppError {
    const err = new Error(message) as AppError;
    err.statusCode = statusCode;
    err.shouldRetry = shouldRetry;
    return err;
}

export async function sendMessage(
    companySlug: string,
    number: string,
    message: string,
    session: Session,
): Promise<SendResult> {
    if (!session) {
        throw makeAppError(
            `Empresa ${companySlug} não existe. Acesse /status/${companySlug} para criar sessão.`,
            422,
            false,
        );
    }

    if (!session.ready) {
        throw makeAppError(
            `Empresa ${companySlug} não está conectada ao WhatsApp. Acesse /status/${companySlug} para reconectar.`,
            422,
            false,
        );
    }

    console.log(`📤 Iniciando envio para ${companySlug} (ready=${session.ready})`);

    try {
        const client = session.client;

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
            console.log(`⚠️ Não foi possível obter informações do contato: ${errMsg(e)}`);
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
        console.error(`❌ Erro ao enviar mensagem pelo cliente ${companySlug}:`, err.message);

        if (err.statusCode === 400 || err.message.includes("não é um usuário válido")) {
            err.shouldRetry = false;
            throw err;
        }

        const knownLibraryBugs = [
            "markedUnread",
            "isNewMsg",
            "Cannot read properties of undefined",
        ];

        const isKnownLibraryBug = knownLibraryBugs.some((bug) => err.message.includes(bug));

        if (isKnownLibraryBug) {
            console.log(
                `⚠️ Erro interno da biblioteca whatsapp-web.js (não é desconexão): ${err.message}`,
            );
            console.log(`🔄 Tentando enviar novamente em 1 segundo...`);

            await new Promise<void>((resolve) => setTimeout(resolve, 1000));

            try {
                const client = session.client;
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
                console.error(`❌ Erro no retry:`, errMsg(retryError));
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
                console.log(`⚠️ Erro ao limpar auth data de ${companySlug}: ${errMsg(cleanErr)}`);
            }

            throw makeAppError(
                `Falha ao enviar mensagem. Sessão ${companySlug} foi encerrada. Acesse /status/${companySlug} para escanear novo QR Code.`,
                422,
                false,
            );
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
            console.log(`⏱️ Erro de timeout detectado para ${companySlug}: ${err.message}`);
            console.log(`🔍 Verificando saúde do cliente ${companySlug} após erro de timeout...`);
            const healthCheck = await verifyClientHealth(companySlug);

            if (!healthCheck.healthy) {
                console.log(
                    `❌ Cliente ${companySlug} confirmado como não saudável: ${healthCheck.reason}`,
                );
                if (session) {
                    session.ready = false;
                }

                throw makeAppError(
                    `Cliente ${companySlug} perdeu conexão (timeout). Acesse /status/${companySlug} para reconectar.`,
                    422,
                    false,
                );
            } else {
                console.log(
                    `✅ Cliente ${companySlug} ainda está saudável após timeout - erro temporário`,
                );
                throw makeAppError(
                    `Timeout temporário ao enviar mensagem. A conexão está OK - tente novamente.`,
                    422,
                    true,
                );
            }
        }

        const connectionErrors = [
            "getChat",
            "perdeu conexão",
            "not connected",
            "UNPAIRED",
            "UNLAUNCHED",
        ];

        const isConnectionError = connectionErrors.some((c) => err.message.includes(c));

        if (isConnectionError) {
            console.log(`🔌 Erro de conexão definitivo para ${companySlug}`);
            if (session) {
                session.ready = false;
            }

            throw makeAppError(
                `Cliente ${companySlug} perdeu conexão com WhatsApp Web. Acesse /status/${companySlug} para reconectar.`,
                422,
                false,
            );
        }

        console.log(`⚠️ Erro desconhecido ao enviar para ${companySlug}: ${err.message}`);
        throw makeAppError(`Erro ao enviar mensagem: ${err.message}`, 422, true);
    }
}
