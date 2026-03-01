import { runPhi3Fallback } from './phi3-fallback.js';

async function quickTest() {
  process.env.DOCKER_CONTAINER = 'false';
  console.log('Testing critical escalation...');
  const ctx = {
    prompt: 'What files are in the current directory?',
    chatJid: 'test-jid',
    groupFolder: 'main',
    isMain: true,
    model: process.env.LOCAL_FALLBACK_MODEL || 'qwen2.5-coder:3b'
  };
  const result = await runPhi3Fallback(ctx);
  console.log('Status:', result.status);
  console.log('Content:', result.result);
  if (result.result && result.result.toUpperCase().includes('ESCALATE')) {
    console.log('SUCCESS: Escalation detected.');
  } else {
    console.log('FAILED: No escalation detected.');
  }
}

quickTest();
