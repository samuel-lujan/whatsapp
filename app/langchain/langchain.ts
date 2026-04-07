import { Client } from "@langchain/langgraph-sdk";
import crypto from "crypto";
import { transcribeAudio } from "../transcription";
import type { Message } from "whatsapp-web.js";
import { clearCellphone, getRealPhoneNumber, prepareInput } from "./utils";
import {
    APP_TOKEN,
    BETA_HASH,
    BETA_HASH_2,
    API_URLS,
    TRANSCRIPTION,
    assistantId,
    SESSION_EXPIRY_SECONDS,
} from "./constants";

const client = new Client({ apiUrl: "http://localhost:2024" });
const CHAT_CACHE: ChatSession[] = [];

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

async function getSession(
    companySlug: string,
    msgFrom: string,
    msgTo: string,
    msgTimestamp: number,
): Promise<ChatSession | null> {
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
        if (nowTimestamp - CHAT_CACHE[foundIndex].lastUpdate > SESSION_EXPIRY_SECONDS) {
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
        const apiUrl = API_URLS[companySlug] || API_URLS.default;
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

            const newSession: ChatSession = {
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
