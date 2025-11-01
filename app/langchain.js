import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
// Using the graph deployed with the name "agent"
const assistantId = "cbd62771-07ef-4c3a-bc76-9fd03be6fa94";

const SESSION_CACHE = [];

const APP_TOKEN = process.env.APP_TOKEN;

function getApiUrl(companySlug) {
  switch (companySlug) {
    default:
      return "https://www.jusilveiraspinning.com.br/api/login";
  }
}

async function cellphoneLogin(companySlug) {
  const url = getApiUrl(companySlug);
  const result = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + APP_TOKEN,
    },
  });

  return result;
}

async function getSession(sessionId, companySlug) {
  const foundSession = SESSION_CACHE.find(
    (session) => session.sessionId === sessionId
  );

  if (foundSession) {
    console.log("Achei sessão em andamento para o ID: ", sessionId);

    return foundSession;
  } else {
    console.log(`Nenhuma sessão para o ID: ${sessionId}.`);

    const loginResponse = await cellphoneLogin(companySlug);
    if (loginResponse.ok) {
      console.log(`Criando nova sessão[${sessionId}].`);
      const thread = await client.threads.create({
        metadata: { sessionId: sessionId },
      });

      const loginJson = loginResponse.json();
      const token = loginJson["token"];

      const newSession = {
        sessionId: sessionId,
        threadId: thread.thread_id,
        token: token,
      };

      SESSION_CACHE.push(newSession);

      return newSession;
    } else if (loginResponse.status === 422) {
      console.log(`Número não reconhecido como cliente ${sessionId}`);
      return false;
    }
  }
}

async function findThread(sessionId) {
  const threads = await client.threads.search({
    metadata: { sessionId: sessionId },
    limit: 1,
  });

  return threads;
}

function prepareInput(message, token) {
  return {
    messages: [{ role: "user", content: message, token: token }],
  };
}

export async function talkToAI(message, sessionId, companySlug) {
  const session = getSession(sessionId, companySlug);

  if (session) {
    console.log("ID da thread: ", session.threadId);

    const input = prepareInput(message, session.token);
    const statelessRunResult = await client.runs.wait(
      session.threadId,
      assistantId,
      {
        input: input,
      }
    );
    console.log(statelessRunResult);

    const thread_messages = statelessRunResult["messages"];
    return thread_messages[thread_messages.length - 1]["content"];
  }

  return false;
}
