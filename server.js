require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

// ===============================
// PostgreSQL
// ===============================

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ===============================
// OpenRouter
// ===============================

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// ===============================
// Middleware
// ===============================

app.use(express.json());
app.use(express.static("public"));

// ===============================
// Database test
// ===============================

async function testDatabase() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("PostgreSQL connected:", result.rows[0].now);
  } catch (error) {
    console.error("PostgreSQL connection failed:", error.message);
  }
}

// ===============================
// Create conversation
// ===============================

async function createConversation() {
  const id = crypto.randomUUID();

  await pool.query(
    "INSERT INTO conversations (id) VALUES ($1)",
    [id]
  );

  return id;
}

// ===============================
// Get messages
// ===============================

async function getMessages(conversationId) {
  const result = await pool.query(
    `SELECT role, content, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC, id ASC`,
    [conversationId]
  );

  return result.rows;
}

// ===============================
// Save message
// ===============================

async function saveMessage(conversationId, role, content) {
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content)
     VALUES ($1, $2, $3)`,
    [conversationId, role, content]
  );
}

// ======================================================
// GET ALL CONVERSATIONS
// ======================================================

app.get("/api/conversations", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         c.id,
         c.created_at,
         (
           SELECT content
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

    const conversation = await pool.query(
      `SELECT id, created_at
       FROM conversations
       WHERE id = $1`,
      [id]
    );

    if (conversation.rows.length === 0) {
      return res.status(404).json({
        error: "Conversation not found.",
      });
    }

    const messages = await getMessages(id);

    res.json({
      conversation: conversation.rows[0],
      messages,
    });
  } catch (error) {
    console.error("Get conversation error:", error);

    res.status(500).json({
      error: "Failed to load conversation.",
    });
  }
});

// ======================================================
// CREATE NEW CONVERSATION
// ======================================================

app.post("/api/conversations", async (req, res) => {
  try {
    const id = await createConversation();

    await saveMessage(
      id,
      "system",
      "You are a helpful AI assistant. Explain things clearly and simply. Use examples when useful."
    );

    res.status(201).json({
      conversationId: id,
    });
  } catch (error) {
    console.error("Create conversation error:", error);

    res.status(500).json({
      error: "Failed to create conversation.",
    });
  }
});

// ======================================================
// CHAT
// ======================================================

app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "Message is required.",
      });
    }

    let id = conversationId;

    // Create conversation automatically if needed
    if (!id) {
      id = await createConversation();

      await saveMessage(
        id,
        "system",
        "You are a helpful AI assistant. Explain things clearly and simply. Use examples when useful."
      );
    }

    // Make sure conversation exists
    const conversationCheck = await pool.query(
      "SELECT id FROM conversations WHERE id = $1",
      [id]
    );

    if (conversationCheck.rows.length === 0) {
      return res.status(404).json({
        error: "Conversation not found.",
      });
    }

    // Get previous messages
    const history = await getMessages(id);

    // Save user message
    const userMessage = message.trim();

    await saveMessage(
      id,
      "user",
      userMessage
    );

    // Add user message to AI history
    history.push({
      role: "user",
      content: userMessage,
    });

    // Ask OpenRouter
   const response = await client.chat.completions.create({
  model: "openai/gpt-oss-20b:free",
  messages: history.map((message) => ({
    role: message.role,
    content: message.content,
  })),
  timeout: 60000,
});
    const answer = response.choices[0].message.content;

    // Save AI response
    await saveMessage(
      id,
      "assistant",
      answer
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

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, async () => {
  console.log(`AI server running at http://localhost:${PORT}`);

  await testDatabase();
});