/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Supports both QR code and pairing code methods.
 *
 * Usage: npx tsx src/whatsapp-auth.ts [--pairing-code]
 */
import fs from 'fs';
import readline from 'readline';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const AUTH_DIR = './store/auth';

const logger = pino({
  level: 'warn', // Quiet logging - only show errors
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log(
      '  To re-authenticate, delete the store/auth folder and run again.',
    );
    rl.close();
    process.exit(0);
  }

  console.log('WhatsApp Authentication\n');
  console.log('Choose authentication method:');
  console.log('  1. Pairing Code (recommended - enter 8-digit code in WhatsApp)');
  console.log('  2. QR Code (scan with camera)\n');

  const usePairingCode = process.argv.includes('--pairing-code');
  let method: string;

  if (usePairingCode) {
    method = '1';
  } else {
    method = await question('Enter choice (1 or 2): ');
  }

  let phoneNumber: string | undefined;

  if (method === '1') {
    console.log('\nPairing Code Method\n');
    phoneNumber = await question('Enter your WhatsApp phone number (with country code, e.g., 1234567890): ');

    // Validate phone number format
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (phoneNumber.length < 10) {
      console.error('✗ Invalid phone number. Must include country code.');
      rl.close();
      process.exit(1);
    }

    console.log(`\nUsing phone number: +${phoneNumber}`);
    console.log('Generating pairing code...\n');
  } else {
    console.log('\nQR Code Method\n');
  }

  rl.close();

  let pairingCodeShown = false;

  async function connect(): Promise<void> {
    const { state: currentState, saveCreds: saveCurrentCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    // Fetch latest WA version to avoid mismatch disconnects
    let waVersion: [number, number, number] | undefined;
    try {
      const { fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
      const { version } = await fetchLatestBaileysVersion();
      waVersion = version;
      console.log(`Using WA Web version: ${version.join('.')}`);
    } catch {
      console.log('Could not fetch WA version, using default');
    }

    const sock = makeWASocket({
      auth: {
        creds: currentState.creds,
        keys: makeCacheableSignalKeyStore(currentState.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ['NanoClaw', 'Chrome', '1.0.0'],
      ...(waVersion ? { version: waVersion } : {}),
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      retryRequestDelayMs: 5000,
    });

    // Request pairing code if phone number provided and not yet paired
    if (phoneNumber && !currentState.creds.registered && !pairingCodeShown) {
      setTimeout(async () => {
        try {
          console.log('Waiting for connection to establish...');
          const code = await sock.requestPairingCode(phoneNumber);
          pairingCodeShown = true;
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('');
          console.log('  Your Pairing Code: ' + code);
          console.log('');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
          console.log('Steps to link:');
          console.log('  1. Open WhatsApp on your phone');
          console.log('  2. Tap Settings > Linked Devices');
          console.log('  3. Tap "Link a Device"');
          console.log('  4. Tap "Link with phone number instead"');
          console.log('  5. Enter the code: ' + code);
          console.log('\nWaiting for you to enter the code...\n');
        } catch (err) {
          console.error('Failed to generate pairing code:', err);
          console.log('Retrying in 10 seconds...');
          setTimeout(() => connect(), 10000);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !phoneNumber) {
        console.log('Scan this QR code with WhatsApp:\n');
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings > Linked Devices > Link a Device');
        console.log('  3. Point your camera at the QR code below\n');
        qrcode.generate(qr, { small: true });
        console.log('\n');
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;

        if (reason === DisconnectReason.loggedOut) {
          console.log('\nLogged out. Delete store/auth and try again.');
          process.exit(1);
        } else if (reason === 515) {
          console.log('\nRate limited (515). Waiting 30 seconds before retry...');
          setTimeout(() => connect(), 30000);
        } else {
          console.log(`\nConnection closed (${reason}). Retrying in 5 seconds...`);
          setTimeout(() => connect(), 5000);
        }
      }

      if (connection === 'open') {
        console.log('\nSuccessfully authenticated with WhatsApp!');
        console.log('  Credentials saved to store/auth/');
        console.log('  You can now start the NanoClaw service.\n');
        // Wait for pre-keys to upload and creds to save
        setTimeout(() => process.exit(0), 3000);
      }
    });

    sock.ev.on('creds.update', saveCurrentCreds);
  }

  await connect();
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  rl.close();
  process.exit(1);
});
