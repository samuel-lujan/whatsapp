import type { WAState } from "whatsapp-web.js";
import type { ConnectionStatus, StatusResult } from "../interfaces";
import { createSession, safeDestroyClient, waitForQrCode } from "./client";
import { sessions } from "./sessions";
import { raceWithTimeout } from "../../utils";

export async function getStatus(companySlug: string): Promise<StatusResult> {
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Cliente ${companySlug} já está conectado - não precisa de QR Code`);
    return { connected: true };
  }

  if (sessions[companySlug] && sessions[companySlug].client) {
    console.log(`🔍 Verificando estado real do cliente ${companySlug}...`);

    try {
      const client = sessions[companySlug].client;
      const state = (await raceWithTimeout(client.getState(), 5000)) as WAState | null;

      console.log(`📱 Estado atual do cliente ${companySlug}:`, state);

      if (state === "CONNECTED") {
        console.log(
          `🔧 Cliente ${companySlug} estava conectado mas não marcado como ready - corrigindo...`,
        );
        sessions[companySlug].ready = true;
        sessions[companySlug].connecting = false;
        sessions[companySlug].qrCode = null;
        return { connected: true };
      }

      if (state === null || state === undefined) {
        console.log(
          `🔍 Estado ambíguo para ${companySlug}, tentando verificação prática...`,
        );
        try {
          const info = client.info;
          if (info && info.wid) {
            console.log(`🔧 Cliente ${companySlug} tem info válida - marcando como ready`);
            sessions[companySlug].ready = true;
            sessions[companySlug].connecting = false;
            sessions[companySlug].qrCode = null;
            return { connected: true };
          }
        } catch (e) {
          console.log(
            `⚠️ Verificação alternativa falhou para ${companySlug}:`,
            (e as Error).message,
          );
        }
      }
    } catch (error) {
      console.log(
        `⚠️ Cliente ${companySlug} não está realmente conectado:`,
        (error as Error).message,
      );

      if (
        (error as Error).message.includes("null") ||
        (error as Error).message.includes("destroyed") ||
        (error as Error).message === "timeout"
      ) {
        console.log(
          `[ZOMBIE] ${companySlug}: sessão zumbi detectada (connecting=${sessions[companySlug]?.connecting}, ready=${sessions[companySlug]?.ready}) - destruindo...`,
        );
        await safeDestroyClient(companySlug);
      }
    }
  }

  if (
    sessions[companySlug] &&
    sessions[companySlug].connecting &&
    !sessions[companySlug].ready
  ) {
    console.log(`⏳ Cliente ${companySlug} ainda está conectando...`);
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));

    if (sessions[companySlug] && sessions[companySlug].ready) {
      console.log(`✅ Cliente ${companySlug} finalizou conexão durante a espera`);
      return { connected: true };
    }

    if (sessions[companySlug] && sessions[companySlug].qrCode) {
      console.log(`📱 Cliente ${companySlug} ainda conectando - QR Code disponível`);
      return {
        connected: false,
        qrCode: sessions[companySlug].qrCode,
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

  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Cliente ${companySlug} conectou durante o processo`);
    return { connected: true };
  }

  const qrCode = sessions[companySlug] ? sessions[companySlug].qrCode : null;
  console.log(
    `📱 Retornando status para ${companySlug} - QR Code: ${
      qrCode ? "Disponível" : "Não disponível"
    }`,
  );
  console.log(`🔍 Estado da sessão ${companySlug}:`, {
    exists: !!sessions[companySlug],
    ready: sessions[companySlug] ? sessions[companySlug].ready : false,
    connecting: sessions[companySlug] ? sessions[companySlug].connecting : false,
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
    sessions[companySlug] &&
    (sessions[companySlug].ready || sessions[companySlug].connecting)
  );
}

export function checkConnectionStatus(companySlug: string): ConnectionStatus {
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Verificação rápida: Cliente ${companySlug} está pronto`);
    return { connected: true };
  }

  if (sessions[companySlug] && sessions[companySlug].client) {
    console.log(
      `🔍 Verificação rápida: Cliente ${companySlug} existe mas não está marcado como ready`,
    );

    try {
      const client = sessions[companySlug].client;
      if (client.pupPage && !client.pupPage.isClosed()) {
        console.log(
          `🤔 Cliente ${companySlug} pode estar conectado - recomendado verificação completa`,
        );
        return {
          connected: false,
          status: "needs_verification",
          suggestion: "Use /status para verificação completa",
        };
      }
    } catch (e) {
      console.log(
        `⚠️ Erro na verificação rápida do cliente ${companySlug}:`,
        (e as Error).message,
      );
    }
  }

  if (sessions[companySlug] && sessions[companySlug].connecting) {
    console.log(`⏳ Verificação rápida: Cliente ${companySlug} ainda conectando`);
    return { connected: false, status: "connecting" };
  }

  console.log(`❌ Verificação rápida: Cliente ${companySlug} não conectado`);
  return { connected: false };
}
