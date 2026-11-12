require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");

const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const SYSTEM_PROMPT =
  "You are a helpful AI assistant. Explain things clearly and simply. Use examples when useful. You are WithUnion AI, built by WithUnion. Never claim to be built by any other company.";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4000;
const SESSION_COOKIE_NAME = "session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONTEXT_MESSAGE_LIMIT = 20;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;
const BCRYPT_COST = 12;
const GENERIC_LOGIN_ERROR = "Invalid email or password.";
const TIMING_HASH_PLAINTEXT = "timing-equalizer-placeholder";

function getDbPort() {
  const port = Number(process.env.DB_PORT);
  return Number.isInteger(port) && port > 0 ? port : 5432;
}

function createSessionToken(secret, userId, expiresAtMs) {
  const payload = Buffer.from(
    JSON.stringify({ userId, exp: expiresAtMs }),
    "utf8"
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifySessionToken(secret, token) {
  if (typeof secret !== "string" || !secret) {
    return null;
  }
  if (typeof token !== "string" || !token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }
  let session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error) {
    return null;
  }
  if (
    !session ||
    typeof session.userId !== "string" ||
    !UUID_REGEX.test(session.userId)
  ) {
    return null;
  }
  if (!Number.isFinite(session.exp) || session.exp <= Date.now()) {
    return null;
  }
  return { userId: session.userId, exp: session.exp };
}

// Factory function – allows tests to inject mock pool and client dependencies.
function createApp({ pool, client } = {}) {
  const app = express();

  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "script-src": [
            "'self'",
            "https://cdn.jsdelivr.net",
            "https://cdnjs.cloudflare.com",
          ],
          "style-src": ["'self'"],
          "font-src": ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, "public")));

  // Use provided pool or create a real one from environment variables.
  const dbPool =
    pool ||
    new Pool({
      host: process.env.DB_HOST,
      port: getDbPort(),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ...(process.env.DB_SSL === "true"
        ? { ssl: { rejectUnauthorized: false } }
        : {}),
    });

  if (typeof dbPool.on === "function") {
    dbPool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error:", error);
    });
  }

  // Use provided client or create a real OpenAI client configured for OpenRouter.
  const aiClient =
    client ||
    new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });

  const sessionSecret = process.env.SESSION_SECRET || "";
  let timingEqualizerHash = null;

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts. Please try again later." },
  });

  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many messages. Please wait a moment and try again." },
  });

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
  });

  app.use("/api", apiLimiter);

  app.use("/api", (req, res, next) => {
    if (req.path === "/signup" || req.path === "/login") {
      return next();
    }

    const session = verifySessionToken(
      sessionSecret,
      req.cookies[SESSION_COOKIE_NAME]
    );

    if (!session) {
      return res.status(401).json({ error: "Authentication required." });
    }

    req.user = { id: session.userId };

    next();
  });

  const startSession = (res, userId) => {
    const token = createSessionToken(
      sessionSecret,
      userId,
      Date.now() + SESSION_TTL_MS
    );

    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
  };

  app.post("/api/signup", async (req, res) => {
    try {
      const { email, password } = req.body || {};

      const normalizedEmail =
        typeof email === "string" ? email.trim().toLowerCase() : "";

      if (!EMAIL_REGEX.test(normalizedEmail)) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }

      if (
        typeof password !== "string" ||
        password.length < MIN_PASSWORD_LENGTH ||
        password.length > MAX_PASSWORD_LENGTH
      ) {
        return res.status(400).json({
          error: "Password must be between 8 and 72 characters.",
        });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

      const result = await dbPool.query(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
        [normalizedEmail, passwordHash]
      );

      const user = result.rows[0];

      startSession(res, user.id);

      res.status(201).json({ user: { id: user.id, email: user.email } });
    } catch (error) {
      if (error && error.code === "23505") {
        return res
          .status(409)
          .json({ error: "An account with this email already exists." });
      }

      console.error("Signup error:", error);
      res.status(500).json({ error: "Failed to create account." });
    }
  });

  app.post("/api/login", loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};

      const normalizedEmail =
        typeof email === "string" ? email.trim().toLowerCase() : "";

      const result =
        normalizedEmail && typeof password === "string" && password
          ? await dbPool.query(
              "SELECT id, password_hash FROM users WHERE email = $1",
              [normalizedEmail]
            )
          : { rows: [] };

      const user = result.rows[0];

      if (!user) {
        if (!timingEqualizerHash) {
          timingEqualizerHash = await bcrypt.hash(
            TIMING_HASH_PLAINTEXT,
            BCRYPT_COST
          );
        }
        await bcrypt.compare(String(password || ""), timingEqualizerHash);
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
      }

      const passwordMatches =
        typeof user.password_hash === "string" &&
        (await bcrypt.compare(password, user.password_hash));

      if (!passwordMatches) {
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
      }

      startSession(res, user.id);

      res.json({ user: { id: user.id, email: normalizedEmail } });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Failed to log in." });
    }
  });

  app.post("/api/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });

    res.json({ ok: true });
  });

  app.get("/api/me", async (req, res) => {
    try {
      const result = await dbPool.query(
        "SELECT id, email FROM users WHERE id = $1",
        [req.user.id]
      );

      const user = result.rows[0];

      if (!user) {
        return res.status(401).json({ error: "Authentication required." });
      }

      res.json({ user: { id: user.id, email: user.email } });
    } catch (error) {
      console.error("Get current user error:", error);
      res.status(500).json({ error: "Failed to load account." });
    }
  });

  app.get("/health", async (req, res) => {
    try {
      await dbPool.query("SELECT 1");
      res.status(200).json({ status: "ok" });
    } catch (error) {
      console.error("Health check failed:", error);
      res.status(503).json({ status: "error" });
    }
  });

  // ======================================================
  // CREATE CONVERSATION
  // ======================================================

  app.post("/api/conversations", async (req, res) => {
    try {
      const id = crypto.randomUUID();

      await dbPool.query(
        "INSERT INTO conversations (id, user_id) VALUES ($1, $2)",
        [id, req.user.id]
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
         WHERE c.user_id = $1
         ORDER BY c.created_at DESC`,
        [req.user.id]
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
        "SELECT id, created_at FROM conversations WHERE id = $1 AND user_id = $2",
        [id, req.user.id]
      );

      if (conversation.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found." });
      }

      const messages = await dbPool.query(
        `SELECT m.role, m.content, m.created_at
         FROM messages m
         JOIN conversations c ON m.conversation_id = c.id
         WHERE m.conversation_id = $1 AND c.user_id = $2
         ORDER BY m.created_at ASC, m.id ASC`,
        [id, req.user.id]
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

  app.post("/api/chat", chatLimiter, async (req, res) => {
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
          "INSERT INTO conversations (id, user_id) VALUES ($1, $2) RETURNING id",
          [uuid, req.user.id]
        );
        id = newConversation.rows[0]?.id || uuid;

        await dbPool.query(
          "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
          [id, "system", SYSTEM_PROMPT]
        );
      }

      // Make sure the conversation exists and belongs to this user.
      const conversationCheck = await dbPool.query(
        "SELECT id FROM conversations WHERE id = $1 AND user_id = $2",
        [id, req.user.id]
      );

      if (conversationCheck.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found." });
      }

      // Get previous messages.
      const history = await dbPool.query(
        `SELECT m.role, m.content, m.created_at
         FROM messages m
         JOIN conversations c ON m.conversation_id = c.id
         WHERE m.conversation_id = $1 AND c.user_id = $2
         ORDER BY m.created_at ASC, m.id ASC`,
        [id, req.user.id]
      );

      // Save the user message before contacting the AI.
      await dbPool.query(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
        [id, "user", message.trim()]
      );

      const contextMessages = [
        ...history.rows,
        { role: "user", content: message.trim() },
      ].slice(-CONTEXT_MESSAGE_LIMIT);

      // Ask OpenRouter.
      let answer;
      try {
        const response = await aiClient.chat.completions.create({
          model: MODEL,
          messages: contextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          timeout: 60000,
        });
        answer = response?.choices?.[0]?.message?.content;

        if (typeof answer !== "string" || !answer.trim()) {
          console.error(
            "OpenRouter returned no message content:",
            JSON.stringify(response)
          );
          return res.status(502).json({
            error: "Failed to get a response from the AI service.",
          });
        }
      } catch (error) {
        console.error("OpenRouter error:", error);

        if (error && error.status === 429) {
          return res.status(429).json({
            error: "Rate limit reached. Please wait a moment and try again.",
          });
        }

        if (error && (error.status === 401 || error.status === 402)) {
          console.error(
            `OpenRouter rejected the request (status ${error.status}). Check OPENROUTER_API_KEY and account credit.`
          );
        }

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

  app.set("dbPool", dbPool);

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
    "SESSION_SECRET",
  ];
  const missing = requiredEnv.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
    process.exit(1);
  }

  const app = createApp();

  const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

  const handleListen = (error) => {
    if (error) {
      console.error(`Failed to start server: ${error.message}`);
      process.exit(1);
    }

    console.log(`AI server running at http://localhost:${PORT}`);
  };

  const server = app.listen(PORT, handleListen);
  server.on("error", handleListen);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log(`\n${signal} received. Shutting down gracefully...`);

    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown timed out. Forcing exit.");
      process.exit(1);
    }, 10000);
    forceExit.unref();

    server.close(async () => {
      try {
        await app.get("dbPool").end();
      } catch (error) {
        console.error("Error closing database pool:", error.message);
      }
      console.log("Shutdown complete.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// Export – tests can inject mock dependencies via `createApp({ pool, client })`
// and reuse the signed session token helpers.
// ---------------------------------------------------------------------------

module.exports = { createApp, createSessionToken, verifySessionToken };