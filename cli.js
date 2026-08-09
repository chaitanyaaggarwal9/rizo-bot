require('dotenv').config();
const readline = require('readline');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const CHAT_URL = `${BASE_URL}/api/chat`;
const RESET_URL = `${BASE_URL}/api/reset`;

async function sendMessage(message) {
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}

async function resetConversation() {
  const response = await fetch(RESET_URL, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}

async function oneShot(message) {
  try {
    const { model, reply } = await sendMessage(message);
    console.log(`\n[${model}]\n${reply}\n`);
  } catch (err) {
    console.error('Error:', err.message);
    console.error('(Is the server running? Start it with: node server.js)');
    process.exitCode = 1;
  }
}

async function resetOnly() {
  try {
    await resetConversation();
    console.log('Conversation history cleared.');
  } catch (err) {
    console.error('Error:', err.message);
    console.error('(Is the server running? Start it with: node server.js)');
    process.exitCode = 1;
  }
}

function interactive() {
  console.log(`Connected to ${CHAT_URL}`);
  console.log('Type your message and press Enter. Type "reset" to clear history, "exit" or Ctrl+C to quit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const message = line.trim();
    if (!message) return rl.prompt();
    if (message === 'exit') return rl.close();

    if (message === 'reset') {
      try {
        await resetConversation();
        console.log('Conversation history cleared.\n');
      } catch (err) {
        console.error('Error:', err.message);
      }
      return rl.prompt();
    }

    try {
      const { model, reply } = await sendMessage(message);
      console.log(`\n[${model}]\n${reply}\n`);
    } catch (err) {
      console.error('Error:', err.message);
      console.error('(Is the server running? Start it with: node server.js)');
    }
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

const args = process.argv.slice(2);

if (args[0] === '--reset') {
  resetOnly();
} else if (args.join(' ').trim()) {
  oneShot(args.join(' ').trim());
} else {
  interactive();
}
