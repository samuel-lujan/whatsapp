/**
 * Standalone WhatsApp test script.
 *
 * - Boots its own whatsapp-web.js client (separate session, does NOT touch the app).
 * - Shows a QR Code in the terminal on first run; reuses saved credentials afterwards.
 * - Sends a message to the configured number.
 * - Waits for that person to reply (timeout configurable).
 * - Appends the full conversation entry to test-responses.json and exits.
 *
 * Usage:  node test-send.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  // Phone number to message — international format without + or spaces
  // e.g. Brazil: "5511999999999"
  number: "5518991553865",

  // List of messages to send in order. Each reply is collected before the next
  // message is sent.
  messages: [
    "Quantos créditos eu tenho?",
    "Quando eles vencem?",
    "Quais as proximas aulas?",
    "Me reserva a primeira aula",
    "Qualquer uma",
    "Qual minha proxima aula?",
    "Cancela minha reserva nela",
    "Me coloca na lista de espera da proxima aula",
    "Deixa eu ver a minha lista de espera",
    "Me tira dessa lista de espera",
    "Quanto custa mais créditos",
    "Quero comprar o primeiro pacote",
  ],

  // How long (ms) to wait for each individual reply before giving up
  replyTimeoutMs: 120_000, // 2 minutes per message

  // File where results are appended (one JSON array entry per full run)
  outputFile: path.join(__dirname, "test-responses.json"),

  // LocalAuth clientId — keeps this session separate from the main app sessions
  sessionId: "test-session",
};
// ──────────────────────────────────────────────────────────────────────────────

function loadExisting(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

async function main() {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: CONFIG.sessionId }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
      ],
    },
  });

  // ── QR Code (only needed on first run) ──────────────────────────────────────
  client.on("qr", (qr) => {
    console.log("\n📱 Scan the QR Code below with WhatsApp:\n");
    qrcodeTerminal.generate(qr, { small: true });
  });

  client.on("authenticated", () => console.log("🔐 Authenticated!"));
  client.on("auth_failure", (msg) => {
    console.error("❌ Authentication failed:", msg);
    process.exit(1);
  });

  // ── Client ready: send all messages in sequence ──────────────────────────────
  client.on("ready", async () => {
    console.log("✅ Client ready.");

    const chatId = `${CONFIG.number}@c.us`;
    const runStarted = new Date().toISOString();
    const exchanges = [];

    for (let i = 0; i < CONFIG.messages.length; i++) {
      const message = CONFIG.messages[i];
      const sentAt = new Date().toISOString();

      console.log(
        `\n[${i + 1}/${CONFIG.messages.length}] Sending: "${message}"`,
      );

      try {
        await client.sendMessage(chatId, message);
        console.log(`📤 Sent at ${sentAt}`);
        console.log(
          `⏳ Waiting up to ${CONFIG.replyTimeoutMs / 1000}s for reply…`,
        );
      } catch (err) {
        console.error("❌ Failed to send message:", err.message);
        await client.destroy();
        process.exit(1);
      }

      // Wait for exactly one reply from the target number
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.warn(`⏰ No reply for message ${i + 1}, moving on.`);
          resolve(null);
        }, CONFIG.replyTimeoutMs);

        const handler = (msg) => {
          if (msg.from !== chatId || msg.fromMe) return;
          clearTimeout(timer);
          client.off("message", handler);
          console.log(`📩 Reply: "${msg.body}"`);
          resolve({ body: msg.body, receivedAt: new Date().toISOString() });
        };

        client.on("message", handler);
      });

      exchanges.push({
        step: i + 1,
        sent: message,
        sentAt,
        reply: reply ? reply.body : null,
        repliedAt: reply ? reply.receivedAt : null,
        timedOut: reply === null,
      });
    }

    // Save the full run
    const runEntry = {
      runStarted,
      runFinished: new Date().toISOString(),
      to: CONFIG.number,
      exchanges,
    };

    const all = loadExisting(CONFIG.outputFile);
    all.push(runEntry);
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(all, null, 2));

    console.log(`\n💾 Full run saved → ${CONFIG.outputFile}`);
    await client.destroy();
    process.exit(0);
  });

  await client.initialize();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
