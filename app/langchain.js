import { Client } from "@langchain/langgraph-sdk";
import crypto from "crypto";

const client = new Client({ apiUrl: "http://localhost:8130" });
// Using the graph deployed with the name "agent"
const assistantId = "fe096781-5601-53d2-b2f6-0d3403f7e9ca";

const CHAT_CACHE = [];

const APP_TOKEN = process.env.APP_TOKEN;
const BETA_HASH = process.env.BETA_HASH;

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
      `Erro ao buscar info do telefone ${body.cellphone}, Status: ${response.status}`
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
      `Erro ao tentar logar com número de telefone ${body.cellphone}, Status: ${response.status}`
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

  if (receiver_hash != BETA_HASH) {
    return null;
  }

  const sessionId = crypto
    .createHash("sha256")
    .update(`${msgFrom}${msgTo}`, "utf8")
    .digest("hex");

  const foundIndex = CHAT_CACHE.findIndex(
    (session) => session.sessionId === sessionId
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
  if (message.type === "chat" && !chat.isGroup) {
    // Obtém o número real para autenticação (resolve LIDs)
    const realPhoneNumber = await getRealPhoneNumber(message);

    const session = await getSession(
      companySlug,
      realPhoneNumber,
      message.to,
      message.timestamp
    );

    if (session) {
      console.log("ID da thread: ", session.threadId);

      try {
        const input = prepareInput(
          message.body,
          session.authToken,
          session.userName
        );
        const statelessRunResult = await client.runs.wait(
          session.threadId,
          assistantId,
          {
            input: input,
          }
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

  return { success: false };
}
