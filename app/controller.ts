import { Request, Response } from "express";
import Rollbar from "rollbar";
import * as whatsapp from "./wppwebjs";
import * as sessionManagement from "./session";
import qrcodeTerminal from "qrcode-terminal";

export function createWhatsappController(rollbar: Rollbar) {
    async function getStatus(req: Request, res: Response): Promise<void> {
        const { companySlug } = req.params as { companySlug: string };

        try {
            console.log(`📊 Verificando status da empresa: ${companySlug}`);

            if (sessionManagement.hasActiveSession(companySlug)) {
                const quickStatus = sessionManagement.checkConnectionStatus(companySlug);
                if (quickStatus.connected) {
                    console.log(`⚡ Empresa ${companySlug} já conectada (verificação rápida)`);
                    res.json({
                        connected: true,
                        companySlug,
                        method: "quick-check",
                        timestamp: new Date().toISOString(),
                    });
                    return;
                }
            }

            const status = await sessionManagement.getStatus(companySlug);

            if (status.connected) {
                console.log(`✅ Empresa ${companySlug} está conectada`);
                res.json({
                    connected: true,
                    companySlug,
                    method: "full-check",
                    timestamp: new Date().toISOString(),
                });
            } else {
                console.log(`⚠️ Empresa ${companySlug} não está conectada`);

                const response: {
                    connected: boolean;
                    companySlug: string;
                    timestamp: string;
                    qrCode?: string | null;
                    message?: string;
                    error?: string;
                    suggestion?: string;
                } = {
                    connected: false,
                    companySlug,
                    timestamp: new Date().toISOString(),
                };

                if (status.qrCode) {
                    console.log(`📱 QR Code disponível para empresa ${companySlug}`);
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
        } catch (err: any) {
            console.error(`❌ Erro ao verificar status da empresa ${companySlug}:`, err.message);
            rollbar.error(err, { companySlug, route: "/status/:companySlug" });
            res.status(500).json({
                error: err.message,
                companySlug,
                timestamp: new Date().toISOString(),
                suggestion: "Tente novamente em alguns segundos",
            });
        }
    }

    async function sendMessage(req: Request, res: Response): Promise<void> {
        const { companySlug } = req.params as { companySlug: string };
        const { number, message } = req.body;

        if (!number || !message) {
            res.status(400).json({
                error: "Os campos 'number' e 'message' são obrigatórios",
                example: {
                    number: "5511999999999",
                    message: "Sua mensagem aqui",
                },
            });
            return;
        }

        try {
            console.log(`🔍 Verificando conexão da empresa ${companySlug} antes de enviar...`);

            let quickStatus = sessionManagement.checkConnectionStatus(companySlug);

            if (!quickStatus.connected) {
                console.log(
                    `⚠️ Quick check retornou não conectado para ${companySlug}, fazendo verificação completa...`,
                );

                const healthCheck = await sessionManagement.verifyClientHealth(companySlug);

                if (healthCheck.healthy) {
                    console.log(
                        `✅ Verificação de saúde confirmou que ${companySlug} está conectado`,
                    );
                    quickStatus = { connected: true };
                } else {
                    console.log(
                        `❌ Verificação de saúde falhou para ${companySlug}:`,
                        healthCheck.reason,
                    );
                }
            }

            if (!quickStatus.connected) {
                const errorMessage = `Empresa ${companySlug} não está conectada ao WhatsApp`;

                console.error(errorMessage);

                res.status(422).json({
                    error: "Empresa não conectada",
                    message: errorMessage,
                    companySlug,
                    status: quickStatus.status || "disconnected",
                    suggestion: `Conecte a empresa primeiro acessando: /status/${companySlug}`,
                });
                return;
            }

            const session = sessionManagement.getSession(companySlug);
            console.log(`Número recebido: ${number}, sessão: ${session?.ready ? "pronta" : "não pronta"}`);

            const result = await whatsapp.sendMessage(companySlug, number, message, session!);
            console.log(`✅ Mensagem enviada pela empresa ${companySlug}`);
            res.status(200).json({
                ...result,
                originalNumber: number,
            });
        } catch (err: any) {
            console.error(`❌ Erro ao enviar mensagem pela empresa ${companySlug}:`, err.message);
            rollbar.error(err, {
                companySlug,
                number,
                route: "/send-message/:companySlug",
            });

            let statusCode = err.statusCode || 500;
            if (!err.statusCode) {
                if (
                    err.message.includes("perdeu conexão") ||
                    err.message.includes("não está conectada")
                ) {
                    statusCode = 422;
                }
            }

            const shouldRetry = err.shouldRetry !== undefined ? err.shouldRetry : false;

            res.status(statusCode).json({
                error: err.message,
                companySlug,
                originalNumber: number,
                shouldRetry,
                suggestion: err.message.includes("/status/")
                    ? "Reconecte usando a rota /status"
                    : shouldRetry
                      ? "Tente novamente em alguns segundos"
                      : `Verifique se a empresa ${companySlug} está conectada em /status/${companySlug}`,
            });
        }
    }

    function listCompanies(req: Request, res: Response): void {
        try {
            const sessions = sessionManagement.listSessions();
            res.json({
                sessions,
                total: Object.keys(sessions).length,
                connected: Object.values(sessions).filter((s) => s.ready).length,
                connecting: Object.values(sessions).filter((s) => s.connecting).length,
            });
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    async function debugSession(req: Request, res: Response): Promise<void> {
        const { companySlug } = req.params as { companySlug: string };
        try {
            console.log(`🔍 Debug da sessão: ${companySlug}`);
            const debugInfo = await sessionManagement.debugSessionState(companySlug);
            res.json({
                companySlug,
                debug: debugInfo,
                timestamp: new Date().toISOString(),
            });
        } catch (error: any) {
            res.status(500).json({
                error: error.message,
                companySlug,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async function checkHealth(req: Request, res: Response): Promise<void> {
        const { companySlug } = req.params as { companySlug: string };
        try {
            console.log(`🩺 Verificando saúde do cliente: ${companySlug}`);
            const healthCheck = await sessionManagement.verifyClientHealth(companySlug);
            res.json({
                companySlug,
                health: healthCheck,
                timestamp: new Date().toISOString(),
                recommendation: healthCheck.healthy
                    ? "Cliente está funcionando normalmente"
                    : healthCheck.shouldReconnect
                      ? `Reconecte usando /status/${companySlug}`
                      : "Verifique os logs para mais detalhes",
            });
        } catch (error: any) {
            res.status(500).json({
                error: error.message,
                companySlug,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async function searchNumber(req: Request, res: Response): Promise<void> {
        const { companySlug, number } = req.params as {
            companySlug: string;
            number: string;
        };
        try {
            console.log(`🔍 Buscando informações do número ${number} para empresa ${companySlug}`);
            const numberInfo = await sessionManagement.searchNumberInfo(companySlug, number);
            res.json({
                companySlug,
                number,
                info: numberInfo,
                timestamp: new Date().toISOString(),
            });
        } catch (error: any) {
            console.error(`❌ Erro ao buscar informações do número ${number}:`, error.message);
            res.status(500).json({
                error: error.message,
                companySlug,
                number,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async function clearSession(req: Request, res: Response): Promise<void> {
        const { companySlug } = req.params as { companySlug: string };
        try {
            console.log(`🧹 Solicitação de limpeza da sessão: ${companySlug}`);

            const result = await sessionManagement.clearSession(companySlug);

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
                        : "Sessão limpa, mas verifique se o WhatsApp foi desconectado no celular",
                });
            } else {
                console.log(`⚠️ Falha ao limpar sessão ${companySlug}:`, result.message);
                res.status(404).json({
                    success: false,
                    message: result.message,
                    companySlug,
                    timestamp: new Date().toISOString(),
                });
            }
        } catch (error: any) {
            console.error(`❌ Erro ao limpar sessão ${companySlug}:`, error.message);
            rollbar.error(error, { companySlug, route: "/clear/:companySlug" });
            res.status(500).json({
                error: error.message,
                companySlug,
                timestamp: new Date().toISOString(),
                suggestion: "Tente novamente ou verifique se a sessão existe",
            });
        }
    }

    async function clearAll(req: Request, res: Response): Promise<void> {
        try {
            console.log(`🧹 Solicitação de limpeza de TODAS as sessões`);

            const result = await sessionManagement.clearAllSessions();

            console.log(`✅ Limpeza em massa concluída:`, result.summary);
            res.json({
                success: true,
                message: result.message,
                summary: result.summary,
                details: result.sessions,
                timestamp: new Date().toISOString(),
                recommendation:
                    result.summary && result.summary.withLogout > 0
                        ? `${result.summary.withLogout} sessões desconectadas do WhatsApp com sucesso`
                        : "Verifique manualmente se as sessões foram desconectadas no WhatsApp",
            });
        } catch (error: any) {
            console.error(`❌ Erro ao limpar todas as sessões:`, error.message);
            rollbar.error(error, { route: "/clear-all" });
            res.status(500).json({
                error: error.message,
                timestamp: new Date().toISOString(),
                suggestion: "Tente limpar as sessões individualmente",
            });
        }
    }

    async function deleteAll(req: Request, res: Response): Promise<void> {
        try {
            console.log(`🗑️ Solicitação de EXCLUSÃO de todas as empresas e sessões`);

            const result = await sessionManagement.deleteAllCompaniesAndSessions();

            console.log(`✅ Exclusão completa concluída:`, result.summary);
            res.json({
                success: true,
                message: result.message,
                summary: result.summary,
                details: result.details,
                timestamp: new Date().toISOString(),
                warning:
                    "Todos os dados de autenticação foram removidos. As empresas precisarão escanear o QR Code novamente.",
            });
        } catch (error: any) {
            console.error(`❌ Erro ao deletar todas as empresas e sessões:`, error.message);
            rollbar.error(error, { route: "/delete-all" });
            res.status(500).json({
                error: error.message,
                timestamp: new Date().toISOString(),
                suggestion: "Tente novamente ou verifique os logs do servidor",
            });
        }
    }

    return {
        getStatus,
        sendMessage,
        listCompanies,
        debugSession,
        checkHealth,
        searchNumber,
        clearSession,
        clearAll,
        deleteAll,
    };
}
