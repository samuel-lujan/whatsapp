interface ChatSession {
    sessionId: string;
    threadId: string;
    authToken: string;
    lastUpdate: number;
    userName: string;
    isAbleToAiResponse: boolean;
    apiUrl: string;
}

interface UserData {
    name: string;
    is_able_to_ai_response: boolean;
}

interface LoginData {
    token: string;
}

interface AiResponse {
    success: boolean;
    body?: string;
}