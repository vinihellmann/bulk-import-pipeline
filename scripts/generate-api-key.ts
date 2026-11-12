import { randomBytes } from 'node:crypto';
import { hashApiKey } from '../src/shared/auth/apiKeys';
import { CLIENT_ID_PATTERN } from '../src/shared/auth/principal';

const clientId = process.argv[2];
if (!clientId || !CLIENT_ID_PATTERN.test(clientId)) {
  process.stderr.write('Usage: npm run generate:api-key -- <clientId>\n');
  process.stderr.write('clientId: lowercase letters, digits, "_" or "-" (max 64 chars)\n');
  process.exit(1);
}

const key = randomBytes(32).toString('base64url');
process.stdout.write(`API key (give to the client, shown only once):\n  ${key}\n\n`);
process.stdout.write(
  `API_KEYS entry (add to the server, comma-separated):\n  ${clientId}:${hashApiKey(key)}\n`,
);
