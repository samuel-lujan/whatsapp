import { getSession } from "../session-v2/service";
import { returnError, returnSuccess } from "../utils";
import { Request, Response } from "express";

export function returnChats(res: Response, data: unknown, args: Record<string, unknown> = {}) {
  return res.status(200).json({
    currentUserId: 'true',
    data,
    ...args,
  });
}

export const getTrackedChatsController = async (req: Request, res: Response) => {
  const { company } = req.params as { company: string };
  try {
    const session = getSession(company);
    if (!session) {
      return returnError(404, res, `Session with name ${company} not found`);
    }

    const chats = await session.client.getChats();
    session.logger.log(`Obtidos ${chats.length} chats`);
    session.logger.log(`Tracking ${session.trackingContacts.length} chats.`);
    const filteredChats = session.trackingContacts.length > 0
      ? await Promise.all(session.trackingContacts.map(async (contact) => ({
          chat: await session.client.getChatById(contact.number),
          contact,
        })))
      : [];
    const formattedChats = filteredChats.map(({ chat, contact }) => ({
      id: chat.id._serialized,
      name: contact.customName || contact.pushname || chat.name,
      users: [chat.name, company],
      lastMessage: chat.lastMessage?.body || '',
      createdAt: Date.now()
    }));
    session.logger.log(`Retornando ${formattedChats.length} chats filtrados por trackingContacts`);
    return returnChats(res, formattedChats);
  } catch (error) {
    return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
  }
};

export const getAllChatsController = async (req: Request, res: Response) => {
  const { company } = req.params as { company: string };
  try {
    const session = getSession(company);
    if (!session) {
      return returnError(404, res, `Session with name ${company} not found`);
    }

    const chats = await session.client.getChats();
    session.logger.log(`Obtidos ${chats.length} chats`);
    const formattedChats = chats.map(chat => {
      const tracked = session.trackingContacts.find(c => c.number === chat.id._serialized);
      return {
        id: chat.id._serialized,
        name: tracked?.customName || tracked?.pushname || chat.name,
        users: [chat.name, company],
        lastMessage: chat.lastMessage?.body || '',
        createdAt: Date.now()
      };
    });
    session.logger.log(`Retornando ${formattedChats.length} chats filtrados por trackingContacts`);
    return returnChats(res, formattedChats);
  } catch (error) {
    return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
  }
};

export const getChatController = async (req: Request, res: Response) => {
  const { company, chatId } = req.params as { company: string, chatId: string };
  try {
    const session = getSession(company);
    if (!session) {
      return returnError(404, res, `Session with name ${company} not found`);
    }

    const chat = await session.client.getChatById(chatId);
    if (!chat) {
      return returnError(404, res, `Chat with id ${chatId} not found`);
    }

    return res.status(200).json(chat);
  } catch (error) {
    return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
  }
};

export const getMessagesController = async (req: Request, res: Response) => {
  const { company, chatId } = req.params as { company: string, chatId: string };
  try {
    const session = getSession(company);
    if (!session) {
      return returnError(404, res, `Session with name ${company} not found`);
    }

    const chat = await session.client.getChatById(chatId);
    if (!chat) {
      return returnError(404, res, `Chat with id ${chatId} not found`);
    }

    const messages = await chat.fetchMessages({ limit: 50 });
    session.logger.log(`Obtidos ${messages.length} mensagens para o chat ${chatId}`);
    const data = messages.map(msg => ({
      id: msg.id._serialized,
      chatId: chat.id._serialized,
      senderId: msg.from || '',
      receiverId: msg.to || '',
      fromMe: msg.fromMe || false,
      content: msg.body || '',
      timestamp: msg.timestamp.toString()
    }));

    return returnSuccess(res, data);;
  } catch (error) {
    return returnError(500, res, error instanceof Error ? error.message : "Internal server error");
  }
};