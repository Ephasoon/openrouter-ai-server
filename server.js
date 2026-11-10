require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { Pool } = require("pg");
const crypto = require("crypto");

const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const SYSTEM_PROMPT =
  "You are a helpful AI assistant. Explain things clearly and simply. Use examples when useful. You are WithUnion AI, built by WithUnion. Never claim to be built by any other company.";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4000;

function getDbPort() {
  const port = Number(process.env.DB_PORT);
  return Number.isInteger(port) && port > 0 ? port : 5432;
}

// Factory function – allows tests to inject mock pool and client dependencies.
function createApp({ pool, client } = {}) {
  const app = express();

  app.use(express.json());
  app.use(express.static("public"));

  // Use provided pool or create a real one from environment variables.
  const dbPool =
    pool ||
    new Pool({
      host: process.env.DB_HOST,
      port: getDbPort(),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

  // Use provided client or create a real OpenAI client configured for OpenRouter.
  const aiClient =
    client ||
    new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });

  // ======================================================
  // CREATE CONVERSATION
  // ======================================================

  app.post("/api/conversations", async (req, res) => {
    try {
      const id = crypto.randomUUID();

      await dbPool.query(
        "INSERT INTO conversations (id) VALUES ($1)",
        [id]
      );

      await dbPool.query(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
        [id, "system", SYSTEM_PROMPT]
      );

      res.status(201).json({ conversationId: id });
    } catch (error) {
      console.error("Create conversation error:", error);
      res.status(500).json({ error: "Failed to create conversation." });
    }
  });

  // ======================================================
  // GET ALL CONVERSATIONS
  // ======================================================

  app.get("/api/conversations", async (req, res) => {
    try {
      const result = await dbPool.query(
        `SELECT
           c.id,
           c.created_at,
           (
             SELECT LEFT(content, 60)
             FROM messages m
             WHERE m.conversation_id = c.id
               AND m.role = 'user'
             ORDER BY m.created_at ASC, m.id ASC
             LIMIT 1
           ) AS title
         FROM conversations c
         ORDER BY c.created_at DESC`
      );

      res.json(result.rows);
    } catch (error) {
      console.error("Get conversations error:", error);

      res.status(500).json({
        error: "Failed to load conversations.",
      });
    }
  });

  // ======================================================
  // GET ONE CONVERSATION
  // ======================================================

  app.get("/api/conversations/:id", async (req, res) => {
    try {
      const { id } = req.params;

      if (!UUID_REGEX.test(id)) {
        return res.status(400).json({ error: "Invalid conversation ID." });
      }

      const conversation = await dbPool.query(
        "SELECT id, created_at FROM conversations WHERE id = $1",
        [id]
      );

      if (conversation.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found." });
      }

      const messages = await dbPool.query(
        `SELECT role, content, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC, id ASC`,
        [id]
      );

      res.json({
        conversation: conversation.rows[0],
        messages: messages.rows,
      });
    } catch (error) {
      console.error("Get conversation error:", error);

      res.status(500).json({ error: "Failed to load conversation." });
    }
  });

  // ======================================================
  // CHAT
  // ======================================================

  app.post("/api/chat", async (req, res) => {
    try {
      const { message, conversationId } = req.body;

      if (typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "Message is required." });
      }

      if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({
          error: "Message is too long. Maximum length is 4000 characters.",
        });
      }

      if (conversationId && !UUID_REGEX.test(conversationId)) {
        return res.status(400).json({ error: "Invalid conversation ID." });
      }

      let id = conversationId;

      // Create conversation automatically if needed.
      if (!id) {
        const uuid = crypto.randomUUID();
        const newConversation = await dbPool.query(
          "INSERT INTO conversations (id) VALUES ($1) RETURNING id",
          [uuid]
        );
        id = newConversation.rows[0]?.id || uuid;

        await dbPool.query(
          "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
          [id, "system", SYSTEM_PROMPT]
        );
      }

      // Make sure conversation exists.
      const conversationCheck = await dbPool.query(
        "SELECT id FROM conversations WHERE id = $1",
        [id]
      );

      if (conversationCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found." });
      }

      // Get previous messages.
      const history = await dbPool.query(
        `SELECT role, content, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC, id ASC`,
        [id]
      );

      // Save the user message before contacting the AI.
      await dbPool.query(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
        [id, "user", message.trim()]
      );

      // Add user message to AI history.
      history.rows = [
        ...history.rows,
        { role: "user", content: message.trim() },
      ];

      // Ask OpenRouter.
      let answer;
      try {
        const response = await aiClient.chat.completions.create({
          model: MODEL,
          messages: history.rows.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          timeout: 60000,
        });
        answer = response.choices[0].message.content;
      } catch (error) {
        console.error("OpenRouter error:", error);
        return res.status(502).json({
          error: "Failed to get a response from the AI service.",
        });
      }

      // Save AI response.
      await dbPool.query(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
        [id, "assistant", answer]
      );

      res.json({
        conversationId: id,
        answer,
      });
    } catch (error) {
      console.error("Server error:", error);

      res.status(500).json({
        error: "Something went wrong. Check the server terminal.",
      });
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Production startup – runs when `node server.js` is executed directly.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const requiredEnv = [
    "OPENROUTER_API_KEY",
    "DB_HOST",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
  ];
  const missing = requiredEnv.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
    process.exit(1);
  }

  const app = createApp();

  const PORT = 3000;

  const handleListen = (error) => {
    if (error) {
      console.error(`Failed to start server: ${error.message}`);
      process.exit(1);
    }

    console.log(`AI server running at http://localhost:${PORT}`);
  };

  const server = app.listen(PORT, handleListen);
  server.on("error", handleListen);
}

// ---------------------------------------------------------------------------
// Export – tests can inject mock dependencies via `createApp({ pool, client })`.
// ---------------------------------------------------------------------------

module.exports = { createApp };