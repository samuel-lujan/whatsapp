import { Message } from "whatsapp-web.js";

function clearCellphone(cellphone: string): string {
    let cleanedCellphone = cellphone.replace(/\D/g, "");
    if (cleanedCellphone.startsWith("55")) {
        cleanedCellphone = cleanedCellphone.slice(2);
    }
    //console.log("Cleaned Cellphone: ", cleanedCellphone);
    return cleanedCellphone;
}

function prepareInput(
    message: string,
    token: string,
    name: string,
    url: string,
): {
    messages: Array<{ role: string; content: string }>;
    auth_token: string;
    user_name: string;
    api_url: string;
} {
    return {
        messages: [{ role: "user", content: message }],
        auth_token: token,
        user_name: name,
        api_url: url,
    };
}

async function getRealPhoneNumber(message: Message): Promise<string> {
    // Se for LID, precisamos obter o número real do contato
    if (message.from.endsWith("@lid")) {
        try {
            const contact = await message.getContact();
            // contact.number contém o número real (ex: "5511999999999")
            if (contact.number) {
                console.log(`📱 LID detectado. Número real: ${contact.number}`);
                return contact.number;
            }
        } catch (e) {
            console.error("Erro ao obter contato do LID:", (e as Error).message);
        }
    }
    // Se não for LID ou não conseguir obter, usa o from original
    return message.from;
}

export { clearCellphone, prepareInput, getRealPhoneNumber };
