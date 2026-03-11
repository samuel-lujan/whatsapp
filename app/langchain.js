import { Client } from "@langchain/langgraph-sdk";
import crypto from "crypto";
import transcribeModule from "./transcribe.js";

const { transcribeAudio } = transcribeModule;

const client = new Client({ apiUrl: "http://localhost:8130" });
// Using the graph deployed with the name "agent"
const assistantId = "fe096781-5601-53d2-b2f6-0d3403f7e9ca";

const CHAT_CACHE = [];

const APP_TOKEN = process.env.APP_TOKEN;
const BETA_HASH = process.env.BETA_HASH;
const TRANSCRIPTION = process.env.TRANSCRIPTION === "true";

function getApiUrl(companySlug) {
  switch (companySlug) {
    default:
      return "https://www.jusilveiraspinning.com.br/api";
  }
}

async function cellphoneLogin(companySlug, cellphone) {
  const url = getApiUrl(companySlug);
  const cleanedCellphone = clearCellphone(cellphone);
  const loginData = await postLogin(url, { cellphone: cleanedCellphone });

  return loginData.token;
}

async function getNameAndPermissions(companySlug, token) {
  const url = getApiUrl(companySlug);
  const userData = await getUser(url, token);

  return {
    name: userData.name,
    is_in_ai_white_list: userData.is_in_ai_white_list,
    is_able_to_schedule_from_ai: userData.is_able_to_schedule_from_ai,
  };
}

async function getUser(url, token) {
  const response = await fetch(`${url}/user`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Erro ao buscar info do telefone ${body.cellphone}, Status: ${response.status}`,
    );
  }

  return await response.json();
}

async function postLogin(url, body) {
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

  return await response.json();
}

function clearCellphone(cellphone) {
  let cleanedCellphone = cellphone.replace(/\D/g, "");
  if (cleanedCellphone.startsWith("55")) {
    cleanedCellphone = cleanedCellphone.slice(2);
  }
  //console.log("Cleaned Cellphone: ", cleanedCellphone);
  return cleanedCellphone;
}

async function getSession(companySlug, msgFrom, msgTo, msgTimestamp) {
  const receiver_hash = crypto
    .createHash("sha256")
    .update(`${msgTo}`, "utf8")
    .digest("hex");

  console.log("Receiver hash: ", receiver_hash);
  if (receiver_hash != BETA_HASH) {
    return null;
  }

  const sessionId = crypto
    .createHash("sha256")
    .update(`${msgFrom}${msgTo}`, "utf8")
    .digest("hex");

  const foundIndex = CHAT_CACHE.findIndex(
    (session) => session.sessionId === sessionId,
  );

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
    const authToken = await cellphoneLogin(companySlug, msgFrom);
    const user = await getNameAndPermissions(companySlug, authToken);
    if (user.is_in_ai_white_list) {
      console.log(`Criando nova sessão. [${sessionId}].`);
      const thread = await client.threads.create({
        metadata: { sessionId: sessionId },
      });

      if (!thread.thread_id) {
        throw new Error("Thread não foi criada!");
      }

      const newSession = {
        sessionId: sessionId,
        threadId: thread.thread_id,
        authToken: authToken,
        lastUpdate: msgTimestamp,
        userName: user.name,
        isWhiteList: user.is_in_ai_white_list,
        isAbleToSchedule: user.is_able_to_schedule_from_ai,
      };

      CHAT_CACHE.push(newSession);

      console.log(`Sessão criada. [${sessionId}].`);
      console.log(newSession);

      return newSession;
    } else {
      console.log("Número sem permissão para IA.");
    }
  } catch (e) {
    console.log(e.message);
  }
  return null;
}

async function findThread(sessionId) {
  const threads = await client.threads.search({
    metadata: { sessionId: sessionId },
    limit: 1,
  });

  return threads;
}

function prepareInput(message, token, name) {
  return {
    messages: [{ role: "user", content: message }],
    auth_token: token,
    user_name: name,
  };
}

async function getRealPhoneNumber(message) {
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
      console.error("Erro ao obter contato do LID:", e.message);
    }
  }
  // Se não for LID ou não conseguir obter, usa o from original
  return message.from;
}

export async function getAiResponse(message, chat, companySlug) {
  let isTranscibed = false;
  let text = message.body;
  const isNewsletter = message.from.endsWith("@newsletter");

  const isChatMessage = !chat.isGroup && !message.broadcast && !isNewsletter;

  // Para testar com um número específico, substitua pelo número desejado
  console.log(message.from);
  if (isChatMessage) {
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
          base64Data.length % 4 === 0 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(base64Data);

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
        console.log("Erro ao transcrever áudio: ", e.message);
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
          const input = prepareInput(text, session.authToken, session.userName);
          const statelessRunResult = await client.runs.wait(
            session.threadId,
            assistantId,
            {
              input: input,
            },
          );

          const thread_messages = statelessRunResult["messages"];
          return {
            success: true,
            body: thread_messages[thread_messages.length - 1]["content"],
          };
        } catch (e) {
          console.log("Erro ao comunicar com LangGraph: ", e.message);
        }
      }
    }
  }

  return { success: false };
}
