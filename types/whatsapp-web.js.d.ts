declare module "whatsapp-web.js" {
  import { EventEmitter } from "events";

  export interface ClientOptions {
    authStrategy?: AuthStrategy;
    puppeteer?: Record<string, unknown>;
    webVersionCache?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface AuthStrategy {}

  export interface LocalAuthOptions {
    clientId?: string;
    dataPath?: string;
  }

  export class LocalAuth implements AuthStrategy {
    constructor(options?: LocalAuthOptions);
  }

  export interface Message {
    id: { id: string; remote: string; fromMe: boolean };
    body: string;
    from: string;
    to: string;
    author?: string;
    hasMedia: boolean;
    type: string;
    isStatus: boolean;
    broadcast: boolean;
    fromMe: boolean;
    timestamp: number;
    getChat(): Promise<Chat>;
    getContact(): Promise<Contact>;
    downloadMedia(): Promise<MessageMedia>;
    reply(content: string): Promise<Message>;
  }

  export interface Chat {
    id: { _serialized: string; user: string };
    name: string;
    isGroup: boolean;
    isReadOnly: boolean;
    unreadCount: number;
    timestamp: number;
    getContact(): Promise<Contact>;
    markUnread(): Promise<void>;
  }

  export interface MessageMedia {
    mimetype: string;
    data: string;
    filename?: string;
  }

  export interface Contact {
    id: { _serialized: string; user: string };
    number?: string;
    name?: string;
    pushname?: string;
    isMyContact: boolean;
    isWAContact: boolean;
    isUser?: boolean;
    isGroup: boolean;
    isBlocked: boolean;
    getChat(): Promise<Chat>;
  }

  export type WAState =
    | "CONNECTED"
    | "OPENING"
    | "PAIRING"
    | "CONFLICT"
    | "UNLAUNCHED"
    | "PROXYBLOCK"
    | "TIMEOUT"
    | "TOS_BLOCK"
    | "SMB_TOS_BLOCK"
    | "UNPAIRED"
    | "UNPAIRED_IDLE";

  export class Client extends EventEmitter {
    constructor(options?: ClientOptions);

    info: { wid: { _serialized: string; user: string }; pushname: string };
    pupBrowser: {
      process(): {
        pid: number | null;
        kill(signal?: string): boolean;
        killed: boolean;
      } | null;
    } | null;
    pupPage: { isClosed(): boolean } | null;

    initialize(): Promise<void>;
    destroy(): Promise<void>;
    logout(): Promise<void>;

    sendMessage(chatId: string, content: string): Promise<Message>;
    getState(): Promise<WAState | null>;
    getChats(): Promise<Chat[]>;
    getChatById(chatId: string): Promise<Chat>;
    getContactById(contactId: string): Promise<Contact>;
    getNumberId(number: string): Promise<{ _serialized: string; user: string } | null>;
    isRegisteredUser(number: string): Promise<boolean>;
    getContacts(): Promise<Contact[]>;

    on(event: "qr", listener: (qr: string) => void): this;
    on(event: "ready", listener: () => void): this;
    on(event: "authenticated", listener: () => void): this;
    on(event: "auth_failure", listener: (msg: string) => void): this;
    on(event: "disconnected", listener: (reason: string) => void): this;
    on(event: "change_state", listener: (state: WAState) => void): this;
    on(event: "change_battery", listener: (batteryInfo: { battery: number; plugged: boolean }) => void): this;
    on(event: "message", listener: (msg: Message) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
