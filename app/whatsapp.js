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
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
      
      console.log(`📱 Estado atual do cliente ${companySlug}:`, state);
      
      // Estados que indicam conexão ativa
      if (state === 'CONNECTED') {
        console.log(`🔧 Cliente ${companySlug} estava conectado mas não marcado como ready - corrigindo...`);
        sessions[companySlug].ready = true;
        sessions[companySlug].connecting = false;
        sessions[companySlug].qrCode = null;
        return { connected: true };
      }
      
      // Se o estado é null/undefined, tenta verificação alternativa
      if (state === null || state === undefined) {
        console.log(`🔍 Estado ambíguo para ${companySlug}, tentando verificação prática...`);
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
          console.log(`⚠️ Verificação alternativa falhou para ${companySlug}:`, e.message);
        }
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
    },
    // Workaround para bug "markedUnread" - usa versão específica do WhatsApp Web
    // Issue: https://github.com/pedroslopez/whatsapp-web.js/issues/5718
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1031490220-alpha.html',
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
    // Primeiro verifica se a página do puppeteer ainda está ativa
    if (client.pupPage) {
      try {
        const isClosed = client.pupPage.isClosed();
        if (isClosed) {
          console.log(`❌ Cliente ${companySlug} - página do browser está fechada`);
          return { healthy: false, reason: 'Página do browser fechada', shouldReconnect: true };
        }
      } catch (e) {
        console.log(`⚠️ Erro ao verificar página do browser para ${companySlug}:`, e.message);
      }
    }

    // Tenta obter o estado do cliente
    let state = null;
    try {
      state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-state')), 5000))
      ]);
      console.log(`📊 Estado do cliente ${companySlug}: ${state}`);
    } catch (e) {
      console.log(`⚠️ Timeout ao obter estado do cliente ${companySlug}, tentando verificação alternativa...`);
    }
    
    // Estados aceitáveis - CONNECTED é o ideal, mas null/undefined pode ocorrer quando conectado
    const acceptableStates = ['CONNECTED', null, undefined];
    
    // Se o estado é CONNECTED, está saudável
    if (state === 'CONNECTED') {
      console.log(`✅ Cliente ${companySlug} está CONNECTED`);
      return { healthy: true, state, info: 'N/A' };
    }
    
    // Se o estado é explicitamente desconectado, não está saudável
    const disconnectedStates = ['CONFLICT', 'UNPAIRED', 'UNLAUNCHED', 'PROXYBLOCK', 'TOS_BLOCK', 'SMB_TOS_BLOCK'];
    if (disconnectedStates.includes(state)) {
      console.log(`❌ Cliente ${companySlug} está em estado de desconexão: ${state}`);
      return { healthy: false, reason: `Estado de desconexão: ${state}`, shouldReconnect: true };
    }
    
    // Para outros estados (null, undefined, OPENING, PAIRING, etc.), 
    // tenta uma verificação prática: obter info do cliente
    console.log(`🔍 Estado ambíguo (${state}), tentando verificação prática para ${companySlug}...`);
    
    try {
      // Tenta obter informações básicas do cliente - isso só funciona se conectado
      const info = await Promise.race([
        Promise.resolve(client.info),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-info')), 3000))
      ]);
      
      if (info && info.wid) {
        console.log(`✅ Cliente ${companySlug} tem info válida: ${info.wid._serialized}`);
        return { healthy: true, state: state || 'ASSUMED_CONNECTED', info: info.wid._serialized };
      }
    } catch (e) {
      console.log(`⚠️ Não conseguiu obter info do cliente ${companySlug}: ${e.message}`);
    }
    
    // Última tentativa: verificar se consegue listar chats (operação leve)
    try {
      console.log(`🔍 Tentativa final: listando chats para ${companySlug}...`);
      const chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-chats')), 5000))
      ]);
      
      if (chats && Array.isArray(chats)) {
        console.log(`✅ Cliente ${companySlug} conseguiu listar ${chats.length} chats - está funcional`);
        return { healthy: true, state: state || 'FUNCTIONAL', info: `${chats.length} chats` };
      }
    } catch (e) {
      console.log(`❌ Cliente ${companySlug} não conseguiu listar chats: ${e.message}`);
    }
    
    // Se chegou aqui, não está saudável
    console.log(`❌ Cliente ${companySlug} falhou em todas as verificações de saúde`);
    return { 
      healthy: false, 
      reason: `Estado: ${state || 'desconhecido'} - falhou nas verificações práticas`,
      shouldReconnect: true 
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

// Função para encontrar o chat correto para um número
async function findCorrectChatId(client, number) {
  const cleanNumber = number.replace(/\D/g, '');
  const possibleChatIds = [
    `${cleanNumber}@c.us`,
    `${cleanNumber}@s.whatsapp.net`
  ];
  
  console.log(`🔍 Procurando chat existente para número: ${cleanNumber}`);
  
  try {
    // PRIMEIRA TENTATIVA: Buscar por chats existentes
    const chats = await client.getChats();
    
    for (const chat of chats) {
      const chatNumber = chat.id.user;
      if (chatNumber === cleanNumber) {
        console.log(`✅ Encontrou chat existente: ${chat.id._serialized} (nome: ${chat.name})`);
        return {
          chatId: chat.id._serialized,
          isExistingChat: true,
          chatName: chat.name,
          isGroup: chat.isGroup
        };
      }
    }
    
    // SEGUNDA TENTATIVA: Verificar se é um contato salvo
    console.log(`🔍 Não encontrou chat existente, verificando contatos salvos...`);
    const contacts = await client.getContacts();
    
    for (const contact of contacts) {
      const contactNumber = contact.id.user;
      if (contactNumber === cleanNumber) {
        console.log(`✅ Encontrou contato salvo: ${contact.id._serialized} (nome: ${contact.name || contact.pushname})`);
        return {
          chatId: contact.id._serialized,
          isExistingChat: false,
          contactName: contact.name || contact.pushname,
          isContact: true
        };
      }
    }
    
    // TERCEIRA TENTATIVA: Verificar se o número está registrado no WhatsApp
    console.log(`🔍 Verificando se número ${cleanNumber} está registrado no WhatsApp...`);
    const isRegistered = await client.isRegisteredUser(`${cleanNumber}@c.us`);
    
    if (isRegistered) {
      console.log(`✅ Número ${cleanNumber} está registrado, usando formato padrão`);
      return {
        chatId: `${cleanNumber}@c.us`,
        isExistingChat: false,
        isRegistered: true
      };
    } else {
      console.log(`⚠️ Número ${cleanNumber} não está registrado no WhatsApp`);
      // Mesmo assim tenta enviar, pode ser que funcione
      return {
        chatId: `${cleanNumber}@c.us`,
        isExistingChat: false,
        isRegistered: false,
        warning: 'Número pode não estar registrado no WhatsApp'
      };
    }
    
  } catch (error) {
    console.log(`⚠️ Erro ao buscar chat/contato, usando formato padrão:`, error.message);
    return {
      chatId: `${cleanNumber}@c.us`,
      isExistingChat: false,
      error: error.message
    };
  }
}

async function validateWhatsAppNumber(client, number) {
  let cleanNumber = number.replace(/\D/g, '');
  
  console.log(`🔢 Número original limpo: ${cleanNumber} (${cleanNumber.length} dígitos)`);
  
  if (!cleanNumber.startsWith('55')) {
    // Se tem 11 dígitos (DDD + número), adiciona 55
    if (cleanNumber.length === 11) {
      cleanNumber = '55' + cleanNumber;
      console.log(`➕ Adicionado código 55 (11 dígitos): ${cleanNumber}`);
    }
    // Se tem 10 dígitos (DDD + número sem 9), adiciona 55
    else if (cleanNumber.length === 10) {
      cleanNumber = '55' + cleanNumber;
      console.log(`➕ Adicionado código 55 (10 dígitos): ${cleanNumber}`);
    }
    // Se tem menos de 10 dígitos, é inválido
    else if (cleanNumber.length < 10) {
      console.log(`⚠️ Número muito curto: ${cleanNumber.length} dígitos`);
      return {
        isValid: false,
        originalNumber: number,
        numberId: null,
        error: `Número muito curto: ${cleanNumber.length} dígitos (mínimo 10)`
      };
    }
    // Se tem mais de 11 mas não começa com 55, pode ser erro
    else {
      console.log(`⚠️ Número com formato inesperado: ${cleanNumber.length} dígitos sem código 55`);
    }
  }
  
  // Validação de formato básico
  if (cleanNumber.length < 12 || cleanNumber.length > 13) {
    console.log(`⚠️ Número com formato inválido: ${cleanNumber.length} dígitos (esperado 12 ou 13)`);
    return {
      isValid: false,
      originalNumber: number,
      numberId: null,
      error: `Número com formato inválido: ${cleanNumber.length} dígitos`
    };
  }
  
  console.log(`🔍 Validando número: ${cleanNumber}`);
  
  // Lista de variações para testar
  const variations = [cleanNumber];
  
  // Se tem 13 dígitos e o 5º caractere (índice 4) é '9', adiciona versão sem o 9
  if (cleanNumber.length === 13 && cleanNumber.charAt(4) === '9') {
    const withoutNine = cleanNumber.substring(0, 4) + cleanNumber.substring(5);
    variations.push(withoutNine);
    console.log(`📋 Testando variações: [${cleanNumber}, ${withoutNine}]`);
  } 
  // Se tem 12 dígitos e o 5º caractere NÃO é '9', adiciona versão COM o 9
  else if (cleanNumber.length === 12 && cleanNumber.charAt(4) !== '9') {
    const withNine = cleanNumber.substring(0, 4) + '9' + cleanNumber.substring(4);
    variations.push(withNine);
    console.log(`📋 Testando variações: [${cleanNumber}, ${withNine}]`);
  } else {
    console.log(`📋 Testando apenas: [${cleanNumber}]`);
  }
  
  // Testa cada variação usando getNumberId (muito mais rápido e confiável)
  for (const variation of variations) {
    try {
      console.log(`🔎 Testando: ${variation}`);
      const numberId = await client.getNumberId(variation);
      
      if (numberId) {
        console.log(`✅ Número válido encontrado: ${numberId._serialized}`);
        return {
          isValid: true,
          numberId: numberId._serialized,
          originalNumber: number,
          validatedNumber: variation,
          wasAlternative: variation !== cleanNumber
        };
      }
    } catch (error) {
      console.log(`❌ Erro ao testar ${variation}: ${error.message}`);
    }
  }
  
  console.log(`⚠️ Nenhuma variação válida encontrada para ${cleanNumber}`);
  return {
    isValid: false,
    originalNumber: number,
    numberId: null
  };
}

/**
 * Envia mensagem para WhatsApp com validação automática do número
 */
async function sendMessage(companySlug, number, message) {
  if (!sessions[companySlug] || !sessions[companySlug].ready) {
    throw new Error(`Empresa ${companySlug} não está conectada ao WhatsApp`);
  }

  // Verifica a saúde do cliente antes de enviar
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
    const client = sessions[companySlug].client;
    
    // VALIDAÇÃO DO NÚMERO: Usa getNumberId() para validar
    console.log(`🔍 Validando número ${number}...`);
    const validation = await validateWhatsAppNumber(client, number);
    
    if (!validation.isValid) {
      console.log(`❌ Número ${number} não é válido no WhatsApp`);
      throw new Error(`Número ${number} não é um usuário válido do WhatsApp`);
    }
    
    const chatId = validation.numberId;
    console.log(`✅ Número validado: ${chatId}${validation.wasAlternative ? ' (versão alternativa)' : ''}`);
    
    // ENVIO DA MENSAGEM
    console.log(`📤 Enviando mensagem do cliente ${companySlug} para ${chatId}`);
    await client.sendMessage(chatId, message);
    console.log(`✅ Mensagem enviada com sucesso!`);
    
    // Busca informações do contato (opcional, para logs/retorno)
    let contactInfo = {
      pushname: 'Desconhecido',
      chatName: chatId
    };
    
    try {
      const chat = await client.getChatById(chatId);
      const contact = await chat.getContact();
      contactInfo = {
        pushname: contact.pushname || 'Sem nome',
        chatName: chat.name || chatId,
        isMyContact: contact.isMyContact
      };
      console.log(`👤 Informações do contato: ${contactInfo.pushname}`);
    } catch (e) {
      console.log(`⚠️ Não foi possível obter informações do contato: ${e.message}`);
    }
    
    return {
      success: true,
      message: 'Mensagem enviada com sucesso',
      data: {
        companySlug,
        number: chatId,
        originalNumber: number,
        validatedNumber: validation.validatedNumber,
        wasAlternative: validation.wasAlternative,
        chatName: contactInfo.chatName,
        userPushname: contactInfo.pushname,
        content: message,
        timestamp: new Date().toISOString()
      }
    };
    
  } catch (error) {
    console.error(`❌ Erro ao enviar mensagem pelo cliente ${companySlug}:`, error.message);

    // Se é erro 400 (número não válido), não marca como desconectado
    if (error.statusCode === 400 || error.message.includes('não é um usuário válido')) {
      throw error;
    }

    // IMPORTANTE: Erros internos da biblioteca whatsapp-web.js que NÃO indicam desconexão
    // Esses erros podem ocorrer mesmo com conexão ativa e geralmente são temporários
    const knownLibraryBugs = [
      'markedUnread',      // Bug conhecido da biblioteca
      'isNewMsg',          // Bug similar
      'Cannot read properties of undefined'  // Erro genérico da biblioteca que não indica desconexão
    ];

    const isKnownLibraryBug = knownLibraryBugs.some(bug => error.message.includes(bug));

    if (isKnownLibraryBug) {
      console.log(`⚠️ Erro interno da biblioteca whatsapp-web.js (não é desconexão): ${error.message}`);
      console.log(`🔄 Tentando enviar novamente em 1 segundo...`);

      // Aguarda 1 segundo e tenta novamente
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        const client = sessions[companySlug].client;
        const validation = await validateWhatsAppNumber(client, number);

        if (validation.isValid) {
          console.log(`📤 Reenviando mensagem para ${validation.numberId}...`);
          await client.sendMessage(validation.numberId, message);
          console.log(`✅ Mensagem reenviada com sucesso!`);

          return {
            success: true,
            message: 'Mensagem enviada com sucesso (após retry)',
            data: {
              companySlug,
              number: validation.numberId,
              originalNumber: number,
              content: message,
              timestamp: new Date().toISOString(),
              wasRetry: true
            }
          };
        }
      } catch (retryError) {
        console.error(`❌ Erro no retry:`, retryError.message);
        // Se falhar no retry, continua com o fluxo normal de erro
      }

      // Se o retry também falhou, lança erro sem marcar como desconectado
      throw new Error(`Erro temporário ao enviar mensagem. Tente novamente.`);
    }

    // Se houve erro de conexão real, marca como não conectado
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      console.log(`🔄 Marcando cliente ${companySlug} como não conectado devido a erro no envio`);
    }

    // Erros que realmente indicam perda de conexão
    if (error.message.includes('getChat') || error.message.includes('perdeu conexão') || error.message.includes('Protocol error')) {
      throw new Error(`Cliente ${companySlug} perdeu conexão com WhatsApp Web. Acesse /status/${companySlug} para reconectar.`);
    }

    throw new Error(`Erro ao enviar mensagem: ${error.message}`);
  }
}

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
    return { success: false, message: 'Sessão não existe' };
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
          setTimeout(() => reject(new Error('Timeout no logout')), 10000)
        )
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
      sessionRemoved: true
    }
  };

  if (logoutSuccess) {
    result.message += ' e logout realizado no WhatsApp';
    result.whatsappLoggedOut = true;
  } else {
    result.message += ' (logout do WhatsApp pode ter falhado)';
    result.whatsappLoggedOut = false;
  }

  return result;
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

// Função para buscar informações de um número específico (para debug)
async function searchNumberInfo(companySlug, number) {
  if (!sessions[companySlug] || !sessions[companySlug].ready) {
    throw new Error(`Empresa ${companySlug} não está conectada ao WhatsApp`);
  }

  const client = sessions[companySlug].client;
  const cleanNumber = number.replace(/\D/g, '');
  
  console.log(`🔍 Buscando informações completas para número: ${cleanNumber}`);
  
  const info = {
    originalNumber: number,
    cleanNumber: cleanNumber,
    searchResults: {
      chats: [],
      contacts: [],
      registrationStatus: null
    }
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
          timestamp: chat.timestamp
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
          isWAContact: contact.isWAContact
        });
      }
    }

    // Verifica se está registrado
    try {
      info.searchResults.registrationStatus = await client.isRegisteredUser(`${cleanNumber}@c.us`);
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
      lastBatteryUpdate: session.lastBatteryUpdate || null
    };
  }
  return sessionList;
}

// Função para deletar todas as empresas e sessões (incluindo dados persistidos)
async function deleteAllCompaniesAndSessions() {
  const fs = require('fs').promises;
  const path = require('path');
  
  const results = {
    sessionsCleared: {},
    authDataDeleted: false,
    cacheDeleted: false
  };
  
  console.log(`🗑️ Iniciando exclusão de TODAS as empresas e sessões...`);
  
  // 1. Primeiro limpa todas as sessões ativas em memória
  const sessionKeys = Object.keys(sessions);
  console.log(`📋 Sessões ativas encontradas: ${sessionKeys.length}`);
  
  for (const companySlug of sessionKeys) {
    try {
      const result = await clearSession(companySlug);
      results.sessionsCleared[companySlug] = result;
    } catch (error) {
      results.sessionsCleared[companySlug] = {
        success: false,
        error: error.message
      };
    }
  }
  
  // 2. Remove diretório de autenticação (.wwebjs_auth)
  const authPath = path.resolve(__dirname, '..', '.wwebjs_auth');
  try {
    await fs.rm(authPath, { recursive: true, force: true });
    results.authDataDeleted = true;
    console.log(`✅ Diretório de autenticação removido: ${authPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.log(`⚠️ Erro ao remover diretório de autenticação: ${error.message}`);
      results.authDataError = error.message;
    } else {
      results.authDataDeleted = true; // Não existia, considera como sucesso
      console.log(`ℹ️ Diretório de autenticação não existia`);
    }
  }
  
  // 3. Remove diretório de cache (.wwebjs_cache) - opcional
  const cachePath = path.resolve(__dirname, '..', '.wwebjs_cache');
  try {
    await fs.rm(cachePath, { recursive: true, force: true });
    results.cacheDeleted = true;
    console.log(`✅ Diretório de cache removido: ${cachePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.log(`⚠️ Erro ao remover diretório de cache: ${error.message}`);
      results.cacheError = error.message;
    } else {
      results.cacheDeleted = true; // Não existia, considera como sucesso
      console.log(`ℹ️ Diretório de cache não existia`);
    }
  }
  
  const successCount = Object.values(results.sessionsCleared).filter(r => r.success).length;
  
  return {
    success: true,
    message: `Todas as empresas e sessões foram deletadas`,
    summary: {
      totalSessions: sessionKeys.length,
      sessionsCleared: successCount,
      authDataDeleted: results.authDataDeleted,
      cacheDeleted: results.cacheDeleted
    },
    details: results
  };
}

// Função para fazer logout de todas as sessões ativas
async function clearAllSessions() {
  const results = {}
  const sessionKeys = Object.keys(sessions);
  
  console.log(`🧹 Iniciando limpeza de todas as sessões (${sessionKeys.length} sessões)`);
  
  if (sessionKeys.length === 0) {
    return { success: true, message: 'Nenhuma sessão ativa para limpar', sessions: {} };
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
        error: error.message
      };
    }
  });
  
  await Promise.all(promises);
  
  const successCount = Object.values(results).filter(r => r.success).length;
  const logoutCount = Object.values(results).filter(r => r.whatsappLoggedOut).length;
  
  console.log(`✅ Limpeza concluída: ${successCount}/${sessionKeys.length} sessões limpas, ${logoutCount} com logout do WhatsApp`);
  
  return {
    success: true,
    message: `Processadas ${sessionKeys.length} sessões`,
    summary: {
      total: sessionKeys.length,
      successful: successCount,
      withLogout: logoutCount,
      failed: sessionKeys.length - successCount
    },
    sessions: results
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
  deleteAllCompaniesAndSessions,
  listSessions,
  searchNumberInfo
};
