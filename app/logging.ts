import Rollbar from "rollbar";

const ROLLBAR_TOKEN = process.env.ROLLBAR_ACCESS_TOKEN;
const ROLLBAR_ENVIRONMENT = process.env.ROLLBAR_ENVIRONMENT || process.env.NODE_ENV || "development";

// Sem token o cliente do Rollbar lança TypeError (header "undefined") de forma assíncrona a cada
// report, o que vira uma cascata de uncaughtException. Por isso só é instanciado com token.
// Este módulo é avaliado no import: o .env precisa já estar carregado (ver `import "dotenv/config"`
// no topo de index.ts).
const rollbar = ROLLBAR_TOKEN
    ? new Rollbar({
          accessToken: ROLLBAR_TOKEN,
          environment: ROLLBAR_ENVIRONMENT,
          // uncaughtException é tratada em index.ts (server.error + shutdown); manter o handler do
          // Rollbar também geraria dois reports para o mesmo erro.
          captureUncaught: false,
          captureUnhandledRejections: true,
          payload: {
              server: {
                  root: __dirname,
              },
          },
      })
    : null;

function reportError(error: unknown, extra: Record<string, unknown>) {
    if (!rollbar) return;
    const err = error instanceof Error || typeof error === "string" ? error : new Error(String(error));
    rollbar.error(err, extra, (sendError) => {
        if (sendError) console.error(`[ROLLBAR] Falha ao enviar report: ${sendError.message}`);
    });
}

// Aguarda os reports pendentes serem entregues (limitado por timeout) para não perdê-los quando o
// processo sai logo em seguida (uncaughtException, SIGTERM do pm2).
export function flushErrorReports(timeoutMs: number = 2000): Promise<void> {
    if (!rollbar) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        rollbar.wait(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

export class Logger {
    private origin: string;

    constructor(origin: string = 'SERVER', tag: string = '') {
        this.origin = origin;
        this.log(`Logger initialized`);
    }

    log(msg: string, tag: string = '') {
        const now = `${new Date().toLocaleTimeString()}`;
        const tagStr = Logger.tagger(tag);
        console.log(`${now} - [${this.origin}]${tagStr} - ${msg}`);
    }

    error(msg: string, tag: string = '', route: string = '', error: unknown) {
        this.log(`[ERROR] ${msg}`, tag);
        // Não usar a chave "route" (nem headers/url/method/body/protocol): o Rollbar trata um objeto
        // com qualquer uma delas como um request do Express e descarta o resto (company se perdia).
        reportError(error, { company: this.origin, endpoint: route });
    }

    jumpLineLog(msg: string, tag: string = '') {
        console.log(`\n`);
        this.log(msg, Logger.tagger(tag));
    }

    static tagger(tag: string) {
        return tag ? `[${tag}]` : '';
    }
}

export const server = new Logger("SERVER");

if (rollbar) {
    server.log(`Rollbar habilitado (environment: ${ROLLBAR_ENVIRONMENT})`);
} else {
    server.log(`[WARN] ROLLBAR_ACCESS_TOKEN não definido: erros NÃO serão enviados ao Rollbar`);
}
