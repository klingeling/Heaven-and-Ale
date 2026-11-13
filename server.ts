import { Server } from 'boardgame.io/server';
import { HeavenAle } from './src/game';

const allowedOrigins = (process.env.CLIENT_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const server = Server({ games: [HeavenAle], origins: allowedOrigins, apiOrigins: allowedOrigins });
server.run(Number(process.env.PORT || 8000));
