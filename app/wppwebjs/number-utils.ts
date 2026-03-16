import type { Client } from "whatsapp-web.js";
import type { ChatIdResult, ValidationResult } from "./types";

export async function findCorrectChatId(client: Client, number: string): Promise<ChatIdResult> {
    const cleanNumber = number.replace(/\D/g, "");

    console.log(`🔍 Procurando chat existente para número: ${cleanNumber}`);

    try {
        const chats = await client.getChats();

        for (const chat of chats) {
            const chatNumber = chat.id.user;
            if (chatNumber === cleanNumber) {
                console.log(
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

        console.log(`🔍 Não encontrou chat existente, verificando contatos salvos...`);
        const contacts = await client.getContacts();

        for (const contact of contacts) {
            const contactNumber = contact.id.user;
            if (contactNumber === cleanNumber) {
                console.log(
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

        console.log(`🔍 Verificando se número ${cleanNumber} está registrado no WhatsApp...`);
        const isRegistered = await client.isRegisteredUser(`${cleanNumber}@c.us`);

        if (isRegistered) {
            console.log(`✅ Número ${cleanNumber} está registrado, usando formato padrão`);
            return {
                chatId: `${cleanNumber}@c.us`,
                isExistingChat: false,
                isRegistered: true,
            };
        } else {
            console.log(`⚠️ Número ${cleanNumber} não está registrado no WhatsApp`);
            return {
                chatId: `${cleanNumber}@c.us`,
                isExistingChat: false,
                isRegistered: false,
                warning: "Número pode não estar registrado no WhatsApp",
            };
        }
    } catch (error) {
        console.log(
            `⚠️ Erro ao buscar chat/contato, usando formato padrão:`,
            (error as Error).message,
        );
        return {
            chatId: `${cleanNumber}@c.us`,
            isExistingChat: false,
            error: (error as Error).message,
        };
    }
}

export async function validateWhatsAppNumber(
    client: Client,
    number: string,
): Promise<ValidationResult> {
    let cleanNumber = number.replace(/\D/g, "");

    console.log(`🔢 Número original limpo: ${cleanNumber} (${cleanNumber.length} dígitos)`);

    if (!cleanNumber.startsWith("55")) {
        if (cleanNumber.length === 11) {
            cleanNumber = "55" + cleanNumber;
            console.log(`➕ Adicionado código 55 (11 dígitos): ${cleanNumber}`);
        } else if (cleanNumber.length === 10) {
            cleanNumber = "55" + cleanNumber;
            console.log(`➕ Adicionado código 55 (10 dígitos): ${cleanNumber}`);
        } else if (cleanNumber.length < 10) {
            console.log(`⚠️ Número muito curto: ${cleanNumber.length} dígitos`);
            return {
                isValid: false,
                originalNumber: number,
                numberId: null,
                error: `Número muito curto: ${cleanNumber.length} dígitos (mínimo 10)`,
            };
        } else {
            console.log(
                `⚠️ Número com formato inesperado: ${cleanNumber.length} dígitos sem código 55`,
            );
        }
    }

    if (cleanNumber.length < 12 || cleanNumber.length > 13) {
        console.log(
            `⚠️ Número com formato inválido: ${cleanNumber.length} dígitos (esperado 12 ou 13)`,
        );
        return {
            isValid: false,
            originalNumber: number,
            numberId: null,
            error: `Número com formato inválido: ${cleanNumber.length} dígitos`,
        };
    }

    console.log(`🔍 Validando número: ${cleanNumber}`);

    const variations = [cleanNumber];

    if (cleanNumber.length === 13 && cleanNumber.charAt(4) === "9") {
        const withoutNine = cleanNumber.substring(0, 4) + cleanNumber.substring(5);
        variations.push(withoutNine);
        console.log(`📋 Testando variações: [${cleanNumber}, ${withoutNine}]`);
    } else if (cleanNumber.length === 12 && cleanNumber.charAt(4) !== "9") {
        const withNine = cleanNumber.substring(0, 4) + "9" + cleanNumber.substring(4);
        variations.push(withNine);
        console.log(`📋 Testando variações: [${cleanNumber}, ${withNine}]`);
    } else {
        console.log(`📋 Testando apenas: [${cleanNumber}]`);
    }

    for (const variation of variations) {
        try {
            console.log(`🔎 Testando: ${variation}`);
            const numberId = await client.getNumberId(variation);

            if (numberId) {
                console.log(`✅ Número válido encontrado: ${numberId._serialized}`);
                return {
                    isValid: true,
                    numberId: numberId._serialized,
                    originalNumber: number,
                    validatedNumber: variation,
                    wasAlternative: variation !== cleanNumber,
                };
            }
        } catch (error) {
            console.log(`❌ Erro ao testar ${variation}: ${(error as Error).message}`);
        }
    }

    console.log(`⚠️ getNumberId() falhou para todas as variações, usando fallback...`);

    const fallbackNumber = variations[0];
    const fallbackChatId = `${fallbackNumber}@c.us`;

    console.log(`🔄 Fallback: usando ${fallbackChatId} (formato válido, não confirmado pela API)`);

    return {
        isValid: true,
        numberId: fallbackChatId,
        originalNumber: number,
        validatedNumber: fallbackNumber,
        wasAlternative: false,
        wasFallback: true,
    };
}
