import fs from "fs";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { Readable } from "stream";

const OPENAI_MODEL = "gpt-4o-transcribe";

interface TranscribeOptions {
  filename?: string;
  language?: string;
  prompt?: string;
  temperature?: number;
}

function getClient(): OpenAI {
  if (!process.env.OPENAI_TRANSCRIBE_KEY) {
    throw new Error("OPENAI_TRANSCRIBE_KEY não configurada");
  }

  return new OpenAI({ apiKey: process.env.OPENAI_TRANSCRIBE_KEY });
}

async function buildAudioFile(
  audio: string | Buffer | Readable,
  options: TranscribeOptions = {}
): Promise<Awaited<ReturnType<typeof toFile>> | fs.ReadStream | Readable> {
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

  if (audio && typeof (audio as Readable).pipe === "function") {
    return audio as Readable;
  }

  throw new Error(
    "Formato de áudio inválido. Use caminho de arquivo, Buffer ou stream."
  );
}

export async function transcribeAudio(
  audio: string | Buffer | Readable,
  options: TranscribeOptions = {}
): Promise<string> {
  const client = getClient();
  const file = await buildAudioFile(audio, options);

  const response = await client.audio.transcriptions.create({
    model: OPENAI_MODEL,
    file: file as Parameters<typeof client.audio.transcriptions.create>[0]["file"],
    language: options.language,
    prompt: options.prompt,
    temperature: options.temperature,
  });

  return response.text || "";
}
