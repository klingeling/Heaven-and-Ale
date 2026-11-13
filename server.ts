import { Server } from 'boardgame.io/server';
import koaBody from 'koa-body';
import { HeavenAle } from './src/game';

const allowedOrigins = (process.env.CLIENT_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const server = Server({ games: [HeavenAle], origins: allowedOrigins, apiOrigins: allowedOrigins });
server.router.post('/admin/matches/:id/delete', koaBody(), async ctx => {
  const matchID = ctx.params.id;
  const { playerID, credentials } = ctx.request.body || {};
  if (String(playerID) !== '0' || typeof credentials !== 'string') ctx.throw(403, 'Only the room owner can delete this room.');
  const { metadata } = await (ctx.db as any).fetch(matchID, { metadata: true });
  if (!metadata) ctx.throw(404, 'Room not found.');
  const authorized = await ctx.auth.authenticateCredentials({ playerID: '0', credentials, metadata });
  if (!authorized) ctx.throw(403, 'Invalid room owner credentials.');
  await (ctx.db as any).wipe(matchID);
  ctx.status = 204;
});
server.run(Number(process.env.PORT || 8000));
