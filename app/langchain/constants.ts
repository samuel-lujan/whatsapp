// Using the graph deployed with the name "agent"
const assistantId = "fe096781-5601-53d2-b2f6-0d3403f7e9ca";

const APP_TOKEN = process.env.APP_TOKEN;
const BETA_HASH = process.env.BETA_HASH;
const BETA_HASH_2 = process.env.BETA_HASH_2;
const TRANSCRIPTION = process.env.TRANSCRIPTION === "true";
const SESSION_EXPIRY_SECONDS = 3600;

const API_URLS = {
    "studio-homolog": "https://homolog.samuellujan.com.br/api",
    lesma: "https://homolog.samuellujan.com.br/api",
    default: "https://www.jusilveiraspinning.com.br/api",
};

export {
    assistantId,
    APP_TOKEN,
    BETA_HASH,
    BETA_HASH_2,
    API_URLS,
    TRANSCRIPTION,
    SESSION_EXPIRY_SECONDS,
};
