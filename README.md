# OpenRouter Test

A local, multi-user AI chat app. It uses Express and PostgreSQL to store users, conversations and messages, and calls OpenRouter for model responses. A browser UI lives in `public/`, and `index.js` provides a separate terminal chat loop.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your OpenRouter key and PostgreSQL connection details:

   ```bash
   cp .env.example .env
   ```

3. Create the database tables:

   ```bash
   npm run db:init
   ```

## Configuration

Required environment variables (see `.env.example`); the server refuses to start without them:

- `OPENROUTER_API_KEY` – OpenRouter API key
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` – PostgreSQL connection
- `SESSION_SECRET` – secret used to sign session cookies

Optional:

- `OPENROUTER_MODEL` – model id (default `openrouter/free`)
- `DB_PORT` – PostgreSQL port (default 5432)
- `DB_SSL` – set to `true` for managed PostgreSQL with TLS
- `PORT` – HTTP port (default 3000)
- `DAILY_MESSAGE_LIMIT` – per-user daily message quota (default 50)
- `MAX_OUTPUT_TOKENS` – maximum tokens per AI reply sent to OpenRouter (default 1000)

## Auth

Each user has an account identified by email with a bcrypt-hashed password (cost 12). The browser UI shows a sign in / sign up screen when the API returns 401. `POST /api/signup` validates the email, requires a password of 8–72 characters and starts a session; `POST /api/login` signs in an existing account and returns the same generic error for unknown emails and wrong passwords; `GET /api/me` returns the signed-in user; `POST /api/logout` clears the session.

Sessions are HMAC-signed httpOnly cookies carrying `{ userId, exp }`, valid for 7 days. All `/api/*` routes require a valid session except `/api/signup` and `/api/login`; `/health` stays public. Conversations belong to the user who created them: every conversation and message query filters by the signed-in user id, and other users' conversations return 404.

Rate limits: signup 5 per hour per IP, login 10 per 15 minutes per IP, chat 20 per minute per user, other `/api/*` 100 per 15 minutes per IP. On top of that, each user can send up to `DAILY_MESSAGE_LIMIT` messages per rolling 24 hours; over the quota returns 429 with "Daily message limit reached. Try again tomorrow." AI replies are capped at `MAX_OUTPUT_TOKENS` tokens. When `NODE_ENV=production`, the app trusts one proxy hop so rate limits see real client IPs.

## Run

Start the server:

```bash
npm start
```

Or run with auto-reload during development:

```bash
npm run dev
```

The app is served at http://localhost:3000.

## Test

```bash
npm test
```

Tests use Node's built-in test runner with mocked database and AI clients.
