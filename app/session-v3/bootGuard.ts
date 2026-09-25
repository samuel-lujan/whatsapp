import path from "path";
import fs from "fs";
import { server } from "../logging";
import { BAILEYS_AUTH_DIR } from "./constants";

// Disjuntor da carga automática de sessões no boot. Se alguma sessão derruba o processo enquanto
// carrega (ou logo depois), o pm2 reinicia, o boot carrega de novo e derruba de novo, em loop.
// Cada boot conta como instável até as sessões ficarem de pé por STABLE_AFTER_MS; depois de
// MAX_UNSTABLE_BOOTS seguidos o boot sobe só a API, como era antes da carga automática.
const GUARD_FILE = path.resolve(process.cwd(), BAILEYS_AUTH_DIR, ".boot-guard.json");
const MAX_UNSTABLE_BOOTS = 3;
const STABLE_AFTER_MS = 2 * 60 * 1000;

let stableTimer: NodeJS.Timeout | null = null;

function readUnstableBoots(): number {
    try {
        const data = JSON.parse(fs.readFileSync(GUARD_FILE, "utf8"));
        return Number(data.unstableBoots) || 0;
    } catch {
        return 0;
    }
}

function writeUnstableBoots(unstableBoots: number): void {
    try {
        fs.mkdirSync(path.dirname(GUARD_FILE), { recursive: true });
        fs.writeFileSync(
            GUARD_FILE,
            JSON.stringify({ unstableBoots, updatedAt: new Date().toISOString() }),
        );
    } catch (e: any) {
        server.log(`[v3] Falha ao gravar ${GUARD_FILE}: ${e.message}`, "BOOT_GUARD");
    }
}

// Registra a tentativa de carga no boot. Retorna false quando o disjuntor está aberto.
export function registerBootLoad(): boolean {
    const unstableBoots = readUnstableBoots();
    if (unstableBoots >= MAX_UNSTABLE_BOOTS) {
        return false;
    }
    writeUnstableBoots(unstableBoots + 1);
    return true;
}

// Chamado depois de cada carga completa (boot ou GET /v3/sessions/load). Se o processo continuar
// de pé por STABLE_AFTER_MS, zera o contador e fecha o disjuntor.
export function markLoadCompleted(): void {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
        stableTimer = null;
        writeUnstableBoots(0);
    }, STABLE_AFTER_MS);
    stableTimer.unref();
}
