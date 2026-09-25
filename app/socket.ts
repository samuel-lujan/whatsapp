import { Server } from "socket.io";
import { createServer } from "node:http";
import { server as logger } from "./logging";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "sua-chave-secreta-aqui";

// Singleton — null until initSocketServer() is called
export let io: Server | null = null;

export function initSocketServer(httpServer: ReturnType<typeof createServer>): Server {
    const socketServer = new Server(httpServer, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
    });

    // Auth middleware — same token used by the REST API
    socketServer.use((socket, next) => {
        const token = socket.handshake.auth?.token as string | undefined;
        if (!token) {
            return next(new Error("Authentication token required"));
        }
        if (token !== AUTH_TOKEN) {
            return next(new Error("Invalid authentication token"));
        }
        next();
    });

    socketServer.on("connection", (socket) => {
        logger.log(`[socket.io] Client connected: ${socket.id}`);

        socket.on("joinChat", (chatId: string) => {
            if (typeof chatId !== "string" || chatId.trim() === "") return;
            socket.join(chatId);
        });

        socket.on("leaveChat", (chatId: string) => {
            if (typeof chatId !== "string" || chatId.trim() === "") return;
            socket.leave(chatId);
        });

        socket.on("disconnect", (reason) => {
            logger.log(`[socket.io] Client disconnected: ${socket.id} — reason: ${reason}`);
        });
    });

    io = socketServer;
    logger.log("[socket.io] Server initialized");

    return socketServer;
}
