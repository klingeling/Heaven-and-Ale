import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { Server } from 'boardgame.io/server';
import koaBody from 'koa-body';
import type { Server as BgioServer } from 'boardgame.io';
import { HeavenAle } from './src/game';

const allowedOrigins = (process.env.CLIENT_ORIGINS || 'http://localhost:5173')
  .split(',').map(origin => origin.trim()).filter(Boolean);
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
const configured = !!(supabaseUrl && supabaseSecret);
const secretBytes = configured ? scryptSync(supabaseSecret!, 'heaven-and-ale-room-data-v1', 32) : Buffer.alloc(32);

async function supabaseRequest(path: string, init: RequestInit = {}) {
  if (!configured) throw new Error('Supabase server configuration is missing.');
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: supabaseSecret!,
      Authorization: `Bearer ${supabaseSecret!}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${body}`);
  if (!body.trim()) return null;
  return JSON.parse(body);
}

const queryPath = (table: string, params: Record<string, string>) => {
  const search = new URLSearchParams(params);
  return `/rest/v1/${table}?${search.toString()}`;
};
const eq = (value: string | number) => `eq.${String(value)}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const encrypt = (value: string) => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretBytes, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
};
const decrypt = (value: string) => {
  const [iv, tag, ciphertext] = value.split('.');
  const decipher = createDecipheriv('aes-256-gcm', secretBytes, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
};

class SupabaseMatchStorage {
  type() { return 1; }
  async connect() { if (configured) await supabaseRequest('/rest/v1/bgio_matches?select=match_id&limit=1'); }
  async createMatch(matchID: string, opts: any) {
    await supabaseRequest('/rest/v1/bgio_matches', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      match_id: matchID, game_name: opts.metadata.gameName, state: opts.initialState, initial_state: opts.initialState, log: [], metadata: opts.metadata,
    }) });
  }
  async setState(matchID: string, state: any, deltalog: any[] = []) {
    const rows = await supabaseRequest(queryPath('bgio_matches', { select: 'log', match_id: eq(matchID) })) as any[];
    const log = [...(rows[0]?.log || []), ...(deltalog || [])];
    await supabaseRequest(queryPath('bgio_matches', { match_id: eq(matchID) }), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ state, log, updated_at: new Date().toISOString() }) });
  }
  async setMetadata(matchID: string, metadata: any) {
    await supabaseRequest(queryPath('bgio_matches', { match_id: eq(matchID) }), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ metadata, updated_at: new Date().toISOString() }) });
  }
  async fetch(matchID: string, opts: any) {
    const columns = Object.entries({ state: opts.state, log: opts.log, metadata: opts.metadata, initial_state: opts.initialState }).filter(([, enabled]) => enabled).map(([name]) => name);
    if (!columns.length) return {};
    const rows = await supabaseRequest(queryPath('bgio_matches', { select: columns.join(','), match_id: eq(matchID) })) as any[];
    if (!rows.length) return {};
    const row = rows[0], result: any = {};
    if (opts.state) result.state = row.state;
    if (opts.log) result.log = row.log || [];
    if (opts.metadata) result.metadata = row.metadata;
    if (opts.initialState) result.initialState = row.initial_state;
    return result;
  }
  async wipe(matchID: string) {
    await supabaseRequest(queryPath('bgio_matches', { match_id: eq(matchID) }), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    await supabaseRequest(queryPath('online_rooms', { match_id: eq(matchID) }), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    await supabaseRequest(queryPath('online_room_members', { match_id: eq(matchID) }), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
  async listMatches(opts: any = {}) {
    const rows = await supabaseRequest(queryPath('bgio_matches', { select: 'match_id,game_name,metadata,updated_at' })) as any[];
    return rows.filter(row => {
      if (opts.gameName && row.game_name !== opts.gameName) return false;
      const ended = !!row.metadata?.gameover;
      if (opts.where?.isGameover !== undefined && ended !== opts.where.isGameover) return false;
      const time = Date.parse(row.updated_at || '');
      if (opts.where?.updatedBefore && time >= opts.where.updatedBefore) return false;
      if (opts.where?.updatedAfter && time <= opts.where.updatedAfter) return false;
      return true;
    }).map(row => row.match_id);
  }
}

// Let boardgame.io choose its normal in-memory/flat-file adapter when Supabase
// is not configured; only provide a custom adapter for the persistent setup.
const server = Server({ games: [HeavenAle], origins: allowedOrigins, apiOrigins: allowedOrigins, db: configured ? new SupabaseMatchStorage() as any : undefined });
server.app.on('error', (error: any, ctx: any) => {
  // Keep credentials out of logs while making unexpected API failures traceable in Render.
  console.error('[api-error]', ctx?.method || 'UNKNOWN', ctx?.path || 'UNKNOWN', error?.stack || error?.message || error);
});

async function getUser(ctx: any) {
  const token = String(ctx.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !supabaseUrl || !supabaseSecret) ctx.throw(401, 'Sign in is required.');
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseSecret, Authorization: `Bearer ${token}` } });
  if (!response.ok) ctx.throw(401, 'Your sign-in session has expired.');
  return await response.json() as { id: string; email?: string };
}
async function usernameAvailable(username: string, excludeUserID?: string) {
  const normalized = username.toLocaleLowerCase();
  for (let page = 1; page <= 1000; page++) {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: supabaseSecret!, Authorization: `Bearer ${supabaseSecret!}` },
    });
    if (!response.ok) throw new Error(`Supabase user lookup failed (${response.status}).`);
    const payload = await response.json() as { users?: any[] };
    const users = payload.users || [];
    if (users.some(user => user.id !== excludeUserID && String(user.user_metadata?.username || '').toLocaleLowerCase() === normalized)) return false;
    if (users.length < 1000) return true;
  }
  throw new Error('Username lookup reached its safety limit.');
}
const validUsername = (value: string) => value.length >= 2 && value.length <= 18 && /^[\p{L}\p{N}_-]+$/u.test(value);
async function getRoom(matchID: string) {
  const rows = await supabaseRequest(queryPath('online_rooms', { select: '*', match_id: eq(matchID) })) as any[];
  return rows[0] || null;
}
async function authorizedSeat(ctx: any, matchID: string, playerID: string, credentials: string) {
  const found = await (server.db as any).fetch(matchID, { metadata: true });
  if (!found?.metadata) ctx.throw(404, 'Room not found.');
  const valid = await server.auth.authenticateCredentials({ playerID, credentials, metadata: found.metadata });
  if (!valid) ctx.throw(403, 'Invalid seat credentials.');
  return found.metadata;
}
function accessToken(userID: string, matchID: string) {
  const payload = Buffer.from(JSON.stringify({ userID, matchID, expires: Date.now() + 5 * 60_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', supabaseSecret!).update(payload).digest('base64url')}`;
}
function validateAccessToken(token: string, userID: string, matchID: string) {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = createHmac('sha256', supabaseSecret!).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  try { const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return body.userID === userID && body.matchID === matchID && body.expires > Date.now(); }
  catch { return false; }
}
const storeMember = async (matchID: string, userID: string, member: any, ownerID: string) => {
  await supabaseRequest('/rest/v1/online_room_members', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({
    match_id: matchID, user_id: userID, owner_user_id: ownerID, player_id: Number(member.playerID), player_name: member.playerName,
    credentials_ciphertext: encrypt(member.credentials), is_bot: member.isBot === true,
  }) });
};

// Private-room access is checked before the normal boardgame.io join route runs.
server.router.post('/games/:name/:id/join', koaBody(), async (ctx, next) => {
  if (configured) {
    const room = await getRoom(ctx.params.id);
    if (room?.is_private || room?.password_hash) {
      const user = await getUser(ctx);
      const token = String(ctx.get('x-room-access') || '');
      if (!validateAccessToken(token, user.id, ctx.params.id)) ctx.throw(403, 'This room requires its invitation link or password.');
    }
  }
  await next();
});

server.router.post('/account/rooms/register', koaBody(), async ctx => {
  const user = await getUser(ctx);
  const body = ctx.request.body || {};
  const matchID = String(body.matchID || ''), playerID = String(body.playerID || ''), credentials = String(body.credentials || '');
  if (!matchID || !playerID || !credentials) ctx.throw(400, 'Missing room seat details.');
  const metadata = await authorizedSeat(ctx, matchID, playerID, credentials);
  const isNew = body.room !== undefined;
  if (isNew) {
    const room = body.room || {};
    const privacy = room.isPrivate === true;
    const passHash = room.password ? hash(`${matchID}:${room.password}`) : null;
    const inviteHash = room.inviteToken ? hash(`${matchID}:${room.inviteToken}`) : null;
    await supabaseRequest('/rest/v1/online_rooms', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({
      match_id: matchID, owner_user_id: user.id, status: 'waiting', is_private: privacy, password_hash: passHash, invite_hash: inviteHash, invite_ciphertext: room.inviteToken ? encrypt(room.inviteToken) : null,
      max_players: Number(room.numPlayers || metadata.players.length), expansion_enabled: room.expansionEnabled === true,
    }) });
    await storeMember(matchID, user.id, { playerID, playerName: room.playerName || metadata.players[Number(playerID)]?.name, credentials }, user.id);
    for (const bot of Array.isArray(body.botCredentials) ? body.botCredentials : []) {
      await authorizedSeat(ctx, matchID, String(bot.playerID), String(bot.credentials));
      await storeMember(matchID, user.id, { ...bot, playerName: metadata.players[Number(bot.playerID)]?.name, isBot: true }, user.id);
    }
  } else {
    const room = await getRoom(matchID);
    if (!room) ctx.throw(404, 'Room is not registered.');
    const playerName = metadata.players[Number(playerID)]?.name || String(body.playerName || '玩家');
    await storeMember(matchID, user.id, { playerID, playerName, credentials }, room.owner_user_id);
  }
  ctx.body = { ok: true };
});

server.router.post('/account/rooms/authorize', koaBody(), async ctx => {
  const user = await getUser(ctx);
  const { matchID, password = '', inviteToken = '' } = ctx.request.body || {};
  const room = await getRoom(String(matchID || ''));
  if (!room) ctx.throw(404, 'Room not found.');
  const memberRows = await supabaseRequest(queryPath('online_room_members', { select: 'user_id', match_id: eq(matchID), user_id: eq(user.id) })) as any[];
  const alreadyMember = memberRows.length > 0;
  if (!alreadyMember) {
    if (room.is_private && (!inviteToken || hash(`${matchID}:${inviteToken}`) !== room.invite_hash)) ctx.throw(403, '请使用房主发来的邀请链接。');
    if (room.password_hash && hash(`${matchID}:${String(password)}`) !== room.password_hash) ctx.throw(403, '房间密码不正确。');
  }
  ctx.body = { accessToken: accessToken(user.id, matchID), room: { matchID, isPrivate: room.is_private, status: room.status, maxPlayers: room.max_players, expansionEnabled: room.expansion_enabled } };
});

server.router.post('/account/rooms/joined', koaBody(), async ctx => {
  const user = await getUser(ctx);
  const { matchID, playerID, credentials } = ctx.request.body || {};
  const metadata = await authorizedSeat(ctx, String(matchID), String(playerID), String(credentials));
  const room = await getRoom(String(matchID));
  if (!room) ctx.throw(404, 'Room not found.');
  await storeMember(String(matchID), user.id, { playerID, credentials, playerName: metadata.players[Number(playerID)]?.name }, room.owner_user_id);
  ctx.body = { ok: true };
});

server.router.get('/account/rooms', async ctx => {
  const user = await getUser(ctx);
  const memberships = await supabaseRequest(queryPath('online_room_members', { select: '*', user_id: eq(user.id), order: 'joined_at.desc' })) as any[];
  const matchIDs = [...new Set(memberships.map(member => member.match_id))];
  const rooms: any[] = [];
  for (const matchID of matchIDs) {
    const room = await getRoom(matchID);
    const allRows = await supabaseRequest(queryPath('online_room_members', { select: '*', match_id: eq(matchID) })) as any[];
    const own = memberships.filter(member => member.match_id === matchID);
    const host = room?.owner_user_id === user.id;
    const main = own.find(member => !member.is_bot) || own[0];
    const fetched = await (server.db as any).fetch(matchID, { metadata: true, state: true, initialState: true, log: true });
    if (!room || !fetched?.metadata || !main) continue;
    const players = fetched.metadata.players || [];
    const started = room.status !== 'waiting';
    const ended = !!fetched.metadata.gameover || fetched.state?.G?.phase === 'finished';
    const status = ended ? 'finished' : started ? 'playing' : 'waiting';
    if (status !== room.status) await supabaseRequest(queryPath('online_rooms', { match_id: eq(matchID) }), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status, updated_at: new Date().toISOString() }) });
    rooms.push({ matchID, status, isPrivate: room.is_private, maxPlayers: room.max_players, expansionEnabled: room.expansion_enabled,
      owner: host, host, playerID: String(main.player_id), credentials: decrypt(main.credentials_ciphertext), playerName: main.player_name,
      numPlayers: room.max_players, players: players.map((player: any, i: number) => ({ id: i, name: player.name, isConnected: player.isConnected, data: player.data })),
      botSeats: allRows.filter(member => member.is_bot).map(member => member.player_id),
      botCredentials: host ? allRows.filter(member => member.is_bot).map(member => ({ playerID: String(member.player_id), credentials: decrypt(member.credentials_ciphertext) })) : [],
      inviteToken: host && room.invite_ciphertext ? decrypt(room.invite_ciphertext) : undefined, isPrivate: room.is_private, gameover: fetched.metadata.gameover, updatedAt: Date.parse(room.updated_at),
    });
  }
  ctx.body = rooms;
});

server.router.post('/account/profile/username-available', koaBody(), async ctx => {
  const username = String(ctx.request.body?.username || '').trim();
  if (!validUsername(username)) ctx.throw(400, '用户名需为 2–18 个字，只能包含文字、数字、下划线或短横线。');
  const token = String(ctx.get('authorization') || '').replace(/^Bearer\s+/i, '');
  let excludeUserID: string | undefined;
  if (token) excludeUserID = (await getUser(ctx)).id;
  try { ctx.body = { available: await usernameAvailable(username, excludeUserID) }; }
  catch { ctx.throw(503, '暂时无法检查用户名，请稍后重试。'); }
});

server.router.post('/account/profile/username', koaBody(), async ctx => {
  const user = await getUser(ctx);
  const username = String(ctx.request.body?.username || '').trim().slice(0, 18);
  if (!validUsername(username)) ctx.throw(400, '用户名需为 2–18 个字，只能包含文字、数字、下划线或短横线。');
  let available = false;
  try { available = await usernameAvailable(username, user.id); }
  catch { ctx.throw(503, '暂时无法检查用户名，请稍后重试。'); }
  if (!available) ctx.throw(409, '这个用户名已被使用，请换一个。');
  const memberships = await supabaseRequest(queryPath('online_room_members', {
    select: 'match_id,player_id', user_id: eq(user.id), is_bot: 'eq.false',
  })) as any[];
  const seats = new Map<string, number[]>();
  for (const member of memberships) {
    const matchID = String(member.match_id);
    seats.set(matchID, [...(seats.get(matchID) || []), Number(member.player_id)]);
  }
  for (const [matchID, playerIDs] of seats) {
    const fetched = await (server.db as any).fetch(matchID, { metadata: true });
    if (!fetched?.metadata) continue;
    const metadata = fetched.metadata;
    let changed = false;
    for (const playerID of playerIDs) {
      if (metadata.players?.[playerID]) {
        metadata.players[playerID].name = username;
        changed = true;
      }
    }
    if (!changed) continue;
    await (server.db as any).setMetadata(matchID, metadata);
    await supabaseRequest(queryPath('online_room_members', {
      match_id: eq(matchID), user_id: eq(user.id), is_bot: 'eq.false',
    }), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ player_name: username }) });
  }
  ctx.body = { ok: true, username };
});

server.router.post('/account/rooms/status', koaBody(), async ctx => {
  const user = await getUser(ctx);
  const { matchID, status, playerID, credentials } = ctx.request.body || {};
  if (!['playing', 'finished'].includes(status)) ctx.throw(400, 'Invalid room status.');
  await authorizedSeat(ctx, String(matchID), String(playerID), String(credentials));
  const rows = await supabaseRequest(queryPath('online_room_members', { select: 'user_id', match_id: eq(matchID), user_id: eq(user.id) })) as any[];
  if (!rows.length) ctx.throw(403, 'You are not a member of this room.');
  await supabaseRequest(queryPath('online_rooms', { match_id: eq(matchID) }), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status, updated_at: new Date().toISOString() }) });
  ctx.body = { ok: true };
});

server.router.get('/account/public-rooms', async ctx => {
  const rows = await supabaseRequest(queryPath('online_rooms', { select: '*', is_private: 'eq.false', status: 'eq.waiting', order: 'created_at.desc' })) as any[];
  const result: any[] = [];
  for (const room of rows) {
    const fetched = await (server.db as any).fetch(room.match_id, { metadata: true });
    if (!fetched?.metadata) continue;
    const players = fetched.metadata.players || [];
    result.push({ matchID: room.match_id, players: players.map((player: any, id: number) => ({ id, name: player.name, isConnected: player.isConnected, data: player.data })),
      setupData: fetched.metadata.setupData, isPrivate: false, hasPassword: !!room.password_hash, status: room.status, updatedAt: Date.parse(room.updated_at) });
  }
  ctx.body = result;
});

server.router.post('/admin/matches/:id/delete', koaBody(), async ctx => {
  const matchID = ctx.params.id;
  const { playerID, credentials } = ctx.request.body || {};
  if (String(playerID) !== '0' || typeof credentials !== 'string') ctx.throw(403, 'Only the room owner can delete this room.');
  const { metadata } = await (server.db as any).fetch(matchID, { metadata: true });
  if (!metadata) ctx.throw(404, 'Room not found.');
  const authorized = await server.auth.authenticateCredentials({ playerID: '0', credentials, metadata });
  if (!authorized) ctx.throw(403, 'Invalid room owner credentials.');
  await (server.db as any).wipe(matchID);
  ctx.status = 204;
});

server.run(Number(process.env.PORT || 8000));
