const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { createApp, createSessionToken } = require('../server.js');

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const MISSING_UUID = '22222222-2222-4222-8222-222222222222';
const CONV_A_UUID = '33333333-3333-4333-8333-333333333333';
const LEGACY_UUID = '44444444-4444-4444-8444-444444444444';

const SESSION_SECRET = 'test-session-secret';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbbb-4bbb-8bbb-bbbbbbbbbbbb';

// The whole suite runs with a known session secret so signed cookies can be
// minted directly for tests that do not exercise signup/login.
process.env.SESSION_SECRET = SESSION_SECRET;

// Mock client – kept at module level to avoid nested-object syntax issues
const mockClient = {};
mockClient.chat = {};
mockClient.chat.completions = {};
mockClient.chat.completions.create = async function () {
  return { choices: [{ message: { content: 'AI response' } }] };
};

function norm(sql) {
  return String(sql).toLowerCase().replace(/\s+/g, ' ');
}

function startAppForTest(mockPool, client = mockClient) {
  const app = createApp({ pool: mockPool, client });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ app, server, port: server.address().port });
    });
  });
}

function makeRequest(server, port, requestPath, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const contents = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'localhost',
      port,
      path: requestPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(contents),
        ...extraHeaders,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(data);
        } catch (error) {
          parsedBody = null;
        }
        resolve({ status: res.statusCode, body: parsedBody, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.write(contents);
    req.end();
  });
}

function sessionCookieFor(userId, expiresAtMs = Date.now() + 60_000) {
  const token = createSessionToken(SESSION_SECRET, userId, expiresAtMs);
  return `session=${token}`;
}

function cookieFrom(result) {
  return result.headers['set-cookie'][0].split(';')[0];
}

// Mock pool that keeps users in memory and supports signup / login / me.
function makeUserStorePool(options = {}) {
  const users = [];
  return {
    users,
    query: async function (sql, params) {
      const q = norm(sql);

      if (q.includes('insert into users')) {
        if (users.some((user) => user.email === params[0])) {
          const error = new Error('duplicate key value violates unique constraint');
          error.code = '23505';
          throw error;
        }
        const user = {
          id: crypto.randomUUID(),
          email: params[0],
          password_hash: params[1],
        };
        users.push(user);
        return { rows: [{ id: user.id, email: user.email }] };
      }

      if (q.includes('from users where email')) {
        const user = users.find((candidate) => candidate.email === params[0]);
        return {
          rows: user ? [{ id: user.id, password_hash: user.password_hash }] : [],
        };
      }

      if (q.includes('from users where id')) {
        const user = users.find((candidate) => candidate.id === params[0]);
        return {
          rows: user ? [{ id: user.id, email: user.email }] : [],
        };
      }

      if (options.handleOther) {
        return options.handleOther(q, params);
      }

      return { rows: [] };
    },
  };
}

// Mock pool that emulates users, conversations (with ownership) and messages.
function makeStatefulPool() {
  const users = new Map();
  const conversations = new Map();
  const messages = [];

  return {
    users,
    conversations,
    messages,
    query: async function (sql, params) {
      const q = norm(sql);

      if (q.includes('insert into users')) {
        if ([...users.values()].some((user) => user.email === params[0])) {
          const error = new Error('duplicate key value violates unique constraint');
          error.code = '23505';
          throw error;
        }
        const id = crypto.randomUUID();
        users.set(id, { id, email: params[0], password_hash: params[1] });
        return { rows: [{ id, email: params[0] }] };
      }

      if (q.includes('from users where email')) {
        const user = [...users.values()].find(
          (candidate) => candidate.email === params[0]
        );
        return {
          rows: user ? [{ id: user.id, password_hash: user.password_hash }] : [],
        };
      }

      if (q.includes('from users where id')) {
        const user = users.get(params[0]);
        return { rows: user ? [{ id: user.id, email: user.email }] : [] };
      }

      if (q.includes('insert into conversations')) {
        conversations.set(params[0], { id: params[0], user_id: params[1] });
        return { rows: [{ id: params[0] }] };
      }

      if (q.includes('insert into messages')) {
        messages.push({
          conversation_id: params[0],
          role: params[1],
          content: params[2],
        });
        return { rows: [] };
      }

      if (q.includes('from conversations c where c.user_id')) {
        const rows = [...conversations.values()]
          .filter((conversation) => conversation.user_id === params[0])
          .map((conversation) => ({
            id: conversation.id,
            created_at: new Date(),
            title: null,
          }));
        return { rows };
      }

      if (q.includes('from conversations where id')) {
        const conversation = conversations.get(params[0]);
        const rows =
          conversation && conversation.user_id === params[1]
            ? [{ id: conversation.id, created_at: new Date() }]
            : [];
        return { rows };
      }

      if (q.includes('from messages m join conversations c')) {
        const conversation = conversations.get(params[0]);
        const rows =
          conversation && conversation.user_id === params[1]
            ? messages
                .filter((message) => message.conversation_id === params[0])
                .map((message) => ({
                  role: message.role,
                  content: message.content,
                  created_at: new Date(),
                }))
            : [];
        return { rows };
      }

      return { rows: [] };
    },
  };
}

function makeChatMockPool(savedMessages) {
  return {
    query: async function (sql, params) {
      const q = norm(sql);
      if (q.includes('insert into conversations') && q.includes('returning id')) {
        return { rows: [{ id: CONV_A_UUID }] };
      }
      if (q.includes('select id from conversations where id')) {
        return { rows: [{ id: params[0] }] };
      }
      if (q.includes('from messages m join conversations c')) {
        return { rows: [] };
      }
      if (q.includes('insert into messages')) {
        savedMessages.push({ role: params[1], content: params[2] });
      }
      return { rows: [] };
    },
  };
}

async function signupAndGetCookie(server, port, email, password) {
  const result = await makeRequest(server, port, '/api/signup', 'POST', {
    email,
    password,
  });
  return { result, cookie: result.headers['set-cookie'] ? cookieFrom(result) : null };
}

// ===== Startup config tests =====

test('startup - missing required environment variables fails fast', function () {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.DB_HOST;

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'server.js')],
    {
      cwd: __dirname,
      env,
      encoding: 'utf8',
      timeout: 10000,
    }
  );

  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Missing required environment variables:/);
  assert.match(result.stderr, /OPENROUTER_API_KEY/);
  assert.match(result.stderr, /DB_HOST/);
  assert.doesNotMatch(result.stderr, /ACCESS_PASSWORD/);
});

// ===== Auth: unauthenticated requests =====

test('GET /api/conversations without session returns 401', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/conversations', 'GET');
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.body.error, 'Authentication required.');
  } finally {
    server.close();
  }
});

test('GET /api/conversations with tampered cookie returns 401', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const validCookie = sessionCookieFor(USER_A_ID);
    const tamperedCookie =
      validCookie.slice(0, -2) + (validCookie.endsWith('AA') ? 'BB' : 'AA');

    const result = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: tamperedCookie,
    });
    assert.strictEqual(result.status, 401);
  } finally {
    server.close();
  }
});

test('GET /api/conversations with expired token returns 401', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const expiredCookie = sessionCookieFor(USER_A_ID, Date.now() - 1000);

    const result = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: expiredCookie,
    });
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.body.error, 'Authentication required.');
  } finally {
    server.close();
  }
});

test('GET /health stays public', async function () {
  const mockPool = {
    query: async function (sql) {
      if (sql === 'SELECT 1') {
        return { rows: [{ '?column?': 1 }] };
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/health', 'GET');
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.status, 'ok');
  } finally {
    server.close();
  }
});

// ===== POST /api/signup tests =====

test('POST /api/signup succeeds, lowercases email and starts a session', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const { result, cookie } = await signupAndGetCookie(
      server,
      port,
      'NewUser@Example.COM',
      'password123'
    );

    assert.strictEqual(result.status, 201);
    assert.strictEqual(result.body.user.email, 'newuser@example.com');
    assert.ok(result.body.user.id);

    assert.ok(cookie);
    const setCookie = result.headers['set-cookie'][0];
    assert.match(setCookie, /^session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Max-Age=604800/);

    // Session cookie works on an authenticated route.
    const listResult = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: cookie,
    });
    assert.strictEqual(listResult.status, 200);
    assert.ok(Array.isArray(listResult.body));

    // Email is stored lowercased.
    assert.strictEqual(mockPool.users[0].email, 'newuser@example.com');
    // Password is stored as a bcrypt hash, not plaintext.
    assert.notStrictEqual(mockPool.users[0].password_hash, 'password123');
    assert.ok(await bcrypt.compare('password123', mockPool.users[0].password_hash));
  } finally {
    server.close();
  }
});

test('POST /api/signup duplicate email returns 409 (case-insensitive)', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const first = await signupAndGetCookie(
      server,
      port,
      'user@example.com',
      'password123'
    );
    assert.strictEqual(first.result.status, 201);

    const duplicate = await makeRequest(server, port, '/api/signup', 'POST', {
      email: 'USER@EXAMPLE.COM',
      password: 'password456',
    });

    assert.strictEqual(duplicate.status, 409);
    assert.strictEqual(
      duplicate.body.error,
      'An account with this email already exists.'
    );
  } finally {
    server.close();
  }
});

test('POST /api/signup rejects too-short password', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/signup', 'POST', {
      email: 'user@example.com',
      password: 'short',
    });

    assert.strictEqual(result.status, 400);
    assert.strictEqual(
      result.body.error,
      'Password must be between 8 and 72 characters.'
    );
    assert.strictEqual(result.headers['set-cookie'], undefined);
    assert.strictEqual(mockPool.users.length, 0);
  } finally {
    server.close();
  }
});

test('POST /api/signup rejects too-long password', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/signup', 'POST', {
      email: 'user@example.com',
      password: 'a'.repeat(73),
    });

    assert.strictEqual(result.status, 400);
    assert.strictEqual(
      result.body.error,
      'Password must be between 8 and 72 characters.'
    );
    assert.strictEqual(mockPool.users.length, 0);
  } finally {
    server.close();
  }
});

test('POST /api/signup rejects invalid email', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/signup', 'POST', {
      email: 'not-an-email',
      password: 'password123',
    });

    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Enter a valid email address.');
    assert.strictEqual(mockPool.users.length, 0);
  } finally {
    server.close();
  }
});

test('POST /api/signup rejects missing fields', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const missingPassword = await makeRequest(server, port, '/api/signup', 'POST', {
      email: 'user@example.com',
    });
    assert.strictEqual(missingPassword.status, 400);

    const missingEmail = await makeRequest(server, port, '/api/signup', 'POST', {
      password: 'password123',
    });
    assert.strictEqual(missingEmail.status, 400);

    assert.strictEqual(mockPool.users.length, 0);
  } finally {
    server.close();
  }
});

// ===== POST /api/login tests =====

test('POST /api/login succeeds with correct credentials and starts a session', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const { result: signupResult } = await signupAndGetCookie(
      server,
      port,
      'user@example.com',
      'password123'
    );
    assert.strictEqual(signupResult.status, 201);

    // Uppercase email is normalized.
    const result = await makeRequest(server, port, '/api/login', 'POST', {
      email: 'USER@EXAMPLE.COM',
      password: 'password123',
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.user.email, 'user@example.com');

    const setCookie = result.headers['set-cookie'][0];
    assert.match(setCookie, /^session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Max-Age=604800/);

    const listResult = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: cookieFrom(result),
    });
    assert.strictEqual(listResult.status, 200);
  } finally {
    server.close();
  }
});

test('POST /api/login with unknown email returns generic 401 and no cookie', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/login', 'POST', {
      email: 'nobody@example.com',
      password: 'password123',
    });

    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.body.error, 'Invalid email or password.');
    assert.strictEqual(result.headers['set-cookie'], undefined);
  } finally {
    server.close();
  }
});

test('POST /api/login with wrong password returns generic 401 and no cookie', async function () {
  const mockPool = makeUserStorePool();
  mockPool.users.push({
    id: USER_A_ID,
    email: 'user@example.com',
    password_hash: bcrypt.hashSync('correct-password', 4),
  });

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/login', 'POST', {
      email: 'user@example.com',
      password: 'wrong-password',
    });

    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.body.error, 'Invalid email or password.');
    assert.strictEqual(result.headers['set-cookie'], undefined);
  } finally {
    server.close();
  }
});

test('POST /api/login with missing fields returns generic 401', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const noEmail = await makeRequest(server, port, '/api/login', 'POST', {
      password: 'password123',
    });
    assert.strictEqual(noEmail.status, 401);
    assert.strictEqual(noEmail.body.error, 'Invalid email or password.');

    const noPassword = await makeRequest(server, port, '/api/login', 'POST', {
      email: 'user@example.com',
    });
    assert.strictEqual(noPassword.status, 401);
    assert.strictEqual(noPassword.body.error, 'Invalid email or password.');
  } finally {
    server.close();
  }
});

// ===== GET /api/me and POST /api/logout tests =====

test('GET /api/me returns the signed-in user', async function () {
  const mockPool = makeUserStorePool();
  mockPool.users.push({
    id: USER_A_ID,
    email: 'user@example.com',
    password_hash: 'hash',
  });

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/me', 'GET', null, {
      Cookie: sessionCookieFor(USER_A_ID),
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.user.id, USER_A_ID);
    assert.strictEqual(result.body.user.email, 'user@example.com');
  } finally {
    server.close();
  }
});

test('GET /api/me returns 401 without a session', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/me', 'GET');
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.body.error, 'Authentication required.');
  } finally {
    server.close();
  }
});

test('GET /api/me returns 401 when the session user no longer exists', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/me', 'GET', null, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 401);
  } finally {
    server.close();
  }
});

test('POST /api/logout clears the session cookie', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/logout', 'POST', {}, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.ok, true);

    const setCookie = result.headers['set-cookie'][0];
    assert.match(setCookie, /^session=;/);
    assert.match(setCookie, /Expires=Thu, 01 Jan 1970/);
  } finally {
    server.close();
  }
});

test('POST /api/logout requires a session', async function () {
  const mockPool = makeUserStorePool();

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/logout', 'POST', {});
    assert.strictEqual(result.status, 401);
  } finally {
    server.close();
  }
});

// ===== Ownership tests =====

test('user A can create and read own conversations; user B gets 404 everywhere', async function () {
  const pool = makeStatefulPool();

  const { app, server, port } = await startAppForTest(pool);
  try {
    const a = await signupAndGetCookie(server, port, 'a@example.com', 'password123');
    const b = await signupAndGetCookie(server, port, 'b@example.com', 'password123');
    assert.strictEqual(a.result.status, 201);
    assert.strictEqual(b.result.status, 201);

    const createResult = await makeRequest(server, port, '/api/conversations', 'POST', {}, {
      Cookie: a.cookie,
    });
    assert.strictEqual(createResult.status, 201);
    const conversationId = createResult.body.conversationId;

    // B's list does not contain A's conversation.
    const bList = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: b.cookie,
    });
    assert.strictEqual(bList.status, 200);
    assert.ok(Array.isArray(bList.body));
    assert.strictEqual(bList.body.length, 0);

    // B cannot read A's conversation.
    const bGet = await makeRequest(
      server,
      port,
      `/api/conversations/${conversationId}`,
      'GET',
      null,
      { Cookie: b.cookie }
    );
    assert.strictEqual(bGet.status, 404);
    assert.strictEqual(bGet.body.error, 'Conversation not found.');

    // B cannot chat in A's conversation.
    const bChat = await makeRequest(server, port, '/api/chat', 'POST', {
      message: 'hello from B',
      conversationId,
    }, { Cookie: b.cookie });
    assert.strictEqual(bChat.status, 404);
    assert.strictEqual(
      pool.messages.filter(
        (message) => message.conversation_id === conversationId && message.role === 'user'
      ).length,
      0,
      'No user message from B should be stored in A conversation'
    );

    // A can read own conversation.
    const aGet = await makeRequest(
      server,
      port,
      `/api/conversations/${conversationId}`,
      'GET',
      null,
      { Cookie: a.cookie }
    );
    assert.strictEqual(aGet.status, 200);
    assert.strictEqual(aGet.body.conversation.id, conversationId);
    assert.ok(Array.isArray(aGet.body.messages));

    // A sees own conversation in the list.
    const aList = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: a.cookie,
    });
    assert.strictEqual(aList.status, 200);
    assert.strictEqual(aList.body.length, 1);
    assert.strictEqual(aList.body[0].id, conversationId);

    // The conversation was created for A.
    assert.strictEqual(pool.conversations.get(conversationId).user_id, a.result.body.user.id);
  } finally {
    server.close();
  }
});

test('legacy conversations with NULL user_id are never returned to any user', async function () {
  const pool = makeStatefulPool();
  pool.conversations.set(LEGACY_UUID, { id: LEGACY_UUID, user_id: null });

  const { app, server, port } = await startAppForTest(pool);
  try {
    const cookie = sessionCookieFor(USER_A_ID);

    const list = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: cookie,
    });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.length, 0);

    const get = await makeRequest(
      server,
      port,
      `/api/conversations/${LEGACY_UUID}`,
      'GET',
      null,
      { Cookie: cookie }
    );
    assert.strictEqual(get.status, 404);

    const chat = await makeRequest(server, port, '/api/chat', 'POST', {
      message: 'hello',
      conversationId: LEGACY_UUID,
    }, { Cookie: cookie });
    assert.strictEqual(chat.status, 404);
  } finally {
    server.close();
  }
});

// ===== GET /api/conversations tests =====

test('GET /api/conversations - successful response', async function () {
  const mockPool = {
    query: async function (sql) {
      if (norm(sql).includes('from conversations c where c.user_id')) {
        return { rows: [
          { id: 'conv-1', title: 'Conversation 1' },
          { id: 'conv-2', title: 'Conversation 2' }
        ] };
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 200);
    assert.ok(Array.isArray(result.body));
    assert.strictEqual(result.body.length, 2);
  } finally {
    server.close();
  }
});

test('GET /api/conversations - database failure', async function () {
  const mockPool = {
    query: async function () {
      throw new Error('DB connection failed');
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/conversations', 'GET', null, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.body.error, 'Failed to load conversations.');
  } finally {
    server.close();
  }
});

test('GET /api/conversations/:id - successful response', async function () {
  const mockPool = {
    query: async function (sql) {
      const q = norm(sql);
      if (q.includes('from conversations where id')) {
        return { rows: [{ id: VALID_UUID, created_at: new Date() }] };
      }
      if (q.includes('from messages m join conversations c')) {
        return { rows: [{ role: 'user', content: 'Hello', created_at: new Date() }] };
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(
      server,
      port,
      `/api/conversations/${VALID_UUID}`,
      'GET',
      null,
      { Cookie: sessionCookieFor(USER_A_ID) }
    );
    assert.strictEqual(result.status, 200);
    assert.ok(result.body.conversation);
    assert.ok(Array.isArray(result.body.messages));
    assert.strictEqual(result.body.messages.length, 1);
    assert.strictEqual(result.body.messages[0].role, 'user');
  } finally {
    server.close();
  }
});

test('GET /api/conversations/:id - nonexistent conversation', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(
      server,
      port,
      `/api/conversations/${MISSING_UUID}`,
      'GET',
      null,
      { Cookie: sessionCookieFor(USER_A_ID) }
    );
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.body.error, 'Conversation not found.');
  } finally {
    server.close();
  }
});

test('GET /api/conversations/:id - invalid id rejection', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(
      server,
      port,
      '/api/conversations/not-a-uuid',
      'GET',
      null,
      { Cookie: sessionCookieFor(USER_A_ID) }
    );
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid conversation ID.');
  } finally {
    server.close();
  }
});

// ===== POST /api/conversations tests =====

test('POST /api/conversations - successful creation stores user_id', async function () {
  const inserts = [];
  const mockPool = {
    query: async function (sql, params) {
      const q = norm(sql);
      if (q.includes('insert into conversations')) {
        inserts.push({ table: 'conversations', params });
        return { rows: [{ id: params[0] }] };
      }
      if (q.includes('insert into messages')) {
        inserts.push({ table: 'messages', params });
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/conversations', 'POST', {}, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 201);
    assert.ok(result.body.conversationId);

    const conversationInsert = inserts.find((row) => row.table === 'conversations');
    assert.strictEqual(conversationInsert.params[1], USER_A_ID);
  } finally {
    server.close();
  }
});

test('POST /api/conversations - database failure', async function () {
  const mockPool = {
    query: async function () {
      throw new Error('DB error');
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/conversations', 'POST', {}, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.body.error, 'Failed to create conversation.');
  } finally {
    server.close();
  }
});

// ===== POST /api/chat tests =====

test('POST /api/chat - empty message rejection', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: '' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Message is required.');
  } finally {
    server.close();
  }
});

test('POST /api/chat - non-string message rejection', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 123 }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Message is required.');
  } finally {
    server.close();
  }
});

test('POST /api/chat - message over 4000 characters rejection', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', {
      message: 'a'.repeat(4001),
    }, { Cookie: sessionCookieFor(USER_A_ID) });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Message is too long. Maximum length is 4000 characters.');
  } finally {
    server.close();
  }
});

test('POST /api/chat - invalid conversationId rejection', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', {
      message: 'Hello',
      conversationId: 'conv-1',
    }, { Cookie: sessionCookieFor(USER_A_ID) });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid conversation ID.');
  } finally {
    server.close();
  }
});

test('POST /api/chat - successful mocked AI response', async function () {
  const savedMessages = [];
  const mockPool = makeChatMockPool(savedMessages);

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 200);
    assert.ok(result.body.answer);
    assert.ok(result.body.conversationId);

    const messageInserts = savedMessages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );
    // User message is saved before the AI call; assistant reply is saved after.
    assert.strictEqual(messageInserts.length, 2, 'Expected two message inserts: user then assistant');
    assert.strictEqual(messageInserts[0].role, 'user');
    assert.strictEqual(messageInserts[0].content, 'Hello');
    assert.strictEqual(messageInserts[1].role, 'assistant');
    assert.strictEqual(messageInserts[1].content, 'AI response');
  } finally {
    server.close();
  }
});

test('POST /api/chat - user and assistant message persistence', async function () {
  const savedMessages = [];
  const mockPool = makeChatMockPool(savedMessages);

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 200);

    const messageSaves = savedMessages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );
    assert.strictEqual(messageSaves.length, 2, 'Expected user and assistant messages to be saved');
    assert.strictEqual(messageSaves[0].role, 'user');
    assert.strictEqual(messageSaves[0].content, 'Hello');
    assert.strictEqual(messageSaves[1].role, 'assistant');
    assert.strictEqual(messageSaves[1].content, 'AI response');
  } finally {
    server.close();
  }
});

test('POST /api/chat - OpenRouter failure keeps user message saved', async function () {
  const savedMessages = [];
  const failingClient = {
    chat: {
      completions: {
        create: async function () {
          throw new Error('OpenRouter API error');
        },
      },
    },
  };

  const mockPool = makeChatMockPool(savedMessages);

  const { app, server, port } = await startAppForTest(mockPool, failingClient);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 502);
    assert.strictEqual(result.body.error, 'Failed to get a response from the AI service.');

    const userSaves = savedMessages.filter((m) => m.role === 'user');
    assert.strictEqual(userSaves.length, 1, 'User message should remain saved after AI failure');
    assert.strictEqual(userSaves[0].content, 'Hello');

    const assistantSaves = savedMessages.filter((m) => m.role === 'assistant');
    assert.strictEqual(assistantSaves.length, 0, 'No assistant message should be saved on failure');
  } finally {
    server.close();
  }
});

test('POST /api/chat - database failure', async function () {
  const mockPool = {
    query: async function () {
      throw new Error('DB error');
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.body.error, 'Something went wrong. Check the server terminal.');
  } finally {
    server.close();
  }
});

// ===== GET /health tests =====

test('GET /health - database reachable', async function () {
  const mockPool = {
    query: async function (sql) {
      if (sql === 'SELECT 1') {
        return { rows: [{ '?column?': 1 }] };
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/health', 'GET');
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.status, 'ok');
  } finally {
    server.close();
  }
});

test('GET /health - database failure', async function () {
  const mockPool = {
    query: async function () {
      throw new Error('DB connection failed');
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/health', 'GET');
    assert.strictEqual(result.status, 503);
    assert.strictEqual(result.body.status, 'error');
  } finally {
    server.close();
  }
});

// ===== POST /api/chat - empty AI answer guard =====

test('POST /api/chat - null AI answer returns 502 and no assistant insert', async function () {
  const savedMessages = [];
  const nullAnswerClient = {
    chat: {
      completions: {
        create: async function () {
          return { choices: [{ message: { content: null } }] };
        },
      },
    },
  };

  const { app, server, port } = await startAppForTest(
    makeChatMockPool(savedMessages),
    nullAnswerClient
  );
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 502);
    assert.strictEqual(result.body.error, 'Failed to get a response from the AI service.');

    const userSaves = savedMessages.filter((m) => m.role === 'user');
    assert.strictEqual(userSaves.length, 1, 'User message should remain saved');
    assert.strictEqual(userSaves[0].content, 'Hello');

    const assistantSaves = savedMessages.filter((m) => m.role === 'assistant');
    assert.strictEqual(
      assistantSaves.length,
      0,
      'No assistant row should be inserted for a null answer'
    );
  } finally {
    server.close();
  }
});

test('POST /api/chat - blank AI answer returns 502 and no assistant insert', async function () {
  const savedMessages = [];
  const blankAnswerClient = {
    chat: {
      completions: {
        create: async function () {
          return { choices: [{ message: { content: '   ' } }] };
        },
      },
    },
  };

  const { app, server, port } = await startAppForTest(
    makeChatMockPool(savedMessages),
    blankAnswerClient
  );
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 502);
    assert.strictEqual(result.body.error, 'Failed to get a response from the AI service.');

    const assistantSaves = savedMessages.filter((m) => m.role === 'assistant');
    assert.strictEqual(
      assistantSaves.length,
      0,
      'No assistant row should be inserted for a blank answer'
    );
  } finally {
    server.close();
  }
});

test('POST /api/chat - missing choices returns 502 and no assistant insert', async function () {
  const savedMessages = [];
  const emptyResponseClient = {
    chat: {
      completions: {
        create: async function () {
          return {};
        },
      },
    },
  };

  const { app, server, port } = await startAppForTest(
    makeChatMockPool(savedMessages),
    emptyResponseClient
  );
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 502);
    assert.strictEqual(result.body.error, 'Failed to get a response from the AI service.');

    const assistantSaves = savedMessages.filter((m) => m.role === 'assistant');
    assert.strictEqual(
      assistantSaves.length,
      0,
      'No assistant row should be inserted when choices are missing'
    );
  } finally {
    server.close();
  }
});

// ===== POST /api/chat - OpenRouter error mapping =====

test('POST /api/chat - 429 from OpenRouter returns 429 with retry message', async function () {
  const rateLimitedClient = {
    chat: {
      completions: {
        create: async function () {
          const error = new Error('Rate limit exceeded');
          error.status = 429;
          throw error;
        },
      },
    },
  };

  const { app, server, port } = await startAppForTest(
    makeChatMockPool([]),
    rateLimitedClient
  );
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 429);
    assert.strictEqual(
      result.body.error,
      'Rate limit reached. Please wait a moment and try again.'
    );
  } finally {
    server.close();
  }
});

test('POST /api/chat - 401 from OpenRouter returns generic 502', async function () {
  const unauthorizedClient = {
    chat: {
      completions: {
        create: async function () {
          const error = new Error('Invalid API key');
          error.status = 401;
          throw error;
        },
      },
    },
  };

  const { app, server, port } = await startAppForTest(
    makeChatMockPool([]),
    unauthorizedClient
  );
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(result.status, 502);
    assert.strictEqual(result.body.error, 'Failed to get a response from the AI service.');
  } finally {
    server.close();
  }
});

// ===== Rate limits =====

test('POST /api/login rate limit returns 429 after 10 attempts', async function () {
  const mockPool = makeUserStorePool();
  mockPool.users.push({
    id: USER_A_ID,
    email: 'user@example.com',
    password_hash: bcrypt.hashSync('correct-password', 4),
  });

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const result = await makeRequest(server, port, '/api/login', 'POST', {
        email: 'user@example.com',
        password: 'wrong-password',
      });
      statuses.push(result.status);
    }

    assert.deepStrictEqual(statuses.slice(0, 10), new Array(10).fill(401));
    assert.strictEqual(statuses[10], 429);
  } finally {
    server.close();
  }
});

test('POST /api/chat rate limit returns 429 after 20 requests per minute', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const cookie = sessionCookieFor(USER_A_ID);

    const statuses = [];
    for (let i = 0; i < 21; i++) {
      const result = await makeRequest(server, port, '/api/chat', 'POST', { message: '' }, {
        Cookie: cookie,
      });
      statuses.push(result.status);
    }

    assert.deepStrictEqual(statuses.slice(0, 20), new Array(20).fill(400));
    assert.strictEqual(statuses[20], 429);
  } finally {
    server.close();
  }
});

// ===== Context cap =====

test('context cap sends only the last 20 messages to the model', async function () {
  const capturedMessages = [];
  const captureClient = {
    chat: {
      completions: {
        create: async function (params) {
          capturedMessages.push(params.messages);
          return { choices: [{ message: { content: 'AI response' } }] };
        },
      },
    },
  };

  const historyRows = [];
  for (let i = 1; i <= 25; i++) {
    historyRows.push({
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `history-${i}`,
      created_at: new Date(),
    });
  }

  const mockPool = {
    query: async function (sql, params) {
      const q = norm(sql);
      if (q.includes('insert into conversations') && q.includes('returning id')) {
        return { rows: [{ id: CONV_A_UUID }] };
      }
      if (q.includes('select id from conversations where id')) {
        return { rows: [{ id: params[0] }] };
      }
      if (q.includes('from messages m join conversations c')) {
        return { rows: historyRows };
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool, captureClient);
  try {
    const chatResult = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
      Cookie: sessionCookieFor(USER_A_ID),
    });
    assert.strictEqual(chatResult.status, 200);

    assert.strictEqual(capturedMessages.length, 1);
    const sent = capturedMessages[0];
    assert.strictEqual(sent.length, 20);
    assert.strictEqual(sent[0].content, 'history-7');
    assert.strictEqual(sent[19].role, 'user');
    assert.strictEqual(sent[19].content, 'Hello');
  } finally {
    server.close();
  }
});
