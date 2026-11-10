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
