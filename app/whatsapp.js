const { Client, LocalAuth } = require('whatsapp-web.js');

const sessions = {};

async function getStatus(companySlug) {
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Cliente ${companySlug} já está conectado - não precisa de QR Code`);
    return { connected: true };
  }
  
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

  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Cliente ${companySlug} conectou durante o processo`);
    return { connected: true };
  }

  const qrCode = sessions[companySlug] ? sessions[companySlug].qrCode : null;
  console.log(`📱 Retornando status para ${companySlug} - QR Code: ${qrCode ? 'Disponível' : 'Não disponível'}`);
  
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
  if (sessions[companySlug] && sessions[companySlug].ready) {
    console.log(`✅ Verificação rápida: Cliente ${companySlug} está pronto`);
    return { connected: true };
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

// Função para enviar mensagem
async function sendMessage(companySlug, number, message) {
  if (!sessions[companySlug] || !sessions[companySlug].ready) {
    throw new Error(`Empresa ${companySlug} não está conectada ao WhatsApp`);
  }

  try {
    // Formatar número para o formato do WhatsApp
    const chatId = number.includes('@c.us') ? number : `${number.replace(/\D/g, '')}@c.us`;
    
    const client = sessions[companySlug].client;
    await client.sendMessage(chatId, message);
    
    return {
      success: true,
      message: 'Mensagem enviada com sucesso',
      data: {
        companySlug,
        number,
        content: message,
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
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
  sendMessage, 
  getClient,
  clearSession,
  listSessions
};
