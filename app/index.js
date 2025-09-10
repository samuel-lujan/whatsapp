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
    // Verifica se a empresa está conectada antes de enviar (SEM abrir browser)
    const status = whatsapp.checkConnectionStatus(companySlug);
    
    if (!status.connected) {
      const errorMessage = `Empresa ${companySlug} não está conectada ao WhatsApp`;
      console.error(errorMessage);
      rollbar.warning(errorMessage, { 
        companySlug, 
        route: '/send-message/:companySlug',
        action: 'company_not_connected'
      });
      
      return res.status(422).json({
        error: "Empresa não conectada",
        message: `A empresa ${companySlug} não está conectada ao WhatsApp`,
        companySlug,
        suggestion: `Conecte a empresa primeiro acessando: /status/${companySlug}`
      });
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

// Rota para forçar limpeza de sessão (para debug)
app.delete("/clear/:companySlug", authenticateToken, (req, res) => {
  const { companySlug } = req.params;
  try {
    if (whatsapp.clearSession) {
      whatsapp.clearSession(companySlug);
      res.json({ message: `Sessão ${companySlug} limpa com sucesso` });
    } else {
      res.json({ message: "Função clearSession não disponível" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor multi-tenant WhatsApp rodando na porta ${PORT}`);
  console.log(`\nRotas disponíveis:`);
  console.log(`GET  /status/:companySlug - Verificar status e obter QR Code`);
  console.log(`POST /send-message/:companySlug - Enviar mensagem`);
  console.log(`GET  /companies - Listar empresas conectadas`);
  console.log(`GET  /debug/:companySlug - Debug de sessão específica (NEW!)`);
  console.log(`DELETE /clear/:companySlug - Limpar sessão específica`);
  console.log(`\n🔧 Melhorias implementadas:`);
  console.log(`   ✅ Detecção inteligente de sessões já conectadas`);
  console.log(`   ✅ Evita regeneração de QR Code desnecessária`);
  console.log(`   ✅ Verificação robusta do estado real da conexão`);
  console.log(`   ✅ Correção automática de estados inconsistentes`);
  console.log(`   ✅ Melhor tratamento de erros e timeouts`);
  console.log(`   ✅ Debug avançado com logs detalhados`);
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

