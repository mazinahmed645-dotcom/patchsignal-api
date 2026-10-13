import 'dotenv/config';
import { createApp } from './src/app.js';

const port = Number(process.env.PORT || 4021);
const app = createApp();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`PatchSignal API listening on port ${port}`);
  console.log(`Payments: ${process.env.PAYMENTS_ENABLED === 'true' ? 'ENABLED' : 'DISABLED (setup/local mode)'}`);
  console.log(`Network: ${process.env.X402_NETWORK || 'eip155:8453'}`);
});

function shutdown(signal) {
  console.log(`${signal} received. Closing HTTP server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
