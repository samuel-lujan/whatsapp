import { execSync } from "child_process";
import { Client, LocalAuth } from "whatsapp-web.js";
import { getAiResponse } from "../../langchain";
import { PERMANENT_FAILURE_REASONS, RECONNECT_CONFIG } from "./config";
import { sessions } from "./sessions";
import { raceWithTimeout } from "../../utils";

export function shouldAutoReconnect(reason: string): boolean {
  if (typeof reason === "string") {
    return !PERMANENT_FAILURE_REASONS.includes(reason);
  }
  return true;
}

export function getReconnectDelay(attempt: number): number {
  const delay =
    RECONNECT_CONFIG.initialDelayMs *
    Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt);
  return Math.min(delay, RECONNECT_CONFIG.maxDelayMs);
}

export async function safeDestroyClient(companySlug: string): Promise<void> {
  const session = sessions[companySlug];
  if (!session || !session.client) {
    delete sessions[companySlug];
    return;
  }

  if (session.destroying) {
    console.log(`[DESTROY] ${companySlug}: ja esta sendo destruido, ignorando`);
    return;
  }
  session.destroying = true;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  const client = session.client;

  try {
    await raceWithTimeout(client.destroy(), 10000, "destroy timeout");
    console.log(`[DESTROY] ${companySlug}: client.destroy() ok`);
  } catch (e) {
    console.log(
      `[DESTROY] ${companySlug}: client.destroy() falhou: ${(e as Error).message}`,
    );

    try {
      if (client.pupBrowser) {
        const browserProcess = client.pupBrowser.process();
        if (browserProcess) {
          console.log(
            `[DESTROY] ${companySlug}: forçando kill no Chrome PID ${browserProcess.pid}`,
          );
          browserProcess.kill("SIGKILL");
        }
      } else {
        console.log(
          `[DESTROY] ${companySlug}: pupBrowser null, buscando processos Chrome órfãos...`,
        );
        try {
          const sessionDir = `session-${companySlug}`;
          const result = execSync(`pgrep -f "${sessionDir}" || true`, {
            timeout: 5000,
          })
            .toString()
            .trim();
          if (result) {
            const pids = result.split("\n").filter(Boolean);
            console.log(
              `[DESTROY] ${companySlug}: encontrados ${pids.length} processos órfãos: ${pids.join(", ")}`,
            );
            execSync(`kill -9 ${pids.join(" ")} || true`, { timeout: 5000 });
            console.log(`[DESTROY] ${companySlug}: processos órfãos eliminados`);
          } else {
            console.log(
              `[DESTROY] ${companySlug}: nenhum processo Chrome órfão encontrado`,
            );
          }
        } catch (pgrepErr) {
          console.log(
            `[DESTROY] ${companySlug}: busca de processos órfãos falhou: ${(pgrepErr as Error).message}`,
          );
        }
      }
    } catch (killErr) {
      console.log(
        `[DESTROY] ${companySlug}: force-kill falhou: ${(killErr as Error).message}`,
      );
    }
  }

  delete sessions[companySlug];
  console.log(`[DESTROY] ${companySlug}: sessao removida da memoria`);
}

export async function scheduleReconnect(
  companySlug: string,
  reason: string,
): Promise<void> {
  if (!sessions[companySlug]) {
    console.log(`[RECONNECT] ${companySlug}: sessao removida, cancelando reconnect`);
    return;
  }

  const session = sessions[companySlug];
  const attempt = session.reconnectAttempts || 0;

  if (attempt >= RECONNECT_CONFIG.maxAttempts) {
    console.log(
      `[RECONNECT] ${companySlug}: max tentativas (${RECONNECT_CONFIG.maxAttempts}) atingido, desistindo`,
    );
    await safeDestroyClient(companySlug);
    return;
  }

  const delay = getReconnectDelay(attempt);
  console.log(
    `[RECONNECT] ${companySlug}: tentativa ${attempt + 1}/${RECONNECT_CONFIG.maxAttempts} em ${delay / 1000}s (motivo: ${reason})`,
  );

  session.reconnectTimer = setTimeout(async () => {
    try {
      await safeDestroyClient(companySlug);

      console.log(`[RECONNECT] ${companySlug}: criando sessao nova...`);
      await createSession(companySlug);

      await new Promise<void>((resolve) => setTimeout(resolve, 15000));

      if (sessions[companySlug] && sessions[companySlug].ready) {
        console.log(`[RECONNECT] ${companySlug}: reconectou com sucesso!`);
        sessions[companySlug].reconnectAttempts = 0;
      } else if (sessions[companySlug]) {
        sessions[companySlug].reconnectAttempts = attempt + 1;
        await scheduleReconnect(companySlug, reason);
      }
    } catch (err) {
      console.log(
        `[RECONNECT] ${companySlug}: tentativa falhou: ${(err as Error).message}`,
      );
      if (sessions[companySlug]) {
        sessions[companySlug].reconnectAttempts = attempt + 1;
        await scheduleReconnect(companySlug, reason);
      }
    }
  }, delay);
}

export async function createSession(companySlug: string): Promise<void> {
  try {
    const sessionDir = `session-${companySlug}`;
    const orphanPids = execSync(`pgrep -f "${sessionDir}" || true`, {
      timeout: 5000,
    })
      .toString()
      .trim();
    if (orphanPids) {
      const pids = orphanPids.split("\n").filter(Boolean);
      console.log(
        `[CREATE] ${companySlug}: matando ${pids.length} processos Chrome órfãos antes de criar sessão: ${pids.join(", ")}`,
      );
      execSync(`kill -9 ${pids.join(" ")} || true`, { timeout: 5000 });
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  } catch (e) {
    console.log(
      `[CREATE] ${companySlug}: falha ao verificar processos órfãos: ${(e as Error).message}`,
    );
  }

  const isProduction = process.env.NODE_ENV === "production";
  const isHeadless = isProduction || process.env.HEADLESS === "true";

  console.log(`🖥️ Ambiente: ${isProduction ? "PRODUÇÃO" : "DESENVOLVIMENTO"}`);
  console.log(`🌐 Browser: ${isHeadless ? "HEADLESS (sem interface)" : "COM INTERFACE"}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: companySlug }),
    puppeteer: {
      headless: isHeadless,
      protocolTimeout: 120000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--metrics-recording-only",
        "--mute-audio",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-component-update",
      ],
    },
    webVersionCache: {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1033090211-alpha.html",
    },
  });

  sessions[companySlug] = {
    client,
    qrCode: null,
    ready: false,
    connecting: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    lastDisconnectTime: null,
    lastDisconnectReason: null,
    destroying: false,
  };

  client.on("qr", (qr) => {
    console.log(`QR Code gerado para empresa: ${companySlug}`);
    sessions[companySlug].qrCode = qr;
  });

  client.on("authenticated", () => {
    console.log(`🔐 Cliente ${companySlug} autenticado - aguardando ready...`);
  });

  client.on("ready", async () => {
    console.log(`✅ WhatsApp conectado para empresa: ${companySlug}`);
    if (sessions[companySlug]) {
      sessions[companySlug].ready = true;
      sessions[companySlug].connecting = false;
      sessions[companySlug].qrCode = null;

      try {
        const info = client.info;
        console.log(`📱 Cliente ${companySlug} conectado como: ${info.wid._serialized}`);
      } catch (e) {
        console.log(`⚠️ Cliente ${companySlug} conectado mas sem info detalhada`);
      }
    }
  });

  client.on("disconnected", async (reason) => {
    console.log(`[EVENT] ${companySlug} disconnected: ${reason}`);
    if (!sessions[companySlug]) return;

    sessions[companySlug].ready = false;
    sessions[companySlug].qrCode = null;
    sessions[companySlug].lastDisconnectTime = Date.now();
    sessions[companySlug].lastDisconnectReason = reason;

    if (shouldAutoReconnect(reason)) {
      await scheduleReconnect(companySlug, reason);
    } else {
      console.log(
        `[EVENT] ${companySlug}: falha permanente (${reason}), destruindo sem reconnect`,
      );
      await safeDestroyClient(companySlug);
    }
  });

  client.on("auth_failure", async (msg) => {
    console.log(`[EVENT] ${companySlug} auth_failure: ${msg}`);
    await safeDestroyClient(companySlug);
  });

  client.on("change_state", (state) => {
    console.log(`[EVENT] ${companySlug} state changed: ${state}`);
    if (!sessions[companySlug]) return;

    if (state === "CONNECTED") {
      sessions[companySlug].ready = true;
      sessions[companySlug].reconnectAttempts = 0;
    }
    const badStates = ["UNPAIRED", "UNLAUNCHED", "UNPAIRED_IDLE"];
    if (badStates.includes(state as string)) {
      sessions[companySlug].ready = false;
      sessions[companySlug].connecting = false;
    }
  });

  client.on("error", async (error) => {
    console.log(`[EVENT] ${companySlug} error: ${error.message}`);
    if (!sessions[companySlug]) return;

    sessions[companySlug].ready = false;
    sessions[companySlug].connecting = false;

    const isBrowserError =
      error.message.includes("Protocol error") ||
      error.message.includes("Target closed") ||
      error.message.includes("Session closed") ||
      error.message.includes("Navigation failed");

    if (isBrowserError) {
      sessions[companySlug].lastDisconnectTime = Date.now();
      sessions[companySlug].lastDisconnectReason = `error:${error.message.substring(0, 50)}`;
      await scheduleReconnect(companySlug, `error:${error.message.substring(0, 50)}`);
    }
  });

  client.on("change_battery", (_batteryInfo) => {
    if (sessions[companySlug]) {
      sessions[companySlug].lastBatteryUpdate = Date.now();
    }
  });

  client.on("message", async (message) => {
    try {
      console.log(
        `📩 Mensagem recebida de ${message.from}: "${message.body?.substring(0, 50)}..."`,
      );

      const chat = await message.getChat();
      const aiResponse = await getAiResponse(message, chat, companySlug);

      if (aiResponse.success) {
        await raceWithTimeout(client.sendMessage(message.from, aiResponse.body!), 15000, "Timeout ao enviar mensagem - cliente pode ter desconectado");
        console.log(`✅ Mensagem enviada com sucesso pelo cliente ${companySlug}`);
      } else {
        if (typeof chat.markUnread === "function") {
          await chat.markUnread();
          console.log(
            `ℹ️ Mensagem marcada como não lida para atendimento humano - ${companySlug}`,
          );
        } else {
          console.log(
            `ℹ️ Sem resposta da IA para ${companySlug}, método markUnread não disponível nesta versão`,
          );
        }
      }
    } catch (error) {
      console.error(
        `❌ Erro ao processar mensagem para ${companySlug}:`,
        (error as Error).message,
      );
    }
  });

  sessions[companySlug].connecting = true;
  await client.initialize();
}

export async function waitForQrCode(
  companySlug: string,
  timeout = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.log(
        `⏰ Timeout ao aguardar QR Code para ${companySlug} após ${timeout / 1000}s`,
      );
      reject(
        new Error(`Timeout ao gerar QR Code para ${companySlug}. Tente novamente.`),
      );
    }, timeout);

    const interval = setInterval(() => {
      if (
        sessions[companySlug] &&
        (sessions[companySlug].qrCode || sessions[companySlug].ready)
      ) {
        clearTimeout(timeoutId);
        clearInterval(interval);
        console.log(`✅ QR Code gerado ou cliente conectado para ${companySlug}`);
        resolve();
      }

      if (!sessions[companySlug]) {
        clearTimeout(timeoutId);
        clearInterval(interval);
        reject(new Error(`Sessão ${companySlug} foi removida durante a espera`));
      }
    }, 1000);
  });
}
