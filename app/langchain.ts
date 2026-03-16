import { Client } from "@langchain/langgraph-sdk";
import crypto from "crypto";
import { transcribeAudio } from "./transcribe";
import type { Message, Chat } from "whatsapp-web.js";

const client = new Client({ apiUrl: "http://localhost:2024" });
// Using the graph deployed with the name "agent"
const assistantId = "fe096781-5601-53d2-b2f6-0d3403f7e9ca";

interface Session {
    sessionId: string;
    threadId: string;
    authToken: string;
    lastUpdate: number;
    userName: string;
    isAbleToAiResponse: boolean;
    apiUrl: string;
}

interface UserData {
    name: string;
    is_able_to_ai_response: boolean;
}

interface LoginData {
    token: string;
}

interface AiResponse {
    success: boolean;
    body?: string;
}

const CHAT_CACHE: Session[] = [];

const APP_TOKEN = process.env.APP_TOKEN;
const BETA_HASH = process.env.BETA_HASH;
const BETA_HASH_2 = process.env.BETA_HASH_2;
const TRANSCRIPTION = process.env.TRANSCRIPTION === "true";

function getApiUrl(companySlug: string): string {
    switch (companySlug) {
        case "studio-homolog":
            return "https://homolog.samuellujan.com.br/api";
        case "lesma":
            return "https://homolog.samuellujan.com.br/api";
        default:
            return "https://www.jusilveiraspinning.com.br/api";
    }
}

async function cellphoneLogin(url: string, cellphone: string): Promise<string> {
    const cleanedCellphone = clearCellphone(cellphone);
    const loginData = await postLogin(url, { cellphone: cleanedCellphone });
    return loginData.token;
}

async function getNameAndPermissions(
    url: string,
    token: string,
): Promise<{ name: string; is_able_to_ai_response: boolean }> {
    const userData = await getUser(url, token);
    return {
        name: userData.name,
        is_able_to_ai_response: userData.is_able_to_ai_response,
    };
}

async function getUser(url: string, token: string): Promise<UserData> {
    const response = await fetch(`${url}/user`, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Erro ao buscar info do usuário. Status: ${response.status}`);
    }

    return (await response.json()) as UserData;
}

async function postLogin(url: string, body: { cellphone: string }): Promise<LoginData> {
    const response = await fetch(`${url}/login`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${APP_TOKEN}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(
            `Erro ao tentar logar com número de telefone ${body.cellphone}, Status: ${response.status}`,
        );
    }

    return (await response.json()) as LoginData;
}

function clearCellphone(cellphone: string): string {
    let cleanedCellphone = cellphone.replace(/\D/g, "");
    if (cleanedCellphone.startsWith("55")) {
        cleanedCellphone = cleanedCellphone.slice(2);
    }
    //console.log("Cleaned Cellphone: ", cleanedCellphone);
    return cleanedCellphone;
}

async function getSession(
    companySlug: string,
    msgFrom: string,
    msgTo: string,
    msgTimestamp: number,
): Promise<Session | null> {
    const receiver_hash = crypto.createHash("sha256").update(`${msgTo}`, "utf8").digest("hex");

    console.log("Receiver hash: ", receiver_hash);
    if (receiver_hash != BETA_HASH && receiver_hash != BETA_HASH_2) {
        return null;
    }

    const sessionId = crypto
        .createHash("sha256")
        .update(`${msgFrom}${msgTo}`, "utf8")
        .digest("hex");

    const foundIndex = CHAT_CACHE.findIndex((session) => session.sessionId === sessionId);

    if (foundIndex > -1) {
        const nowTimestamp = Math.floor(Date.now() / 1000);
        if (nowTimestamp - CHAT_CACHE[foundIndex].lastUpdate > 3600) {
            //isExpired: 1 hora
            CHAT_CACHE.splice(foundIndex, 1);
            console.log("Sessão expirada para o ID: ", sessionId);
        } else {
            console.log("Achei sessão em andamento para o ID: ", sessionId);
            const session = CHAT_CACHE[foundIndex];
            session.lastUpdate = msgTimestamp;
            return session;
        }
    } else {
        console.log("Nenhuma sessão encontrada para o ID: ", sessionId);
    }

    try {
        const apiUrl = getApiUrl(companySlug);
        const authToken = await cellphoneLogin(apiUrl, msgFrom);
        const user = await getNameAndPermissions(apiUrl, authToken);
        console.log(authToken);
        console.log(user);
        if (user.is_able_to_ai_response) {
            console.log(`Criando nova sessão. [${sessionId}].`);
            const thread = await client.threads.create({
                metadata: { sessionId: sessionId },
            });

            if (!thread.thread_id) {
                throw new Error("Thread não foi criada!");
            }

            const newSession: Session = {
                sessionId: sessionId,
                threadId: thread.thread_id,
                authToken: authToken,
                lastUpdate: msgTimestamp,
                userName: user.name,
                isAbleToAiResponse: user.is_able_to_ai_response,
                apiUrl: apiUrl,
            };

            CHAT_CACHE.push(newSession);

            console.log(`Sessão criada. [${sessionId}].`);
            console.log(newSession);

            return newSession;
        } else {
            console.log("Número sem permissão para IA.");
        }
    } catch (e) {
        console.log((e as Error).message);
    }
    return null;
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

export async function getAiResponse(message: Message, companySlug: string): Promise<AiResponse> {
    let isTranscibed = false;
    let text = message.body;

    // Para testar com um número específico, substitua pelo número desejado
    console.log(message.from);
    if (message.type === "image") {
        return {
            success: true,
            body: "Desculpe, mas não consigo processar imagens no momento. Por favor, envie uma mensagem de texto.",
        };
    } else if (message.type === "audio" || message.type === "ptt") {
        if (!TRANSCRIPTION) {
            return {
                success: true,
                body: "Desculpe, não consigo processar mensagens de áudio no momento. Por favor, envie uma mensagem de texto.",
            };
        }

        try {
            const media = await message.downloadMedia();
            const mediaData = media?.data;

            if (typeof mediaData !== "string" || mediaData.trim() === "") {
                throw new Error("Media data inválida para transcrição.");
            }

            const base64Data = mediaData.trim();
            const isValidBase64 =
                base64Data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64Data);

            if (!isValidBase64) {
                throw new Error("Media data não está em base64 válido.");
            }

            console.log("Base64 data is valid. Length: ", base64Data.length);

            const audioBuffer = Buffer.from(base64Data, "base64");
            if (!audioBuffer.length) {
                throw new Error("Buffer de áudio vazio.");
            }

            console.log("Media filename: ", media?.filename);

            text = await transcribeAudio(audioBuffer, {
                filename: media?.filename || "audio.ogg",
            });

            console.log("Transcrição obtida: ", text);

            if (typeof text !== "string" || text.trim() === "") {
                throw new Error("Transcrição vazia.");
            }

            isTranscibed = true;
        } catch (e) {
            console.log("Erro ao transcrever áudio: ", (e as Error).message);
            return {
                success: true,
                body: "Desculpe, Houve um erro analisando seu áudio. Por favor, envie uma mensagem de texto.",
            };
        }
    }

    console.log("Texto a ser processado: ", text);
    console.log(message.type);
    if (message.type === "chat" || isTranscibed) {
        // Obtém o número real para autenticação (resolve LIDs)
        const realPhoneNumber = await getRealPhoneNumber(message);

        const session = await getSession(
            companySlug,
            realPhoneNumber,
            message.to,
            message.timestamp,
        );

        console.log("session: ", session);

        if (session) {
            console.log("ID da thread: ", session.threadId);

            try {
                const input = prepareInput(
                    text,
                    session.authToken,
                    session.userName,
                    session.apiUrl,
                );
                const statelessRunResult = (await client.runs.wait(session.threadId, assistantId, {
                    input: input,
                })) as Record<string, unknown>;

                const thread_messages = statelessRunResult["messages"] as Array<
                    Record<string, unknown>
                >;
                return {
                    success: true,
                    body: thread_messages[thread_messages.length - 1]["content"] as string,
                };
            } catch (e) {
                console.log("Erro ao comunicar com LangGraph: ", (e as Error).message);
            }
        }
    }

    return { success: false };
}
