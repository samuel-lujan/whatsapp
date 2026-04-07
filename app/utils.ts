import { execSync } from "child_process";
import { server } from "./logging";
import { clearAllSessions } from "./session-v2/service";
import { Response } from "express";

export const errMsg = (e: unknown): string => (e as Error).message;

export function raceWithTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message = "timeout",
): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
}

export async function gracefulShutdown(signal: string, isShuttingDown: boolean): Promise<void> {
    const tag = "SHUTDOWN";
    if (isShuttingDown) return;
    isShuttingDown = true;

    server.jumpLineLog(`Recebido ${signal}, limpando todas as sessoes...`, tag);

    try {
        await raceWithTimeout(clearAllSessions(), 30000, "shutdown timeout");
        server.log(`Sessoes limpas com sucesso`, tag);
    } catch (err: any) {
        server.log(`Erro/timeout na limpeza: ${err.message}`, tag);
    }

    // Ultimo recurso: mata processos Chrome orfaos
    try {
        execSync('pkill -f "chromium.*--no-sandbox" || true', { timeout: 5000 });
    } catch (e) {
        // pkill retorna non-zero se nenhum processo encontrado
        server.log(`Nenhum processo Chrome órfão encontrado para eliminar`, tag);
    }

    server.log(`Saindo.`, tag);
    process.exit(0);
}


export function returnSuccess(res: Response, data: unknown, args: Record<string, unknown> = {}) {
  return res.status(200).json({
    success: true,
    data,
    ...args,
  });
}

export function returnError(status: number, res: Response, message: string, args: Record<string, unknown> = {}) {
  return res.status(status).json({
    success: false,
    message,
    ...args,
  });
}
