# WhatsApp Multi-Tenant API

API multi-tenant para gerenciar sessões do WhatsApp Web por empresa, com suporte a restauração automática, envio de mensagens, logs estruturados e integração opcional com IA.

---

## ✨ Recursos

- Sessões isoladas por empresa
- Restauração automática a partir de `.wwebjs_auth`
- Envio de mensagens via `whatsapp-web.js`
- Sessões com IA pela rota dedicada `/v2/ai/session/:company`
- Health check de sessão e verificação do Puppeteer
- Logs com origem, horário e tags
- Suporte a `Dockerfile` e `docker-compose.yml`

---

## ⚙️ Variáveis de ambiente

Crie um arquivo `.env` com os valores abaixo:

```bash
NODE_ENV=development
AUTH_TOKEN=sua-chave-secreta
ROLLBAR_ACCESS_TOKEN=token-rollbar
HEADLESS=true
APP_TOKEN=seu-app-token
BETA_HASH=seu-beta-hash
```

### Modo de browser

O projeto detecta o ambiente automaticamente:

- `NODE_ENV=development` → browser com interface
- `NODE_ENV=production` → browser headless
- `HEADLESS=true` → força modo headless em qualquer ambiente

---

## 🚀 Como rodar

### Localmente

```bash
npm install
npm run dev
```

Servidor HTTP padrão:

- **Porta:** `8080`

### Typecheck

```bash
npm run typecheck
```

### Docker

```bash
docker build -t whatsapp-server .
docker run --env-file .env -p 8080:8080 whatsapp-server
```

### Docker Compose

```bash
docker compose up -d --build
```

> A rede externa `lang-network` precisa existir antes do `docker compose up`.

---

## 🔐 Autenticação

Todas as rotas usam Bearer Token no header `Authorization`:

```http
Authorization: Bearer SEU_TOKEN
```

O token é validado em `app/routes.ts` com base em `AUTH_TOKEN`.

---

## 📡 Rotas da API

| Método   | Rota                           | Descrição                            | Observações                                          |
| -------- | ------------------------------ | ------------------------------------ | ---------------------------------------------------- |
| `GET`    | `/v2/session/:company`         | Obtém a sessão atual da empresa      | Retorna `404` se a sessão não existir                |
| `POST`   | `/v2/session/:company`         | Cria ou restaura uma sessão          | Pode retornar QR Code se ainda não estiver conectada |
| `POST`   | `/v2/ai/session/:company`      | Cria sessão com IA habilitada        | Mesmo fluxo da criação normal, com `hasAi=true`      |
| `POST`   | `/v2/session/:company/message` | Envia mensagem para um número        | Body: `number`, `message`, `customName?`             |
| `DELETE` | `/v2/session/:company`         | Remove a sessão e limpa recursos     | Faz logout/cleanup do cliente                        |
| `GET`    | `/v2/sessions/`                | Lista as sessões ativas em memória   | Retorna array de nomes/sessões disponíveis           |
| `GET`    | `/v2/sessions/load`            | Carrega sessões persistidas do disco | Reidrata sessões salvas em `.wwebjs_auth`            |

---

## 🧪 Exemplos de uso

### Criar ou restaurar sessão

```bash
curl -X POST http://localhost:8080/v2/session/minha-empresa \
  -H "Authorization: Bearer sua-chave-secreta"
```

Se a sessão ainda não estiver conectada, a resposta pode incluir `qrCode` para escaneamento.

### Criar sessão com IA

```bash
curl -X POST http://localhost:8080/v2/ai/session/minha-empresa \
  -H "Authorization: Bearer sua-chave-secreta"
```

### Enviar mensagem

```bash
curl -X POST http://localhost:8080/v2/session/minha-empresa/message \
  -H "Authorization: Bearer sua-chave-secreta" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5511999999999",
    "message": "Olá! Esta é uma mensagem de teste.",
    "customName": "Cliente Demo"
  }'
```

### Deletar sessão

```bash
curl -X DELETE http://localhost:8080/v2/session/minha-empresa \
  -H "Authorization: Bearer sua-chave-secreta"
```

---

## 🧠 Objeto `Session`

Arquivo principal: `app/session-v2/session.ts`

A classe `Session` representa uma conexão do WhatsApp vinculada a uma empresa. Ela encapsula o cliente do `whatsapp-web.js`, o estado da conexão e os fluxos de envio e reconexão.

### Responsabilidades

- inicializar o cliente WhatsApp
- capturar QR Code
- acompanhar mudanças de estado
- enviar mensagens com validação de número
- detectar falhas do browser/Puppeteer
- serializar um resumo seguro da sessão para a API

### Campos importantes

- `name`: identificador da empresa/sessão
- `qrCode`: QR atual para autenticação
- `ready`: indica se a sessão está pronta para uso
- `connecting`: indica se a sessão ainda está conectando
- `destroying`: evita destruição duplicada
- `reconnectAttempts`: contador de tentativas de reconnect
- `lastDisconnectReason`: último motivo de desconexão
- `hasAi`: habilita fluxo de IA para mensagens recebidas
- `trackingContacts`: contatos acompanhados durante os envios

### Métodos principais

- `initialize()` — inicia o cliente WhatsApp
- `sendMessage()` — valida e envia mensagens
- `checkPupPage()` — verifica se a página do Puppeteer ainda está aberta
- `getState()` — obtém o estado atual do cliente
- `getInfo()` — tenta recuperar dados básicos do cliente conectado
- `getChatsLength()` — verificação prática de saúde da sessão
- `toJSON()` — retorna um objeto serializável para respostas HTTP

### Objeto serializado da sessão

A API retorna um resumo seguro da sessão, incluindo campos como:

- `name`
- `qrCode`
- `ready`
- `connecting`
- `destroying`
- `reconnectAttempts`
- `lastDisconnectTime`
- `lastDisconnectReason`
- `hasAi`
- `trackingContacts`
- `isPuppeteerOpen`
- `clientInfo`

---

## 🗂️ `SessionManager`

Arquivo principal: `app/session-v2/sessionManager.ts`

`SessionManager` é o coordenador central das sessões. Ele usa padrão **singleton** para manter uma única instância responsável por todas as sessões carregadas em memória.

### Responsabilidades

- manter o mapa de sessões ativas
- evitar criação duplicada com `pendingSessions`
- restaurar sessões salvas ao subir a aplicação
- recriar sessões com Puppeteer fechado
- validar a saúde da conexão antes de operações críticas

### Métodos principais

- `setup()` — procura diretórios em `.wwebjs_auth` e restaura sessões persistidas
- `loadSession(name)` — carrega uma sessão específica do disco
- `createSession(name, isHeadless, hasAi)` — cria sessão nova com proteção contra duplicidade
- `getSession(name)` — busca a sessão em memória
- `listSessions()` — lista sessões ativas
- `verifySessionHealth(companySlug)` — faz checagens de browser, estado e chats

---

## 🧾 Logger e rastreabilidade

Arquivo principal: `app/logging.ts`

O projeto usa uma classe `Logger` simples e consistente para facilitar debug e operação em produção.

### Recursos do logger

- prefixo com horário atual
- origem do log, como `[SERVER]` ou o nome da sessão
- tags opcionais, por exemplo `[onREADY]`, `[RECONNECT]`, `[DESTROY]`
- método `jumpLineLog()` para destacar blocos importantes no terminal

### Exemplo de saída

```text
14:30:10 - [SERVER] - Servidor multi-tenant WhatsApp rodando na porta 8080
14:30:15 - [empresa-a][onREADY] - ✅ WhatsApp conectado.
14:31:02 - [empresa-a][RECONNECT] - tentativa 1/5 em 10s
```

Instâncias importantes:

- `server` → logger global da aplicação
- `session.logger` → logger específico de cada sessão

---

## 📁 Organização de pastas

```text
app/
├── index.ts               # ponto de entrada do servidor HTTP
├── routes.ts              # rotas Express v2 e autenticação por token
├── logging.ts             # classe Logger e logger global `server`
├── socket.ts              # inicialização do Socket.IO
├── types.ts               # tipos compartilhados da aplicação
├── utils.ts               # helpers como timeout, retorno e shutdown
├── langchain/             # integração com IA / geração de resposta
├── transcription/         # recursos de transcrição
├── wppwebjs/              # helpers para whatsapp-web.js
└── session-v2/
    ├── controller.ts      # controllers HTTP
    ├── service.ts         # regras de negócio da sessão
    ├── session.ts         # classe `Session`
    ├── sessionManager.ts  # singleton `SessionManager`
    ├── constants.ts       # estados e constantes
    └── errorHandler.ts    # tratamento centralizado de erros
```

Diretórios auxiliares:

- `.wwebjs_auth/` — persistência das sessões autenticadas
- `.wwebjs_cache/` — cache do browser/WhatsApp Web
- `test/` — scripts de teste e apoio
- `types/` — declarações de tipos customizados

---

## ✅ Resumo

Este projeto fornece uma base estável para operar múltiplas sessões do WhatsApp com:

- gerenciamento centralizado de sessão
- reconexão e health check
- documentação de rotas atualizada
- logs claros para operação e suporte
- suporte a execução local e em containers
