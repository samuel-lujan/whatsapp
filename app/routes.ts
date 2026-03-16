import { Router, Request, Response, NextFunction } from "express";
import Rollbar from "rollbar";
import * as whatsapp from "./wppwebjs";
import qrcodeTerminal from "qrcode-terminal";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "sua-chave-secreta-aqui";

function authenticateToken(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

    if (!token) {
        res.status(401).json({
            error: "Token de acesso requerido",
            message: "Inclua o token no header: Authorization: Bearer SEU_TOKEN",
        });
        return;
    }

    if (token !== AUTH_TOKEN) {
        res.status(403).json({
            error: "Token inválido",
            message: "O token fornecido não é válido",
        });
        return;
    }

    next();
}

export function createRouter(rollbar: Rollbar): Router {
    const router = Router();

    // Rota para verificar status da empresa e retornar QR Code se necessário
    router.get("/status/:companySlug", authenticateToken, async (req, res) => {
        const { companySlug } = req.params as { companySlug: string };

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
                        method: "quick-check",
                        timestamp: new Date().toISOString(),
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
    });

    // Rota para enviar mensagem usando a sessão da empresa
    router.post("/send-message/:companySlug", authenticateToken, async (req, res) => {
        const { companySlug } = req.params as { companySlug: string };
        const { number, message } = req.body;

        // Validação dos campos obrigatórios
        if (!number || !message) {
            return res.status(400).json({
                error: "Os campos 'number' e 'message' são obrigatórios",
                example: {
                    number: "5511999999999",
                    message: "Sua mensagem aqui",
                },
            });
        }

        try {
            console.log(`🔍 Verificando conexão da empresa ${companySlug} antes de enviar...`);

            // Primeiro tenta quick check
            let quickStatus = whatsapp.checkConnectionStatus(companySlug);

            // Se retornou needs_verification ou não conectado, faz verificação completa
            if (!quickStatus.connected) {
                console.log(
                    `⚠️ Quick check retornou não conectado para ${companySlug}, fazendo verificação completa...`,
                );

                const healthCheck = await whatsapp.verifyClientHealth(companySlug);

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
                const suggestion = `Conecte a empresa primeiro acessando: /status/${companySlug}`;

                console.error(errorMessage);

                return res.status(422).json({
                    error: "Empresa não conectada",
                    message: errorMessage,
                    companySlug,
                    status: quickStatus.status || "disconnected",
                    suggestion,
                });
            }

            console.log(`Número recebido: ${number}`);

            const result = await whatsapp.sendMessage(companySlug, number, message);
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

            // Usa statusCode do erro se disponível, senão infere do tipo de erro
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
    });

    // Rota para listar empresas conectadas
    router.get("/companies", authenticateToken, (req, res) => {
        try {
            const sessions = whatsapp.listSessions();
            res.json({
                sessions,
                total: Object.keys(sessions).length,
                connected: Object.values(sessions).filter((s) => s.ready).length,
                connecting: Object.values(sessions).filter((s) => s.connecting).length,
            });
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    });

    // Rota para debug de sessão específica
    router.get("/debug/:companySlug", authenticateToken, async (req, res) => {
        const { companySlug } = req.params as { companySlug: string };
        try {
            console.log(`🔍 Debug da sessão: ${companySlug}`);
            const debugInfo = await whatsapp.debugSessionState(companySlug);
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
    });

    // Rota para verificar saúde específica de um cliente
    router.get("/health/:companySlug", authenticateToken, async (req, res) => {
        const { companySlug } = req.params as { companySlug: string };
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
                      : "Verifique os logs para mais detalhes",
            });
        } catch (error: any) {
            res.status(500).json({
                error: error.message,
                companySlug,
                timestamp: new Date().toISOString(),
            });
        }
    });

    // Rota para buscar informações de um número específico (para debug)
    router.get("/search-number/:companySlug/:number", authenticateToken, async (req, res) => {
        const { companySlug, number } = req.params as {
            companySlug: string;
            number: string;
        };
        try {
            console.log(`🔍 Buscando informações do número ${number} para empresa ${companySlug}`);
            const numberInfo = await whatsapp.searchNumberInfo(companySlug, number);
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
    });

    // Rota para forçar limpeza de sessão com logout completo
    router.delete("/clear/:companySlug", authenticateToken, async (req, res) => {
        const { companySlug } = req.params as { companySlug: string };
        try {
            console.log(`🧹 Solicitação de limpeza da sessão: ${companySlug}`);

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
    });

    // Rota para limpar TODAS as sessões ativas
    router.delete("/clear-all", authenticateToken, async (req, res) => {
        try {
            console.log(`🧹 Solicitação de limpeza de TODAS as sessões`);

            const result = await whatsapp.clearAllSessions();

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
    });

    // Rota para deletar TODAS as empresas e sessões (incluindo dados persistidos)
    router.delete("/delete-all", authenticateToken, async (req, res) => {
        try {
            console.log(`🗑️ Solicitação de EXCLUSÃO de todas as empresas e sessões`);

            const result = await whatsapp.deleteAllCompaniesAndSessions();

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
    });

    return router;
}
