const { Client, LocalAuth } = require('whatsapp-web.js');

const sessions = {};

async function getStatus(companySlug) {
  // PRIMEIRA VERIFICAÇÃO: Se já existe uma sessão conectada
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Cliente ${companySlug} já está conectado - não precisa de QR Code`);
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
      
      console.log(`📱 Estado atual do cliente ${companySlug}:`, info);
      
      if (info === 'CONNECTED') {
        console.log(`🔧 Cliente ${companySlug} estava conectado mas não marcado como ready - corrigindo...`);
        sessions[companySlug].ready = true;
        sessions[companySlug].connecting = false;
        sessions[companySlug].qrCode = null;
        return { connected: true };
      }
      
    } catch (error) {
      console.log(`⚠️ Cliente ${companySlug} não está realmente conectado:`, error.message);
      // Continua com o fluxo normal
    }
  }
  
  // TERCEIRA VERIFICAÇÃO: Se está conectando
  if (sessions[companySlug] && sessions[companySlug].connecting && !sessions[companySlug].ready) {
    console.log(`⏳ Cliente ${companySlug} ainda está conectando...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    if (sessions[companySlug] && sessions[companySlug].ready) {
      console.log(`✅ Cliente ${companySlug} finalizou conexão durante a espera`);
      return { connected: true };
    }
    
    if (sessions[companySlug] && sessions[companySlug].qrCode) {
      console.log(`📱 Cliente ${companySlug} ainda conectando - QR Code disponível`);
      return { 
        connected: false, 
        qrCode: sessions[companySlug].qrCode,
        status: 'connecting'
      };
    }
  }

  // QUARTA VERIFICAÇÃO: Só cria nova sessão se realmente não existe
  if (!sessions[companySlug]) {
    console.log(`🆕 Nenhuma sessão encontrada para ${companySlug} - criando nova...`);
    try {
      await createSession(companySlug);
      
      console.log(`⏳ Aguardando QR Code ou conexão automática para ${companySlug}...`);
      await waitForQrCode(companySlug, 20000); // 20 segundos
      
    } catch (error) {
      console.log(`⚠️ Erro ao criar sessão/aguardar QR Code para ${companySlug}:`, error.message);
      return { 
        connected: false, 
        error: error.message,
        suggestion: "Tente novamente - o WhatsApp pode estar inicializando" 
      };
    }
  }

  // VERIFICAÇÃO FINAL
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Cliente ${companySlug} conectou durante o processo`);
    return { connected: true };
  }

  const qrCode = sessions[companySlug] ? sessions[companySlug].qrCode : null;
  console.log(`📱 Retornando status para ${companySlug} - QR Code: ${qrCode ? 'Disponível' : 'Não disponível'}`);
  console.log(`🔍 Estado da sessão ${companySlug}:`, {
    exists: !!sessions[companySlug],
    ready: sessions[companySlug] ? sessions[companySlug].ready : false,
    connecting: sessions[companySlug] ? sessions[companySlug].connecting : false,
    hasQrCode: !!qrCode
  });
  
  return { 
    connected: false, 
    qrCode: qrCode,
    message: qrCode ? "Escaneie o QR Code para conectar" : "Aguardando QR Code..."
  };
}

function hasActiveSession(companySlug) {
  return sessions[companySlug] && (sessions[companySlug].ready || sessions[companySlug].connecting);
}

function checkConnectionStatus(companySlug) {
  // Verificação básica primeiro
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Verificação rápida: Cliente ${companySlug} está pronto`);
    return { connected: true };
  }
  
  // Se existe sessão mas não está marcada como ready, vamos investigar
  if (sessions[companySlug] && sessions[companySlug].client) {
    console.log(`🔍 Verificação rápida: Cliente ${companySlug} existe mas não está marcado como ready`);
    
    // Tenta uma verificação síncrona básica
    try {
      const client = sessions[companySlug].client;
      // Se o cliente tem pupPage e não está fechado, pode estar conectado
      if (client.pupPage && !client.pupPage.isClosed()) {
        console.log(`🤔 Cliente ${companySlug} pode estar conectado - recomendado verificação completa`);
        return { connected: false, status: 'needs_verification', suggestion: 'Use /status para verificação completa' };
      }
    } catch (e) {
      console.log(`⚠️ Erro na verificação rápida do cliente ${companySlug}:`, e.message);
    }
  }
  
  if (sessions[companySlug] && sessions[companySlug].connecting) {
    console.log(`⏳ Verificação rápida: Cliente ${companySlug} ainda conectando`);
    return { connected: false, status: 'connecting' };
  }
  
  console.log(`❌ Verificação rápida: Cliente ${companySlug} não conectado`);
  return { connected: false };
}

async function createSession(companySlug) {
  const isProduction = process.env.NODE_ENV === 'production';
  const isHeadless = isProduction || process.env.HEADLESS === 'true';
  
  console.log(`🖥️ Ambiente: ${isProduction ? 'PRODUÇÃO' : 'DESENVOLVIMENTO'}`);
  console.log(`🌐 Browser: ${isHeadless ? 'HEADLESS (sem interface)' : 'COM INTERFACE'}`);
  
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: companySlug }),
    puppeteer: { 
      headless: isHeadless,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  sessions[companySlug] = { 
    client, 
    qrCode: null, 
    ready: false,
    connecting: false
  };

  client.on('qr', (qr) => {
    console.log(`QR Code gerado para empresa: ${companySlug}`);
    sessions[companySlug].qrCode = qr;
  });

  client.on('authenticated', (session) => {
    console.log(`🔐 Cliente ${companySlug} autenticado - sessão salva`);
    if (sessions[companySlug]) {
      sessions[companySlug].connecting = false; // Já foi autenticado
    }
  });

  client.on('ready', async () => {
    console.log(`✅ WhatsApp conectado para empresa: ${companySlug}`);
    if (sessions[companySlug]) {
      sessions[companySlug].ready = true;
      sessions[companySlug].connecting = false;
      sessions[companySlug].qrCode = null; // Limpa QR Code após conexão
      
      // Tenta obter info do cliente para confirmar conexão
      try {
        const info = await client.info;
        console.log(`📱 Cliente ${companySlug} conectado como: ${info.wid._serialized}`);
      } catch (e) {
        console.log(`⚠️ Cliente ${companySlug} conectado mas sem info detalhada`);
      }
    }
  });

  client.on('disconnected', (reason) => {
    console.log(`❌ WhatsApp desconectado para empresa ${companySlug}:`, reason);
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      sessions[companySlug].qrCode = null;
    }
  });

  client.on('auth_failure', (msg) => {
    console.log(`🚫 Falha de autenticação para empresa ${companySlug}:`, msg);
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      sessions[companySlug].qrCode = null;
    }
  });

  client.on('change_state', (state) => {
    console.log(`🔄 Estado alterado para empresa ${companySlug}:`, state);
    if (state === 'DISCONNECTED' || state === 'UNPAIRED' || state === 'UNLAUNCHED') {
      if (sessions[companySlug]) {
        sessions[companySlug].ready = false;
        sessions[companySlug].connecting = false;
        sessions[companySlug].qrCode = null;
      }
    }
  });

  // Captura erros do puppeteer/chrome
  client.on('error', (error) => {
    console.log(`❌ Erro no cliente ${companySlug}:`, error.message);
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      sessions[companySlug].connecting = false;
      sessions[companySlug].qrCode = null;
    }
  });

  // Monitora se a página foi fechada/perdida
  client.on('change_battery', (batteryInfo) => {
    // Este evento para de disparar quando desconecta
    if (sessions[companySlug]) {
      sessions[companySlug].lastBatteryUpdate = Date.now();
    }
  });

  sessions[companySlug].connecting = true;
  await client.initialize();
}

// Função para aguardar QR Code ser gerado
async function waitForQrCode(companySlug, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.log(`⏰ Timeout ao aguardar QR Code para ${companySlug} após ${timeout/1000}s`);
      reject(new Error(`Timeout ao gerar QR Code para ${companySlug}. Tente novamente.`));
    }, timeout);

    const interval = setInterval(() => {
      if (sessions[companySlug] && (sessions[companySlug].qrCode || sessions[companySlug].ready)) {
        clearTimeout(timeoutId);
        clearInterval(interval);
        console.log(`✅ QR Code gerado ou cliente conectado para ${companySlug}`);
        resolve();
      }
      
      // Verifica se a sessão foi perdida/removida
      if (!sessions[companySlug]) {
        clearTimeout(timeoutId);
        clearInterval(interval);
        reject(new Error(`Sessão ${companySlug} foi removida durante a espera`));
      }
    }, 1000); // Verifica a cada 1 segundo ao invés de 500ms
  });
}

// Função para verificar se o cliente está realmente funcional
async function verifyClientHealth(companySlug) {
  if (!sessions[companySlug] || !sessions[companySlug].client) {
    return { healthy: false, reason: 'Sessão não existe' };
  }
  
  const client = sessions[companySlug].client;
  
  try {
    // Tenta várias verificações para garantir que está funcionando
    const checks = await Promise.all([
      // Verifica estado
      Promise.race([
        client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-state')), 3000))
      ]),
      
      // Tenta obter informações básicas
      Promise.race([
        client.info,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-info')), 3000))
      ]).catch(() => null) // Não falha se info não estiver disponível
    ]);
    
    const [state, info] = checks;
    
    if (state !== 'CONNECTED') {
      console.log(`⚠️ Cliente ${companySlug} não está no estado CONNECTED (atual: ${state})`);
      return { 
        healthy: false, 
        reason: `Estado inválido: ${state}`,
        shouldReconnect: true 
      };
    }
    
    console.log(`✅ Cliente ${companySlug} passou na verificação de saúde`);
    return { 
      healthy: true, 
      state, 
      info: info ? info.wid._serialized : 'N/A' 
    };
    
  } catch (error) {
    console.log(`❌ Cliente ${companySlug} falhou na verificação de saúde:`, error.message);
    return { 
      healthy: false, 
      reason: error.message,
      shouldReconnect: true 
    };
  }
}

// Função para enviar mensagem com verificação robusta
async function sendMessage(companySlug, number, message) {
  if (!sessions[companySlug] || !sessions[companySlug].ready) {
    throw new Error(`Empresa ${companySlug} não está conectada ao WhatsApp`);
  }

  // PRIMEIRA TENTATIVA: Verifica a saúde do cliente antes de enviar
  console.log(`🔍 Verificando saúde do cliente ${companySlug} antes de enviar mensagem...`);
  const healthCheck = await verifyClientHealth(companySlug);
  
  if (!healthCheck.healthy) {
    console.log(`⚠️ Cliente ${companySlug} não está saudável:`, healthCheck.reason);
    
    // Marca como não conectado para forçar reconexão
    sessions[companySlug].ready = false;
    
    if (healthCheck.shouldReconnect) {
      throw new Error(`Cliente ${companySlug} perdeu conexão. Erro: ${healthCheck.reason}. Acesse /status/${companySlug} para reconectar.`);
    } else {
      throw new Error(`Cliente ${companySlug} não está funcional: ${healthCheck.reason}`);
    }
  }

  try {
    // Remove máscaras e formata para WhatsApp
    let cleanNumber = number.replace(/\D/g, ''); // Remove tudo que não é dígito
    console.log(`🔢 Número após limpeza: ${cleanNumber} (${cleanNumber.length} dígitos)`);
    
    // Adiciona 55 APENAS se não começar com 55
    if (!cleanNumber.startsWith('55')) {
      cleanNumber = '55' + cleanNumber;
      console.log(`➕ Adicionado código 55: ${cleanNumber}`);
    } else {
      console.log(`✅ Número já tem código 55: ${cleanNumber}`);
    }
    
    // Formata para o padrão do WhatsApp
    let chatId = cleanNumber + '@c.us';
    console.log(`📱 ChatId final: ${chatId}`);
    
    const client = sessions[companySlug].client;
    console.log(`🔍 Procurando chat para ${chatId}`);
    
    // Procura o chat primeiro
    let chat = null;
    try {
      chat = await client.getChatById(chatId);
      console.log(`📱 Chat encontrado - Nome do usuário: ${chat.name || 'undefined/null'}`);
    } catch (e) {
      console.log(`⚠️ Chat não encontrado para ${chatId}`);
    }
    // Se o chat não foi encontrado ou o nome do usuário é null/undefined, tenta remover o primeiro 9
    if (!chat || chat.name === null || chat.name === undefined || chat.name === '') {
      console.log(`🔄 Chat não encontrado ou usuário sem nome válido no WhatsApp, tentando remover o primeiro 9...`);
      
      // Se o número tem pelo menos 13 dígitos e tem 9 na posição correta (após DDD)
      if (cleanNumber.length >= 13 && cleanNumber.charAt(4) === '9') {
        const alternativeNumber = cleanNumber.substring(0, 4) + cleanNumber.substring(5);
        const alternativeChatId = alternativeNumber + '@c.us';
        console.log(`🔄 Tentando número alternativo (sem primeiro 9): ${alternativeChatId}`);
        
        try {
          const alternativeChat = await client.getChatById(alternativeChatId);
          console.log(`📱 Chat alternativo encontrado, verificando nome: ${alternativeChat.name || 'undefined'}`);
          
          // Verifica se o chat alternativo tem nome de usuário válido
          if (alternativeChat && alternativeChat.name !== null && alternativeChat.name !== undefined && alternativeChat.name !== '') {
            console.log(`✅ Chat alternativo com nome de usuário válido: ${alternativeChat.name}`);
            chat = alternativeChat;
            chatId = alternativeChatId;
          } else {
            console.log(`❌ Chat alternativo também sem nome de usuário válido (undefined/null/vazio)`);
          }
        } catch (e) {
          console.log(`❌ Chat alternativo também não encontrado: ${alternativeChatId}`);
        }
      } else {
        console.log(`❌ Número não tem formato esperado para remoção do 9 (${cleanNumber.length} dígitos)`);
      }
    }
    
    // Se ainda não encontrou um chat com nome de usuário válido, retorna erro 400
    if (!chat || chat.name === null || chat.name === undefined || chat.name === '') {
      console.log(`❌ Nenhum usuário válido encontrado no WhatsApp para ${number}`);
      const error = new Error('Número não válido - usuário não encontrado no WhatsApp');
      error.statusCode = 400;
      throw error;
    }
    
    console.log(`📤 Enviando mensagem do cliente ${companySlug} para ${chatId} - Usuário: ${chat.name}`);
    
    // Envia com timeout para evitar travamento
    await Promise.race([
      client.sendMessage(chatId, message),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout ao enviar mensagem - cliente pode ter desconectado')), 15000)
      )
    ]);
    
    console.log(`✅ Mensagem enviada com sucesso pelo cliente ${companySlug} para o usuário: ${chat.name}`);
    
    return {
      success: true,
      message: 'Mensagem enviada com sucesso',
      data: {
        companySlug,
        number: chatId,
        chatName: chat.name,
        content: message,
        timestamp: new Date().toISOString()
      }
    };
    
  } catch (error) {
    console.error(`❌ Erro ao enviar mensagem pelo cliente ${companySlug}:`, error.message);
    
    // Se é erro 400 (número não válido), não marca como desconectado
    if (error.statusCode === 400) {
      throw error;
    }
    
    // Se houve erro, marca como não conectado
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      console.log(`🔄 Marcando cliente ${companySlug} como não conectado devido a erro no envio`);
    }
    
    // Retorna erro mais específico
    if (error.message.includes('getChat') || error.message.includes('Cannot read properties')) {
      throw new Error(`Cliente ${companySlug} perdeu conexão com WhatsApp Web. Acesse /status/${companySlug} para reconectar.`);
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

// Função para forçar limpeza de uma sessão (para debug)
function clearSession(companySlug) {
  if (sessions[companySlug]) {
    try {
      sessions[companySlug].client.destroy();
    } catch (e) {
      console.log(`Erro ao destruir cliente ${companySlug}:`, e.message);
    }
    delete sessions[companySlug];
    console.log(`🗑️ Sessão ${companySlug} foi limpa manualmente`);
    return true;
  }
  return false;
}

// Função para debug - força verificação do estado real
async function debugSessionState(companySlug) {
  if (!sessions[companySlug]) {
    return { exists: false, message: 'Sessão não existe' };
  }
  
  const session = sessions[companySlug];
  const debug = {
    exists: true,
    ready: session.ready,
    connecting: session.connecting,
    hasQrCode: !!session.qrCode,
    hasClient: !!session.client,
    lastBatteryUpdate: session.lastBatteryUpdate || null
  };
  
  if (session.client) {
    try {
      const state = await Promise.race([
        session.client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      debug.realState = state;
      debug.isReallyConnected = state === 'CONNECTED';
      
      if (state === 'CONNECTED' && !session.ready) {
        console.log(`🔧 CORREÇÃO: Marcando ${companySlug} como conectado`);
        session.ready = true;
        session.connecting = false;
        session.qrCode = null;
      }
      
    } catch (error) {
      debug.realState = 'ERROR';
      debug.error = error.message;
    }
  }
  
  return debug;
}

// Função para listar todas as sessões (para debug)
function listSessions() {
  const sessionList = {};
  for (const [companySlug, session] of Object.entries(sessions)) {
    sessionList[companySlug] = {
      ready: session.ready,
      connecting: session.connecting,
      hasQrCode: !!session.qrCode,
      lastBatteryUpdate: session.lastBatteryUpdate || null
    };
  }
  return sessionList;
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
  listSessions
};
