const { getAiReponse } = require("./langchain.js");

const { Client, LocalAuth } = require("whatsapp-web.js");

const sessions = {};

async function getStatus(companySlug) {
  // PRIMEIRA VERIFICAÇÃO: Se já existe uma sessão conectada
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(
      `✅ Cliente ${companySlug} já está conectado - não precisa de QR Code`
    );
    return { connected: true };
  }

  // SEGUNDA VERIFICAÇÃO: Se existe sessão mas não está marcada como ready, vamos testar diretamente
  if (sessions[companySlug] && sessions[companySlug].client) {
    console.log(`🔍 Verificando estado real do cliente ${companySlug}...`);

    try {
      // Tenta uma operação que só funciona se estiver conectado
      const client = sessions[companySlug].client;
      const info = await Promise.race([
        client.getState(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000)
        ),
      ]);

      console.log(`📱 Estado atual do cliente ${companySlug}:`, info);

      if (info === "CONNECTED") {
        console.log(
          `🔧 Cliente ${companySlug} estava conectado mas não marcado como ready - corrigindo...`
        );
        sessions[companySlug].ready = true;
        sessions[companySlug].connecting = false;
        sessions[companySlug].qrCode = null;
        return { connected: true };
      }
    } catch (error) {
      console.log(
        `⚠️ Cliente ${companySlug} não está realmente conectado:`,
        error.message
      );
      // Continua com o fluxo normal
    }
  }

  // TERCEIRA VERIFICAÇÃO: Se está conectando
  if (
    sessions[companySlug] &&
    sessions[companySlug].connecting &&
    !sessions[companySlug].ready
  ) {
    console.log(`⏳ Cliente ${companySlug} ainda está conectando...`);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (sessions[companySlug] && sessions[companySlug].ready) {
      console.log(
        `✅ Cliente ${companySlug} finalizou conexão durante a espera`
      );
      return { connected: true };
    }

    if (sessions[companySlug] && sessions[companySlug].qrCode) {
      console.log(
        `📱 Cliente ${companySlug} ainda conectando - QR Code disponível`
      );
      return {
        connected: false,
        qrCode: sessions[companySlug].qrCode,
        status: "connecting",
      };
    }
  }

  // QUARTA VERIFICAÇÃO: Só cria nova sessão se realmente não existe
  if (!sessions[companySlug]) {
    console.log(
      `🆕 Nenhuma sessão encontrada para ${companySlug} - criando nova...`
    );
    try {
      await createSession(companySlug);

      console.log(
        `⏳ Aguardando QR Code ou conexão automática para ${companySlug}...`
      );
      await waitForQrCode(companySlug, 20000); // 20 segundos
    } catch (error) {
      console.log(
        `⚠️ Erro ao criar sessão/aguardar QR Code para ${companySlug}:`,
        error.message
      );
      return {
        connected: false,
        error: error.message,
        suggestion: "Tente novamente - o WhatsApp pode estar inicializando",
      };
    }
  }

  // VERIFICAÇÃO FINAL
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Cliente ${companySlug} conectou durante o processo`);
    return { connected: true };
  }

  const qrCode = sessions[companySlug] ? sessions[companySlug].qrCode : null;
  console.log(
    `📱 Retornando status para ${companySlug} - QR Code: ${
      qrCode ? "Disponível" : "Não disponível"
    }`
  );
  console.log(`🔍 Estado da sessão ${companySlug}:`, {
    exists: !!sessions[companySlug],
    ready: sessions[companySlug] ? sessions[companySlug].ready : false,
    connecting: sessions[companySlug]
      ? sessions[companySlug].connecting
      : false,
    hasQrCode: !!qrCode,
  });

  return {
    connected: false,
    qrCode: qrCode,
    message: qrCode
      ? "Escaneie o QR Code para conectar"
      : "Aguardando QR Code...",
  };
}

function hasActiveSession(companySlug) {
  return (
    sessions[companySlug] &&
    (sessions[companySlug].ready || sessions[companySlug].connecting)
  );
}

function checkConnectionStatus(companySlug) {
  // Verificação básica primeiro
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Verificação rápida: Cliente ${companySlug} está pronto`);
    return { connected: true };
  }

  // Se existe sessão mas não está marcada como ready, vamos investigar
  if (sessions[companySlug] && sessions[companySlug].client) {
    console.log(
      `🔍 Verificação rápida: Cliente ${companySlug} existe mas não está marcado como ready`
    );

    // Tenta uma verificação síncrona básica
    try {
      const client = sessions[companySlug].client;
      // Se o cliente tem pupPage e não está fechado, pode estar conectado
      if (client.pupPage && !client.pupPage.isClosed()) {
        console.log(
          `🤔 Cliente ${companySlug} pode estar conectado - recomendado verificação completa`
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
        e.message
      );
    }
  }

  if (sessions[companySlug] && sessions[companySlug].connecting) {
    console.log(
      `⏳ Verificação rápida: Cliente ${companySlug} ainda conectando`
    );
    return { connected: false, status: "connecting" };
  }

  console.log(`❌ Verificação rápida: Cliente ${companySlug} não conectado`);
  return { connected: false };
}

async function createSession(companySlug) {
  const isProduction = process.env.NODE_ENV === "production";
  const isHeadless = isProduction || process.env.HEADLESS === "true";

  console.log(`🖥️ Ambiente: ${isProduction ? "PRODUÇÃO" : "DESENVOLVIMENTO"}`);
  console.log(
    `🌐 Browser: ${isHeadless ? "HEADLESS (sem interface)" : "COM INTERFACE"}`
  );

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: companySlug }),
    puppeteer: {
      headless: isHeadless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
  });

  sessions[companySlug] = {
    client,
    qrCode: null,
    ready: false,
    connecting: false,
  };

  client.on("qr", (qr) => {
    console.log(`QR Code gerado para empresa: ${companySlug}`);
    sessions[companySlug].qrCode = qr;
  });

  client.on("authenticated", (session) => {
    console.log(`🔐 Cliente ${companySlug} autenticado - sessão salva`);
    if (sessions[companySlug]) {
      sessions[companySlug].connecting = false; // Já foi autenticado
    }
  });

  client.on("ready", async () => {
    console.log(`✅ WhatsApp conectado para empresa: ${companySlug}`);
    if (sessions[companySlug]) {
      sessions[companySlug].ready = true;
      sessions[companySlug].connecting = false;
      sessions[companySlug].qrCode = null; // Limpa QR Code após conexão

      // Tenta obter info do cliente para confirmar conexão
      try {
        const info = await client.info;
        console.log(
          `📱 Cliente ${companySlug} conectado como: ${info.wid._serialized}`
        );
      } catch (e) {
        console.log(
          `⚠️ Cliente ${companySlug} conectado mas sem info detalhada`
        );
      }
    }
  });

  client.on("disconnected", (reason) => {
    console.log(
      `❌ WhatsApp desconectado para empresa ${companySlug}:`,
      reason
    );
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      sessions[companySlug].qrCode = null;
    }
  });

  client.on("auth_failure", (msg) => {
    console.log(`🚫 Falha de autenticação para empresa ${companySlug}:`, msg);
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      sessions[companySlug].qrCode = null;
    }
  });

  client.on("change_state", (state) => {
    console.log(`🔄 Estado alterado para empresa ${companySlug}:`, state);
    if (
      state === "DISCONNECTED" ||
      state === "UNPAIRED" ||
      state === "UNLAUNCHED"
    ) {
      if (sessions[companySlug]) {
        sessions[companySlug].ready = false;
        sessions[companySlug].connecting = false;
        sessions[companySlug].qrCode = null;
      }
    }
  });

  // Captura erros do puppeteer/chrome
  client.on("error", (error) => {
    console.log(`❌ Erro no cliente ${companySlug}:`, error.message);
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      sessions[companySlug].connecting = false;
      sessions[companySlug].qrCode = null;
    }
  });

  // Monitora se a página foi fechada/perdida
  client.on("change_battery", (batteryInfo) => {
    // Este evento para de disparar quando desconecta
    if (sessions[companySlug]) {
      sessions[companySlug].lastBatteryUpdate = Date.now();
    }
  });

  client.on("message", async (message) => {
    const chat = await message.getChat();
    const aiResponse = getAiReponse(message, chat, companySlug);

    if (aiResponse.success) {
      await Promise.race([
        client.sendMessage(message.from, aiResponse.body), // aqui
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "Timeout ao enviar mensagem - cliente pode ter desconectado"
                )
              ),
            15000
          )
        ),
      ]);

      console.log(
        `✅ Mensagem enviada com sucesso pelo cliente ${companySlug}`
      );
    } else {
      await chat.markUnread(); // Marca como não lida se não for texto ou for grupo
    }
  });

  sessions[companySlug].connecting = true;
  await client.initialize();
}

// Função para aguardar QR Code ser gerado
async function waitForQrCode(companySlug, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.log(
        `⏰ Timeout ao aguardar QR Code para ${companySlug} após ${
          timeout / 1000
        }s`
      );
      reject(
        new Error(
          `Timeout ao gerar QR Code para ${companySlug}. Tente novamente.`
        )
      );
    }, timeout);

    const interval = setInterval(() => {
      if (
        sessions[companySlug] &&
        (sessions[companySlug].qrCode || sessions[companySlug].ready)
      ) {
        clearTimeout(timeoutId);
        clearInterval(interval);
        console.log(
          `✅ QR Code gerado ou cliente conectado para ${companySlug}`
        );
        resolve();
      }

      // Verifica se a sessão foi perdida/removida
      if (!sessions[companySlug]) {
        clearTimeout(timeoutId);
        clearInterval(interval);
        reject(
          new Error(`Sessão ${companySlug} foi removida durante a espera`)
        );
      }
    }, 1000); // Verifica a cada 1 segundo ao invés de 500ms
  });
}

// Função para verificar se o cliente está realmente funcional
async function verifyClientHealth(companySlug) {
  if (!sessions[companySlug] || !sessions[companySlug].client) {
    return { healthy: false, reason: "Sessão não existe" };
  }

  const client = sessions[companySlug].client;

  try {
    // Tenta várias verificações para garantir que está funcionando
    const checks = await Promise.all([
      // Verifica estado
      Promise.race([
        client.getState(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout-state")), 3000)
        ),
      ]),

      // Tenta obter informações básicas
      Promise.race([
        client.info,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout-info")), 3000)
        ),
      ]).catch(() => null), // Não falha se info não estiver disponível
    ]);

    const [state, info] = checks;

    if (state !== "CONNECTED") {
      console.log(
        `⚠️ Cliente ${companySlug} não está no estado CONNECTED (atual: ${state})`
      );
      return {
        healthy: false,
        reason: `Estado inválido: ${state}`,
        shouldReconnect: true,
      };
    }

    console.log(`✅ Cliente ${companySlug} passou na verificação de saúde`);
    return {
      healthy: true,
      state,
      info: info ? info.wid._serialized : "N/A",
    };
  } catch (error) {
    console.log(
      `❌ Cliente ${companySlug} falhou na verificação de saúde:`,
      error.message
    );
    return {
      healthy: false,
      reason: error.message,
      shouldReconnect: true,
    };
  }
}

// Função para encontrar o chat correto para um número
async function findCorrectChatId(client, number) {
  const cleanNumber = number.replace(/\D/g, "");
  const possibleChatIds = [
    `${cleanNumber}@c.us`,
    `${cleanNumber}@s.whatsapp.net`,
  ];

  console.log(`🔍 Procurando chat existente para número: ${cleanNumber}`);

  try {
    // PRIMEIRA TENTATIVA: Buscar por chats existentes
    const chats = await client.getChats();

    for (const chat of chats) {
      const chatNumber = chat.id.user;
      if (chatNumber === cleanNumber) {
        console.log(
          `✅ Encontrou chat existente: ${chat.id._serialized} (nome: ${chat.name})`
        );
        return {
          chatId: chat.id._serialized,
          isExistingChat: true,
          chatName: chat.name,
          isGroup: chat.isGroup,
        };
      }
    }

    // SEGUNDA TENTATIVA: Verificar se é um contato salvo
    console.log(
      `🔍 Não encontrou chat existente, verificando contatos salvos...`
    );
    const contacts = await client.getContacts();

    for (const contact of contacts) {
      const contactNumber = contact.id.user;
      if (contactNumber === cleanNumber) {
        console.log(
          `✅ Encontrou contato salvo: ${contact.id._serialized} (nome: ${
            contact.name || contact.pushname
          })`
        );
        return {
          chatId: contact.id._serialized,
          isExistingChat: false,
          contactName: contact.name || contact.pushname,
          isContact: true,
        };
      }
    }

    // TERCEIRA TENTATIVA: Verificar se o número está registrado no WhatsApp
    console.log(
      `🔍 Verificando se número ${cleanNumber} está registrado no WhatsApp...`
    );
    const isRegistered = await client.isRegisteredUser(`${cleanNumber}@c.us`);

    if (isRegistered) {
      console.log(
        `✅ Número ${cleanNumber} está registrado, usando formato padrão`
      );
      return {
        chatId: `${cleanNumber}@c.us`,
        isExistingChat: false,
        isRegistered: true,
      };
    } else {
      console.log(`⚠️ Número ${cleanNumber} não está registrado no WhatsApp`);
      // Mesmo assim tenta enviar, pode ser que funcione
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
      error.message
    );
    return {
      chatId: `${cleanNumber}@c.us`,
      isExistingChat: false,
      error: error.message,
    };
  }
}

// Função para enviar mensagem com verificação robusta
async function sendMessage(companySlug, number, message) {
  if (!sessions[companySlug] || !sessions[companySlug].ready) {
    throw new Error(`Empresa ${companySlug} não está conectada ao WhatsApp`);
  }

  // PRIMEIRA TENTATIVA: Verifica a saúde do cliente antes de enviar
  console.log(
    `🔍 Verificando saúde do cliente ${companySlug} antes de enviar mensagem...`
  );
  const healthCheck = await verifyClientHealth(companySlug);

  if (!healthCheck.healthy) {
    console.log(
      `⚠️ Cliente ${companySlug} não está saudável:`,
      healthCheck.reason
    );

    // Marca como não conectado para forçar reconexão
    sessions[companySlug].ready = false;

    if (healthCheck.shouldReconnect) {
      throw new Error(
        `Cliente ${companySlug} perdeu conexão. Erro: ${healthCheck.reason}. Acesse /status/${companySlug} para reconectar.`
      );
    } else {
      throw new Error(
        `Cliente ${companySlug} não está funcional: ${healthCheck.reason}`
      );
    }
  }

  try {
    // Remove máscaras e formata para WhatsApp
    let cleanNumber = number.replace(/\D/g, ""); // Remove tudo que não é dígito
    console.log(
      `🔢 Número após limpeza: ${cleanNumber} (${cleanNumber.length} dígitos)`
    );

    // Adiciona 55 APENAS se não começar com 55
    if (!cleanNumber.startsWith("55")) {
      cleanNumber = "55" + cleanNumber;
      console.log(`➕ Adicionado código 55: ${cleanNumber}`);
    } else {
      console.log(`✅ Número já tem código 55: ${cleanNumber}`);
    }

    // Formata para o padrão do WhatsApp
    let chatId = cleanNumber + "@c.us";
    console.log(`📱 ChatId final: ${chatId}`);

    const client = sessions[companySlug].client;
    console.log(`🔍 Procurando chat para ${chatId}`);

    // PRIMEIRA VERIFICAÇÃO: Procura o chat original - sem timeout, leva o tempo que for
    let chat = null;
    let contact = null;
    let isValidWhatsAppUser = false;

    console.log(
      `🔍 Verificando se ${chatId} é um usuário válido do WhatsApp...`
    );
    try {
      chat = await client.getChatById(chatId);
      contact = await chat.getContact();

      // Verifica se é realmente um usuário válido do WhatsApp
      if (
        contact &&
        contact.pushname !== null &&
        contact.pushname !== undefined &&
        contact.pushname !== ""
      ) {
        console.log(
          `✅ Usuário válido encontrado - Pushname: ${contact.pushname}`
        );
        isValidWhatsAppUser = true;
      } else {
        console.log(
          `⚠️ Chat encontrado mas pushname inválido: ${
            contact?.pushname || "undefined/null"
          }`
        );
        isValidWhatsAppUser = false;
      }
    } catch (e) {
      console.log(
        `❌ Não é um usuário válido do WhatsApp: ${chatId} - ${e.message}`
      );
      isValidWhatsAppUser = false;
    }
    // SEGUNDA VERIFICAÇÃO: Se não é usuário válido, tenta remover o 9 (APENAS quando necessário)
    if (!isValidWhatsAppUser) {
      console.log(
        `🔄 Número original não é usuário válido do WhatsApp, tentando versão sem o 9...`
      );

      // Se o número tem pelo menos 13 dígitos e tem 9 na posição correta (após DDD)
      if (cleanNumber.length >= 13 && cleanNumber.charAt(4) === "9") {
        const alternativeNumber =
          cleanNumber.substring(0, 4) + cleanNumber.substring(5);
        const alternativeChatId = alternativeNumber + "@c.us";
        console.log(
          `� Verificando se ${alternativeChatId} é um usuário válido do WhatsApp...`
        );

        try {
          const alternativeChat = await client.getChatById(alternativeChatId);
          const alternativeContact = await alternativeChat.getContact();

          // Verifica se o número alternativo é um usuário válido
          if (
            alternativeChat &&
            alternativeContact &&
            alternativeContact.pushname !== null &&
            alternativeContact.pushname !== undefined &&
            alternativeContact.pushname !== ""
          ) {
            console.log(
              `✅ Usuário válido encontrado na versão alternativa - Pushname: ${alternativeContact.pushname}`
            );
            chat = alternativeChat;
            contact = alternativeContact;
            chatId = alternativeChatId;
            isValidWhatsAppUser = true;
          } else {
            console.log(
              `❌ Versão alternativa também não é usuário válido: pushname ${
                alternativeContact?.pushname || "undefined/null"
              }`
            );
          }
        } catch (e) {
          console.log(
            `❌ Versão alternativa também não é usuário válido do WhatsApp: ${alternativeChatId} - ${e.message}`
          );
        }
      } else {
        console.log(
          `❌ Número não tem formato esperado para remoção do 9 (${cleanNumber.length} dígitos)`
        );
      }
    }

    // Se ainda não encontrou um usuário com pushname válido, envia APENAS para a versão sem 9
    if (!isValidWhatsAppUser) {
      console.log(
        `⚠️ Nenhum usuário com pushname válido encontrado no WhatsApp para ${number}`
      );

      // Se o número tem 9 na posição correta, envia APENAS para a versão sem 9
      if (cleanNumber.length >= 13 && cleanNumber.charAt(4) === "9") {
        const alternativeNumber =
          cleanNumber.substring(0, 4) + cleanNumber.substring(5);
        const alternativeChatId = alternativeNumber + "@c.us";
        console.log(
          `📱 Enviando APENAS para versão sem 9: ${alternativeChatId}`
        );

        // Envia APENAS para o número alternativo (sem 9)
        console.log(
          `📤 Enviando mensagem do cliente ${companySlug} para ${alternativeChatId} (versão sem 9)`
        );

        await client.sendMessage(alternativeChatId, message);

        console.log(
          `✅ Mensagem enviada com sucesso pelo cliente ${companySlug} para versão sem 9: ${alternativeChatId}`
        );

        return {
          success: true,
          message: "Mensagem enviada com sucesso para versão sem 9",
          data: {
            companySlug,
            number: alternativeChatId,
            originalNumber: number,
            chatName: alternativeChatId,
            userPushname: "Usuário sem pushname válido",
            content: message,
            timestamp: new Date().toISOString(),
            sentToAlternative: true,
          },
        };
      } else {
        console.log(
          `❌ Número não tem formato esperado para remoção do 9, não enviando mensagem`
        );
        throw new Error(
          `Número ${number} não é um usuário válido do WhatsApp e não tem formato para tentativa alternativa`
        );
      }
    }

    // ENVIO NORMAL: Se encontrou usuário válido, envia normalmente
    console.log(
      `📤 Enviando mensagem do cliente ${companySlug} para ${chatId} - Usuário: ${contact.pushname}`
    );

    await client.sendMessage(chatId, message);

    console.log(
      `✅ Mensagem enviada com sucesso pelo cliente ${companySlug} para: ${contact.pushname}`
    );

    return {
      success: true,
      message: "Mensagem enviada com sucesso",
      data: {
        companySlug,
        number: chatId,
        chatName: chat.name,
        userPushname: contact.pushname,
        content: message,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error(
      `❌ Erro ao enviar mensagem pelo cliente ${companySlug}:`,
      error.message
    );

    // Se é erro 400 (número não válido), não marca como desconectado
    if (error.statusCode === 400) {
      throw error;
    }

    // Se houve erro, marca como não conectado
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      console.log(
        `🔄 Marcando cliente ${companySlug} como não conectado devido a erro no envio`
      );
    }

    // Retorna erro mais específico
    if (
      error.message.includes("getChat") ||
      error.message.includes("Cannot read properties")
    ) {
      throw new Error(
        `Cliente ${companySlug} perdeu conexão com WhatsApp Web. Acesse /status/${companySlug} para reconectar.`
      );
    }

    throw new Error(`Erro ao enviar mensagem: ${error.message}`);
  }
}

// Função para obter cliente de uma empresa
function getClient(companySlug) {
  if (sessions[companySlug] && sessions[companySlug].ready) {
    return sessions[companySlug].client;
  }
  return null;
}

// Função para forçar limpeza de uma sessão com logout completo
async function clearSession(companySlug) {
  if (!sessions[companySlug]) {
    console.log(`⚠️ Sessão ${companySlug} não existe`);
    return { success: false, message: "Sessão não existe" };
  }

  const client = sessions[companySlug].client;
  let logoutSuccess = false;
  let destroySuccess = false;

  console.log(`🧹 Iniciando limpeza completa da sessão ${companySlug}...`);

  // PRIMEIRO: Tenta fazer logout do WhatsApp (desconecta do celular)
  if (client) {
    try {
      console.log(`📱 Fazendo logout do WhatsApp para ${companySlug}...`);
      await Promise.race([
        client.logout(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout no logout")), 10000)
        ),
      ]);
      logoutSuccess = true;
      console.log(`✅ Logout realizado com sucesso para ${companySlug}`);
    } catch (e) {
      console.log(`⚠️ Erro no logout para ${companySlug}:`, e.message);
      // Continua mesmo se logout falhar
    }

    // SEGUNDO: Destroi o cliente (limpa sessão local)
    try {
      console.log(`🗑️ Destruindo cliente ${companySlug}...`);
      await client.destroy();
      destroySuccess = true;
      console.log(`✅ Cliente ${companySlug} destruído com sucesso`);
    } catch (e) {
      console.log(`⚠️ Erro ao destruir cliente ${companySlug}:`, e.message);
      // Continua mesmo se destroy falhar
    }
  }

  // TERCEIRO: Remove da lista de sessões
  delete sessions[companySlug];
  console.log(`🗑️ Sessão ${companySlug} removida da lista`);

  const result = {
    success: true,
    message: `Sessão ${companySlug} foi limpa`,
    details: {
      logoutSuccess,
      destroySuccess,
      sessionRemoved: true,
    },
  };

  if (logoutSuccess) {
    result.message += " e logout realizado no WhatsApp";
    result.whatsappLoggedOut = true;
  } else {
    result.message += " (logout do WhatsApp pode ter falhado)";
    result.whatsappLoggedOut = false;
  }

  return result;
}

// Função para debug - força verificação do estado real
async function debugSessionState(companySlug) {
  if (!sessions[companySlug]) {
    return { exists: false, message: "Sessão não existe" };
  }

  const session = sessions[companySlug];
  const debug = {
    exists: true,
    ready: session.ready,
    connecting: session.connecting,
    hasQrCode: !!session.qrCode,
    hasClient: !!session.client,
    lastBatteryUpdate: session.lastBatteryUpdate || null,
  };

  if (session.client) {
    try {
      const state = await Promise.race([
        session.client.getState(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 3000)
        ),
      ]);
      debug.realState = state;
      debug.isReallyConnected = state === "CONNECTED";

      if (state === "CONNECTED" && !session.ready) {
        console.log(`🔧 CORREÇÃO: Marcando ${companySlug} como conectado`);
        session.ready = true;
        session.connecting = false;
        session.qrCode = null;
      }
    } catch (error) {
      debug.realState = "ERROR";
      debug.error = error.message;
    }
  }

  return debug;
}

// Função para buscar informações de um número específico (para debug)
async function searchNumberInfo(companySlug, number) {
  if (!sessions[companySlug] || !sessions[companySlug].ready) {
    throw new Error(`Empresa ${companySlug} não está conectada ao WhatsApp`);
  }

  const client = sessions[companySlug].client;
  const cleanNumber = number.replace(/\D/g, "");

  console.log(`🔍 Buscando informações completas para número: ${cleanNumber}`);

  const info = {
    originalNumber: number,
    cleanNumber: cleanNumber,
    searchResults: {
      chats: [],
      contacts: [],
      registrationStatus: null,
    },
  };

  try {
    // Busca por chats
    const chats = await client.getChats();
    for (const chat of chats) {
      if (chat.id.user === cleanNumber) {
        info.searchResults.chats.push({
          id: chat.id._serialized,
          name: chat.name,
          isGroup: chat.isGroup,
          isReadOnly: chat.isReadOnly,
          unreadCount: chat.unreadCount,
          timestamp: chat.timestamp,
        });
      }
    }

    // Busca por contatos
    const contacts = await client.getContacts();
    for (const contact of contacts) {
      if (contact.id.user === cleanNumber) {
        info.searchResults.contacts.push({
          id: contact.id._serialized,
          name: contact.name,
          pushname: contact.pushname,
          isMyContact: contact.isMyContact,
          isUser: contact.isUser,
          isWAContact: contact.isWAContact,
        });
      }
    }

    // Verifica se está registrado
    try {
      info.searchResults.registrationStatus = await client.isRegisteredUser(
        `${cleanNumber}@c.us`
      );
    } catch (e) {
      info.searchResults.registrationStatus = `Erro: ${e.message}`;
    }

    // Usa a função de busca de chat correto
    const chatInfo = await findCorrectChatId(client, number);
    info.recommendedChatId = chatInfo;

    return info;
  } catch (error) {
    throw new Error(`Erro ao buscar informações: ${error.message}`);
  }
}

// Função para listar todas as sessões (para debug)
function listSessions() {
  const sessionList = {};
  for (const [companySlug, session] of Object.entries(sessions)) {
    sessionList[companySlug] = {
      ready: session.ready,
      connecting: session.connecting,
      hasQrCode: !!session.qrCode,
      lastBatteryUpdate: session.lastBatteryUpdate || null,
    };
  }
  return sessionList;
}

// Função para fazer logout de todas as sessões ativas
async function clearAllSessions() {
  const results = {};
  const sessionKeys = Object.keys(sessions);

  console.log(
    `🧹 Iniciando limpeza de todas as sessões (${sessionKeys.length} sessões)`
  );

  if (sessionKeys.length === 0) {
    return {
      success: true,
      message: "Nenhuma sessão ativa para limpar",
      sessions: {},
    };
  }

  // Processa todas as sessões em paralelo
  const promises = sessionKeys.map(async (companySlug) => {
    try {
      const result = await clearSession(companySlug);
      results[companySlug] = result;
    } catch (error) {
      results[companySlug] = {
        success: false,
        message: `Erro ao limpar sessão: ${error.message}`,
        error: error.message,
      };
    }
  });

  await Promise.all(promises);

  const successCount = Object.values(results).filter((r) => r.success).length;
  const logoutCount = Object.values(results).filter(
    (r) => r.whatsappLoggedOut
  ).length;

  console.log(
    `✅ Limpeza concluída: ${successCount}/${sessionKeys.length} sessões limpas, ${logoutCount} com logout do WhatsApp`
  );

  return {
    success: true,
    message: `Processadas ${sessionKeys.length} sessões`,
    summary: {
      total: sessionKeys.length,
      successful: successCount,
      withLogout: logoutCount,
      failed: sessionKeys.length - successCount,
    },
    sessions: results,
  };
}

module.exports = {
  getStatus,
  checkConnectionStatus,
  hasActiveSession,
  verifyClientHealth,
  debugSessionState,
  sendMessage,
  getClient,
  clearSession,
  clearAllSessions,
  listSessions,
  searchNumberInfo,
};
