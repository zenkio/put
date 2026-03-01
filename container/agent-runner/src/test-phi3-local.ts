import { runPhi3Fallback } from './phi3-fallback.js';

// Mock environment and context
process.env.GROUP_FOLDER = 'main';

// Test 1: Simple prompt (should NOT escalate)
async function testSimplePrompt() {
  console.log('\n--- Testing local fallback with simple prompt ---');
  const ctx = {
    prompt: 'What is the capital of France?',
    chatJid: 'test-jid',
    groupFolder: 'main',
    isMain: true,
    model: process.env.LOCAL_FALLBACK_MODEL || 'qwen2.5-coder:3b'
  };
  try {
    const result = await runPhi3Fallback(ctx);
    console.log('Result status:', result.status);
    console.log('Result content:', result.result);
    if (result.error) console.error('Result error:', result.error);
    if (result.result && result.result.includes('ESCALATE_TO_PREMIUM')) {
      console.error('ERROR: Simple prompt unexpectedly escalated!');
    }
  } catch (err) {
    console.error('Test failed:', err);
  }
}

// Test 2: Complex prompt (SHOULD escalate)
async function testComplexPrompt() {
  console.log('\n--- Testing local fallback with complex prompt (should escalate) ---');
  const ctx = {
    prompt: 'Write a detailed software architecture proposal for a distributed microservices system with event sourcing and a GraphQL API.',
    chatJid: 'test-jid',
    groupFolder: 'main',
    isMain: true,
    model: process.env.LOCAL_FALLBACK_MODEL || 'qwen2.5-coder:3b'
  };
  try {
    const result = await runPhi3Fallback(ctx);
    console.log('Result status:', result.status);
    console.log('Result content:', result.result);
    if (result.error) console.error('Result error:', result.error);
    if (result.result && !result.result.includes('ESCALATE_TO_PREMIUM')) {
      console.error('ERROR: Complex prompt did NOT escalate!');
    } else {
      console.log('SUCCESS: Complex prompt correctly escalated.');
    }
  } catch (err) {
    console.error('Test failed:', err);
  }
}

async function testToolPrompt() {
  console.log('\n--- Testing local fallback with tool-dependent prompt (should escalate) ---');
  const ctx = {
    prompt: 'I need you to delete all files in the current directory and then search the web for how to fix a broken linux install.',
    chatJid: 'test-jid',
    groupFolder: 'main',
    isMain: true,
    model: process.env.LOCAL_FALLBACK_MODEL || 'qwen2.5-coder:3b'
  };
  try {
    const result = await runPhi3Fallback(ctx);
    console.log('Result status:', result.status);
    console.log('Result content:', result.result);
    if (result.error) console.error('Result error:', result.error);
    if (result.result && result.result.includes('ESCALATE_TO_PREMIUM')) {
      console.log('SUCCESS: Tool prompt correctly escalated.');
    } else {
      console.error('ERROR: Tool prompt did NOT escalate!');
    }
  } catch (err) {
    console.error('Test failed:', err);
  }
}

async function main() {
  process.env.DOCKER_CONTAINER = 'false'; // Simulate running outside docker for local Ollama
  await testSimplePrompt();
  await testComplexPrompt();
  await testToolPrompt();
}

main();
