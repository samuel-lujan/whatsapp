import type { Client } from "whatsapp-web.js";
import type { ChatIdResult, ValidationResult } from "../types";
import { errMsg } from "../utils";
import { Logger } from "../logging";

export async function findCorrectChatId(client: Client, number: string, logger: Logger): Promise<ChatIdResult> {
    const cleanNumber = number.replace(/\D/g, "");

    logger.log(`🔍 Procurando chat existente para número: ${cleanNumber}`);

    try {
        const chats = await client.getChats();

        for (const chat of chats) {
            const chatNumber = chat.id.user;
            if (chatNumber === cleanNumber) {
                logger.log(
                    `✅ Encontrou chat existente: ${chat.id._serialized} (nome: ${chat.name})`,
                );
                return {
                    chatId: chat.id._serialized,
                    isExistingChat: true,
                    chatName: chat.name,
                    isGroup: chat.isGroup,
                };
            }
        }

        logger.log(`🔍 Não encontrou chat existente, verificando contatos salvos...`);
        const contacts = await client.getContacts();

        for (const contact of contacts) {
            const contactNumber = contact.id.user;
            if (contactNumber === cleanNumber) {
                logger.log(
                    `✅ Encontrou contato salvo: ${contact.id._serialized} (nome: ${
                        contact.name || contact.pushname
                    })`,
                );
                return {
                    chatId: contact.id._serialized,
                    isExistingChat: false,
                    contactName: contact.name || contact.pushname,
                    isContact: true,
                };
            }
        }

        logger.log(`🔍 Verificando se número ${cleanNumber} está registrado no WhatsApp...`);
        const isRegistered = await client.isRegisteredUser(`${cleanNumber}@c.us`);

        if (isRegistered) {
            logger.log(`✅ Número ${cleanNumber} está registrado, usando formato padrão`);
            return {
                chatId: `${cleanNumber}@c.us`,
                isExistingChat: false,
                isRegistered: true,
            };
        } else {
            logger.log(`⚠️ Número ${cleanNumber} não está registrado no WhatsApp`);
            return {
                chatId: `${cleanNumber}@c.us`,
                isExistingChat: false,
                isRegistered: false,
                warning: "Número pode não estar registrado no WhatsApp",
            };
        }
    } catch (error) {
        logger.log(`⚠️ Erro ao buscar chat/contato, usando formato padrão: ${errMsg(error)}`);
        return {
            chatId: `${cleanNumber}@c.us`,
            isExistingChat: false,
            error: errMsg(error),
        };
    }
}

export async function validateWhatsAppNumber(
    client: Client,
    number: string,
    logger: Logger,
): Promise<ValidationResult> {
    let cleanNumber = number.replace(/\D/g, "");

    logger.log(`🔢 Número original limpo: ${cleanNumber} (${cleanNumber.length} dígitos)`);

    if (!cleanNumber.startsWith("55")) {
        if (cleanNumber.length === 11) {
            cleanNumber = "55" + cleanNumber;
            logger.log(`➕ Adicionado código 55 (11 dígitos): ${cleanNumber}`);
        } else if (cleanNumber.length === 10) {
            cleanNumber = "55" + cleanNumber;
            logger.log(`➕ Adicionado código 55 (10 dígitos): ${cleanNumber}`);
        } else if (cleanNumber.length < 10) {
            logger.log(`⚠️ Número muito curto: ${cleanNumber.length} dígitos`);
            return {
                isValid: false,
                originalNumber: number,
                numberId: null,
                error: `Número muito curto: ${cleanNumber.length} dígitos (mínimo 10)`,
            };
        } else {
            logger.log(
                `⚠️ Número com formato inesperado: ${cleanNumber.length} dígitos sem código 55`,
            );
        }
    }

    if (cleanNumber.length < 12 || cleanNumber.length > 13) {
        logger.log(
            `⚠️ Número com formato inválido: ${cleanNumber.length} dígitos (esperado 12 ou 13)`,
        );
        return {
            isValid: false,
            originalNumber: number,
            numberId: null,
            error: `Número com formato inválido: ${cleanNumber.length} dígitos`,
        };
    }

    logger.log(`🔍 Validando número: ${cleanNumber}`);

    const variations = [cleanNumber];

    if (cleanNumber.length === 13 && cleanNumber.charAt(4) === "9") {
        const withoutNine = cleanNumber.substring(0, 4) + cleanNumber.substring(5);
        variations.push(withoutNine);
        logger.log(`📋 Testando variações: [${cleanNumber}, ${withoutNine}]`);
    } else if (cleanNumber.length === 12 && cleanNumber.charAt(4) !== "9") {
        const withNine = cleanNumber.substring(0, 4) + "9" + cleanNumber.substring(4);
        variations.push(withNine);
        logger.log(`📋 Testando variações: [${cleanNumber}, ${withNine}]`);
    } else {
        logger.log(`📋 Testando apenas: [${cleanNumber}]`);
    }

    for (const variation of variations) {
        try {
            logger.log(`🔎 Testando: ${variation}`);
            const numberId = await client.getNumberId(variation);

            if (numberId) {
                logger.log(`✅ Número válido encontrado: ${numberId._serialized}`);
                return {
                    isValid: true,
                    numberId: numberId._serialized,
                    originalNumber: number,
                    validatedNumber: variation,
                    wasAlternative: variation !== cleanNumber,
                };
            }
        } catch (error) {
            logger.log(`❌ Erro ao testar ${variation}: ${errMsg(error)}`);
        }
    }

    logger.log(`⚠️ getNumberId() falhou para todas as variações, usando fallback...`);

    const fallbackNumber = variations[0];
    const fallbackChatId = `${fallbackNumber}@c.us`;

    logger.log(`🔄 Fallback: usando ${fallbackChatId} (formato válido, não confirmado pela API)`);

    return {
        isValid: true,
        numberId: fallbackChatId,
        originalNumber: number,
        validatedNumber: fallbackNumber,
        wasAlternative: false,
        wasFallback: true,
    };
}
