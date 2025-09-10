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
      
      // Primeira verificação: estado do cliente
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout na verificação de estado')), 10000) // Aumentado de 3s para 10s
        )
      ]);
      
      // Se o estado indica desconexão clara, reconecta
      const disconnectedStates = ['DISCONNECTED', 'UNLAUNCHED', 'UNPAIRED'];
      if (disconnectedStates.includes(state)) {
        throw new Error(`Estado desconectado: ${state}`);
      }
      
      // Segunda verificação: tenta obter informações do cliente
      let clientInfo;
      try {
        clientInfo = await Promise.race([
          client.info,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout na verificação de info')), 15000) // Aumentado de 5s para 15s
          )
        ]);
      } catch (infoError) {
        // Se falhar na verificação de info mas estado está OK, considera conectado
        console.log(`⚠️ Cliente ${companySlug} - falha na verificação de info mas estado OK (${state}):`, infoError.message);
        
        // Verifica se é uma falha temporária
        if (state === 'CONNECTED' || state === 'PAIRING') {
          console.log(`✅ Cliente ${companySlug} mantido como conectado (estado: ${state})`);
          return { connected: true, state, warning: 'Verificação de info falhou mas estado OK' };
        }
        
        throw infoError;
      }
      
      if (!clientInfo || !clientInfo.wid) {
        throw new Error('Cliente não possui informações válidas');
      }
      
      console.log(`✅ ===== VERIFICAÇÃO DE CONEXÃO =====`);
      console.log(`✅ Cliente ${companySlug} está conectado`);
      console.log(`✅ Número: ${clientInfo.wid._serialized}`);
      console.log(`✅ Estado: ${state}`);
      console.log(`✅ Timestamp: ${new Date().toLocaleString('pt-BR')}`);
      console.log(`✅ =================================`);
      return { connected: true, state, clientInfo: clientInfo.wid._serialized };
      
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
    console.log(`✅ ===== STATUS: PRONTO =====`);
    console.log(`✅ Cliente: ${companySlug}`);
    console.log(`✅ Status: Completamente sincronizado e pronto`);
    console.log(`✅ Timestamp: ${new Date().toLocaleString('pt-BR')}`);
    console.log(`✅ =============================`);
    return { connected: true, status: 'ready' };
  }

  // Verifica se está autenticado mas não ready (sincronizando)
  if (sessions[companySlug].authenticated && !sessions[companySlug].ready) {
    const now = Date.now();
    const syncTime = sessions[companySlug].authTime ? Math.floor((now - sessions[companySlug].authTime) / 1000) : 0;
    const progress = sessions[companySlug].syncProgress || 0;
    
    // CRITÉRIO INTELIGENTE: Se 100% há mais de 5 minutos, considerar pronto
    const shouldForceReadyByTime = (progress === 100 && syncTime >= 300); // 5 minutos
    
    // VERIFICAÇÃO INTELIGENTE: Testa se está realmente funcionando
    try {
      const client = sessions[companySlug].client;
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout state')), 5000)
        )
      ]);
      
      if (state === 'CONNECTED') {
        try {
          const info = await Promise.race([
            client.info,
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout info')), 8000)
            )
          ]);
          
          if (info && info.wid) {
            console.log(`🎯 ===== WHATSAPP REALMENTE PRONTO =====`);
            console.log(`🎯 Cliente: ${companySlug}`);
            console.log(`🎯 WhatsApp: ${info.wid._serialized}`);
            console.log(`🎯 Estado: ${state}`);
            console.log(`🎯 Progresso: ${progress}% (${Math.floor(syncTime/60)}min)`);
            console.log(`🎯 Detecção: Funcionando perfeitamente!`);
            console.log(`🎯 Forçando ready=true (sync completo detectado)`);
            console.log(`🎯 =====================================`);
            
            // Força ready se conseguiu obter todas as informações
            sessions[companySlug].ready = true;
            sessions[companySlug].readyTime = now;
            sessions[companySlug].syncProgress = 100;
            
            return { 
              connected: true, 
              status: 'ready',
              forced: true,
              clientInfo: info.wid._serialized,
              state: state
            };
          }
        } catch (infoError) {
          console.log(`🔍 Info ainda não disponível: ${infoError.message}`);
          
          // Se está 100% há muito tempo mesmo sem info, força ready
          if (shouldForceReadyByTime && state === 'CONNECTED') {
            console.log(`⚡ ===== FORÇANDO POR TEMPO =====`);
            console.log(`⚡ Cliente: ${companySlug}`);
            console.log(`⚡ Progresso: ${progress}% há ${Math.floor(syncTime/60)} minutos`);
            console.log(`⚡ Estado: ${state} (conectado)`);
            console.log(`⚡ Razão: Muito tempo em 100% - assumindo pronto`);
            console.log(`⚡ ============================`);
            
            sessions[companySlug].ready = true;
            sessions[companySlug].readyTime = now;
            sessions[companySlug].syncProgress = 100;
            
            return { 
              connected: true, 
              status: 'ready',
              forced: true,
              reason: `Forçado após ${Math.floor(syncTime/60)}min em 100%`,
              state: state
            };
          }
        }
      }
    } catch (error) {
      console.log(`🔍 Verificação inteligente falhou: ${error.message}`);
    }
    
    console.log(`🔄 ===== STATUS: SINCRONIZANDO =====`);
    console.log(`🔄 Cliente: ${companySlug}`);
    console.log(`🔄 Status: Conectado mas ainda sincronizando`);
    console.log(`🔄 Progresso: ${progress}%`);
    console.log(`🔄 Tempo de sincronização: ${syncTime}s`);
    console.log(`🔄 ================================`);
    
    return { 
      connected: true, 
      syncing: true, 
      progress: progress,
      syncTime: syncTime,
      status: 'syncing'
    };
  }

  return { connected: false, qrCode: sessions[companySlug].qrCode };
}

// Função para verificar status SEM criar sessão (para validação antes de envio)
async function checkConnectionStatus(companySlug) {
  // Verifica se existe uma sessão ativa
  if (!sessions[companySlug]) {
    return { connected: false, reason: 'Sessão não existe' };
  }

  // Se está pronto, é a melhor situação
  if (sessions[companySlug].ready) {
    try {
      const client = sessions[companySlug].client;
      
      // Verificação mais leve - apenas checa se o cliente ainda está ativo
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout na verificação de estado')), 10000) // Aumentado de 3s para 10s
        )
      ]);
      
      // Estados que indicam conexão ativa
      const connectedStates = ['CONNECTED', 'PAIRING', 'OPENING'];
      const isConnected = connectedStates.includes(state);
      
      if (!isConnected) {
        console.log(`⚠️ Cliente ${companySlug} em estado não conectado: ${state}`);
        return { connected: false, state, reason: `Estado não conectado: ${state}` };
      }
      
      console.log(`🔍 ===== VERIFICAÇÃO RÁPIDA =====`);
      console.log(`🔍 Cliente: ${companySlug}`);
      console.log(`🔍 Estado: ${state}`);
      console.log(`🔍 Status: READY (Pronto para usar)`);
      console.log(`🔍 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
      console.log(`🔍 =============================`);
      return { connected: true, state, status: 'ready' };
      
    } catch (error) {
      console.log(`❌ Erro na verificação rápida de ${companySlug}:`, error.message);
      return { 
        connected: false, 
        reason: `Erro na verificação: ${error.message}`
      };
    }
  }

  // Se está autenticado mas não ready, ainda está sincronizando
  if (sessions[companySlug].authenticated) {
    const now = Date.now();
    const syncTime = sessions[companySlug].authTime ? Math.floor((now - sessions[companySlug].authTime) / 1000) : 0;
    const progress = sessions[companySlug].syncProgress || 0;
    
    // DETECÇÃO INTELIGENTE MELHORADA: 100% + tempo suficiente = forçar ready
    const shouldForceReady = (progress === 100 && syncTime >= 300); // 5 minutos com 100%
    
    // TESTE ADICIONAL: Verifica se consegue obter informações do cliente
    // Isso pode indicar que está funcionando mesmo sem o evento 'ready'
    try {
      const client = sessions[companySlug].client;
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 5000)
        )
      ]);
      
      // Se está em estado CONNECTED e consegue obter info, pode estar pronto
      if (state === 'CONNECTED') {
        try {
          const info = await Promise.race([
            client.info,
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout info')), 8000)
            )
          ]);
          
          if (info && info.wid) {
            // Critério 1: Sempre força se consegue obter info do cliente
            const forceByInfo = true;
            
            // Critério 2: Força se 100% há muito tempo
            const forceByProgress = shouldForceReady;
            
            if (forceByInfo || forceByProgress) {
              const reason = forceByInfo ? 'Info obtida com sucesso' : `100% há ${Math.floor(syncTime/60)}min`;
              
              console.log(`🎯 ===== DETECÇÃO INTELIGENTE =====`);
              console.log(`🎯 Cliente: ${companySlug}`);
              console.log(`🎯 Status: Funcionando (mesmo sem evento 'ready')`);
              console.log(`🎯 Razão: ${reason}`);
              console.log(`🎯 Estado: ${state}`);
              console.log(`🎯 WhatsApp: ${info.wid._serialized}`);
              console.log(`🎯 Progresso: ${progress}%`);
              console.log(`🎯 Tempo desde auth: ${syncTime}s (${Math.floor(syncTime/60)}min)`);
              console.log(`🎯 FORÇANDO STATUS READY...`);
              console.log(`🎯 ===============================`);
              
              // Força o status ready se conseguiu obter as informações
              sessions[companySlug].ready = true;
              sessions[companySlug].readyTime = now;
              sessions[companySlug].syncProgress = 100;
              
              return { 
                connected: true, 
                status: 'ready', 
                forced: true,
                reason: reason,
                clientInfo: info.wid._serialized,
                state: state,
                syncTime: syncTime,
                progress: progress
              };
            }
          }
        } catch (infoError) {
          console.log(`🔍 Info não disponível ainda: ${infoError.message}`);
          
          // Mesmo sem info, se está 100% há muito tempo, pode forçar
          if (shouldForceReady && state === 'CONNECTED') {
            console.log(`⚡ ===== FORÇA POR PROGRESSO =====`);
            console.log(`⚡ Cliente: ${companySlug}`);
            console.log(`⚡ Progresso: ${progress}% há ${Math.floor(syncTime/60)} minutos`);
            console.log(`⚡ Estado: ${state} (conectado)`);
            console.log(`⚡ FORÇANDO READY POR TEMPO/PROGRESSO...`);
            console.log(`⚡ ==============================`);
            
            sessions[companySlug].ready = true;
            sessions[companySlug].readyTime = now;
            sessions[companySlug].syncProgress = 100;
            
            return { 
              connected: true, 
              status: 'ready', 
              forced: true,
              reason: `100% há ${Math.floor(syncTime/60)}min - forçado por tempo`,
              state: state,
              syncTime: syncTime,
              progress: progress
            };
          }
        }
      }
    } catch (stateError) {
      console.log(`🔍 Estado não disponível: ${stateError.message}`);
    }
    
    console.log(`🔄 ===== SINCRONIZAÇÃO EM ANDAMENTO =====`);
    console.log(`🔄 Cliente: ${companySlug}`);
    console.log(`🔄 Status: Conectado mas sincronizando`);
    console.log(`🔄 Progresso: ${progress}%`);
    console.log(`🔄 Tempo de sincronização: ${syncTime}s`);
    console.log(`🔄 Última atualização: ${sessions[companySlug].syncMessage || 'N/A'}`);
    console.log(`🔄 ⏳ Aguarde a finalização da sincronização...`);
    console.log(`🔄 =====================================`);
    
    return { 
      connected: true, 
      status: 'syncing',
      progress: progress,
      syncTime: syncTime,
      message: 'Conectado mas ainda sincronizando. Aguarde alguns minutos.'
    };
  }

  return { connected: false, reason: 'Não autenticado' };
}

// Função para criar uma nova sessão
async function createSession(companySlug) {
  // Detecta ambiente para configurar o modo do browser
  const isProduction = process.env.NODE_ENV === 'production';
  const isHeadless = isProduction || process.env.HEADLESS === 'true';
  
  console.log(`🖥️ Ambiente: ${isProduction ? 'PRODUÇÃO' : 'DESENVOLVIMENTO'}`);
  console.log(`🌐 Browser: ${isHeadless ? 'HEADLESS (sem interface)' : 'COM INTERFACE'}`);
  
  const client = new Client({
    puppeteer: { 
      headless: isHeadless,
      timeout: 60000, // Timeout geral do Puppeteer aumentado para 60s
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // Para ambientes com recursos limitados
        '--disable-gpu',
        '--disable-web-security', // Pode ajudar com problemas de CORS
        '--disable-background-timer-throttling', // Evita throttling durante sync
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    },
    // Configurações específicas do whatsapp-web.js
    authStrategy: new LocalAuth({
      clientId: companySlug // Usa o companySlug como ID único da sessão
    }),
    // Timeout para operações do WhatsApp Web
    authTimeoutMs: 300000, // 5 minutos para autenticação
    // Configurações de retry
    takeoverOnConflict: false, // Não tomar controle se já houver uma sessão
    takeoverTimeoutMs: 0
  });

  sessions[companySlug] = { 
    client, 
    qrCode: null, 
    ready: false,
    connecting: false,
    authenticated: false,
    authTime: null,
    readyTime: null,
    syncProgress: 0,
    syncMessage: null,
    lastSyncUpdate: null,
    lastStateChange: Date.now(),
    consecutiveFailures: 0
  };

  client.on('qr', (qr) => {
    console.log(`📱 QR Code gerado para empresa: ${companySlug}`);
    console.log(`📱 Escaneie o QR Code no seu WhatsApp para conectar`);
    sessions[companySlug].qrCode = qr;
  });

  // Evento quando o QR Code é escaneado com sucesso
  client.on('authenticated', () => {
    console.log(`🔐 ===== AUTENTICAÇÃO REALIZADA COM SUCESSO =====`);
    console.log(`🔐 Empresa: ${companySlug}`);
    console.log(`🔐 QR Code foi escaneado e aceito pelo WhatsApp`);
    console.log(`🔐 Status: Conectado! Iniciando sincronização...`);
    console.log(`🔐 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
    console.log(`🔐 ⚠️ IMPORTANTE: A sincronização pode demorar até 10 minutos`);
    console.log(`🔐 ⚠️ Especialmente se você tem muitas conversas/mensagens`);
    console.log(`🔐 ⚠️ Seja paciente, o processo não foi interrompido`);
    console.log(`🔐 ============================================`);
    
    // Marca como parcialmente conectado (autenticado mas não pronto)
    if (sessions[companySlug]) {
      sessions[companySlug].authenticated = true;
      sessions[companySlug].authTime = Date.now();
    }
  });

  // Evento quando está carregando
  client.on('loading_screen', (percent, message) => {
    const now = Date.now();
    const authTime = sessions[companySlug].authTime || now;
    const syncDuration = Math.floor((now - authTime) / 1000);
    
    console.log(`⏳ ===== SINCRONIZANDO WHATSAPP =====`);
    console.log(`⏳ Empresa: ${companySlug}`);
    console.log(`⏳ Progresso: ${percent}%`);
    console.log(`⏳ Status: ${message}`);
    console.log(`⏳ Tempo decorrido: ${syncDuration}s`);
    console.log(`⏳ Timestamp: ${new Date().toLocaleString('pt-BR')}`);
    console.log(`⏳ 💡 Dica: Este processo pode demorar de 30s a 10min`);
    console.log(`⏳ 💡 Depende da quantidade de conversas para sincronizar`);
    
    // Aviso especial se está demorando muito
    if (syncDuration > 300) { // 5 minutos
      console.log(`⏳ ⚠️ SINCRONIZAÇÃO LONGA DETECTADA (${Math.floor(syncDuration/60)}min)`);
      console.log(`⏳ ⚠️ Isso é normal para contas com muitas mensagens`);
      console.log(`⏳ ⚠️ Aguarde mais alguns minutos...`);
    }
    
    console.log(`⏳ ==================================`);
    
    // Atualiza progresso na sessão
    if (sessions[companySlug]) {
      sessions[companySlug].syncProgress = percent;
      sessions[companySlug].syncMessage = message;
      sessions[companySlug].lastSyncUpdate = Date.now();
    }
    
    // Se chegou a 100% mas ainda não disparou ready, força uma verificação
    if (percent === 100 && !sessions[companySlug].ready) {
      console.log(`🔍 Progresso 100% detectado - verificando se está realmente pronto...`);
      
      setTimeout(async () => {
        try {
          const state = await client.getState();
          if (state === 'CONNECTED') {
            const info = await client.info;
            if (info && info.wid) {
              console.log(`🎯 FORÇANDO READY após 100% de progresso!`);
              sessions[companySlug].ready = true;
              sessions[companySlug].readyTime = Date.now();
            }
          }
        } catch (error) {
          console.log(`🔍 Verificação pós-100% falhou: ${error.message}`);
        }
      }, 3000); // Aguarda 3 segundos após 100%
    }
  });

  client.on('ready', () => {
    const now = Date.now();
    const authTime = sessions[companySlug].authTime || now;
    const syncDuration = Math.floor((now - authTime) / 1000);
    
    console.log(`🎉 ===== WHATSAPP CONECTADO E SINCRONIZADO =====`);
    console.log(`✅ Empresa: ${companySlug}`);
    console.log(`✅ Status: PRONTO PARA ENVIAR MENSAGENS!`);
    console.log(`✅ Tempo de sincronização: ${syncDuration}s (${Math.floor(syncDuration/60)}min ${syncDuration%60}s)`);
    console.log(`✅ Timestamp: ${new Date().toLocaleString('pt-BR')}`);
    console.log(`✅ IMPORTANTE: AGORA SIM o WhatsApp está 100% pronto!`);
    console.log(`🎉 ============================================`);
    
    // APENAS AQUI que marca como ready = true
    sessions[companySlug].ready = true;
    sessions[companySlug].qrCode = null; // Limpa QR Code após conexão
    sessions[companySlug].lastStateChange = Date.now();
    sessions[companySlug].consecutiveFailures = 0;
    sessions[companySlug].readyTime = now;
    sessions[companySlug].syncProgress = 100;
    
    console.log(`📊 Sessão atualizada - ready: ${sessions[companySlug].ready}, authenticated: ${sessions[companySlug].authenticated}`);
  });

  client.on('disconnected', (reason) => {
    console.log(`💥 ===== WHATSAPP DESCONECTADO =====`);
    console.log(`💥 Empresa: ${companySlug}`);
    console.log(`💥 Motivo: ${reason}`);
    console.log(`💥 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
    console.log(`💥 =================================`);
    
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      sessions[companySlug].qrCode = null;
      sessions[companySlug].lastStateChange = Date.now();
    }
  });

  client.on('auth_failure', (msg) => {
    console.log(`🚫 ===== FALHA DE AUTENTICAÇÃO =====`);
    console.log(`🚫 Empresa: ${companySlug}`);
    console.log(`🚫 Mensagem: ${msg}`);
    console.log(`🚫 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
    console.log(`🚫 Solução: Gere um novo QR Code`);
    console.log(`🚫 =================================`);
    
    if (sessions[companySlug]) {
      sessions[companySlug].ready = false;
      sessions[companySlug].qrCode = null;
      sessions[companySlug].lastStateChange = Date.now();
    }
  });

  client.on('change_state', (state) => {
    const timestamp = new Date().toLocaleString('pt-BR');
    console.log(`🔄 ===== MUDANÇA DE ESTADO =====`);
    console.log(`🔄 Empresa: ${companySlug}`);
    console.log(`🔄 Novo Estado: ${state}`);
    console.log(`🔄 Timestamp: ${timestamp}`);
    
    // Explica o que cada estado significa
    const stateExplanations = {
      'INITIALIZING': '🚀 Inicializando cliente WhatsApp',
      'AUTHENTICATING': '🔑 Autenticando com WhatsApp',
      'CONNECTED': '✅ Conectado com sucesso!',
      'OPENING': '📂 Abrindo sessão WhatsApp', 
      'PAIRING': '🔗 Pareando dispositivo',
      'TIMEOUT': '⏰ Timeout - pode estar demorando mais que o esperado',
      'CONFLICT': '⚠️ Conflito - outra sessão pode estar ativa',
      'UNLAUNCHED': '⏸️ Não iniciado',
      'PROXYBLOCK': '🚫 Bloqueado por proxy',
      'TOS_BLOCK': '🚫 Bloqueado pelos Termos de Serviço',
      'SMB_TOS_BLOCK': '🚫 Bloqueado pelo WhatsApp Business',
      'DISCONNECTED': '❌ Desconectado',
      'UNPAIRED': '🚫 Dispositivo não pareado'
    };
    
    const explanation = stateExplanations[state] || `❓ Estado desconhecido: ${state}`;
    console.log(`🔄 Significado: ${explanation}`);
    console.log(`🔄 =============================`);
    
    if (sessions[companySlug]) {
      sessions[companySlug].lastStateChange = Date.now();
    }
    
    if (state === 'DISCONNECTED' || state === 'UNPAIRED' || state === 'UNLAUNCHED') {
      if (sessions[companySlug]) {
        sessions[companySlug].ready = false;
        sessions[companySlug].authenticated = false;
        sessions[companySlug].qrCode = null;
      }
    } else if (state === 'CONNECTED') {
      if (sessions[companySlug]) {
        // NÃO marca como ready aqui - apenas quando o evento 'ready' for disparado
        // O estado CONNECTED significa que está conectado mas pode ainda estar sincronizando
        sessions[companySlug].consecutiveFailures = 0;
        console.log(`🔄 Estado CONNECTED detectado - aguardando evento 'ready' para confirmar sincronização completa`);
      }
    }
  });

  // Monitora se a página foi fechada/perdida
  client.on('change_battery', (batteryInfo) => {
    // Este evento para de disparar quando desconecta
    if (sessions[companySlug]) {
      sessions[companySlug].lastBatteryUpdate = Date.now();
      
      // Se recebeu battery info mas ainda não está ready, pode estar pronto
      if (!sessions[companySlug].ready && sessions[companySlug].authenticated) {
        console.log(`🔋 Battery info recebido - pode indicar que está pronto!`);
        console.log(`🔋 Nível da bateria: ${batteryInfo.battery}% (${batteryInfo.plugged ? 'carregando' : 'descarregando'})`);
        
        // Tenta verificação inteligente
        setTimeout(async () => {
          try {
            const state = await client.getState();
            const info = await client.info;
            if (state === 'CONNECTED' && info && info.wid) {
              console.log(`🔋 FORÇANDO READY após receber battery info!`);
              sessions[companySlug].ready = true;
              sessions[companySlug].readyTime = Date.now();
              sessions[companySlug].syncProgress = 100;
            }
          } catch (error) {
            console.log(`🔋 Verificação pós-battery falhou: ${error.message}`);
          }
        }, 2000);
      }
    }
  });

  sessions[companySlug].connecting = true;
  console.log(`🚀 ===== INICIANDO CLIENTE WHATSAPP =====`);
  console.log(`🚀 Empresa: ${companySlug}`);
  console.log(`🚀 Modo: ${isHeadless ? 'HEADLESS (sem interface)' : 'COM INTERFACE'}`);
  console.log(`🚀 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
  console.log(`🚀 Aguarde a geração do QR Code...`);
  console.log(`🚀 =====================================`);
  
  await client.initialize();
}

// Função para aguardar QR Code ser gerado
async function waitForQrCode(companySlug, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Timeout ao gerar QR Code - processo demorou mais que 60 segundos'));
    }, timeout);

    const interval = setInterval(() => {
      console.log(sessions[companySlug].ready);
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
  console.log(`🧹 ===== LIMPEZA COMPLETA DA SESSÃO =====`);
  console.log(`🧹 Empresa: ${companySlug}`);
  console.log(`🧹 Iniciando limpeza completa...`);
  
  if (sessions[companySlug]) {
    try {
      // 1. Primeiro destrói o cliente se existir
      if (sessions[companySlug].client) {
        sessions[companySlug].client.destroy();
        console.log(`🧹 ✅ Cliente destruído`);
      }
    } catch (e) {
      console.log(`🧹 ⚠️ Erro ao destruir cliente: ${e.message}`);
    }
    
    // 2. Remove a sessão da memória
    delete sessions[companySlug];
    console.log(`🧹 ✅ Sessão removida da memória`);
  } else {
    console.log(`🧹 ⚠️ Sessão não existia na memória`);
  }
  
  // 3. Remove pasta de cache/auth do LocalAuth
  try {
    const fs = require('fs');
    const path = require('path');
    
    // O LocalAuth com clientId salva em .wwebjs_auth/session-{clientId}
    const authPath = path.join(process.cwd(), '.wwebjs_auth');
    const sessionPath = path.join(authPath, `session-${companySlug}`);
    
    console.log(`🧹 Verificando pasta de sessão: ${sessionPath}`);
    
    if (fs.existsSync(sessionPath)) {
      // Remove recursivamente a pasta da sessão
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`🧹 ✅ Pasta de sessão removida: ${sessionPath}`);
    } else {
      console.log(`🧹 💡 Pasta de sessão não encontrada: ${sessionPath}`);
      console.log(`🧹 💡 (Normal se ainda não foi autenticado ou já estava limpo)`);
    }
    
    // Verifica se há outros arquivos/pastas relacionados
    if (fs.existsSync(authPath)) {
      const files = fs.readdirSync(authPath);
      const relatedFiles = files.filter(file => 
        file.includes(companySlug) || file === `session-${companySlug}`
      );
      
      if (relatedFiles.length > 0) {
        console.log(`🧹 Encontrados arquivos relacionados: ${relatedFiles.join(', ')}`);
        
        for (const file of relatedFiles) {
          const filePath = path.join(authPath, file);
          try {
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
              fs.rmSync(filePath, { recursive: true, force: true });
              console.log(`🧹 ✅ Pasta relacionada removida: ${file}`);
            } else {
              fs.unlinkSync(filePath);
              console.log(`🧹 ✅ Arquivo relacionado removido: ${file}`);
            }
          } catch (fileError) {
            console.log(`🧹 ⚠️ Erro ao remover ${file}: ${fileError.message}`);
          }
        }
      } else {
        console.log(`🧹 💡 Nenhum arquivo relacionado encontrado para ${companySlug}`);
      }
      
      // Lista o que sobrou na pasta de auth (para debug)
      const remainingFiles = fs.readdirSync(authPath);
      if (remainingFiles.length > 0) {
        console.log(`🧹 📂 Arquivos restantes em .wwebjs_auth: ${remainingFiles.join(', ')}`);
      } else {
        console.log(`🧹 📂 Pasta .wwebjs_auth está vazia`);
      }
    } else {
      console.log(`🧹 💡 Pasta .wwebjs_auth não existe`);
    }
    
  } catch (fsError) {
    console.log(`🧹 ⚠️ Erro na limpeza de arquivos: ${fsError.message}`);
  }
  
  console.log(`🧹 ===== LIMPEZA CONCLUÍDA =====`);
  console.log(`🧹 Empresa: ${companySlug}`);
  console.log(`🧹 Status: Sessão e cache completamente limpos`);
  console.log(`🧹 Próxima conexão será como se fosse a primeira vez`);
  console.log(`🧹 =============================`);
  
  return true;
}

// Função para obter estatísticas detalhadas de todas as sessões
function getSessionsHealth() {
  const health = {};
  const now = Date.now();
  
  for (const [slug, session] of Object.entries(sessions)) {
    const timeSinceLastStateChange = now - (session.lastStateChange || 0);
    const authTime = session.authTime ? Math.floor((now - session.authTime) / 1000) : null;
    const readyTime = session.readyTime ? Math.floor((now - session.readyTime) / 1000) : null;
    const lastSyncUpdate = session.lastSyncUpdate ? Math.floor((now - session.lastSyncUpdate) / 1000) : null;
    
    // Calcula status mais detalhado
    let detailedStatus = 'disconnected';
    if (session.ready) {
      detailedStatus = 'ready';
    } else if (session.authenticated) {
      const syncTime = authTime || 0;
      if (syncTime > 600) { // Mais de 10 minutos
        detailedStatus = 'syncing_long';
      } else if (syncTime > 300) { // Mais de 5 minutos
        detailedStatus = 'syncing_slow';
      } else {
        detailedStatus = 'syncing';
      }
    }
    
    health[slug] = {
      ready: session.ready,
      authenticated: session.authenticated || false,
      connecting: session.connecting,
      hasQrCode: !!session.qrCode,
      syncProgress: session.syncProgress || 0,
      syncMessage: session.syncMessage || null,
      consecutiveFailures: session.consecutiveFailures || 0,
      timeSinceLastStateChange: Math.floor(timeSinceLastStateChange / 1000), // em segundos
      authTime: authTime, // tempo desde autenticação em segundos
      readyTime: readyTime, // tempo desde ready em segundos
      lastSyncUpdate: lastSyncUpdate, // tempo desde última atualização de sync
      lastBatteryUpdate: session.lastBatteryUpdate ? Math.floor((now - session.lastBatteryUpdate) / 1000) : null,
      status: detailedStatus,
      syncDurationMinutes: authTime ? Math.floor(authTime / 60) : null
    };
  }
  
  return health;
}

module.exports = { 
  getStatus, 
  checkConnectionStatus,
  sendMessage, 
  getClient,
  clearSession,
  getSessionsHealth
};
