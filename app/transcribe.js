const fs = require("fs");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

const OPENAI_MODEL = "gpt-4o-transcribe";

function getClient() {
  if (!process.env.OPENAI_TRANSCRIBE_KEY) {
    throw new Error("OPENAI_TRANSCRIBE_KEY não configurada");
  }

  return new OpenAI({ apiKey: process.env.OPENAI_TRANSCRIBE_KEY });
}

async function buildAudioFile(audio, options = {}) {
  const filename = options.filename || "audio.wav";

  if (typeof audio === "string") {
    if (!fs.existsSync(audio)) {
      throw new Error(`Arquivo de áudio não encontrado: ${audio}`);
    }
    return fs.createReadStream(audio);
  }

  if (Buffer.isBuffer(audio)) {
    return toFile(audio, filename);
  }

  if (audio && typeof audio.pipe === "function") {
    return audio;
  }

  throw new Error(
    "Formato de áudio inválido. Use caminho de arquivo, Buffer ou stream.",
  );
}

async function transcribeAudio(audio, options = {}) {
  const client = getClient();
  const file = await buildAudioFile(audio, options);

  const response = await client.audio.transcriptions.create({
    model: OPENAI_MODEL,
    file,
    language: options.language,
    prompt: options.prompt,
    temperature: options.temperature,
  });

  return response.text || "";
}

module.exports = {
  transcribeAudio,
};
