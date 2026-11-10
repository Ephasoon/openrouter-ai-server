const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server.js');

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

function makeRequest(server, port, path, method, body) {
  return new Promise((resolve, reject) => {
    const contents = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(contents),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(data) });
      });
    });

    req.on('error', reject);
    req.write(contents);
    req.end();
  });
}

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
      return { rows: [{ id: 'conv-1', created_at: new Date() }] };
    },
  };

  const { app, server, port } = await startAppForTest(mockPool);
  try {
    const result = await makeRequest(server, port, '/api/conversations/conv-1', 'GET');
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
    const result = await makeRequest(server, port, '/api/conversations/nonexistent', 'GET');
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.body.error, 'Conversation not found.');
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