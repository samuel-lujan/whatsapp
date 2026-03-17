import { execSync } from "child_process";
import { sessions } from ".";
import { errMsg } from "../utils";

export function killOrphanChromeProcesses(companySlug: string, tag: string): void {
    try {
        const sessionDir = `session-${companySlug}`;
        const result = execSync(`pgrep -f "${sessionDir}" || true`, { timeout: 5000 }).toString().trim();
        if (!result) {
            console.log(`[${tag}] ${companySlug}: nenhum processo Chrome órfão encontrado`);
            return;
        }
        const pids = result.split("\n").filter(Boolean);
        console.log(`[${tag}] ${companySlug}: matando ${pids.length} processos Chrome órfãos: ${pids.join(", ")}`);
        execSync(`kill -9 ${pids.join(" ")} || true`, { timeout: 5000 });
        console.log(`[${tag}] ${companySlug}: processos órfãos eliminados`);
    } catch (e) {
        console.log(`[${tag}] ${companySlug}: busca de processos órfãos falhou: ${errMsg(e)}`);
    }
}

export async function waitForQrCode(companySlug: string, timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            console.log(`⏰ Timeout ao aguardar QR Code para ${companySlug} após ${timeout / 1000}s`);
            reject(new Error(`Timeout ao gerar QR Code para ${companySlug}. Tente novamente.`));
        }, timeout);

        const interval = setInterval(() => {
            if (sessions[companySlug] && (sessions[companySlug].qrCode || sessions[companySlug].ready)) {
                clearTimeout(timeoutId);
                clearInterval(interval);
                console.log(`✅ QR Code gerado ou cliente conectado para ${companySlug}`);
                resolve();
            }

            if (!sessions[companySlug]) {
                clearTimeout(timeoutId);
                clearInterval(interval);
                reject(new Error(`Sessão ${companySlug} foi removida durante a espera`));
            }
        }, 1000);
    });
}
