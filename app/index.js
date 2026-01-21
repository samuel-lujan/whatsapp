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
    console.log(`📊 Verificando status da empresa: ${companySlug}`);
    
    // Primeiro verifica se já existe uma sessão ativa (rápido)
    if (whatsapp.hasActiveSession(companySlug)) {
      const quickStatus = whatsapp.checkConnectionStatus(companySlug);
      if (quickStatus.connected) {
        console.log(`⚡ Empresa ${companySlug} já conectada (verificação rápida)`);
        return res.json({ 
          connected: true, 
          companySlug,
          method: 'quick-check',
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // Se não tem sessão ativa, faz verificação completa
    const status = await whatsapp.getStatus(companySlug);
    
    if (status.connected) {
      console.log(`✅ Empresa ${companySlug} está conectada`);
      res.json({ 
        connected: true, 
        companySlug,
        method: 'full-check',
        timestamp: new Date().toISOString()
      });
    } else {
      console.log(`⚠️ Empresa ${companySlug} não está conectada`);
      
      const response = { 
        connected: false, 
        companySlug,
        timestamp: new Date().toISOString()
      };
      
      if (status.qrCode) {
        console.log(`📱 QR Code disponível para empresa ${companySlug}`);
        // Exibe o QR Code no terminal em ASCII
        qrcodeTerminal.generate(status.qrCode, { small: true });
        response.qrCode = status.qrCode;
        response.message = "Escaneie o QR Code com o WhatsApp para conectar";
      } else if (status.error) {
        response.error = status.error;
        response.message = status.suggestion || "Erro ao gerar QR Code";
      } else {
        response.message = status.message || "Aguardando geração do QR Code...";
      }
      
      res.json(response);
    }
  } catch (err) {
    console.error(`❌ Erro ao verificar status da empresa ${companySlug}:`, err.message);
    rollbar.error(err, { companySlug, route: '/status/:companySlug' });
    res.status(500).json({ 
      error: err.message,
      companySlug,
      timestamp: new Date().toISOString(),
      suggestion: "Tente novamente em alguns segundos"
    });
  }
});

// Rota para enviar mensagem usando a sessão da empresa
app.post("/send-message/:companySlug", authenticateToken, async (req, res) => {
  const { companySlug } = req.params;
  const { number, message } = req.body;

  // Validação dos campos obrigatórios
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
    // Verifica se a empresa está conectada antes de enviar
    const quickStatus = whatsapp.checkConnectionStatus(companySlug);
    
    if (!quickStatus.connected) {
      let errorMessage = `Empresa ${companySlug} não está conectada ao WhatsApp`;
      let suggestion = `Conecte a empresa primeiro acessando: /status/${companySlug}`;
      
      if (quickStatus.status === 'needs_verification') {
        errorMessage = `Empresa ${companySlug} precisa de verificação de conexão`;
        suggestion = quickStatus.suggestion || suggestion;
      }
      
      console.error(errorMessage);
      
      return res.status(422).json({
        error: "Empresa não conectada",
        message: errorMessage,
        companySlug,
        status: quickStatus.status || 'disconnected',
        suggestion
      });
    }

    // Envia o número diretamente, sem formatação prévia
    console.log(`Número recebido: ${number}`);
    
    const result = await whatsapp.sendMessage(companySlug, number, message);
    console.log(`✅ Mensagem enviada pela empresa ${companySlug}`);
    res.status(200).json({
      ...result,
      originalNumber: number
    });
  } catch (err) {
    console.error(`❌ Erro ao enviar mensagem pela empresa ${companySlug}:`, err.message);
    rollbar.error(err, { companySlug, number, route: '/send-message/:companySlug' });
    
    // Determina o status code baseado no tipo de erro
    let statusCode = 500;
    if (err.message.includes('perdeu conexão') || err.message.includes('não está conectada')) {
      statusCode = 422;
    }
    
    res.status(statusCode).json({ 
      error: err.message,
      companySlug,
      originalNumber: number,
      suggestion: err.message.includes('/status/') 
        ? "Reconecte usando a rota /status" 
        : `Verifique se a empresa ${companySlug} está conectada em /status/${companySlug}`
    });
  }
});

// Rota para listar empresas conectadas
app.get("/companies", authenticateToken, (req, res) => {
  try {
    const sessions = whatsapp.listSessions();
    res.json({ 
      sessions,
      total: Object.keys(sessions).length,
      connected: Object.values(sessions).filter(s => s.ready).length,
      connecting: Object.values(sessions).filter(s => s.connecting).length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rota para debug de sessão específica
app.get("/debug/:companySlug", authenticateToken, async (req, res) => {
  const { companySlug } = req.params;
  try {
    console.log(`🔍 Debug da sessão: ${companySlug}`);
    const debugInfo = await whatsapp.debugSessionState(companySlug);
    res.json({
      companySlug,
      debug: debugInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      companySlug,
      timestamp: new Date().toISOString()
    });
  }
});

// Rota para verificar saúde específica de um cliente
app.get("/health/:companySlug", authenticateToken, async (req, res) => {
  const { companySlug } = req.params;
  try {
    console.log(`🩺 Verificando saúde do cliente: ${companySlug}`);
    const healthCheck = await whatsapp.verifyClientHealth(companySlug);
    res.json({
      companySlug,
      health: healthCheck,
      timestamp: new Date().toISOString(),
      recommendation: healthCheck.healthy 
        ? "Cliente está funcionando normalmente" 
        : healthCheck.shouldReconnect 
          ? `Reconecte usando /status/${companySlug}` 
          : "Verifique os logs para mais detalhes"
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      companySlug,
      timestamp: new Date().toISOString()
    });
  }
});

// Rota para buscar informações de um número específico (para debug)
app.get("/search-number/:companySlug/:number", authenticateToken, async (req, res) => {
  const { companySlug, number } = req.params;
  try {
    console.log(`🔍 Buscando informações do número ${number} para empresa ${companySlug}`);
    const numberInfo = await whatsapp.searchNumberInfo(companySlug, number);
    res.json({
      companySlug,
      number,
      info: numberInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`❌ Erro ao buscar informações do número ${number}:`, error.message);
    res.status(500).json({ 
      error: error.message,
      companySlug,
      number,
      timestamp: new Date().toISOString()
    });
  }
});

// Rota para forçar limpeza de sessão com logout completo
app.delete("/clear/:companySlug", authenticateToken, async (req, res) => {
  const { companySlug } = req.params;
  try {
    console.log(`🧹 Solicitação de limpeza da sessão: ${companySlug}`);
    
    if (whatsapp.clearSession) {
      const result = await whatsapp.clearSession(companySlug);
      
      if (result.success) {
        console.log(`✅ Sessão ${companySlug} limpa:`, result.message);
        res.json({
          success: true,
          message: result.message,
          companySlug,
          details: result.details,
          whatsappLoggedOut: result.whatsappLoggedOut,
          timestamp: new Date().toISOString(),
          recommendation: result.whatsappLoggedOut 
            ? "Sessão limpa e WhatsApp desconectado com sucesso" 
            : "Sessão limpa, mas verifique se o WhatsApp foi desconectado no celular"
        });
      } else {
        console.log(`⚠️ Falha ao limpar sessão ${companySlug}:`, result.message);
        res.status(404).json({
          success: false,
          message: result.message,
          companySlug,
          timestamp: new Date().toISOString()
        });
      }
    } else {
      res.status(500).json({ 
        error: "Função clearSession não disponível",
        companySlug,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error(`❌ Erro ao limpar sessão ${companySlug}:`, error.message);
    rollbar.error(error, { companySlug, route: '/clear/:companySlug' });
    res.status(500).json({ 
      error: error.message,
      companySlug,
      timestamp: new Date().toISOString(),
      suggestion: "Tente novamente ou verifique se a sessão existe"
    });
  }
});

// Rota para limpar TODAS as sessões ativas
app.delete("/clear-all", authenticateToken, async (req, res) => {
  try {
    console.log(`🧹 Solicitação de limpeza de TODAS as sessões`);
    
    if (whatsapp.clearAllSessions) {
      const result = await whatsapp.clearAllSessions();
      
      console.log(`✅ Limpeza em massa concluída:`, result.summary);
      res.json({
        success: true,
        message: result.message,
        summary: result.summary,
        details: result.sessions,
        timestamp: new Date().toISOString(),
        recommendation: result.summary.withLogout > 0 
          ? `${result.summary.withLogout} sessões desconectadas do WhatsApp com sucesso` 
          : "Verifique manualmente se as sessões foram desconectadas no WhatsApp"
      });
    } else {
      res.status(500).json({ 
        error: "Função clearAllSessions não disponível",
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error(`❌ Erro ao limpar todas as sessões:`, error.message);
    rollbar.error(error, { route: '/clear-all' });
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString(),
      suggestion: "Tente limpar as sessões individualmente"
    });
  }
});

// Rota para deletar TODAS as empresas e sessões (incluindo dados persistidos)
app.delete("/delete-all", authenticateToken, async (req, res) => {
  try {
    console.log(`🗑️ Solicitação de EXCLUSÃO de todas as empresas e sessões`);
    
    if (whatsapp.deleteAllCompaniesAndSessions) {
      const result = await whatsapp.deleteAllCompaniesAndSessions();
      
      console.log(`✅ Exclusão completa concluída:`, result.summary);
      res.json({
        success: true,
        message: result.message,
        summary: result.summary,
        details: result.details,
        timestamp: new Date().toISOString(),
        warning: "Todos os dados de autenticação foram removidos. As empresas precisarão escanear o QR Code novamente."
      });
    } else {
      res.status(500).json({ 
        error: "Função deleteAllCompaniesAndSessions não disponível",
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error(`❌ Erro ao deletar todas as empresas e sessões:`, error.message);
    rollbar.error(error, { route: '/delete-all' });
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString(),
      suggestion: "Tente novamente ou verifique os logs do servidor"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor multi-tenant WhatsApp rodando na porta ${PORT}`);
  console.log(`\nRotas disponíveis:`);
  console.log(`GET  /status/:companySlug - Verificar status e obter QR Code`);
  console.log(`POST /send-message/:companySlug - Enviar mensagem`);
  console.log(`GET  /companies - Listar empresas conectadas`);
  console.log(`GET  /debug/:companySlug - Debug de sessão específica`);
  console.log(`GET  /health/:companySlug - Verificar saúde do cliente`);
  console.log(`GET  /search-number/:companySlug/:number - Buscar info de número (NEW!)`);
  console.log(`DELETE /clear/:companySlug - Limpar sessão e desconectar WhatsApp`);
  console.log(`DELETE /clear-all - Limpar TODAS as sessões e desconectar`);
  console.log(`DELETE /delete-all - DELETAR todas as empresas e sessões (inclui dados persistidos) (NEW!)`);
  console.log(`\n🔧 Melhorias implementadas:`);
  console.log(`   ✅ Detecção inteligente de sessões já conectadas`);
  console.log(`   ✅ Verificação robusta do estado real da conexão`);
  console.log(`   ✅ Verificação de saúde antes de enviar mensagens`);
  console.log(`   ✅ Correção automática de estados inconsistentes`);
  console.log(`   ✅ Tratamento específico de erros de conexão perdida`);
  console.log(`   ✅ Debug avançado e monitoramento de saúde`);
  console.log(`   ✅ Busca inteligente de chat correto (resolve conversa vs número) (NEW!)`);
  console.log(`   ✅ Limpeza completa com logout do WhatsApp no celular (NEW!)`);
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

