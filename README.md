# OpenRouter Test

A local, single-user AI chat app. It uses Express and PostgreSQL to store conversations and messages, and calls OpenRouter for model responses. A browser UI lives in `public/`, and `index.js` provides a separate terminal chat loop.

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
- `ACCESS_PASSWORD` – password for the browser login screen
- `SESSION_SECRET` – secret used to sign session cookies

Optional:

- `OPENROUTER_MODEL` – model id (default `openrouter/free`)
- `DB_PORT` – PostgreSQL port (default 5432)
- `DB_SSL` – set to `true` for managed PostgreSQL with TLS
- `PORT` – HTTP port (default 3000)

## Auth

The browser UI shows a login screen when the API returns 401. `POST /api/login` checks the access password and sets an HMAC-signed, httpOnly session cookie valid for 7 days; `POST /api/logout` clears it. All `/api/*` routes require a valid session except `/api/login`; `/health` stays public.

Rate limits (per IP): login 10 per 15 minutes, chat 20 per minute, other `/api/*` 100 per 15 minutes.

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
