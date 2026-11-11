const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server.js');

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const MISSING_UUID = '22222222-2222-4222-8222-222222222222';

// Mock client – kept at module level to avoid nested-object syntax issues
const mockClient = {};
mockClient.chat = {};
mockClient.chat.completions = {};
mockClient.chat.completions.create = async function () {
  return { choices: [{ message: { content: 'AI response' } }] };
};

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
});

// ===== GET /api/conversations tests =====

test('GET /api/conversations - successful response', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [
        { id: 'conv-1', title: 'Conversation 1' },
        { id: 'conv-2', title: 'Conversation 2' }
      ] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/conversations', 'GET');
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
    const result = await makeRequest(server, port, '/api/conversations', 'GET');
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.body.error, 'Failed to load conversations.');
  } finally {
    server.close();
  }
});

test('GET /api/conversations/:id - successful response', async function () {
  const mockPool = {
    query: async function (sql) {
      if (sql && sql.includes('conversation_id')) {
        return { rows: [{ role: 'user', content: 'Hello', created_at: new Date() }] };
      }
      return { rows: [{ id: VALID_UUID, created_at: new Date() }] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, `/api/conversations/${VALID_UUID}`, 'GET');
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
    const result = await makeRequest(server, port, `/api/conversations/${MISSING_UUID}`, 'GET');
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
    const result = await makeRequest(server, port, '/api/conversations/not-a-uuid', 'GET');
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid conversation ID.');
  } finally {
    server.close();
  }
});

// ===== POST /api/conversations tests =====

test('POST /api/conversations - successful creation', async function () {
  const mockPool = {
    query: async function () {
      return { rows: [{ id: 'new-conv' }] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/conversations', 'POST', {});
    assert.strictEqual(result.status, 201);
    assert.ok(result.body.conversationId);
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
    const result = await makeRequest(server, port, '/api/conversations', 'POST', {});
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
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: '' });
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
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 123 });
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
    });
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
    });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'Invalid conversation ID.');
  } finally {
    server.close();
  }
});

test('POST /api/chat - successful mocked AI response', async function () {
  const savedMessages = [];
  const mockPool = {
    query: async function (sql, params) {
      if (sql && sql.includes('INSERT INTO conversations') && sql.includes('RETURNING id')) {
        const id = crypto.randomUUID();
        return { rows: [{ id }] };
      }
      if (sql && sql.includes('SELECT id FROM conversations WHERE id')) {
        return { rows: [{ id: params[0] }] };
      }
      if (sql && sql.includes('SELECT role, content, created_at FROM messages WHERE conversation_id')) {
        return { rows: [] };
      }
      if (sql && sql.toLowerCase().includes('insert into messages')) {
        savedMessages.push({ sql, params, rows: [] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
    assert.strictEqual(result.status, 200);
    assert.ok(result.body.answer);
    assert.ok(result.body.conversationId);

    const messageInserts = savedMessages.filter(
      (m) => m.params && (m.params[1] === 'user' || m.params[1] === 'assistant')
    );
    // User message is saved before the AI call; assistant reply is saved after.
    assert.strictEqual(messageInserts.length, 2, 'Expected two message inserts: user then assistant');
    assert.strictEqual(messageInserts[0].params[1], 'user');
    assert.strictEqual(messageInserts[0].params[2], 'Hello');
    assert.strictEqual(messageInserts[1].params[1], 'assistant');
    assert.strictEqual(messageInserts[1].params[2], 'AI response');
    assert.strictEqual(messageInserts[0].params[0], result.body.conversationId);
    assert.strictEqual(messageInserts[1].params[0], result.body.conversationId);
  } finally {
    server.close();
  }
});

test('POST /api/chat - user and assistant message persistence', async function () {
  const savedMessages = [];
  const mockPool = {
    query: async function (sql, params) {
      if (sql && sql.includes('INSERT INTO conversations')) {
        return { rows: [{ id: 'conv-1' }] };
      }
      if (sql && sql.includes('SELECT id FROM conversations WHERE id')) {
        return { rows: [{ id: params[0] }] };
      }
      if (sql && sql.toLowerCase().includes('insert into messages')) {
        savedMessages.push({ role: params[1], content: params[2] });
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
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

  const mockPool = {
    query: async function (sql, params) {
      if (sql && sql.includes('INSERT INTO conversations')) {
        return { rows: [{ id: 'conv-1' }] };
      }
      if (sql && sql.includes('SELECT id FROM conversations WHERE id')) {
        return { rows: [{ id: params[0] }] };
      }
      if (sql && sql.toLowerCase().includes('insert into messages')) {
        savedMessages.push({ role: params[1], content: params[2] });
      }
      return { rows: [] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool, failingClient);
  try {
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
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
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
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

function makeChatMockPool(savedMessages) {
  return {
    query: async function (sql, params) {
      if (sql && sql.includes('INSERT INTO conversations')) {
        return { rows: [{ id: 'conv-1' }] };
      }
      if (sql && sql.includes('SELECT id FROM conversations WHERE id')) {
        return { rows: [{ id: params[0] }] };
      }
      if (sql && sql.toLowerCase().includes('insert into messages')) {
        savedMessages.push({ role: params[1], content: params[2] });
      }
      return { rows: [] };
    },
  };
}

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
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
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
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
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
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
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
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
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
    const result = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' });
    assert.strictEqual(result.status, 502);
    assert.strictEqual(result.body.error, 'Failed to get a response from the AI service.');
  } finally {
    server.close();
  }
});

// ===== Auth (Phase 2) =====

const AUTH_TEST_PASSWORD = 'test-access-password';
const AUTH_TEST_SECRET = 'test-session-secret';

function setAuthEnv() {
  process.env.ACCESS_PASSWORD = AUTH_TEST_PASSWORD;
  process.env.SESSION_SECRET = AUTH_TEST_SECRET;
}

function clearAuthEnv() {
  delete process.env.ACCESS_PASSWORD;
  delete process.env.SESSION_SECRET;
}

async function loginAndGetCookie(server, port) {
  const result = await makeRequest(server, port, '/api/login', 'POST', {
    password: AUTH_TEST_PASSWORD,
  });
  const cookie = result.headers['set-cookie'][0].split(';')[0];
  return { result, cookie };
}

test('GET /api/conversations without session returns 401 when auth is enabled', async function () {
  setAuthEnv();
  try {
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
  } finally {
    clearAuthEnv();
  }
});

test('GET /health stays public when auth is enabled', async function () {
  setAuthEnv();
  try {
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
  } finally {
    clearAuthEnv();
  }
});

test('POST /api/login with wrong password returns 401 and sets no cookie', async function () {
  setAuthEnv();
  try {
    const mockPool = {
      query: async function () {
        return { rows: [] };
      },
    };

    const { app, server, port } = await startAppForTest(mockPool);
    try {
      const result = await makeRequest(server, port, '/api/login', 'POST', { password: 'wrong' });
      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.body.error, 'Invalid password.');
      assert.strictEqual(result.headers['set-cookie'], undefined);
    } finally {
      server.close();
    }
  } finally {
    clearAuthEnv();
  }
});

test('POST /api/login with correct password sets signed httpOnly session cookie', async function () {
  setAuthEnv();
  try {
    const mockPool = {
      query: async function () {
        return { rows: [] };
      },
    };

    const { app, server, port } = await startAppForTest(mockPool);
    try {
      const result = await makeRequest(server, port, '/api/login', 'POST', {
        password: AUTH_TEST_PASSWORD,
      });
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.ok, true);

      const setCookie = result.headers['set-cookie'][0];
      assert.match(setCookie, /^session=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      assert.match(setCookie, /Max-Age=604800/);
    } finally {
      server.close();
    }
  } finally {
    clearAuthEnv();
  }
});

test('authenticated request succeeds with session cookie', async function () {
  setAuthEnv();
  try {
    const mockPool = {
      query: async function () {
        return { rows: [{ id: 'conv-1', title: 'Conversation 1' }] };
      },
    };

    const { app, server, port } = await startAppForTest(mockPool);
    try {
      const { result: loginResult, cookie } = await loginAndGetCookie(server, port);
      assert.strictEqual(loginResult.status, 200);

      const listResult = await makeRequest(server, port, '/api/conversations', 'GET', null, {
        Cookie: cookie,
      });
      assert.strictEqual(listResult.status, 200);
      assert.ok(Array.isArray(listResult.body));
      assert.strictEqual(listResult.body.length, 1);
    } finally {
      server.close();
    }
  } finally {
    clearAuthEnv();
  }
});

test('POST /api/logout clears the session cookie', async function () {
  setAuthEnv();
  try {
    const mockPool = {
      query: async function () {
        return { rows: [] };
      },
    };

    const { app, server, port } = await startAppForTest(mockPool);
    try {
      const result = await makeRequest(server, port, '/api/logout', 'POST', {});
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.ok, true);

      const setCookie = result.headers['set-cookie'][0];
      assert.match(setCookie, /^session=;/);
      assert.match(setCookie, /Expires=Thu, 01 Jan 1970/);
    } finally {
      server.close();
    }
  } finally {
    clearAuthEnv();
  }
});

test('POST /api/login rate limit returns 429 after 10 attempts', async function () {
  setAuthEnv();
  try {
    const mockPool = {
      query: async function () {
        return { rows: [] };
      },
    };

    const { app, server, port } = await startAppForTest(mockPool);
    try {
      const statuses = [];
      for (let i = 0; i < 11; i++) {
        const result = await makeRequest(server, port, '/api/login', 'POST', { password: 'wrong' });
        statuses.push(result.status);
      }

      assert.deepStrictEqual(statuses.slice(0, 10), new Array(10).fill(401));
      assert.strictEqual(statuses[10], 429);
    } finally {
      server.close();
    }
  } finally {
    clearAuthEnv();
  }
});

test('POST /api/chat rate limit returns 429 after 20 requests per minute', async function () {
  setAuthEnv();
  try {
    const mockPool = {
      query: async function () {
        return { rows: [] };
      },
    };

    const { app, server, port } = await startAppForTest(mockPool);
    try {
      const { result: loginResult, cookie } = await loginAndGetCookie(server, port);
      assert.strictEqual(loginResult.status, 200);

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
  } finally {
    clearAuthEnv();
  }
});

// ===== Context cap (Phase 2) =====

test('context cap sends only the last 20 messages to the model', async function () {
  setAuthEnv();
  try {
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
        if (sql && sql.includes('INSERT INTO conversations')) {
          return { rows: [{ id: 'conv-1' }] };
        }
        if (sql && sql.includes('SELECT id FROM conversations WHERE id')) {
          return { rows: [{ id: params[0] }] };
        }
        if (
          sql &&
          sql.replace(/\s+/g, ' ').includes(
            'SELECT role, content, created_at FROM messages WHERE conversation_id'
          )
        ) {
          return { rows: historyRows };
        }
        return { rows: [] };
      },
    };

    const { app, server, port } = await startAppForTest(mockPool, captureClient);
    try {
      const { result: loginResult, cookie } = await loginAndGetCookie(server, port);
      assert.strictEqual(loginResult.status, 200);

      const chatResult = await makeRequest(server, port, '/api/chat', 'POST', { message: 'Hello' }, {
        Cookie: cookie,
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
  } finally {
    clearAuthEnv();
  }
});