const { Client, LocalAuth } = require('whatsapp-web.js');

// Armazena as sessões por companySlug
const sessions = {};

// Função para obter status da empresa
async function getStatus(companySlug) {
  // Se já existe uma sessão e está conectada
  if (sessions[companySlug] && sessions[companySlug].ready) {
    // Verificação rigorosa de conectividade - tenta uma operação real
    try {
      const client = sessions[companySlug].client;
      
      // Tenta obter informações do próprio número para verificar se está conectado
      const info = await Promise.race([
        client.info,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout na verificação')), 5000)
        )
      ]);
      
      if (!info || !info.wid) {
        throw new Error('Cliente não possui informações válidas');
      }
      
      console.log(`✅ Cliente ${companySlug} está conectado (${info.wid._serialized})`);
      return { connected: true };
      
    } catch (error) {
      console.log(`❌ Cliente ${companySlug} perdeu conexão:`, error.message);
      
      // Marca como não conectado e limpa a sessão
      sessions[companySlug].ready = false;
      sessions[companySlug].qrCode = null;
      
      // Tenta destruir o cliente antigo
      try {
        await sessions[companySlug].client.destroy();
        console.log(`🗑️ Cliente ${companySlug} destruído`);
      } catch (destroyError) {
        console.log(`⚠️ Erro ao destruir cliente ${companySlug}:`, destroyError.message);
      }
      
      // Remove a sessão para forçar recriação
      delete sessions[companySlug];
      console.log(`🔄 Recriando sessão para ${companySlug}...`);
    }
  }

  // Se não existe, cria uma nova sessão
  if (!sessions[companySlug]) {
    console.log(`🆕 Criando nova sessão para ${companySlug}...`);
    await createSession(companySlug);
  }

  // Se ainda não tem QR Code, aguarda ser gerado
  if (!sessions[companySlug].qrCode && !sessions[companySlug].ready) {
    console.log(`⏳ Aguardando QR Code para ${companySlug}...`);
    await waitForQrCode(companySlug);
  }

  if (sessions[companySlug].ready) {
    return { connected: true };
  }

  return { connected: false, qrCode: sessions[companySlug].qrCode };
}

// Função para criar uma nova sessão
async function createSession(companySlug) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: companySlug }),
    puppeteer: { 
      headless: false, // Para desenvolvimento - permite ver o WhatsApp Web
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
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

  client.on('ready', () => {
    console.log(`✅ WhatsApp conectado para empresa: ${companySlug}`);
    sessions[companySlug].ready = true;
    sessions[companySlug].qrCode = null; // Limpa QR Code após conexão
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
        sessions[companySlug].qrCode = null;
      }
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
async function waitForQrCode(companySlug, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Timeout ao gerar QR Code'));
    }, timeout);

    const interval = setInterval(() => {
      if (sessions[companySlug].qrCode || sessions[companySlug].ready) {
        clearTimeout(timeoutId);
        clearInterval(interval);
        resolve();
      }
    }, 500);
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

module.exports = { 
  getStatus, 
  sendMessage, 
  getClient,
  clearSession
};
