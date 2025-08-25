# WhatsApp Multi-Tenant API

## Configuração de Ambiente

### Detecção Automática do Browser

O sistema detecta automaticamente o ambiente e configura o browser adequadamente:

#### 🖥️ **Desenvolvimento** (`NODE_ENV=development`)
- Browser **COM INTERFACE** visual (headless: false)
- Permite ver o WhatsApp Web funcionando
- Melhor para debug e desenvolvimento

#### 🚀 **Produção** (`NODE_ENV=production`) 
- Browser **HEADLESS** (sem interface)
- Menor consumo de recursos
- Ideal para servidores sem interface gráfica

### Variáveis de Ambiente

```bash
# .env
NODE_ENV=development          # ou 'production'
AUTH_TOKEN=sua-chave-secreta
ROLLBAR_ACCESS_TOKEN=token-rollbar
HEADLESS=true                 # Força headless (opcional)
```

### Como Funciona a Identificação

```javascript
// No arquivo whatsapp.js
const isProduction = process.env.NODE_ENV === 'production';
const isHeadless = isProduction || process.env.HEADLESS === 'true';

// Logs automáticos:
// 🖥️ Ambiente: DESENVOLVIMENTO
// 🌐 Browser: COM INTERFACE
```

### Forçar Modo Headless

Para forçar headless independente do ambiente:
```bash
HEADLESS=true
```

### Exemplo de Deploy em Produção

```bash
# Servidor de produção
export NODE_ENV=production
npm start
# → Browser será headless automaticamente
```

## Rotas da API

- `GET /status/:companySlug` - Status e QR Code
- `POST /send-message/:companySlug` - Enviar mensagem
- `DELETE /clear/:companySlug` - Limpar sessão
