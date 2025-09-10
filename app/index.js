require('dotenv').config();

const express = require("express");
const whatsapp = require("./whatsapp.js");
const qrcodeTerminal = require("qrcode-terminal");
const Rollbar = require('rollbar');

const rollbar = new Rollbar({
  accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
  environment: process.env.NODE_ENV || 'development',
  captureUncaught: true,
  captureUnhandledRejections: true,
  payload: {
    server: {
      root: __dirname,
    }
  }
});

const PORT = 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "sua-chave-secreta-aqui";

const app = express();

// Função para limpar e validar número do WhatsApp
function formatWhatsAppNumber(number) {
  // Remove todos os caracteres que não são números (incluindo o +)
  const cleanNumber = number.replace(/\D/g, '');
  
  // Se o número já tem 13 dígitos (55 + 11 dígitos), está correto
  if (cleanNumber.length === 13 && cleanNumber.startsWith('55')) {
    return '+' + cleanNumber;
  }
  
  // Se tem 11 dígitos, adiciona o código do país (55)
  if (cleanNumber.length === 11) {
    return '+55' + cleanNumber;
  }
  
  // Se tem 10 dígitos, adiciona 9 + código do país
  if (cleanNumber.length === 10) {
    // Adiciona o 9 no celular (assume que é celular se tem 10 dígitos)
    const ddd = cleanNumber.substring(0, 2);
    const numeroSem9 = cleanNumber.substring(2);
    return '+55' + ddd + '9' + numeroSem9;
  }
  
  // Se tem 12 dígitos sem o código do país (começando com 55), remove o 55 e reprocessa
  if (cleanNumber.length === 12 && cleanNumber.startsWith('55')) {
    const numberWithout55 = cleanNumber.substring(2);
    return formatWhatsAppNumber(numberWithout55);
  }
  
  // Se não se enquadra em nenhum padrão conhecido, retorna erro
  throw new Error(`Número inválido: ${number}. Formato esperado: +5511999999999, (11) 99999-9999 ou 11999999999`);
}

// Middleware para parsing JSON
app.use(express.json());

// Middleware de autenticação
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ 
      error: 'Token de acesso requerido',
      message: 'Inclua o token no header: Authorization: Bearer SEU_TOKEN'
    });
  }

  if (token !== AUTH_TOKEN) {
    return res.status(403).json({ 
      error: 'Token inválido',
      message: 'O token fornecido não é válido'
    });
  }

  next();
}

// Rota para verificar status da empresa e retornar QR Code se necessário
app.get("/status/:companySlug", authenticateToken, async (req, res) => {
  const { companySlug } = req.params;
  try {
    const status = await whatsapp.getStatus(companySlug);
    
    // Se está completamente pronto (ready = true)
    if (status.connected && status.status === 'ready') {
      console.log(`🟢 ===== STATUS: PRONTO =====`);
      console.log(`🟢 Empresa: ${companySlug}`);
      console.log(`🟢 Status: 100% PRONTO para envio de mensagens`);
      console.log(`🟢 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
      if (status.clientInfo) {
        console.log(`🟢 WhatsApp: ${status.clientInfo}`);
      }
      if (status.state) {
        console.log(`🟢 Estado: ${status.state}`);
      }
      console.log(`🟢 =============================`);
      res.json({ connected: true, ready: true, ...status });
      
    } 
    else if (status.connected && status.syncing) {
      console.log(`🟡 ===== STATUS: SINCRONIZANDO =====`);
      console.log(`🟡 Empresa: ${companySlug}`);
      console.log(`🟡 Status: Conectado mas sincronizando conversas`);
      console.log(`🟡 Progresso: ${status.progress}%`);
      console.log(`🟡 Tempo decorrido: ${status.syncTime}s (${Math.floor(status.syncTime/60)}min)`);
      console.log(`🟡 💡 Aguarde a finalização da sincronização`);
      console.log(`🟡 💡 Este processo pode demorar vários minutos`);
      console.log(`🟡 =================================`);
      
      res.json({ 
        connected: true, 
        ready: false,
        syncing: true,
        progress: status.progress,
        syncTime: status.syncTime,
        message: 'Sincronização em andamento - aguarde alguns minutos',
        qrCode: null
      });
    }
    else {
      console.log(`🔴 ===== STATUS: DESCONECTADO =====`);
      console.log(`🔴 Empresa: ${companySlug}`);
      console.log(`🔴 Status: Necessita escaneamento do QR Code`);
      console.log(`🔴 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
      console.log(`🔴 ================================`);
      
      if (status.qrCode) {
        console.log(`\n📱 QR Code para empresa ${companySlug}:`);
        qrcodeTerminal.generate(status.qrCode, { small: true });
      }
      res.json({ connected: false, ready: false, syncing: false, qrCode: status.qrCode });
    }
  } catch (err) {
    console.error(`Erro ao verificar status da empresa ${companySlug}:`, err.message);
    rollbar.error(err, { companySlug, route: '/status/:companySlug' });
    res.status(500).json({ error: err.message });
  }
});

app.post("/send-message/:companySlug", authenticateToken, async (req, res) => {
  const { companySlug } = req.params;
  const { number, message } = req.body;

  if (!number || !message) {
    return res.status(400).json({
      error: "Os campos 'number' e 'message' são obrigatórios",
      example: {
        number: "5511999999999",
        message: "Sua mensagem aqui"
      }
    });
  }

  try {
    const status = await whatsapp.checkConnectionStatus(companySlug);
    
    if (!status.connected) {
      const errorMessage = `Empresa ${companySlug} não está conectada ao WhatsApp`;
      console.error(errorMessage, status);
      rollbar.warning(errorMessage, { 
        companySlug, 
        route: '/send-message/:companySlug',
        action: 'company_not_connected',
        statusDetails: status
      });
      
      return res.status(422).json({
        error: "Empresa não conectada",
        message: `A empresa ${companySlug} não está conectada ao WhatsApp`,
        companySlug,
        statusDetails: status,
        suggestion: `Conecte a empresa primeiro acessando: /status/${companySlug}`
      });
    }

    if (status.status === 'syncing') {
      const syncTime = status.syncTime || 0;
      console.log(`⚠️ ${companySlug} está sincronizando (${status.progress}%) há ${syncTime}s`);
      
      if (status.progress < 30 && syncTime < 600) { // Menos de 30% e menos de 10 minutos
        return res.status(423).json({
          error: "Sincronização em andamento",
          message: `A empresa ${companySlug} está conectada mas ainda sincronizando (${status.progress}%)`,
          syncTime: syncTime,
          companySlug,
          statusDetails: status,
          suggestion: `Aguarde alguns minutos para a sincronização completar. Tempo atual: ${Math.floor(syncTime/60)}min`
        });
      }
      
      // Se já passou muito tempo, permite tentar mesmo com sincronização
      if (syncTime >= 600) { // 10 minutos ou mais
        console.log(`⚠️ Sincronização longa (${Math.floor(syncTime/60)}min) - permitindo tentativa de envio`);
      }
    }

    // Se há warning na verificação, loga mas continua
    if (status.warning) {
      console.log(`⚠️ Warning na verificação de ${companySlug}: ${status.warning}`);
    }

    // Limpa e valida o número do WhatsApp
    const formattedNumber = formatWhatsAppNumber(number);
    console.log(`Número original: ${number}, Número formatado: ${formattedNumber}`);
    
    const result = await whatsapp.sendMessage(companySlug, formattedNumber, message);
    console.log(`Mensagem enviada pela empresa ${companySlug} para ${formattedNumber}`);
    res.status(200).json({
      ...result,
      originalNumber: number,
      formattedNumber: formattedNumber
    });
  } catch (err) {
    console.error(`Erro ao enviar mensagem pela empresa ${companySlug}:`, err.message);
    rollbar.error(err, { companySlug, number, route: '/send-message/:companySlug' });
    res.status(500).json({ 
      error: err.message,
      companySlug,
      suggestion: `Verifique se a empresa ${companySlug} está conectada em /status/${companySlug}`
    });
  }
});

// Rota para listar empresas conectadas
app.get("/companies", authenticateToken, async (req, res) => {
  try {
    console.log(`📊 ===== LISTAGEM DE EMPRESAS =====`);
    console.log(`📊 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
    console.log(`📊 Solicitante: ${req.ip || req.connection.remoteAddress}`);
    
    const health = whatsapp.getSessionsHealth();
    const companies = [];
    const summary = {
      total: 0,
      ready: 0,
      syncing: 0,
      disconnected: 0,
      authenticated: 0
    };
    
    // Para cada empresa na memória, obter status detalhado
    for (const [companySlug, sessionHealth] of Object.entries(health)) {
      try {
        // Faz verificação rápida do status atual
        const currentStatus = await whatsapp.checkConnectionStatus(companySlug);
        
        const company = {
          companySlug: companySlug,
          status: sessionHealth.status,
          ready: sessionHealth.ready,
          authenticated: sessionHealth.authenticated,
          connecting: sessionHealth.connecting,
          hasQrCode: sessionHealth.hasQrCode,
          syncProgress: sessionHealth.syncProgress,
          syncMessage: sessionHealth.syncMessage,
          consecutiveFailures: sessionHealth.consecutiveFailures,
          timeSinceLastStateChange: sessionHealth.timeSinceLastStateChange,
          authTime: sessionHealth.authTime,
          readyTime: sessionHealth.readyTime,
          lastSyncUpdate: sessionHealth.lastSyncUpdate,
          lastBatteryUpdate: sessionHealth.lastBatteryUpdate,
          syncDurationMinutes: sessionHealth.syncDurationMinutes,
          
          // Status atual (pode ser diferente do armazenado)
          currentCheck: {
            connected: currentStatus.connected,
            status: currentStatus.status || 'unknown',
            state: currentStatus.state || null,
            reason: currentStatus.reason || null,
            warning: currentStatus.warning || null,
            forced: currentStatus.forced || false
          },
          
          // Interpretação do status
          interpretation: getStatusInterpretation(sessionHealth, currentStatus),
          
          // Timestamp da verificação
          lastChecked: new Date().toISOString()
        };
        
        companies.push(company);
        
        // Atualiza contadores do summary
        summary.total++;
        if (company.ready) summary.ready++;
        if (company.authenticated) summary.authenticated++;
        if (company.status === 'syncing' || company.status === 'syncing_slow' || company.status === 'syncing_long') {
          summary.syncing++;
        }
        if (!company.authenticated && !company.ready) {
          summary.disconnected++;
        }
        
      } catch (checkError) {
        console.log(`📊 ⚠️ Erro ao verificar ${companySlug}: ${checkError.message}`);
        
        // Adiciona mesmo com erro
        companies.push({
          companySlug: companySlug,
          status: sessionHealth.status,
          ready: sessionHealth.ready,
          authenticated: sessionHealth.authenticated,
          error: checkError.message,
          interpretation: {
            summary: 'Erro na verificação',
            details: `Falha ao verificar status: ${checkError.message}`,
            action: 'Tente verificar individualmente ou limpar a sessão'
          },
          lastChecked: new Date().toISOString(),
          ...sessionHealth
        });
        
        summary.total++;
        summary.disconnected++;
      }
    }
    
    // Ordena por status (ready primeiro, depois syncing, depois disconnected)
    companies.sort((a, b) => {
      const statusOrder = { 'ready': 1, 'syncing': 2, 'syncing_slow': 3, 'syncing_long': 4, 'disconnected': 5 };
      return (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
    });
    
    console.log(`📊 Total de empresas: ${summary.total}`);
    console.log(`📊 Ready: ${summary.ready}, Syncing: ${summary.syncing}, Disconnected: ${summary.disconnected}`);
    console.log(`📊 ===============================`);
    
    res.json({ 
      message: "Lista de todas as empresas e seus status",
      timestamp: new Date().toISOString(),
      summary: summary,
      companies: companies,
      metadata: {
        totalSessions: summary.total,
        checkDuration: "Individual status check performed",
        sortedBy: "status (ready first)"
      }
    });
    
  } catch (error) {
    console.error('📊 ❌ Erro ao listar empresas:', error.message);
    rollbar.error(error, { route: '/companies' });
    res.status(500).json({ 
      error: error.message,
      message: "Erro ao obter lista de empresas"
    });
  }
});

// Função auxiliar para interpretar o status
function getStatusInterpretation(sessionHealth, currentStatus) {
  if (sessionHealth.ready && currentStatus.connected) {
    return {
      summary: '✅ Pronto para uso',
      details: 'WhatsApp está conectado e sincronizado. Pode enviar mensagens.',
      action: 'Nenhuma ação necessária'
    };
  }
  
  if (sessionHealth.authenticated && !sessionHealth.ready) {
    const syncTime = sessionHealth.syncDurationMinutes || 0;
    if (syncTime > 10) {
      return {
        summary: '🐌 Sincronização lenta',
        details: `Conectado há ${syncTime} minutos mas ainda sincronizando. Progresso: ${sessionHealth.syncProgress}%`,
        action: 'Aguarde mais alguns minutos ou use force-check'
      };
    } else {
      return {
        summary: '⏳ Sincronizando',
        details: `Conectado e sincronizando. Progresso: ${sessionHealth.syncProgress}%. Tempo: ${syncTime}min`,
        action: 'Aguarde a conclusão da sincronização'
      };
    }
  }
  
  if (sessionHealth.hasQrCode) {
    return {
      summary: '📱 Aguardando QR Code',
      details: 'QR Code gerado. Escaneie no seu WhatsApp para conectar.',
      action: 'Escaneie o QR Code no endpoint /status/:companySlug'
    };
  }
  
  if (sessionHealth.connecting) {
    return {
      summary: '🔄 Conectando',
      details: 'Processo de conexão em andamento.',
      action: 'Aguarde a geração do QR Code'
    };
  }
  
  return {
    summary: '❌ Desconectado',
    details: 'Não há sessão ativa para esta empresa.',
    action: 'Acesse /status/:companySlug para iniciar conexão'
  };
}

// Rota para resumo rápido das empresas (sem verificação individual)
app.get("/companies/summary", authenticateToken, (req, res) => {
  try {
    console.log(`📋 ===== RESUMO RÁPIDO DE EMPRESAS =====`);
    
    const health = whatsapp.getSessionsHealth();
    const summary = {
      total: 0,
      ready: 0,
      syncing: 0,
      disconnected: 0,
      authenticated: 0,
      hasQrCode: 0,
      connecting: 0
    };
    
    const companiesList = [];
    
    for (const [companySlug, sessionHealth] of Object.entries(health)) {
      summary.total++;
      
      if (sessionHealth.ready) summary.ready++;
      if (sessionHealth.authenticated) summary.authenticated++;
      if (sessionHealth.hasQrCode) summary.hasQrCode++;
      if (sessionHealth.connecting) summary.connecting++;
      
      if (sessionHealth.status === 'syncing' || sessionHealth.status === 'syncing_slow' || sessionHealth.status === 'syncing_long') {
        summary.syncing++;
      }
      
      if (!sessionHealth.authenticated && !sessionHealth.ready) {
        summary.disconnected++;
      }
      
      companiesList.push({
        companySlug: companySlug,
        status: sessionHealth.status,
        ready: sessionHealth.ready,
        authenticated: sessionHealth.authenticated,
        syncProgress: sessionHealth.syncProgress,
        syncDurationMinutes: sessionHealth.syncDurationMinutes
      });
    }
    
    // Ordena por status
    companiesList.sort((a, b) => {
      const statusOrder = { 'ready': 1, 'syncing': 2, 'syncing_slow': 3, 'syncing_long': 4, 'disconnected': 5 };
      return (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
    });
    
    console.log(`📋 Resumo: ${summary.total} empresas (Ready: ${summary.ready}, Syncing: ${summary.syncing}, Disconnected: ${summary.disconnected})`);
    
    res.json({
      message: "Resumo rápido de todas as empresas",
      timestamp: new Date().toISOString(),
      summary: summary,
      companies: companiesList,
      note: "Para status detalhado com verificação individual, use GET /companies"
    });
    
  } catch (error) {
    console.error('📋 ❌ Erro no resumo de empresas:', error.message);
    rollbar.error(error, { route: '/companies/summary' });
    res.status(500).json({ error: error.message });
  }
});

// Rota para monitoramento detalhado de uma empresa específica
app.get("/health/:companySlug", authenticateToken, async (req, res) => {
  const { companySlug } = req.params;
  try {
    const quickCheck = await whatsapp.checkConnectionStatus(companySlug);
    const allHealth = whatsapp.getSessionsHealth();
    const specificHealth = allHealth[companySlug];
    
    res.json({
      companySlug,
      quickCheck,
      detailedHealth: specificHealth || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    rollbar.error(error, { companySlug, route: '/health/:companySlug' });
    res.status(500).json({ error: error.message });
  }
});

// Rota para forçar verificação inteligente se está realmente pronto
app.post("/force-check/:companySlug", authenticateToken, async (req, res) => {
  const { companySlug } = req.params;
  try {
    console.log(`🎯 ===== VERIFICAÇÃO FORÇADA =====`);
    console.log(`🎯 Empresa: ${companySlug}`);
    console.log(`🎯 Tentando detectar se está realmente pronto...`);
    
    const health = whatsapp.getSessionsHealth();
    const session = health[companySlug];
    
    if (!session || !session.authenticated) {
      return res.status(422).json({
        error: "Sessão não autenticada",
        message: `A empresa ${companySlug} não está autenticada`
      });
    }
    
    // Força nova verificação
    const status = await whatsapp.checkConnectionStatus(companySlug);
    
    res.json({
      message: "Verificação forçada executada",
      companySlug,
      result: status,
      sessionHealth: session
    });
    
  } catch (error) {
    console.error(`Erro na verificação forçada de ${companySlug}:`, error.message);
    rollbar.error(error, { companySlug, route: '/force-check/:companySlug' });
    res.status(500).json({ error: error.message });
  }
});

// Rota para forçar limpeza de sessão (para debug)
app.delete("/clear/:companySlug", authenticateToken, (req, res) => {
  const { companySlug } = req.params;
  try {
    console.log(`🧹 ===== SOLICITAÇÃO DE LIMPEZA =====`);
    console.log(`🧹 Empresa: ${companySlug}`);
    console.log(`🧹 Timestamp: ${new Date().toLocaleString('pt-BR')}`);
    console.log(`🧹 IP: ${req.ip || req.connection.remoteAddress}`);
    console.log(`🧹 =================================`);
    
    if (whatsapp.clearSession) {
      const result = whatsapp.clearSession(companySlug);
      
      if (result) {
        res.json({ 
          success: true,
          message: `Sessão ${companySlug} foi completamente limpa`,
          details: {
            memoryCleared: true,
            cacheCleared: true,
            timestamp: new Date().toISOString(),
            companySlug: companySlug
          },
          nextSteps: [
            "A próxima conexão será como se fosse a primeira vez",
            "Será necessário escanear o QR Code novamente",
            "Todos os dados de autenticação foram removidos"
          ]
        });
      } else {
        res.json({ 
          success: true,
          message: `Nenhuma sessão ativa encontrada para ${companySlug}`,
          details: {
            memoryCleared: false,
            cacheCleared: true, // Tentou limpar mesmo assim
            timestamp: new Date().toISOString(),
            companySlug: companySlug
          }
        });
      }
    } else {
      res.status(500).json({ 
        success: false,
        error: "Função clearSession não disponível",
        message: "O módulo de limpeza não está carregado corretamente"
      });
    }
  } catch (error) {
    console.error(`🧹 ❌ Erro na limpeza de ${companySlug}:`, error.message);
    rollbar.error(error, { companySlug, route: '/clear/:companySlug' });
    res.status(500).json({ 
      success: false,
      error: error.message,
      message: `Erro ao limpar sessão ${companySlug}`
    });
  }
});

// Rota para estatísticas globais do sistema
app.get("/stats", authenticateToken, (req, res) => {
  try {
    const health = whatsapp.getSessionsHealth();
    const now = Date.now();
    
    const stats = {
      system: {
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      },
      sessions: {
        total: Object.keys(health).length,
        ready: 0,
        syncing: 0,
        disconnected: 0,
        authenticated: 0,
        hasQrCode: 0,
        connecting: 0,
        withErrors: 0
      },
      syncStats: {
        averageSyncTime: 0,
        longestSyncTime: 0,
        shortestSyncTime: Infinity,
        syncingCompanies: []
      },
      ages: {
        oldestSession: 0,
        newestSession: 0,
        averageAge: 0
      }
    };
    
    const syncTimes = [];
    const sessionAges = [];
    
    for (const [companySlug, sessionHealth] of Object.entries(health)) {
      // Contadores básicos
      if (sessionHealth.ready) stats.sessions.ready++;
      if (sessionHealth.authenticated) stats.sessions.authenticated++;
      if (sessionHealth.hasQrCode) stats.sessions.hasQrCode++;
      if (sessionHealth.connecting) stats.sessions.connecting++;
      
      if (sessionHealth.status === 'syncing' || sessionHealth.status === 'syncing_slow' || sessionHealth.status === 'syncing_long') {
        stats.sessions.syncing++;
        stats.syncStats.syncingCompanies.push({
          companySlug: companySlug,
          syncTime: sessionHealth.syncDurationMinutes || 0,
          progress: sessionHealth.syncProgress || 0
        });
      }
      
      if (!sessionHealth.authenticated && !sessionHealth.ready) {
        stats.sessions.disconnected++;
      }
      
      // Estatísticas de sync
      if (sessionHealth.syncDurationMinutes) {
        syncTimes.push(sessionHealth.syncDurationMinutes);
        stats.syncStats.longestSyncTime = Math.max(stats.syncStats.longestSyncTime, sessionHealth.syncDurationMinutes);
        stats.syncStats.shortestSyncTime = Math.min(stats.syncStats.shortestSyncTime, sessionHealth.syncDurationMinutes);
      }
      
      // Idades das sessões
      if (sessionHealth.timeSinceLastStateChange) {
        const ageMinutes = Math.floor(sessionHealth.timeSinceLastStateChange / 60);
        sessionAges.push(ageMinutes);
        stats.ages.oldestSession = Math.max(stats.ages.oldestSession, ageMinutes);
        stats.ages.newestSession = Math.min(stats.ages.newestSession, ageMinutes);
      }
    }
    
    // Calcula médias
    if (syncTimes.length > 0) {
      stats.syncStats.averageSyncTime = Math.round(syncTimes.reduce((a, b) => a + b, 0) / syncTimes.length * 100) / 100;
    }
    if (stats.syncStats.shortestSyncTime === Infinity) {
      stats.syncStats.shortestSyncTime = 0;
    }
    
    if (sessionAges.length > 0) {
      stats.ages.averageAge = Math.round(sessionAges.reduce((a, b) => a + b, 0) / sessionAges.length * 100) / 100;
    }
    
    // Ordena empresas sincronizando por tempo
    stats.syncStats.syncingCompanies.sort((a, b) => b.syncTime - a.syncTime);
    
    res.json({
      message: "Estatísticas globais do sistema WhatsApp multi-tenant",
      timestamp: new Date().toISOString(),
      ...stats
    });
    
  } catch (error) {
    console.error('📈 ❌ Erro ao gerar estatísticas:', error.message);
    rollbar.error(error, { route: '/stats' });
    res.status(500).json({ error: error.message });
  }
});

// Rota para listar arquivos de cache/sessão (debug)
app.get("/cache", authenticateToken, (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const authPath = path.join(process.cwd(), '.wwebjs_auth');
    const cacheInfo = {
      authPath: authPath,
      exists: fs.existsSync(authPath),
      files: [],
      sessions: []
    };
    
    if (cacheInfo.exists) {
      const files = fs.readdirSync(authPath);
      
      for (const file of files) {
        const filePath = path.join(authPath, file);
        const stats = fs.statSync(filePath);
        
        const fileInfo = {
          name: file,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: stats.mtime,
          isSession: file.startsWith('session-')
        };
        
        if (fileInfo.isSession) {
          fileInfo.companySlug = file.replace('session-', '');
          cacheInfo.sessions.push(fileInfo);
        }
        
        cacheInfo.files.push(fileInfo);
      }
    }
    
    // Adiciona info das sessões ativas na memória
    const activeSessions = whatsapp.getSessionsHealth();
    
    res.json({
      message: "Informações de cache e sessões",
      timestamp: new Date().toISOString(),
      cache: cacheInfo,
      activeSessions: activeSessions,
      summary: {
        totalCacheFiles: cacheInfo.files.length,
        totalSessions: cacheInfo.sessions.length,
        activeSessionsCount: Object.keys(activeSessions).length,
        authFolderExists: cacheInfo.exists
      }
    });
    
  } catch (error) {
    console.error('Erro ao listar cache:', error.message);
    rollbar.error(error, { route: '/cache' });
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor multi-tenant WhatsApp rodando na porta ${PORT}`);
  console.log(`\nRotas principais:`);
  console.log(`GET  /status/:companySlug - Verificar status e obter QR Code`);
  console.log(`POST /send-message/:companySlug - Enviar mensagem`);
  console.log(`\nRotas de monitoramento:`);
  console.log(`GET  /companies - Lista DETALHADA de todas as empresas`);
  console.log(`GET  /companies/summary - Resumo rápido de todas as empresas`);
  console.log(`GET  /health/:companySlug - Monitoramento detalhado da empresa`);
  console.log(`GET  /stats - Estatísticas globais do sistema`);
  console.log(`\nRotas de manutenção:`);
  console.log(`POST /force-check/:companySlug - Forçar verificação inteligente`);
  console.log(`GET  /cache - Listar arquivos de cache/sessão (debug)`);
  console.log(`DELETE /clear/:companySlug - LIMPEZA COMPLETA da sessão e cache`);
  console.log(`\n📊 DICA: Use /companies/summary para visão geral rápida`);
  console.log(`� DICA: Use /companies para verificação detalhada (mais lento)`);
  console.log(`� DICA: Use /stats para estatísticas e métricas do sistema`);
  console.log(`\n🎯 FUNCIONALIDADE: Detecção inteligente de WhatsApp pronto`);
  console.log(`💡 Se o WhatsApp parece funcionar mas mostra "sincronizando",`);
  console.log(`💡 use POST /force-check/:companySlug para verificação forçada`);
  console.log(`\n🧹 LIMPEZA: DELETE /clear/:companySlug remove tudo`);
  console.log(`💡 Limpa memória + cache (.wwebjs_auth/session-{empresa})`);
  console.log(`\nPressione Ctrl+C para parar o servidor`);
});

// Tratamento graceful para encerramento do servidor
process.on('SIGINT', () => {
  console.log('\n🔄 Encerrando servidor...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🔄 Encerrando servidor...');
  process.exit(0);
});

