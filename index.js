require("dotenv").config();

const OpenAI = require("openai");
const readline = require("readline");

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Conversation memory
const messages = [
  {
    role: "system",
    content:
      "You are a helpful AI assistant. Explain things clearly and simply when the user asks beginner questions.",
  },
];

async function askAI(question) {
  try {
    // Add the user's message to memory
    messages.push({
      role: "user",
      content: question,
    });

    const response = await client.chat.completions.create({
      model: "openrouter/free",
      messages: messages,
    });

    const answer = response.choices[0].message.content;

    // Add AI response to memory
    messages.push({
      role: "assistant",
      content: answer,
    });

    return answer;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

function chat() {
  rl.question("\nYou: ", async (question) => {
    if (question.toLowerCase() === "exit") {
      console.log("\nGoodbye! 👋");
      rl.close();
      return;
    }

    if (!question.trim()) {
      chat();
      return;
    }

    console.log("\nAI is thinking...");

    const answer = await askAI(question);

    console.log("\nAI:", answer);

    chat();
  });
}

console.log("=================================");
console.log("      My OpenRouter AI Chat");
console.log("=================================");
console.log("Conversation memory: ON 🧠");
console.log('Type "exit" to quit.');

chat();