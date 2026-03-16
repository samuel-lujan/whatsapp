import type { WAState } from "whatsapp-web.js";
import type { ConnectionStatus, StatusResult } from "../interfaces";
import { createSession } from "./client";
import { waitForQrCode, safeDestroyClient } from "./handlers";
import { sessions } from "./sessions";
import { markSessionAsReady } from "./utils";
import { raceWithTimeout } from "../../utils";

export async function getStatus(companySlug: string): Promise<StatusResult> {
  const isConnected = sessions[companySlug]?.ready;
  if (isConnected) {
    console.log(`✅ Cliente ${companySlug} já está conectado - não precisa de QR Code`);
    return { connected: isConnected };
  }

  const client = sessions[companySlug]?.client;
  if (client) {
    console.log(`🔍 Verificando estado real do cliente ${companySlug}...`);

    try {
      const state = (await raceWithTimeout(client.getState(), 5000)) as WAState | null;

      console.log(`📱 Estado atual do cliente ${companySlug}:`, state);

      if (state === "CONNECTED") {
        console.log(
          `🔧 Cliente ${companySlug} estava conectado mas não marcado como ready - corrigindo...`,
        );
        markSessionAsReady(companySlug);
        return { connected: true };
      }

      if (state == null) {
        console.log(
          `🔍 Estado ambíguo para ${companySlug}, tentando verificação prática...`,
        );
        try {
          const info = client.info;
          if (info && info.wid) {
            console.log(`🔧 Cliente ${companySlug} tem info válida - marcando como ready`);
            markSessionAsReady(companySlug);
            return { connected: true };
          }
        } catch (e) {
          console.log(
            `⚠️ Verificação alternativa falhou para ${companySlug}:`,
            (e as Error).message,
          );
        }
      }
      return { connected: false };
    } catch (error) {
      const msg = (error as Error).message;
      console.log(
        `⚠️ Cliente ${companySlug} não está realmente conectado:`,
        msg,
      );

      if (
        msg.includes("null") || msg.includes("destroyed") || msg === "timeout"
      ) {
        console.log(
          `[ZOMBIE] ${companySlug}: sessão zumbi detectada (connecting=${sessions[companySlug]?.connecting}, ready=${sessions[companySlug]?.ready}) - destruindo...`,
        );
        await safeDestroyClient(companySlug);
      }
    }
  }

  if (
    sessions[companySlug]?.connecting &&
    !sessions[companySlug]?.ready
  ) {
    console.log(`⏳ Cliente ${companySlug} ainda está conectando...`);
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));

    if (sessions[companySlug]?.ready) {
      console.log(`✅ Cliente ${companySlug} finalizou conexão durante a espera`);
      return { connected: true };
    }

    const qrCode = sessions[companySlug]?.qrCode;
    if (qrCode) {
      console.log(`📱 Cliente ${companySlug} ainda conectando - QR Code disponível`);
      return {
        connected: false,
        qrCode: qrCode,
        status: "connecting",
      };
    }
  }

  if (!sessions[companySlug]) {
    console.log(`🆕 Nenhuma sessão encontrada para ${companySlug} - criando nova...`);
    try {
      await createSession(companySlug);

      console.log(`⏳ Aguardando QR Code ou conexão automática para ${companySlug}...`);
      await waitForQrCode(companySlug, 20000);
    } catch (error) {
      console.log(
        `⚠️ Erro ao criar sessão/aguardar QR Code para ${companySlug}:`,
        (error as Error).message,
      );
      return {
        connected: false,
        error: (error as Error).message,
        suggestion: "Tente novamente - o WhatsApp pode estar inicializando",
      };
    }
  }

  if (sessions[companySlug]?.ready) {
    console.log(`✅ Cliente ${companySlug} conectou durante o processo`);
    return { connected: true };
  }

  const qrCode = sessions[companySlug]?.qrCode ?? null;
  console.log(
    `📱 Retornando status para ${companySlug} - QR Code: ${
      qrCode ? "Disponível" : "Não disponível"
    }`,
  );
  console.log(`🔍 Estado da sessão ${companySlug}:`, {
    exists: !!sessions[companySlug],
    ready: sessions[companySlug]?.ready ?? false,
    connecting: sessions[companySlug]?.connecting ?? false,
    hasQrCode: !!qrCode,
  });

  return {
    connected: false,
    qrCode: qrCode,
    message: qrCode ? "Escaneie o QR Code para conectar" : "Aguardando QR Code...",
  };
}

export function hasActiveSession(companySlug: string): boolean {
  return !!(
    (sessions[companySlug]?.ready || sessions[companySlug]?.connecting)
  );
}
 
export function checkConnectionStatus(companySlug: string): ConnectionStatus {
  
  const response: ConnectionStatus = { connected: false };

  if (sessions[companySlug]?.ready) {
    console.log(`✅ Verificação rápida: Cliente ${companySlug} está pronto`);
    response.connected = true;
  } else if (sessions[companySlug]?.client) {
    console.log(
      `🔍 Verificação rápida: Cliente ${companySlug} existe mas não está marcado como ready`,
    );

    try {
      const client = sessions[companySlug]?.client;
      if (client.pupPage && !client.pupPage.isClosed()) {
        console.log(
          `🤔 Cliente ${companySlug} pode estar conectado - recomendado verificação completa`,
        );
        response.status = "needs_verification";
        response.suggestion = "Use /status para verificação completa";
      }
    } catch (e) {
      console.log(
        `⚠️ Erro na verificação rápida do cliente ${companySlug}:`,
        (e as Error).message,
      );
    }
  } else if (sessions[companySlug]?.connecting) {
    console.log(`⏳ Verificação rápida: Cliente ${companySlug} ainda conectando`);
    response.status = "connecting";
  } else {
    console.log(`❌ Verificação rápida: Cliente ${companySlug} não conectado`);
  }
  return response;
}
