import { Server } from 'boardgame.io/server';
import { HeavenAle } from './src/game';

const server = Server({ games: [HeavenAle] });
server.run(Number(process.env.PORT || 8000));
