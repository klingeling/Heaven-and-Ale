import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { HeavenAle, availableBarrelIds, barrelGoals, barrelTokenPositions, canBuyFrom, canMoveTo, canScore, canSelectShedCell, gardenCells, lowestResources, monkNames, playerBoardPercent, privilegeCardPositions, productionTrackPositions, resourceColors, resourceLabels, resources, scoreBreakdown, scoreChoices, scoringDiscPositions, shedProductionProgress, startSlots, tileBaseCost, validShedSelection, type AleState, type Resource, type ShedChoice, type Tile } from './game';
import { chooseBotMove, type BotDifficulty } from './bot';
import './style.css';
import './garden-layout.css';
import './readable-text.css';

type AnyClient = ReturnType<typeof Client>;
type PieceFlight = { id: string; kind: 'tile' | 'disc' | 'barrel' | 'coin' | 'meeple' | 'resource-marker' | 'brewer-marker' | 'privilege-card'; tile?: Tile; card?: string; pairIndex?: number; targetIndex?: number; scoreIndex?: number; targetTrackIndex?: number; targetStartSlot?: number; playerColor?: string; playerName?: string; resourceKey?: Resource; playerIndex?: number; barrelId?: number; barrelSize?: 'large' | 'small'; left: number; top: number; width: number; height: number; dx: number; dy: number; scale: number; delayMs?: number; started: boolean };
const gameName = 'heaven-and-ale';
const BOT_AFTER_ANIMATION_PAUSE_MS = 500;
const tokenSpriteColorIndex: Record<string, number> = { black: 0, blue: 1, green: 2, orange: 3, purple: 4, red: 5, yellow: 6 };
const tokenSpritePosition = (color: string) => `${(tokenSpriteColorIndex[color] ?? 0) * (100 / 6)}% center`;
const localSaveKey = 'heaven-and-ale-local-session-v1';
type LocalSave = { version: 1; playerCount: number; botSeats: number[]; botDifficulty: BotDifficulty; playerNames: string[]; state: any; initialState: any; log: any[]; savedAt: number; botNames?: string[] };
type OnlineRoomSession = { matchID: string; playerID: string; credentials: string; playerName: string; numPlayers: number; host: boolean; botSeats: number[]; botDifficulty?: BotDifficulty; botCredentials: { playerID: string; credentials: string }[] };
type LobbyRoom = { matchID: string; players: { id: number; name?: string; isConnected?: boolean }[]; gameover?: unknown; updatedAt?: number };
const onlineNameKey = 'heaven-and-ale-online-player-name-v1';
const onlineSessionKey = (matchID: string) => `heaven-and-ale-online-room-${matchID}`;
function saveOnlineSession(session: OnlineRoomSession) {
  localStorage.setItem(onlineSessionKey(session.matchID), JSON.stringify(session));
}
function loadOnlineSession(matchID: string): OnlineRoomSession | null {
  try { const value = localStorage.getItem(onlineSessionKey(matchID)); return value ? JSON.parse(value) as OnlineRoomSession : null; }
  catch { return null; }
}
function readLocalSave(): LocalSave | null {
  try {
    const raw = localStorage.getItem(localSaveKey);
    if (!raw) return null;
    const saved = JSON.parse(raw) as LocalSave;
    if (saved.version !== 1 || !saved.state?.G || !saved.initialState) return null;
    for (const gameState of [saved.state, saved.initialState]) {
      gameState.G?.players?.forEach((player: { name: string }, i: number) => {
        if (/^修道院\s*\d+$/.test(player.name)) player.name = `玩家${i + 1}`;
      });
    }
    saved.playerNames ??= saved.state.G.players.map((player: { name: string }, i: number) => saved.botSeats.includes(i) ? player.name || saved.botNames?.[i] || `机器人${i + 1}` : player.name || `玩家${i + 1}`);
    return saved;
  } catch { return null; }
}
function makeLocalGame(bots: number[], names: string[]) {
  const setup = HeavenAle.setup!;
  const botSeatSet = new Set(bots);
  return {
    ...HeavenAle,
    setup: (args: any) => {
      const G = setup(args);
      G.players.forEach((player, i) => {
        player.name = names[i]?.trim() || (botSeatSet.has(i) ? `机器人${i + 1}` : `玩家${i + 1}`);
      });
      return G;
    },
  };
}
function App() {
  const [screen, setScreen] = useState<'home' | 'waiting' | 'game'>('home');
  const [client, setClient] = useState<AnyClient | null>(null);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [playerCount, setPlayerCount] = useState(2);
  const [botSeats, setBotSeats] = useState<number[]>([]);
  const [playerNames, setPlayerNames] = useState(['玩家1', '玩家2', '玩家3', '玩家4']);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('normal');
  const [activeBotSeats, setActiveBotSeats] = useState<number[]>([]);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(onlineNameKey) || '玩家1');
  const [onlinePlayerCount, setOnlinePlayerCount] = useState(2);
  const [onlineBotCount, setOnlineBotCount] = useState(0);
  const [onlineBotDifficulty, setOnlineBotDifficulty] = useState<BotDifficulty>('normal');
  const [serverUrl, setServerUrl] = useState(import.meta.env.VITE_GAME_SERVER || 'http://localhost:8000');
  const [roomCode, setRoomCode] = useState(() => new URLSearchParams(window.location.search).get('room') || '');
  const [roomInfo, setRoomInfo] = useState('');
  const [openRooms, setOpenRooms] = useState<LobbyRoom[]>([]);
  const [onlineRoom, setOnlineRoom] = useState<OnlineRoomSession | null>(null);
  const [roomMatch, setRoomMatch] = useState<LobbyRoom | null>(null);
  const [remoteBotClients, setRemoteBotClients] = useState<{ seat: number; client: AnyClient }[]>([]);
  const [busy, setBusy] = useState(false);
  const [savedLocal, setSavedLocal] = useState<LocalSave | null>(readLocalSave);
  const [localConfig, setLocalConfig] = useState<Omit<LocalSave, 'state' | 'initialState' | 'log' | 'savedAt' | 'version' | 'botNames'> | null>(null);

  const startLocal = (count: number, bots: number[], difficulty: BotDifficulty = 'normal', names: string[] = []) => {
    const selectedBots = [...new Set(bots)].filter(seat => Number.isInteger(seat) && seat >= 0 && seat < count).sort((a, b) => a - b);
    const selectedNames = Array.from({ length: count }, (_, i) => names[i]?.trim() || (selectedBots.includes(i) ? `机器人${i + 1}` : `玩家${i + 1}`));
    const config = { playerCount: count, botSeats: selectedBots, botDifficulty: difficulty, playerNames: selectedNames };
    const c = Client({ game: makeLocalGame(selectedBots, selectedNames), numPlayers: count, debug: false });
    c.start(); setLocalConfig(config); setClient(c); setScreen('game'); setActiveBotSeats(selectedBots); setBotSeats(selectedBots); setPlayerNames(selectedNames);
    setRoomInfo(selectedBots.length === count ? `机器人对局 · 全部由${difficulty === 'expert' ? '专家' : '普通'}机器人操控` : selectedBots.length ? `本地混合对局 · ${difficulty === 'expert' ? '专家' : '普通'}机器人 ×${selectedBots.length}` : '本地热座 · 轮流操作');
  };
  const setSeatMode = (seat: number, robot: boolean) => {
    if (botSeats.includes(seat) === robot) return;
    setBotSeats(current => robot ? [...current, seat].sort((a, b) => a - b) : current.filter(id => id !== seat));
    setPlayerNames(current => current.map((name, i) => i === seat ? `${robot ? '机器人' : '玩家'}${seat + 1}` : name));
  };
  const setAllSeatModes = (robot: boolean) => {
    setBotSeats(robot ? Array.from({ length: playerCount }, (_, i) => i) : []);
    setPlayerNames(Array.from({ length: 4 }, (_, i) => `${robot ? '机器人' : '玩家'}${i + 1}`));
  };
  const resumeLocal = () => {
    const saved = readLocalSave();
    if (!saved) { setSavedLocal(null); return; }
    const c = Client({ game: makeLocalGame(saved.botSeats, saved.playerNames), numPlayers: saved.playerCount, debug: false });
    c.store.dispatch({ type: 'SYNC', state: saved.state, initialState: saved.initialState, log: saved.log, clientOnly: true });
    c.start();
    setLocalConfig({ playerCount: saved.playerCount, botSeats: saved.botSeats, botDifficulty: saved.botDifficulty, playerNames: saved.playerNames });
    setClient(c); setActiveBotSeats(saved.botSeats); setPlayerNames(saved.playerNames); setBotDifficulty(saved.botDifficulty); setScreen('game');
    setRoomInfo(saved.botSeats.length === saved.playerCount ? `已恢复 · 全部由${saved.botDifficulty === 'expert' ? '专家' : '普通'}机器人操控` : saved.botSeats.length ? `已恢复本地混合对局 · ${saved.botDifficulty === 'expert' ? '专家' : '普通'}机器人 × ${saved.botSeats.length}` : '已恢复本地热座对局');
  };
  useEffect(() => { if (savedLocal && !new URLSearchParams(window.location.search).has('room')) resumeLocal(); }, []);
  const setSavedName = (value: string) => {
    setPlayerName(value);
    localStorage.setItem(onlineNameKey, value);
  };
  const refreshRooms = async () => {
    try {
      const lobby = new LobbyClient({ server: serverUrl });
      const result = await lobby.listMatches(gameName, { isGameover: false });
      setOpenRooms((result.matches || []) as LobbyRoom[]);
    } catch { /* the lobby can be sleeping while Render wakes up */ }
  };
  useEffect(() => {
    if (screen !== 'home') return;
    void refreshRooms();
    const timer = window.setInterval(() => void refreshRooms(), 7000);
    return () => window.clearInterval(timer);
  }, [screen, serverUrl]);
  const matchAsRoom = (match: any): LobbyRoom => ({ matchID: match.matchID, players: match.players || [], gameover: match.gameover, updatedAt: match.updatedAt });
  const enterWaitingRoom = async (session: OnlineRoomSession, match: any) => {
    saveOnlineSession(session);
    setOnlineRoom(session); setRoomMatch(matchAsRoom(match)); setRoomCode(session.matchID);
    const url = new URL(window.location.href); url.searchParams.set('room', session.matchID); window.history.replaceState({}, '', url);
    setScreen('waiting'); setRoomInfo('');
  };
  const createRoom = async () => {
    const name = playerName.trim() || '玩家1'; setSavedName(name);
    const count = onlinePlayerCount;
    const botSeats = Array.from({ length: onlineBotCount }, (_, i) => count - onlineBotCount + i);
    setBusy(true); setRoomInfo('正在创建房间…');
    try {
      const lobby = new LobbyClient({ server: serverUrl });
      const created = await lobby.createMatch(gameName, { numPlayers: count });
      const host = await lobby.joinMatch(gameName, created.matchID, { playerID: '0', playerName: name });
      const botCredentials: OnlineRoomSession['botCredentials'] = [];
      for (const seat of botSeats) {
        const joinedBot = await lobby.joinMatch(gameName, created.matchID, { playerID: String(seat), playerName: `机器人${seat + 1}` });
        botCredentials.push({ playerID: String(joinedBot.playerID), credentials: joinedBot.playerCredentials });
      }
      const match = await lobby.getMatch(gameName, created.matchID);
      await enterWaitingRoom({ matchID: created.matchID, playerID: String(host.playerID), credentials: host.playerCredentials, playerName: name, numPlayers: count, host: true, botSeats, botDifficulty: onlineBotDifficulty, botCredentials }, match);
      void refreshRooms();
    } catch (e) { setRoomInfo(`连接失败：${e instanceof Error ? e.message : '请确认 boardgame.io 服务端已启动。'}`); }
    setBusy(false);
  };
  const joinRoom = async (requestedCode = roomCode) => {
    const code = requestedCode.trim(); if (!code) return;
    const name = playerName.trim() || '玩家1'; setSavedName(name);
    setBusy(true); setRoomInfo('正在加入房间…');
    try {
      const lobby = new LobbyClient({ server: serverUrl });
      const existing = loadOnlineSession(code);
      let session: OnlineRoomSession;
      if (existing) session = { ...existing, playerName: name };
      else {
        const joined = await lobby.joinMatch(gameName, code, { playerName: name });
        const match = await lobby.getMatch(gameName, code);
        session = { matchID: code, playerID: String(joined.playerID), credentials: joined.playerCredentials, playerName: name, numPlayers: match.players.length, host: false, botSeats: [], botCredentials: [] };
        await enterWaitingRoom(session, match);
      }
      if (existing) await enterWaitingRoom(session, await lobby.getMatch(gameName, code));
      void refreshRooms();
    } catch (e) { setRoomInfo(`加入失败：${e instanceof Error ? e.message : '请检查房间号和服务器地址。'}`); }
    setBusy(false);
  };
  const startOnlineGame = async () => {
    if (!onlineRoom || !roomMatch || roomMatch.players.length < onlineRoom.numPlayers || roomMatch.players.some(p => !p.name)) return;
    setBusy(true); setRoomInfo('正在连接对局…');
    try {
      const makeClient = (playerID: string, credentials: string) => Client({ game: HeavenAle, multiplayer: SocketIO({ server: serverUrl }), matchID: onlineRoom.matchID, playerID, credentials, debug: false });
      const main = makeClient(onlineRoom.playerID, onlineRoom.credentials);
      const bots = onlineRoom.botCredentials.map(({ playerID, credentials }) => ({ seat: Number(playerID), client: makeClient(playerID, credentials) }));
      main.start(); bots.forEach(({ client: botClient }) => botClient.start());
      setLocalConfig(null); setClient(main); setRemoteBotClients(bots); setActiveBotSeats([]); setBotSeats(onlineRoom.botSeats);
      setRoomInfo(`线上房间 · ${onlineRoom.matchID}`); setScreen('game');
    } catch (e) { setRoomInfo(`进入失败：${e instanceof Error ? e.message : '请重试。'}`); }
    setBusy(false);
  };
  const leaveWaitingRoom = async () => {
    if (onlineRoom) {
      try {
        const lobby = new LobbyClient({ server: serverUrl });
        await lobby.leaveMatch(gameName, onlineRoom.matchID, { playerID: onlineRoom.playerID, credentials: onlineRoom.credentials });
        for (const bot of onlineRoom.botCredentials) await lobby.leaveMatch(gameName, onlineRoom.matchID, { playerID: bot.playerID, credentials: bot.credentials });
      } catch { /* room may already have started or expired */ }
      localStorage.removeItem(onlineSessionKey(onlineRoom.matchID));
    }
    const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.replaceState({}, '', url);
    setOnlineRoom(null); setRoomMatch(null); setScreen('home'); setRoomInfo(''); void refreshRooms();
  };
  useEffect(() => { if (roomCode && screen === 'home' && !busy) void joinRoom(roomCode); }, []);
  useEffect(() => {
    if (screen !== 'waiting' || !onlineRoom) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const match = await new LobbyClient({ server: serverUrl }).getMatch(gameName, onlineRoom.matchID);
        if (!cancelled) setRoomMatch(matchAsRoom(match));
      } catch { if (!cancelled) setRoomInfo('无法读取房间状态，房间可能已结束或服务暂时休眠。'); }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [screen, onlineRoom?.matchID, serverUrl]);

  useEffect(() => { if (!client) return; const persist = () => {
    if (!localConfig) return;
    try {
      const record: LocalSave = { version: 1, ...localConfig, state: (client as any).store.getState(), initialState: client.getInitialState(), log: (client as any).log ?? [], savedAt: Date.now() };
      localStorage.setItem(localSaveKey, JSON.stringify(record)); setSavedLocal(record);
    } catch (error) { console.warn('本地对局保存失败', error); }
  };
  const unsub = client.subscribe((state: any) => { setSnapshot(state); persist(); });
  persist();
  return () => { unsub(); client.stop(); };
  }, [client, localConfig]);
  const returnHome = () => { client?.stop(); remoteBotClients.forEach(({ client: botClient }) => botClient.stop()); setRemoteBotClients([]); setClient(null); setSnapshot(null); setScreen('home'); setActiveBotSeats([]); setLocalConfig(null); setOnlineRoom(null); setRoomMatch(null); setRoomCode(''); setPlayerCount(2); setBotSeats([]); setPlayerNames(['玩家1', '玩家2', '玩家3', '玩家4']); setBotDifficulty('normal'); const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.replaceState({}, '', url); };
  const abandonLocalGame = () => { localStorage.removeItem(localSaveKey); setSavedLocal(null); returnHome(); };
  if (screen === 'game' && client && snapshot) return <GameView client={client} state={snapshot} roomInfo={roomInfo} roomCode={roomCode} botSeats={localConfig ? activeBotSeats : onlineRoom?.botSeats || []} remoteBotClients={remoteBotClients} playerName={onlineRoom?.playerName} remoteBotDifficulty={onlineRoom?.botDifficulty || 'normal'} botDifficulty={localConfig ? botDifficulty : onlineRoom?.botDifficulty || 'normal'} isLocal={!!localConfig} onExit={returnHome} onAbandon={abandonLocalGame} />;
  if (screen === 'waiting' && onlineRoom) {
    const players = roomMatch?.players || [];
    const full = players.length >= onlineRoom.numPlayers && players.slice(0, onlineRoom.numPlayers).every(p => !!p.name);
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(onlineRoom.matchID)}`;
    return <main className="landing waiting-screen"><div className="landing-image" /><header className="topbar"><div className="brand-mark"><img src="/Images/ha-cover.png" alt="Heaven & Ale" /></div><b>天堂与美酒 · 等候室</b></header><section className="waiting-room setup-card"><div className="card-kicker">TABLE {onlineRoom.matchID}</div><h1>{full ? '所有玩家已到齐' : '等待玩家加入'}</h1><p>房主开始游戏前，所有席位需要有人就座。分享此桌的专属链接即可邀请朋友。</p><label>房间链接<div className="share-link-row"><input readOnly value={shareUrl} /><button className="btn btn-light" onClick={() => { void navigator.clipboard?.writeText(shareUrl); setRoomInfo('已复制房间链接。'); }}>复制</button></div></label><div className="waiting-seats">{Array.from({ length: onlineRoom.numPlayers }, (_, seat) => { const occupant = players.find(p => Number(p.id) === seat); return <div className={`waiting-seat ${occupant?.name ? 'is-filled' : ''}`} key={seat}><span className="seat-number">{seat + 1}</span><div><b>{occupant?.name || '等待玩家…'}</b><small>{onlineRoom.botSeats.includes(seat) ? '机器人席位' : occupant?.isConnected ? '已连接' : occupant?.name ? '已加入' : '空位'}</small></div>{occupant?.name && <i />}</div>; })}</div>{roomInfo && <div className="room-message">{roomInfo}</div>}<div className="waiting-actions"><button className="btn btn-outline" onClick={leaveWaitingRoom}>离开房间</button><button className="btn btn-gold" disabled={!full || busy} onClick={startOnlineGame}>{busy ? '连接中…' : full ? '进入对局' : '等待所有玩家加入'}</button></div><small className="waiting-footnote">房间状态每 2.5 秒自动刷新 · 昵称会保存在此设备</small></section></main>;
  }
  return <main className="landing">
    <div className="landing-image" />
    <header className="topbar"><div className="brand-mark"><img src="/Images/ha-cover.png" alt="Heaven & Ale" /></div><div>在犹如众神天堂般的麦芽酒花园中开怀畅饮！</div><div className="online-status"><i /> 桌游数字版</div></header>
    <section className="hero">
      <div className="eyebrow"><span>STRATEGY · 2–4 PLAYERS</span><span className="eyeline" /></div>
      <h1>天堂与美酒</h1>
      <p className="hero-sub">Heaven & Ale</p>
      <div className="hero-copy">作为一座古老修道院的负责人，你努力为人们提供最好的啤酒！<br />Harvest beer ingredients and master the art of monastic brewcrafting.</div>
      <div className="setup-grid">
        <div className="setup-card primary-card">
          <div className="card-kicker">QUICK TABLE</div><h2>开始本地对局</h2><p>先选择游戏人数，再为每个席位指定真实玩家或机器人<br />支持混合对局和全机器人观战</p>
          {savedLocal && <button className="btn btn-outline resume-local" onClick={resumeLocal}>继续上次本地对局 · {new Date(savedLocal.savedAt).toLocaleString()}</button>}
          <label>游戏人数<select value={playerCount} onChange={e => { const count = Number(e.target.value); setPlayerCount(count); setBotSeats(current => current.filter(seat => seat < count)); }}><option value={2}>两人游戏</option><option value={3}>三人游戏</option><option value={4}>四人游戏</option></select></label>
          <div className="bot-seat-toolbar"><span>玩家席位</span><div><button type="button" onClick={() => setAllSeatModes(false)}>全部设为真实玩家</button><button type="button" onClick={() => setAllSeatModes(true)}>全部设为机器人</button></div></div>
          <div className="bot-seat-list">{Array.from({ length: playerCount }, (_, seat) => { const isBot = botSeats.includes(seat); return <div className="bot-seat-row" key={seat}>
            <div className="bot-seat-toggle"><input className="bot-seat-name" aria-label={`玩家 ${seat + 1} 名称`} value={playerNames[seat]} maxLength={18} onChange={e => setPlayerNames(current => current.map((name, i) => i === seat ? e.target.value : name))} onBlur={e => { if (!e.target.value.trim()) setPlayerNames(current => current.map((name, i) => i === seat ? `${isBot ? '机器人' : '玩家'}${seat + 1}` : name)); }} /><div className="bot-seat-options" role="group" aria-label={`玩家 ${seat + 1} 类型`}><button type="button" className={!isBot ? 'selected' : ''} aria-pressed={!isBot} onClick={() => setSeatMode(seat, false)}>真实玩家</button><button type="button" className={isBot ? 'selected' : ''} aria-pressed={isBot} onClick={() => setSeatMode(seat, true)}>机器人</button></div></div>
          </div>; })}</div>
          {botSeats.length > 0 && <label>机器人难度<select value={botDifficulty} onChange={e => setBotDifficulty(e.target.value as BotDifficulty)}><option value="normal">普通 · 约 3 秒/步</option><option value="expert">专家 · 约 12 秒/步</option></select></label>}
          <button className="btn btn-gold" onClick={() => startLocal(playerCount, botSeats, botDifficulty, playerNames)}>开始本地对局 <span>↗</span></button>
        </div>
        <div className="setup-card online-card"><div className="card-kicker">PLAY TOGETHER</div><h2>线上大厅</h2><p>浏览公开等候桌，或创建一桌并邀请朋友加入。</p><label>玩家名称<input value={playerName} onChange={e => setSavedName(e.target.value)} onBlur={() => { if (!playerName.trim()) setSavedName('玩家1'); }} maxLength={18} /></label><label>游戏服务器<input value={serverUrl} onChange={e => setServerUrl(e.target.value)} /></label><div className="online-create-options"><label>总人数<select value={onlinePlayerCount} onChange={e => { const n = Number(e.target.value); setOnlinePlayerCount(n); setOnlineBotCount(current => Math.min(current, n - 1)); }}><option value={2}>2 人</option><option value={3}>3 人</option><option value={4}>4 人</option></select></label><label>机器人席位<select value={onlineBotCount} onChange={e => setOnlineBotCount(Number(e.target.value))}>{Array.from({ length: onlinePlayerCount }, (_, n) => n < onlinePlayerCount ? <option key={n} value={n}>{n === 0 ? '不加入机器人' : `加入 ${n} 个机器人`}</option> : null).slice(0, onlinePlayerCount)}</select></label></div>{onlineBotCount > 0 && <label>机器人难度<select value={onlineBotDifficulty} onChange={e => setOnlineBotDifficulty(e.target.value as BotDifficulty)}><option value="normal">普通</option><option value="expert">专家</option></select></label>}<div className="online-actions"><button className="btn btn-outline" disabled={busy} onClick={createRoom}>创建等候桌</button><div className="join-row"><input placeholder="房间号 / 链接" value={roomCode} onChange={e => { const v = e.target.value; const match = v.match(/[?&]room=([^&]+)/); setRoomCode(match ? decodeURIComponent(match[1]) : v); }} /><button className="btn btn-light" disabled={busy} onClick={() => void joinRoom()}>加入</button></div></div>{roomInfo && <div className="room-message">{roomInfo}</div>}<div className="lobby-list-heading"><b>可加入的房间</b><button onClick={() => void refreshRooms()}>刷新</button></div><div className="lobby-room-list">{openRooms.filter(room => room.players?.some(p => p.name)).map(room => { const occupied = room.players.filter(p => p.name).length, cap = room.players.length || 0; return <button className="lobby-room" key={room.matchID} disabled={busy || occupied >= cap} onClick={() => { setRoomCode(room.matchID); void joinRoom(room.matchID); }}><span><b>房间 {room.matchID}</b><small>{room.players.filter(p => p.name).map(p => p.name).join('、')}</small></span><em>{occupied}/{cap} 人 · {occupied >= cap ? '已满' : '等待中'}</em></button>; })}{openRooms.filter(room => room.players?.some(p => p.name)).length === 0 && <div className="lobby-empty">当前没有公开等候桌</div>}</div></div>
      </div>
      <div className="feature-row"><span>✦ 依照官方规则设计</span><span>✦ 共享房间码联机</span><span>✦ 支持 2–4 人</span></div>
    </section>
    <footer>HEAVEN & ALE <span>·</span> 天堂与美酒</footer>
  </main>;
}

function GameView({ client, state, roomInfo, roomCode, botSeats, remoteBotClients, playerName, remoteBotDifficulty, botDifficulty, isLocal, onExit, onAbandon }: { client: AnyClient; state: any; roomInfo: string; roomCode: string; botSeats: number[]; remoteBotClients: { seat: number; client: AnyClient }[]; playerName?: string; remoteBotDifficulty: BotDifficulty; botDifficulty: BotDifficulty; isLocal: boolean; onExit: () => void; onAbandon: () => void }) {
  const G = state.G as AleState, ctx = state.ctx, currentPlayerIndex = Number(ctx.currentPlayer);
  const currentPlayer = G.players[currentPlayerIndex] ?? G.players[0];
  const gameover = ctx.gameover as { winner?: string; winners?: string[]; draw?: boolean; scores?: number[] } | undefined;
  const winnerIds = gameover?.winners ?? (gameover?.winner !== undefined ? [String(gameover.winner)] : []);
  const moves = (client as any).moves;
  useEffect(() => {
    const ownID = Number((client as any).playerID);
    if (!isLocal && playerName?.trim() && ownID === currentPlayerIndex && G.players[ownID]?.name !== playerName.trim()) moves.setPlayerName?.(playerName.trim());
  }, [state._stateID, client, playerName, isLocal, currentPlayerIndex]);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [pieceFlights, setPieceFlights] = useState<PieceFlight[]>([]);
  const [deferredGameAction, setDeferredGameAction] = useState<'undoStep' | 'undoAction' | 'confirmAction' | null>(null);
  const deferredGameActionRef = React.useRef<typeof deferredGameAction>(null);
  const [scoreChoice, setScoreChoice] = useState<string>('1');
  const [scoreCategory, setScoreCategory] = useState<'A' | 'B' | 'C'>('A');
  const [privilegeCardChoice, setPrivilegeCardChoice] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [showAbandonConfirm, setShowAbandonConfirm] = useState(false);
  const [toast, setToast] = useState('');
  const [botSearchStatus, setBotSearchStatus] = useState<{ playerID: number; iterations: number } | null>(null);
  const [viewingPlayerIndex, setViewingPlayerIndex] = useState(currentPlayerIndex);
  useEffect(() => setViewingPlayerIndex(currentPlayerIndex), [currentPlayerIndex]);
  useEffect(() => {
    const logList = document.querySelector<HTMLElement>('.far-right-rail .log-list');
    if (logList) logList.scrollTop = logList.scrollHeight;
  }, [G.log[0]]);
  const me = G.players[viewingPlayerIndex] ?? currentPlayer;
  const isViewingCurrent = viewingPlayerIndex === currentPlayerIndex;
  const action = G.pending;
  const activePlayer = action ? G.players[Number(action.player)] : currentPlayer;
  const garden = gardenCells;
  const activeSeat = Number(ctx.currentPlayer);
  const isBotTurn = botSeats.includes(activeSeat) && G.phase !== 'finished';
  const canMove = !isBotTurn && !action && !G.confirmationKind && !G.privilegePrompts.length && !currentPlayer.retired && G.phase === 'play';
  const trackMove = (index: number) => { const moveTime = animateMeepleMove(currentPlayerIndex, index); const barrelTime = G.track[index]?.type === 'barrel' ? animateBarrels(currentPlayerIndex) : 0; moves.moveTo(index); setSelectedTileId(null); return Math.max(moveTime, barrelTime); };
  const currentActionSpace = action ? G.track[action.space] : null;
  const activeShedChoice = G.shedChoices[0];
  const market = action?.type === 'resource' ? G.resources[currentActionSpace?.sourceIndex ?? -1] : action?.type === 'monk' ? G.monks[currentActionSpace?.sourceIndex ?? -1] : [];
  const selectedTile = market?.find(tile => tile.id === selectedTileId) ?? market?.[0];
  const canPlace = !isBotTurn && isViewingCurrent && !!action && ['resource', 'monk'].includes(action.type) && !!selectedTile;
  const executeGameAction = (kind: 'undoStep' | 'undoAction' | 'confirmAction') => {
    if (kind === 'undoStep') moves.undoStep();
    else if (kind === 'undoAction') moves.undoAction();
    else moves.confirmAction();
    if (kind !== 'confirmAction') { setSelectedTileId(null); setPrivilegeCardChoice(null); }
  };
  const requestGameAction = (kind: 'undoStep' | 'undoAction' | 'confirmAction') => {
    if (deferredGameActionRef.current) return;
    if (pieceFlights.length) {
      deferredGameActionRef.current = kind;
      setDeferredGameAction(kind);
      return;
    }
    executeGameAction(kind);
  };
  useEffect(() => {
    if (pieceFlights.length || !deferredGameActionRef.current) return;
    const kind = deferredGameActionRef.current;
    deferredGameActionRef.current = null;
    setDeferredGameAction(null);
    executeGameAction(kind);
  }, [pieceFlights.length, deferredGameAction]);
  const startPieceFlight = (kind: PieceFlight['kind'], sourceElement: HTMLElement | null, target: { left: number; top: number; width: number; height: number } | null, data: Partial<PieceFlight> = {}) => {
    if (!sourceElement || !target) return 0;
    const source = kind === 'tile' ? sourceElement.querySelector<HTMLElement>('.tile-image') || sourceElement : sourceElement;
    const sourceRect = source.getBoundingClientRect();
    if (sourceRect.width < 2 || sourceRect.height < 2 || target.width < 2 || target.height < 2) return 0;
    const size = kind === 'coin' ? 18 : 0;
    const from = size ? { left: sourceRect.left + sourceRect.width / 2 - size / 2, top: sourceRect.top + sourceRect.height / 2 - size / 2, width: size, height: size } : sourceRect;
    const scale = Math.min(target.width / from.width, target.height / from.height);
    const id = `${kind}-${Date.now()}-${Math.random()}`;
    const flight: PieceFlight = { id, kind, left: from.left, top: from.top, width: from.width, height: from.height, dx: target.left + target.width / 2 - (from.left + from.width / 2), dy: target.top + target.height / 2 - (from.top + from.height / 2), scale, started: false, ...data };
    setPieceFlights(current => [...current, flight]);
    requestAnimationFrame(() => requestAnimationFrame(() => setPieceFlights(current => current.map(item => item.id === id ? { ...item, started: true } : item))));
    const duration = kind === 'coin' ? 680 : 980, delay = data.delayMs ?? 0, total = duration + delay + 140;
    window.setTimeout(() => setPieceFlights(current => current.filter(item => item.id !== id)), total);
    return total;
  };
  const startPieceFlightFromRects = (kind: PieceFlight['kind'], from: { left: number; top: number; width: number; height: number }, target: { left: number; top: number; width: number; height: number }, data: Partial<PieceFlight> = {}) => {
    if (from.width < 2 || from.height < 2 || target.width < 2 || target.height < 2) return 0;
    const scale = Math.min(target.width / from.width, target.height / from.height);
    const id = `${kind}-${Date.now()}-${Math.random()}`;
    const flight: PieceFlight = { id, kind, left: from.left, top: from.top, width: from.width, height: from.height, dx: target.left + target.width / 2 - (from.left + from.width / 2), dy: target.top + target.height / 2 - (from.top + from.height / 2), scale, started: false, ...data };
    setPieceFlights(current => [...current, flight]);
    requestAnimationFrame(() => requestAnimationFrame(() => setPieceFlights(current => current.map(item => item.id === id ? { ...item, started: true } : item))));
    const duration = kind === 'coin' ? 680 : 980, delay = data.delayMs ?? 0, total = duration + delay + 140;
    window.setTimeout(() => setPieceFlights(current => current.filter(item => item.id !== id)), total);
    return total;
  };
  const animateMeepleMove = (playerIndex: number, targetTrackIndex?: number, targetStartSlot?: number) => {
    const player = G.players[playerIndex];
    if (!player || (player.position < 0 && player.startSlot === null)) return 0;
    const source = [...document.querySelectorAll<HTMLElement>('[data-player-index]')].find(element => Number(element.dataset.playerIndex) === playerIndex && (element.classList.contains('player-meeple') || element.classList.contains('start-player-figure')));
    const sourceRect = source?.getBoundingClientRect();
    let targetRect: { left: number; top: number; width: number; height: number } | undefined;
    if (targetTrackIndex !== undefined) {
      const cell = document.querySelector<HTMLElement>(`[data-track-index="${targetTrackIndex}"]`), rect = cell?.getBoundingClientRect();
      if (rect) { const width = sourceRect?.width ?? Math.max(18, Math.min(28, rect.width * .3)), height = sourceRect?.height ?? Math.max(34, Math.min(64, rect.height * .8)); targetRect = { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height }; }
    } else if (targetStartSlot !== undefined) {
      const slot = document.querySelector<HTMLElement>(`.start-slot.slot-${targetStartSlot}`), rect = slot?.getBoundingClientRect();
      if (rect) { const width = sourceRect?.width ?? rect.width * .32, height = sourceRect?.height ?? rect.height * .74; targetRect = { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height }; }
    }
    if (!source || !sourceRect || !targetRect) return 0;
    return startPieceFlight('meeple', source, targetRect, { playerIndex, playerName: player.name, playerColor: player.color, targetTrackIndex, targetStartSlot });
  };
  const markerSnapshotRef = React.useRef<any[] | null>(null);
  useLayoutEffect(() => {
    const current = G.players.map(player => ({ tracks: { ...player.tracks }, brewer: player.brewer, position: player.position, startSlot: player.startSlot }));
    const previous = markerSnapshotRef.current;
    markerSnapshotRef.current = current;
    if (!previous) return;
    for (let playerIndex = 0; playerIndex < current.length; playerIndex++) {
      if (playerIndex !== viewingPlayerIndex) continue;
      const old = previous[playerIndex], now = current[playerIndex];
      const board = document.querySelector<HTMLElement>(`.garden-board[data-player-board-index="${playerIndex}"]`), rect = board?.getBoundingClientRect();
      if (!rect) continue;
      const markerRect = (value: number, widthRatio: number, heightRatio: number) => {
        const point = productionTrackPositions[value]; if (!point) return null;
        const width = rect.width * widthRatio, height = rect.height * heightRatio;
        return { left: rect.left + rect.width * point.left / 100 - width / 2, top: rect.top + rect.height * point.top / 100 - height / 2, width, height };
      };
      resources.forEach(resource => {
        const from = markerRect(old.tracks[resource], .05, .075), to = markerRect(now.tracks[resource], .05, .075);
        if (from && to && old.tracks[resource] !== now.tracks[resource]) startPieceFlightFromRects('resource-marker', from, to, { playerIndex, resourceKey: resource });
      });
      const brewerFrom = markerRect(old.brewer, .088, .18), brewerTo = markerRect(now.brewer, .088, .18);
      if (brewerFrom && brewerTo && old.brewer !== now.brewer) startPieceFlightFromRects('brewer-marker', brewerFrom, brewerTo, { playerIndex, playerColor: G.players[playerIndex].color });
    }
  }, [state._stateID, viewingPlayerIndex]);
  const startCoinFlights = (origins: { element: HTMLElement | null; amount: number }[], target: HTMLElement | null) => {
    if (!target) return 0;
    const targetRect = target.getBoundingClientRect();
    let index = 0, total = 0;
    for (const origin of origins) for (let n = 0; n < origin.amount; n++) {
      const delayMs = index++ * 65;
      total = Math.max(total, startPieceFlight('coin', origin.element, targetRect, { delayMs }));
    }
    return total;
  };
  const moneyIcon = (playerIndex: number) => document.querySelector<HTMLElement>(`.player-info-unit[data-player-index="${playerIndex}"] .player-card .money .player-coin-icon`);
  const animatePrivilegePlacement = (playerIndex: number, card: string, pairIndex: number) => {
    const board = document.querySelector<HTMLElement>(`.garden-board[data-player-board-index="${playerIndex}"]`);
    const source = document.querySelector<HTMLImageElement>(`.privilege[data-privilege-card="${card}"] img`);
    if (!board || !source) return 0;
    const boardRect = board.getBoundingClientRect(), sourceRect = source.getBoundingClientRect(), position = privilegeCardPositions[pairIndex];
    if (sourceRect.width < 2 || sourceRect.height < 2) return 0;
    const height = boardRect.height * position.height / 100;
    const width = height * (source.naturalWidth / Math.max(1, source.naturalHeight));
    const left = boardRect.right - width * .18 - width;
    const top = boardRect.top + boardRect.height * position.top / 100 - height / 2;
    return startPieceFlight('privilege-card', source, { left, top, width, height }, { card, pairIndex, playerIndex });
  };
  const startTileFlight = (tile: Tile, index: number) => {
    const findTileElement = (selector: string, id: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(element => element.dataset.tileId === id || element.dataset.shopTileId === id);
    const source = findTileElement('[data-tile-id]', tile.id) || findTileElement('[data-shop-tile-id]', tile.id);
    const target = document.querySelector<HTMLElement>(`[data-garden-index="${index}"]`)?.getBoundingClientRect();
    return startPieceFlight('tile', source || null, target || null, { tile, targetIndex: index });
  };
  const animatePurchase = (tile: Tile, index: number, playerIndex: number, sourceIndex?: number) => {
    const tileTime = startTileFlight(tile, index);
    const boardSupplyTile = [...document.querySelectorAll<HTMLElement>('[data-tile-id]')].find(element => element.dataset.tileId === tile.id);
    const costTarget = boardSupplyTile?.querySelector<HTMLElement>('.tile-image') || boardSupplyTile || [...document.querySelectorAll<HTMLElement>('[data-shop-tile-cost]')].find(element => element.dataset.shopTileCost === tile.id) || null;
    const price = tileBaseCost(tile, sourceIndex) * (gardenCells[index]?.side === 'sun' ? 2 : 1);
    const coinTime = startCoinFlights([{ element: moneyIcon(playerIndex), amount: price }], costTarget);
    return Math.max(tileTime, coinTime);
  };
  const gardenNeighborIndices = (index: number) => {
    const spot = gardenCells[index];
    return gardenCells.flatMap((other, j) => {
      if (j === index || Math.abs(spot.row - other.row) > 1) return [];
      const dx = Math.abs(spot.x - other.x), dz = Math.abs(spot.z - other.z);
      return (dz < .05 && Math.abs(dx - 1.77) < .12) || (dz > 1.4 && dz < 1.65 && Math.abs(dx - .88) < .12) ? [j] : [];
    });
  };
  const animateActivationCoins = (player: any, playerIndex: number, cellIndices: number[]) => {
    const tracks = { ...player.tracks } as Record<Resource, number>;
    const origins: { element: HTMLElement | null; amount: number }[] = [];
    for (const cellIndex of cellIndices) {
      const cell = player.board[cellIndex], tile = cell?.tile;
      if (tile?.kind !== 'resource') continue;
      const resource = tile.resource as Resource;
      let amount = 0;
      if (cell.side === 'sun') {
        amount = Math.max(0, tracks[resource] + tile.value - 20);
        tracks[resource] = Math.min(20, tracks[resource] + tile.value);
      } else amount = tile.value;
      if (amount > 0) origins.push({ element: document.querySelector<HTMLElement>(`[data-garden-index="${cellIndex}"] .tile-image`), amount });
    }
    return startCoinFlights(origins, moneyIcon(playerIndex));
  };
  const scoreActivationCells = (player: any, category: string, option: string) => {
    if (category === 'A') return player.board.flatMap((cell: any, i: number) => cell.tile?.kind === 'resource' && cell.tile.value === Number(option) ? [i] : []);
    if (category === 'C') return player.board.flatMap((cell: any, i: number) => cell.tile?.resource === option ? [i] : []);
    return player.board.flatMap((cell: any, i: number) => cell.tile?.kind === 'monk' && cell.tile.monk === option ? gardenNeighborIndices(i).filter(j => !!player.board[j].tile) : []);
  };
  const animateStartSlotCoins = (playerIndex: number, slot: number) => slot === 1 ? startCoinFlights([{ element: document.querySelector<HTMLElement>(`.start-slot.slot-${slot}`), amount: 2 }], moneyIcon(playerIndex)) : 0;
  const animatePrivilegeCoins = (playerIndex: number, card: string, amount: number) => startCoinFlights([{ element: document.querySelector<HTMLElement>(`.privilege[data-privilege-card="${card}"] img`), amount }], moneyIcon(playerIndex));
  const animateTrackAdvanceCoins = (playerIndex: number, player: any, resource: Resource, steps: number) => {
    const amount = Math.max(0, player.tracks[resource] + steps - 20);
    const source = document.querySelector<HTMLElement>(`.production-marker[data-resource-key="${resource}"]`);
    return startCoinFlights([{ element: source, amount }], moneyIcon(playerIndex));
  };
  const startScoreFlight = (scoreIndex: number, sourceScoreIndex: number) => {
    const source = [...document.querySelectorAll<HTMLElement>('[data-score-source-index]')].find(element => element.dataset.scoreSourceIndex === String(sourceScoreIndex));
    const board = document.querySelector<HTMLElement>('.right-rail .garden-board')?.getBoundingClientRect();
    const point = scoringDiscPositions[scoreIndex];
    const targetSize = board ? board.width * .05 : 0;
    const target = board && point ? { left: board.left + board.width * point.left / 100 - targetSize / 2, top: board.top + board.height * point.top / 100 - targetSize / 2, width: targetSize, height: targetSize } : null;
    return startPieceFlight('disc', source || null, target, { scoreIndex });
  };
  const animateBarrels = (playerIndex: number) => {
    const player = G.players[playerIndex];
    const ids = availableBarrelIds(G, player);
    const strip = document.querySelector<HTMLElement>(`.player-info-unit[data-player-index="${playerIndex}"] .barrel-strip`);
    const stripRect = strip?.getBoundingClientRect();
    if (!stripRect) return 0;
    const currentCount = player.claimedBarrels.length;
    let duration = 0;
    ids.forEach((barrelId, index) => {
      const stock = G.barrels.find(barrel => barrel.id === barrelId);
      const sourceClass = stock?.remaining === 2 ? '.large-front' : '.small-alone';
      const source = document.querySelector<HTMLElement>(`[data-barrel-source-id="${barrelId}"] ${sourceClass}`);
      const itemLeft = stripRect.left + Math.max(0, Math.min(stripRect.width - 22, (currentCount + index) * 33 + 14));
      duration = Math.max(duration, startPieceFlight('barrel', source, { left: itemLeft, top: stripRect.top + stripRect.height / 2 - 14, width: 28, height: 28 }, { barrelId, barrelSize: stock?.remaining === 2 ? 'large' : 'small', playerIndex }));
    });
    return duration;
  };
  const animateBotTilePlacement = (tileId: string, index: number) => {
    const latest = (client as any).getState();
    const pending = latest?.G?.pending;
    if (!pending || !['resource', 'monk'].includes(pending.type)) return 0;
    const space = latest.G.track[pending.space];
    const market = pending.type === 'resource' ? latest.G.resources[space?.sourceIndex ?? -1] : latest.G.monks[space?.sourceIndex ?? -1];
    const tile = market?.find((item: Tile) => item.id === tileId);
    if (tile) return animatePurchase(tile, index, Number(latest.ctx.currentPlayer), space?.sourceIndex);
    return 0;
  };
  const animateBotMove = (decision: { name: string; args: unknown[] }, current: any) => {
    const playerIndex = Number(current.ctx.currentPlayer), player = current.G.players[playerIndex];
    if (decision.name === 'buyTile') return animateBotTilePlacement(String(decision.args[0]), Number(decision.args[1]));
    if (decision.name === 'takeScore') {
      const category = String(decision.args[0]), option = String(decision.args[1]);
      const index = category === 'A' ? 0 : category === 'C' ? 1 + resources.indexOf(option as Resource) : 6 + monkNames.indexOf(option);
      const discTime = startScoreFlight(index, current.G.track[current.G.pending?.space ?? -1]?.sourceIndex ?? -1);
      const coinTime = animateActivationCoins(player, playerIndex, scoreActivationCells(player, category, option));
      return Math.max(discTime, coinTime);
    }
    if (decision.name === 'completeShedChoice') return Math.max(1120, animateActivationCoins(player, playerIndex, current.G.shedChoices[0]?.selected ?? []));
    if (decision.name === 'chooseStartSlot') {
      const slot = Number(decision.args[0]);
      const moveTime = animateMeepleMove(playerIndex, undefined, slot);
      return Math.max(1120, moveTime, animateStartSlotCoins(playerIndex, slot));
    }
    if (decision.name === 'chooseStartResource') return Math.max(1120, animateTrackAdvanceCoins(playerIndex, player, decision.args[0] as Resource, 2));
    if (decision.name === 'choosePrivilege') {
      const card = String(decision.args[0]), pairIndex = current.G.privilegePrompts[0]?.pairIndex;
      const cardTime = card !== 'skip' && pairIndex !== undefined ? animatePrivilegePlacement(playerIndex, card, pairIndex) : 0;
      if ((card === 'A' || card === 'B') && decision.args[1]) {
        const resource = decision.args[1] as Resource;
        const steps = card === 'A' ? player.board.filter((cell: any) => cell.tile?.resource === resource).length : Number(player.scores.x !== undefined) + player.scores.resource.filter(Boolean).length + player.scores.monk.filter(Boolean).length;
        return Math.max(1120, cardTime, animateTrackAdvanceCoins(playerIndex, player, resource, steps));
      }
      if (card === 'D') return Math.max(cardTime, animatePrivilegeCoins(playerIndex, 'D', 12));
      if (card === 'E') return Math.max(1120, cardTime);
      return cardTime;
    }
    if (decision.name === 'moveTo') {
      const trackIndex = Number(decision.args[0]);
      const moveTime = animateMeepleMove(playerIndex, trackIndex);
      const barrelTime = current.G.track[trackIndex]?.type === 'barrel' ? animateBarrels(playerIndex) : 0;
      return Math.max(moveTime, barrelTime);
    }
    return 0;
  };
  const placeTile = (index: number) => {
    if (!selectedTile) return;
    animatePurchase(selectedTile, index, currentPlayerIndex, currentActionSpace?.sourceIndex);
    moves.buyTile(selectedTile.id, index); setSelectedTileId(null);
  };
  const startSlotTaken = (slot: number) => G.players.some(p => p.startSlot === slot);
  const lastToReturn = G.phase === 'play' && !!action && action.type === 'start' && G.players.every(p => p.retired || p === activePlayer);
  const forceFirstPlayerSlot = lastToReturn && !startSlotTaken(0);
  const canChooseStartSlot = (slot: number) => !isBotTurn && !G.startChoice && !startSlotTaken(slot) && (G.phase === 'setup' ? slot !== 0 && currentPlayer.startSlot === null : action?.type === 'start' && (!forceFirstPlayerSlot || slot === 0));
  const chooseStartSlot = (slot: number) => { animateMeepleMove(currentPlayerIndex, undefined, slot); animateStartSlotCoins(currentPlayerIndex, slot); moves.chooseStartSlot(slot); };
  const chooseStartResource = (resource: Resource) => { animateTrackAdvanceCoins(currentPlayerIndex, activePlayer, resource, 2); moves.chooseStartResource(resource); };
  const completeShedChoice = () => { if (activeShedChoice) animateActivationCoins(activePlayer, currentPlayerIndex, activeShedChoice.selected); moves.completeShedChoice(); };
  const currentScoreSpace = action ? G.track[action.space] : null;
  const privilegePrompt = G.privilegePrompts[0];
  const privilegeResources = privilegeCardChoice === 'A' ? resources.filter(resource => activePlayer.board.some(cell => cell.tile?.resource === resource)) : privilegeCardChoice === 'B' ? lowestResources(activePlayer) : [];
  const choosePrivilegeCard = (card: string | null) => {
    if (card === 'A') setPrivilegeCardChoice(card);
    else if (card === 'B') {
      const choices = lowestResources(activePlayer);
      if (choices.length === 1) {
        const pairIndex = privilegePrompt?.pairIndex;
        if (pairIndex !== undefined) animatePrivilegePlacement(currentPlayerIndex, card, pairIndex);
        const steps = Number(activePlayer.scores.x !== undefined) + activePlayer.scores.resource.filter(Boolean).length + activePlayer.scores.monk.filter(Boolean).length;
        animateTrackAdvanceCoins(currentPlayerIndex, activePlayer, choices[0], steps);
        moves.choosePrivilege(card, choices[0]); setPrivilegeCardChoice(null);
      }
      else setPrivilegeCardChoice(card);
    }
    else {
      if (card && card !== 'skip' && privilegePrompt) animatePrivilegePlacement(currentPlayerIndex, card, privilegePrompt.pairIndex);
      if (card === 'D') animatePrivilegeCoins(currentPlayerIndex, card, 12);
      moves.choosePrivilege(card); setPrivilegeCardChoice(null);
    }
  };
  const choosePrivilegeResource = (resource: Resource) => {
    const steps = privilegeCardChoice === 'A' ? activePlayer.board.filter((cell: any) => cell.tile?.resource === resource).length : Number(activePlayer.scores.x !== undefined) + activePlayer.scores.resource.filter(Boolean).length + activePlayer.scores.monk.filter(Boolean).length;
    if (privilegePrompt && privilegeCardChoice) animatePrivilegePlacement(currentPlayerIndex, privilegeCardChoice, privilegePrompt.pairIndex);
    animateTrackAdvanceCoins(currentPlayerIndex, activePlayer, resource, steps);
    moves.choosePrivilege(privilegeCardChoice, resource);
    setPrivilegeCardChoice(null);
  };
  const scoreCategories: ('A' | 'B' | 'C')[] = currentScoreSpace?.scoreType === 'ABC' ? ['A', 'B', 'C'] : currentScoreSpace?.scoreType ? [currentScoreSpace.scoreType] : [];
  const selectedScoreCategory = scoreCategories.includes(scoreCategory) ? scoreCategory : scoreCategories[0] || 'A';
  const scoreOptions = scoreChoices(activePlayer, selectedScoreCategory).map(String);
  const selectedScoreOption = scoreOptions.includes(scoreChoice) ? scoreChoice : scoreOptions[0];
  const placeScoreChoice = (category: 'A' | 'B' | 'C', choice: string) => {
    if (!scoreCategories.includes(category) || !scoreChoices(activePlayer, category).some(value => String(value) === choice)) return;
    const option = category === 'A' ? Number(choice) : choice;
    const scoreIndex = category === 'A' ? 0 : category === 'C' ? 1 + resources.indexOf(String(option) as Resource) : 6 + monkNames.indexOf(String(option));
    startScoreFlight(scoreIndex, currentScoreSpace?.sourceIndex ?? -1);
    animateActivationCoins(activePlayer, currentPlayerIndex, scoreActivationCells(activePlayer, category, String(option)));
    moves.takeScore(category, option);
  };
  const submitScore = () => selectedScoreOption && placeScoreChoice(selectedScoreCategory, selectedScoreOption);
  const scoreTargetIndices = action?.type === 'score' && isViewingCurrent ? [
    ...(scoreCategories.includes('A') && scoreChoices(activePlayer, 'A').length ? [0] : []),
    ...(scoreCategories.includes('C') ? resources.flatMap((resource, i) => scoreChoices(activePlayer, 'C').some(value => String(value) === resource) ? [i + 1] : []) : []),
    ...(scoreCategories.includes('B') ? monkNames.flatMap((monk, i) => scoreChoices(activePlayer, 'B').some(value => String(value) === monk) ? [i + 6] : []) : []),
  ] : [];
  const placeScoreFromBoard = (index: number) => {
    if (index === 0) {
      const choices = scoreChoices(activePlayer, 'A').map(String);
      const choice = selectedScoreCategory === 'A' && selectedScoreOption && choices.includes(selectedScoreOption) ? selectedScoreOption : choices[0];
      if (choice) placeScoreChoice('A', choice);
      return;
    }
    if (index >= 1 && index <= 5) placeScoreChoice('C', resources[index - 1]);
    else if (index >= 6 && index <= 9) placeScoreChoice('B', monkNames[index - 6]);
  };
  return <main className="table-screen">
    {isLocal && <BotController client={client} botSeats={botSeats} difficulty={botDifficulty} onThinking={setBotSearchStatus} onBeforeMove={animateBotMove} />}
    {remoteBotClients.map(({ client: botClient, seat }) => <OnlineBotDriver key={seat} client={botClient} seat={seat} name={`机器人${seat + 1}`} difficulty={remoteBotDifficulty} onThinking={setBotSearchStatus} onBeforeMove={animateBotMove} />)}
    {pieceFlights.map(flight => <div key={flight.id} className={`tile-flight ${flight.started ? 'is-moving' : ''} flight-${flight.kind} ${flight.kind === 'meeple' ? 'player-meeple' : flight.kind === 'resource-marker' ? 'production-marker' : flight.kind === 'brewer-marker' ? 'brewer-marker-art' : ''}`} aria-hidden="true" style={{ left: flight.left, top: flight.top, width: flight.width, height: flight.height, ['--tile-flight-x' as any]: `${flight.dx}px`, ['--tile-flight-y' as any]: `${flight.dy}px`, ['--tile-flight-scale' as any]: flight.scale, ['--flight-delay' as any]: `${flight.delayMs ?? 0}ms`, backgroundPosition: flight.kind === 'resource-marker' ? `${resources.indexOf(flight.resourceKey!) * 25}% center` : flight.kind === 'brewer-marker' || flight.kind === 'meeple' ? tokenSpritePosition(flight.playerColor || 'green') : undefined }}>{flight.kind === 'tile' && flight.tile ? <TileFace tile={flight.tile} /> : flight.kind === 'disc' ? <img src="/Images/scoring_disc.png" alt="" /> : flight.kind === 'coin' ? <i className="player-coin-icon" /> : flight.kind === 'barrel' ? <img src={`/Images/barrel_goal_${flight.barrelId}.png`} alt="" /> : flight.kind === 'privilege-card' ? <img src={`/Images/privilege_card_front_${flight.card}.png`} alt="" /> : null}</div>)}
    <header className="table-header"><div className="brand-mark small"><img src="/Images/ha-cover.png" alt="Heaven & Ale" /></div><div className="table-title"><b>天堂与美酒</b><small>{roomInfo}{roomCode && ` · 房间 ${roomCode}`}</small></div><div className="round-chip">第 {G.round} / {G.maxRounds} 轮</div><button className="icon-btn" onClick={() => setShowRules(true)}>规则</button><button className="icon-btn" onClick={onExit}>回到主页</button>{isLocal && <button className="icon-btn abandon-btn" onClick={() => setShowAbandonConfirm(true)}>放弃游戏</button>}</header>
    {G.phase === 'finished' && <div className="game-over-banner"><b>{gameover?.draw ? '平分，共享胜利：' : '获胜者：'}{winnerIds.map(id => G.players[Number(id)]?.name).filter(Boolean).join('、')}</b><span> · </span>{G.players.map((p, i) => <span key={i}>{p.name}：{gameover?.scores?.[i] ?? scoreBreakdown(p).total} 分{i < G.players.length - 1 ? '　' : ''}</span>)}</div>}
    <div className={`game-layout ${isBotTurn ? 'bot-thinking' : ''}`}>
      <section className="center-play"><div className="board-heading"><div><h2>主游戏版图</h2></div>{isBotTurn ? <span className="bot-thinking-pill"><i className="bot-thinking-dot" />{G.players[activeSeat]?.name} 正在思考</span> : <span className="board-tip"></span>}</div>
        <div className="main-board-wrap"><img src="/Images/main_board_clear.jpg" alt="天堂与美酒主版图" className="main-board-art" /><div className="track-overlay">
          {G.track.map((space, i) => {
            const occupants = G.players.filter(p => p.position === i); const here = canMove && i > currentPlayer.position; const stock = space.type === 'resource' ? G.resources[space.sourceIndex ?? -1] : space.type === 'monk' ? G.monks[space.sourceIndex ?? -1] : []; const supplySpace = space.type === 'resource' || space.type === 'monk'; const good = here && canMoveTo(G, currentPlayer, i); const x = (space.x / 1904) * 100, y = (space.y / 1176) * 100; return <button key={i} data-track-index={i} disabled={!good} onClick={() => trackMove(i)} style={{ left: `${x}%`, top: `${y}%` }} className={`track-space ${space.type} ${good ? 'available-space' : ''} ${currentPlayer.position === i ? 'current-space' : ''}`} title={`${i + 1} · ${space.label}`}>
              {space.type === 'score' ? <span className="space-score-discs">{Array.from({ length: G.scores[space.sourceIndex ?? -1] || 0 }, (_, disc) => <img key={disc} data-score-source-index={space.sourceIndex} src="/Images/scoring_disc.png" alt="紫色计分圆片" />)}</span> : supplySpace ? <span className="space-supply">{(stock || []).map(tile => <span key={tile.id} className="space-supply-tile" data-tile-id={tile.id}><TileFace tile={tile} /></span>)}</span> : <span>{space.type === 'barrel' ? '▣' : space.type === 'start' ? '⌂' : '✦'}</span>}
              {!supplySpace && space.type !== 'score' && <small>{space.label}</small>}
              {occupants.some(p => !pieceFlights.some(flight => flight.kind === 'meeple' && flight.playerIndex === G.players.indexOf(p) && flight.targetTrackIndex === i)) && <i className="occupants">{occupants.filter(p => !pieceFlights.some(flight => flight.kind === 'meeple' && flight.playerIndex === G.players.indexOf(p) && flight.targetTrackIndex === i)).map(p => <span key={p.color} role="img" className={`player-meeple ${G.players.indexOf(p) === currentPlayerIndex ? 'is-active-player' : ''}`} style={{ backgroundPosition: tokenSpritePosition(p.color) }} aria-label={p.name} data-player-name={p.name} data-player-index={G.players.indexOf(p)} title={`${p.name}${G.players.indexOf(p) === currentPlayerIndex ? ' · 正在行动' : ''}`} />)}</i>}
            </button>;
          })}
          {G.barrels.map(stock => { const pos = barrelTokenPositions[stock.id - 1], goalTitle = `目标 ${stock.id}：${barrelGoals[stock.id - 1]}`, claims = G.players.flatMap(p => p.claimedBarrels.filter(b => b.id === stock.id).map(b => ({ player: p, size: b.size }))); return <div data-barrel-source-id={stock.id} className={`barrel-goal-cell ${stock.remaining === 0 ? 'exhausted' : ''}`} key={`barrel-${stock.id}`} style={{ left: `${pos.left}%`, top: `${pos.top}%` }} title={goalTitle}>{stock.remaining === 2 ? <><img className="barrel-goal-token small-under" src={`/Images/barrel_goal_${stock.id}.png`} alt="" /><img className="barrel-goal-token large-front" src={`/Images/barrel_goal_${stock.id}.png`} alt={`酒桶成就 ${stock.id}`} /></> : stock.remaining === 1 ? <img className="barrel-goal-token small-alone" src={`/Images/barrel_goal_${stock.id}.png`} alt={`酒桶成就 ${stock.id}，小酒桶`} /> : <img className="barrel-goal-token exhausted-token" src={`/Images/barrel_goal_${stock.id}.png`} alt={`已领取的酒桶成就 ${stock.id}`} />}{claims.length > 0 && <div className="barrel-claim-badges">{claims.map(({ player, size }) => <span key={`${player.color}-${size}`} className={`barrel-claim-badge ${player.color}`} title={`${player.name} 已领取${size === 'large' ? '大酒桶（4分）' : '小酒桶（2分）'}`}><img src={`/Images/player_figure_${player.color}.png`} alt="" /><b>{size === 'large' ? '大' : '小'}</b></span>)}</div>}</div>; })}
          {startSlots.map((slot, i) => { const occupant = G.players.find(p => p.startSlot === i); const selectable = canChooseStartSlot(i); const flyingOut = occupant && pieceFlights.some(flight => flight.kind === 'meeple' && flight.playerIndex === G.players.indexOf(occupant) && flight.targetStartSlot === i); return <button key={`start-${i}`} disabled={!selectable} onClick={() => chooseStartSlot(i)} className={`start-slot slot-${i} ${occupant ? 'occupied' : ''} ${selectable ? 'selectable' : ''} ${forceFirstPlayerSlot && i === 0 ? 'forced' : ''}`} style={{ left: `${slot.x / 1904 * 100}%`, top: `${slot.y / 1176 * 100}%` }} aria-label={`${slot.label}：${slot.reward}`}><span className="start-slot-caption">{slot.label}<small>{slot.reward}</small></span>{occupant && !flyingOut && <span role="img" className="start-player-figure player-meeple" style={{ backgroundPosition: tokenSpritePosition(occupant.color) }} aria-label={occupant.name} data-player-name={occupant.name} data-player-index={G.players.indexOf(occupant)} />}</button>; })}
        </div></div>
        <div className="action-area">
          {G.phase === 'setup' && !G.startChoice && <div className="action-panel start-guide"><span className="eyebrow">STARTING POSITIONS</span><h3>逆时针选择起始奖励</h3><p>首位玩家（{G.players[G.startPlayer]?.name}）已在“首位玩家格”。现在轮到{currentPlayer.name}，请点击主板起始区域中的空位</p></div>}
          {G.startChoice && <div className="action-panel compact-panel"><span className="eyebrow">START BONUS</span><h3>选择推进的资源</h3><p className="panel-desc">将选中的资源标记向前推进2格；若已在第20格，每推进1个获得1个钱币</p><div className="score-picker">{resources.map(r => <button key={r} onClick={() => chooseStartResource(r)} style={{ borderColor: resourceColors[r] }}>{resourceLabels[r]}</button>)}</div></div>}
          {!action && !activeShedChoice && !G.confirmationKind && G.phase === 'play' && <div className="empty-action"><div className="action-glyph">✦</div><div><b>{currentPlayer.retired ? '本轮已结束' : `轮到 ${currentPlayer.name}`}</b><p>{currentPlayer.retired ? '等待仍在公共轨上行动的玩家。' : '沿公共轨向前移动，进入一个可使用的行动格；可以进入一个空起始格，结束本轮行动'}</p></div><span className="move-hint">{canMove ? '选择一个行动格' : '等待对手'}</span></div>}
          {action?.type === 'resource' || action?.type === 'monk' ? <div className="action-panel"><div className="panel-title"><div><span className="eyebrow">{action.type === 'resource' ? 'GARDEN GOODS' : 'BROTHERHOOD'}</span><h3>{action.type === 'resource' ? '选择资源板块' : '选择僧侣板块'}</h3></div><div className="cost-note">钱币足够时可连续购买多个</div></div><div className="purchase-flow"><div className="flow-step"><b>1</b><span>选择板块</span></div><div className="shop-row">{market?.map((tile: Tile) => <button key={tile.id} data-shop-tile-id={tile.id} className={`shop-tile ${tile.resource || 'monk-tile'} ${selectedTile?.id === tile.id ? 'selected' : ''}`} onClick={() => setSelectedTileId(tile.id)} disabled={market.length === 1}><TileFace tile={tile} /><small>{tile.kind === 'resource' ? resourceLabels[tile.resource!] : tile.monk}</small></button>)}</div><div className="flow-step"><b>2</b><span>{selectedTile ? '选择花园空格' : '先选板块'}</span></div><span className="selection-hint">{selectedTile ? '阳面价格为阴面的2倍。点击空格完成放置' : market?.length === 1 ? '唯一板块已自动选中。' : '选择板块后，花园会高亮所有当前可放置的位置。'}</span></div>{!activeShedChoice && <button className="btn btn-outline finish-purchase" disabled={(action.purchases ?? 0) < 1 || pieceFlights.length > 0} onClick={() => moves.finishPurchase()}>{(action.purchases ?? 0) < 1 ? '至少购买1个板块' : '结束购买并确认行动'}</button>}</div> : null}
          {action?.type === 'score' && <div className="action-panel compact-panel"><div className="panel-title"><div><span className="eyebrow">SCORING TOKEN</span><h3>将紫色圆片放到对应图标</h3></div></div><p className="panel-desc">每个玩家版图上的计分图标只能放置一次；A 激活指定产值板块，B 触发指定僧侣，C 激活指定资源</p>{currentScoreSpace?.scoreType === 'ABC' && <div className="score-picker score-category-picker">{scoreCategories.map(category => <button key={category} className={selectedScoreCategory === category ? 'selected' : ''} onClick={() => { setScoreCategory(category); setScoreChoice(''); }}>{category} 类</button>)}</div>}<div className="score-picker">{scoreOptions.map(option => <button key={option} className={selectedScoreOption === option ? 'selected' : ''} onClick={() => setScoreChoice(option)}>{selectedScoreCategory === 'A' ? `产值 ${option}` : selectedScoreCategory === 'C' ? resourceLabels[option as Resource] : <img className="score-monk-icon" src={`/Images/monk_tile_${String.fromCharCode(65 + monkNames.indexOf(option))}.png`} alt="僧侣图标" title="僧侣板块" />}</button>)}</div><button className="btn btn-gold" disabled={!selectedScoreOption} onClick={submitScore}>放置圆片<span>↗</span></button></div>}
          {privilegePrompt && <div className="action-panel compact-panel privilege-prompt"><span className="eyebrow">PRIVILEGE REWARD</span><h3>{`完成第 ${privilegePrompt.pairIndex + 1} 组计分标记`}</h3><p className="panel-desc">{'立即放置一张尚未弃置的特权卡到对应组右侧，或永久跳过。'}</p>{privilegePrompt.kind === 'pair' && <div className="privilege-pick-list">{activePlayer.privileges.filter((card: string) => card !== 'A' || activePlayer.board.some((cell: any) => !!cell.tile?.resource)).map((card: string) => <button key={card} onClick={() => choosePrivilegeCard(card)}><img src={`/Images/privilege_card_front_${card}.png`} alt={`特权卡 ${card}`} /><span>{card}{card === 'A' ? ' · 资源轨道' : card === 'B' ? ' · 最后资源推进' : card === 'C' ? ' · 酒桶终局 +1' : card === 'D' ? ' · +12钱币' : ' · 酿酒师 +5'}</span></button>)}<button className="skip-privilege" onClick={() => choosePrivilegeCard('skip')}>本组不放置<br /><small>之后不能补放</small></button></div>}{privilegeCardChoice === 'A' && <p className="panel-desc">只显示至少有 1 块对应资源板块的种类。</p>}{privilegeResources.length > 0 && <div className="score-picker privilege-resource-picker">{privilegeResources.map(resource => <button key={resource} onClick={() => choosePrivilegeResource(resource)} style={{ borderColor: resourceColors[resource] }}>{resourceLabels[resource]}</button>)}</div>}</div>}
          {!action && G.confirmationKind === 'turn' && G.log[0]?.includes('到达酒桶成就格') && <div className="action-panel compact-panel"><span className="eyebrow">CELLAR ACHIEVEMENTS</span><h3>酒桶成就已领取</h3><p className="panel-desc">{G.log[0]}</p></div>}
          {action?.type === 'start' && !G.startChoice && <div className="action-panel start-guide"><span className="eyebrow">RETURN TO START</span><h3>选择起始区域空位</h3><p>{forceFirstPlayerSlot ? '其他玩家都已返回，首位玩家格空置；你必须停在首位玩家格。' : '点击主板起始区域中任一空位，立即领取该格奖励并结束本轮。'}</p></div>}
          {activeShedChoice && <div className="action-panel shed-choice-panel"><span className="eyebrow">SHED BONUS</span><h3>棚屋奖励 · 周围产值 {activeShedChoice.value}</h3><p>酿酒师轨道 +{activeShedChoice.brewerAdvance} 格。请选择激活的相邻板块：{shedChoiceInstruction(activeShedChoice)}</p><div className="shed-choice-status">已选 {activeShedChoice.selected.length} / {activeShedChoice.activateCount} 块 · 点击花园中高亮的相邻板块</div><button className="btn btn-gold" disabled={!validShedSelection(activeShedChoice)} onClick={completeShedChoice}>完成棚屋激活选择</button></div>}
          {G.undoSnapshot && <div className="action-confirm-bar"><span>{G.confirmationKind ? '行动已完成，请确认或撤回。' : activeShedChoice ? '请选择棚屋奖励板块，或撤回整次行动。' : action?.type === 'resource' || action?.type === 'monk' ? '可继续购买；结束购买后可确认或撤回整次行动。' : '可以撤回当前选择，重新选行动格。'}</span>{G.stepUndoSnapshots?.length ? <button className="btn btn-undo" onClick={() => requestGameAction('undoStep')}>撤回上一步</button> : null}<button className="btn btn-undo" onClick={() => requestGameAction('undoAction')}>撤回整次行动</button>{G.confirmationKind && <button className="btn btn-gold btn-confirm" onClick={() => requestGameAction('confirmAction')}>确认行动</button>}</div>}
        </div>
      </section>
      <aside className={`right-rail ${!isViewingCurrent ? 'is-inspecting-opponent' : ''}`}><div className="garden-heading"><div><h2>{me.name}的修道院</h2>{!isViewingCurrent && <small className="inspection-hint">正在查看对手版图 · 只读</small>}</div><div className="garden-legend"></div></div><div className="garden-board-reserved"><Garden player={me} playerIndex={viewingPlayerIndex} pieceFlights={pieceFlights} selectedTile={isViewingCurrent && canPlace ? selectedTile : undefined} sourceIndex={currentActionSpace?.sourceIndex} coins={activePlayer.coins} canPlace={isViewingCurrent && canPlace} activePlayer={me} shedChoice={isViewingCurrent ? activeShedChoice : undefined} flightTileId={pieceFlights.find(flight => flight.kind === 'tile')?.tile?.id} flightTargetIndex={pieceFlights.find(flight => flight.kind === 'tile')?.targetIndex} flightScoreIndex={pieceFlights.find(flight => flight.kind === 'disc')?.scoreIndex} scoreTargetIndices={scoreTargetIndices} onScoreTarget={placeScoreFromBoard} onShedToggle={(i) => { if (isViewingCurrent) moves.toggleShedChoice(i); }} onSelect={(i) => { if (isViewingCurrent) placeTile(i); }} cells={garden} /></div><div className="rail-heading">特权卡 · 点击弃置可得3个钱币</div><div className="privileges">{['A', 'B', 'C', 'D', 'E'].filter(card => !me.privilegePairs.includes(card)).map(card => { const inHand = me.privileges.includes(card); const earned = me.privilegePairs.includes(card); const blocked = !isViewingCurrent || (!!G.confirmationKind && G.confirmationKind !== 'turn') || !!privilegePrompt; return <div className={`privilege ${inHand ? '' : 'used'}`} data-privilege-card={card} key={card}><img src={`/Images/privilege_card_front_${card}.png`} alt={`特权卡 ${card}`} />{inHand ? <button disabled={blocked} onClick={() => { animatePrivilegeCoins(currentPlayerIndex, card, 3); moves.discardPrivilege(card); }}>弃置 +3</button> : <span>{earned ? '已放置' : '已弃置'}</span>}</div>; })}</div><div className="rail-heading">已领取酒桶 <span className="count">{me.claimedBarrels.length}</span></div><div className="barrel-strip">{me.claimedBarrels.map((b, i) => <span key={`${b.id}-${i}`} className={`barrel-claimed-item ${b.size}`} style={{ visibility: pieceFlights.some(flight => flight.kind === 'barrel' && flight.playerIndex === viewingPlayerIndex && flight.barrelId === b.id && flight.barrelSize === b.size) ? 'hidden' : 'visible' }} title={`目标 ${b.id}：${barrelGoals[b.id - 1]} ${b.size === 'large' ? '大酒桶，4分' : '小酒桶，2分'}`}><img src={`/Images/barrel_goal_${b.id}.png`} alt={`目标 ${b.id}`} /><small>{b.size === 'large' ? '大 · 4分' : '小 · 2分'}</small></span>)}</div><div className="score-summary"><span>当前钱币</span><b><i className="player-coin-icon" aria-label="钱币" /> {me.coins}</b><span>酒桶计分</span><b>{me.claimedBarrels.reduce((n, b) => n + (b.size === 'large' ? 4 : 2), 0) + (me.privilegePairs.includes('C') ? me.claimedBarrels.length : 0)} 分</b></div></aside>
      <aside className="far-right-rail"><div className="rail-heading">玩家信息 · 点击查看版图</div><div className="player-roster">{G.players.map((p, i) => {
        const scoring = scoreBreakdown(p); return <div className={`player-info-unit ${i === viewingPlayerIndex ? 'is-viewing' : ''}`} data-player-index={i} key={i} role="button" tabIndex={0} aria-label={`查看${p.name}的玩家版图`} onClick={() => setViewingPlayerIndex(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewingPlayerIndex(i); } }}>
          <div className={`player-card ${i === Number(ctx.currentPlayer) ? 'is-turn' : ''} ${p.retired ? 'is-done' : ''}`}><div className={`avatar ${p.color}`}>{p.name.slice(-1)}</div><div className="player-name"><span className="player-name-score">{p.name}<b title="实时计分">★ {scoring.total}</b></span><small>{botSeats.includes(i) ? `${botDifficulty === 'expert' ? '专家' : '普通'}机器人${i === Number(ctx.currentPlayer) ? botSearchStatus?.playerID === i ? ` · 搜索中 ${botSearchStatus.iterations} 次` : ' · 正在行动' : ''}` : p.retired ? '本轮已休息' : i === Number(ctx.currentPlayer) ? '正在行动' : '等待中'}</small></div><div className="money"><i className="player-coin-icon" aria-label="钱币" /> {p.coins}</div></div>
          <div className="player-live-details" title={`按当前状态预演终局：资源归并后最低为 ${scoring.minResource}，生产 ${scoring.productionScore} 分；酒桶 ${scoring.barrelScore} 分；起始奖励 ${scoring.startBonus} 分。`}>
            <div className="player-info-table">
              <div className="player-info-row resource-icon-row">{resources.map(resource => <span key={resource} className="resource-stat" title={`${resourceLabels[resource]}：${p.tracks[resource]}`}><img className="player-board-resource" src={`/Images/resource_icon_${resource}.png`} alt="" /><b>{p.tracks[resource]}</b></span>)}</div>
              <div className="player-info-row player-metric-combined-row">
                <span title={`酿酒师：${p.brewer}`}><i className="player-info-brewer" style={{ backgroundPosition: tokenSpritePosition(p.color) }} /><b>{p.brewer}</b></span>
                <span title={`资源交换比：${scoring.exchangeRate}:1`}><b className="exchange-ratio-value">{scoring.exchangeRate}:1</b></span>
                <span title={`胜利点数：${scoring.victoryPoints}`}><i className="player-info-beer" role="img" aria-label="啤酒" /><b>x{scoring.victoryPoints}</b></span>
                <span title={`交换后最少资源：${scoring.minResource}`}><b className="base-value">{scoring.minResource}</b></span>
                <span title={`酒桶分数：${scoring.barrelScore}`}><i className="player-info-barrel" role="img" aria-label="酒桶" /><b>{scoring.barrelScore}</b></span>
              </div>
            </div>
          </div>
        </div>;
      })}</div><div className="rail-heading log-heading">行动日志</div><div className="log-list">{G.log.slice(0, 80).reverse().map((line, i) => <p key={i} className={line.startsWith('[[TURN:') ? 'log-turn-divider' : ''}>{renderLog(line, G.players)}</p>)}</div></aside>
    </div>
    {showRules && <div className="modal-backdrop" onClick={() => setShowRules(false)}><div className="rules-modal" onClick={e => e.stopPropagation()}><button className="close-modal" onClick={() => setShowRules(false)}>×</button><span className="eyebrow">HOW TO PLAY</span><h2>修道院经营要点</h2><p>每回合沿公共轨道向前移动，并执行落点行动。购买资源与僧侣板块后，将它们放入花园的向阳或阴凉空格。</p><ul><li>阴凉板块按面值购买；资源激活时获得钱币。</li><li>向阳板块花费双倍；资源激活时推进对应生产轨道。</li><li>计分行动会激活对应产值、资源或僧侣，帮助提升最终分数。</li><li>返回起点领取奖励，本轮休息；所有人都返回后开始新一轮。</li></ul><p className="fine-print">线上联机需要先启动项目内的 boardgame.io 服务端。各回合在玩家设备上依次进行。</p></div></div>}
    {showAbandonConfirm && <div className="modal-backdrop" onClick={() => setShowAbandonConfirm(false)}><div className="rules-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="abandon-title" onClick={e => e.stopPropagation()}><button className="close-modal" onClick={() => setShowAbandonConfirm(false)}>×</button><span className="eyebrow">ABANDON GAME</span><h2 id="abandon-title">放弃当前对局？</h2><p>放弃后会删除本地存档，无法继续这场对局。</p><div className="confirm-actions"><button className="btn btn-outline" onClick={() => setShowAbandonConfirm(false)}>继续游戏</button><button className="btn btn-danger" onClick={onAbandon}>确认放弃</button></div></div></div>}
    {toast && <div className="toast" onClick={() => setToast('')}>{toast} <span>×</span></div>}
  </main>;
}

function OnlineBotDriver({ client, seat, name, difficulty, onThinking, onBeforeMove }: { client: AnyClient; seat: number; name: string; difficulty: BotDifficulty; onThinking: (status: { playerID: number; iterations: number } | null) => void; onBeforeMove: (decision: { name: string; args: unknown[] }, current: any) => number }) {
  useEffect(() => {
    const syncName = (state: any) => {
      if (Number(state?.ctx?.currentPlayer) === seat && state?.G?.players?.[seat]?.name !== name) (client as any).moves.setPlayerName?.(name);
    };
    const unsubscribe = (client as any).subscribe(syncName);
    syncName((client as any).getState());
    return unsubscribe;
  }, [client, seat, name]);
  return <BotController client={client} botSeats={[seat]} difficulty={difficulty} onThinking={onThinking} onBeforeMove={onBeforeMove} />;
}

function BotController({ client, botSeats, difficulty, onThinking, onBeforeMove }: { client: AnyClient; botSeats: number[]; difficulty: BotDifficulty; onThinking: (status: { playerID: number; iterations: number } | null) => void; onBeforeMove: (decision: { name: string; args: unknown[] }, current: any) => number }) {
  const onBeforeMoveRef = React.useRef(onBeforeMove);
  useEffect(() => { onBeforeMoveRef.current = onBeforeMove; }, [onBeforeMove]);
  useEffect(() => {
    if (!botSeats.length) return;
    let timer: number | undefined;
    let worker: Worker | undefined;
    let requestID = 0;
    let animationLockUntil = 0;
    const onState = (state: any) => {
      requestID++;
      const request = requestID;
      if (timer !== undefined) window.clearTimeout(timer);
      worker?.terminate(); worker = undefined;
      const playerID = Number(state?.ctx?.currentPlayer);
      if (!state || state.G.phase === 'finished' || !botSeats.includes(playerID)) { onThinking(null); return; }
      onThinking({ playerID, iterations: 0 });
      const waitForAnimation = Math.max(100, animationLockUntil - Date.now() + 30);
      timer = window.setTimeout(() => {
        const current = (client as any).getState();
        if (!current || current._stateID !== state._stateID) return;
        const finish = (decision: ReturnType<typeof chooseBotMove>) => {
          if (request !== requestID) return;
          worker?.terminate(); worker = undefined;
          onThinking(null);
          const latest = (client as any).getState();
          if (latest?._stateID !== current._stateID || latest.ctx.currentPlayer !== current.ctx.currentPlayer) return;
          if (decision) {
            const animationTime = onBeforeMoveRef.current(decision, current);
            if (animationTime > 0) animationLockUntil = Math.max(animationLockUntil, Date.now() + animationTime + BOT_AFTER_ANIMATION_PAUSE_MS);
            (client as any).moves[decision.name]?.(...decision.args);
          }
        };
        worker = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = event => {
          if (event.data.requestID !== request) return;
          if (typeof event.data.progress === 'number') { onThinking({ playerID, iterations: event.data.progress }); return; }
          if (event.data.error) console.error('MCTS 搜索失败', event.data.error);
          finish(event.data.move ?? chooseBotMove(current.G, current.ctx.currentPlayer, difficulty));
        };
        worker.onerror = error => {
          console.error('MCTS 后台线程失败', error);
          finish(chooseBotMove(current.G, current.ctx.currentPlayer, difficulty));
        };
        worker.postMessage({
          requestID: request, difficulty, state: {
            G: current.G, ctx: current.ctx, plugins: current.plugins,
            _stateID: current._stateID, _undo: [], _redo: [], deltalog: [],
          }
        });
      }, waitForAnimation);
    };
  const unsubscribe = client.subscribe(onState);
    return () => {
      requestID++;
      if (timer !== undefined) window.clearTimeout(timer);
      worker?.terminate();
      onThinking(null);
      unsubscribe();
    };
  }, [client, botSeats, difficulty, onThinking]);
  return null;
}

function TileFace({ tile }: { tile: Tile }) {
  return tile.resource ? <div className="tile-image resource-face"><img src={`/Images/${tile.resource}_${tile.value}.png`} alt="" /></div> : <div className="tile-image monk-face"><img src={`/Images/monk_tile_${['A', 'B', 'C', 'D'][Math.max(0, ['僧侣A', '僧侣B', '僧侣C', '僧侣D'].indexOf(tile.monk || ''))]}.png`} alt="" /></div>;
}
function renderLog(line: string, players: AleState['players']) {
  const turn = line.match(/^\[\[TURN:(\d+):(\d+)\]\]$/);
  if (turn) return `第 ${turn[1]} 轮 · 第 ${turn[2]} 回合`;
  const colors: Record<string, string> = { green: '#a4d58b', red: '#f29785', blue: '#91c8f0', yellow: '#f1d77b', orange: '#f5b274', purple: '#c9a1ed', black: '#c6cbd0' };
  return line.split(/(\[\[MONK:[A-D]\]\])/g).map((part, index) => {
    const code = part.match(/^\[\[MONK:([A-D])\]\]$/)?.[1];
    if (code) return <img key={index} className="log-monk-icon" src={`/Images/monk_tile_${code}.png`} alt="僧侣图标" title="僧侣板块" />;
    const nodes: React.ReactNode[] = [];
    let offset = 0;
    while (offset < part.length) {
      const matches = players.filter(p => p.name).map(p => ({ p, at: part.indexOf(p.name, offset) })).filter(m => m.at >= 0).sort((a, b) => a.at - b.at || b.p.name.length - a.p.name.length);
      const match = matches[0];
      if (!match) { nodes.push(part.slice(offset)); break; }
      nodes.push(part.slice(offset, match.at), <strong key={match.at} style={{ color: colors[match.p.color] || '#e5d3a5' }}>{match.p.name}</strong>);
      offset = match.at + match.p.name.length;
    }
    return <React.Fragment key={index}>{nodes}</React.Fragment>;
  });
}
function markerClusterOffset(index: number, count: number): [number, number] {
  const layouts: Record<number, [number, number][]> = {
    2: [[-.9, 0], [.9, 0]],
    3: [[-.95, -.7], [.95, -.7], [0, .85]],
    4: [[-.95, -.7], [.95, -.7], [-.95, .85], [.95, .85]],
    5: [[-1, -.7], [0, -.7], [1, -.7], [-.55, .85], [.55, .85]],
  };
  return (layouts[count] || [[0, 0]])[index] || [0, 0];
}
function Garden({ player, playerIndex, pieceFlights, activePlayer, selectedTile, sourceIndex, coins, canPlace, shedChoice, flightTileId, flightTargetIndex, flightScoreIndex, scoreTargetIndices, onScoreTarget, onShedToggle, onSelect, cells }: { player: any; playerIndex: number; pieceFlights: PieceFlight[]; activePlayer: any; selectedTile?: Tile; sourceIndex?: number; coins: number; canPlace: boolean; shedChoice?: ShedChoice; flightTileId?: string; flightTargetIndex?: number; flightScoreIndex?: number; scoreTargetIndices: number[]; onScoreTarget: (index: number) => void; onShedToggle: (n: number) => void; onSelect: (n: number) => void; cells: typeof gardenCells }) {
  const markers = [...resources.map(resource => ({ key: resource, label: resourceLabels[resource], value: player.tracks[resource], color: resourceColors[resource] })), { key: 'brewer', label: '酿酒师', value: player.brewer, color: '#eee4c8' }];
  const markerGroups = new Map<number, typeof markers>();
  markers.forEach(marker => markerGroups.set(marker.value, [...(markerGroups.get(marker.value) || []), marker]));
  const boardExtension = ['black', 'yellow', 'blue', 'red'].includes(player.color) ? 'jpg' : 'png';
  return <div className={`garden-board ${canPlace ? 'placement-active' : ''} ${shedChoice ? 'shed-choice-active' : ''}`} data-player-board-index={playerIndex} style={{ backgroundImage: `url('/Images/board_${player.color}.${boardExtension}')` }}>{cells.map((g, i) => {
    const cell = player.board[i], tile = cell?.tile as Tile | undefined, point = playerBoardPercent(g.x, g.z);
    const empty = !g.hut && !activePlayer.board[i]?.tile;
    const cost = selectedTile && g.side ? tileBaseCost(selectedTile, sourceIndex) * (g.side === 'sun' ? 2 : 1) : Infinity;
    const eligible = canPlace && empty && !!selectedTile && !!g.side && cost <= coins;
    const hiddenCandidate = canPlace && empty && !eligible;
    const shedCandidate = !!shedChoice?.candidates.includes(i);
    const shedTarget = shedCandidate && canSelectShedCell(shedChoice!, i);
    const shedUnavailable = shedCandidate && !shedTarget, shedSelected = !!shedChoice?.selected.includes(i);
    const shedProgress = g.hut ? shedProductionProgress(activePlayer.board, i) : null;
    const hasShedYield = !!shedProgress && !cell?.completed && shedProgress.filled > 0;
    const shownShedYield = cell?.shedValue ?? shedProgress?.value ?? 0;
    const title = shedCandidate ? `${tile?.resource ? resourceLabels[tile.resource] : tile?.monk} · 棚屋奖励候选板块${shedSelected ? ' · 已选择' : shedUnavailable ? ' · 当前组合不符合规则' : ''}` : g.hut ? cell?.completed ? `已完成棚屋 · 产值 ${shedProgress?.value ?? 0} · 类型 ${cell.shedType}` : `棚屋位置：已放板块产值 ${shedProgress?.value ?? 0}（${shedProgress?.filled ?? 0}/6）` : `${g.row + 1} 行 · ${g.side === 'sun' ? '向阳' : '阴凉'}${eligible ? ` · ${cost}个钱币 · 点击放置` : ''}`;
    return <button key={i} data-garden-index={i} onClick={() => shedTarget ? onShedToggle(i) : eligible && onSelect(i)} disabled={!eligible && !shedTarget} className={`garden-cell ${g.side || ''} ${g.hut ? 'hut-cell' : ''} ${eligible ? 'eligible' : ''} ${hiddenCandidate ? 'hidden-candidate' : ''} ${tile ? 'filled' : ''} ${cell?.completed ? 'completed' : ''} ${shedTarget ? 'shed-target' : ''} ${shedUnavailable ? 'shed-unavailable' : ''} ${shedSelected ? 'shed-selected' : ''}`} style={{ left: `${point.left}%`, top: `${point.top}%` }} title={title}>{g.hut ? <>{cell?.completed && <img className="shed-image" src={`/Images/shed_tile_${cell.shedType}.png`} alt="棚屋奖励" />}{hasShedYield && <span className="hut-yield-badge" aria-label={`棚屋周围产值 ${shownShedYield}`}>{shownShedYield}</span>}</> : tile ? (flightTargetIndex === i && tile.id === flightTileId ? null : <TileFace tile={tile} />) : <span className="plus">{eligible ? `${cost}` : ''}</span>}{shedSelected && <span className="shed-check" aria-label="已选择激活">✓</span>}</button>;
  })}{markers.map(marker => {
    const pos = productionTrackPositions[marker.value]; if (!pos) return null;
    const group = markerGroups.get(marker.value)!, offset = markerClusterOffset(group.indexOf(marker), group.length);
    const markerFlying = pieceFlights.some(flight => flight.playerIndex === playerIndex && (marker.key === 'brewer' ? flight.kind === 'brewer-marker' : flight.kind === 'resource-marker' && flight.resourceKey === marker.key));
    if (markerFlying) return null;
    return marker.key === 'brewer' ? <span key={marker.key} role="img" className="brewer-marker-art" style={{ left: `${pos.left + offset[0]}%`, top: `${pos.top + offset[1]}%`, zIndex: 9, backgroundPosition: tokenSpritePosition(player.color) }} title={`${marker.label}：${marker.value}`} aria-label="酿酒师标记" data-marker-label={`${marker.label} · ${marker.value}`} /> : <span key={marker.key} className="production-marker" data-resource-key={marker.key} style={{ left: `${pos.left + offset[0]}%`, top: `${pos.top + offset[1]}%`, zIndex: 10 + group.indexOf(marker), backgroundPosition: `${resources.indexOf(marker.key as Resource) * 25}% center` }} title={`${marker.label}：${marker.value}`} aria-label={`${marker.label} ${marker.value}`} data-marker-label={marker.label} />;
  })}{player.scores.x !== undefined && flightScoreIndex !== 0 && <ScoreDisc index={0} label="A 类计分" />}{player.scores.resource.map((resource: Resource | null) => { const index = resource ? 1 + resources.indexOf(resource) : -1; return resource && flightScoreIndex !== index && <ScoreDisc key={`resource-${resource}`} index={index} label={`C 类 · ${resourceLabels[resource]}`} />; })}{player.scores.monk.map((used: boolean, i: number) => used && flightScoreIndex !== 6 + i && <ScoreDisc key={`monk-${i}`} index={6 + i} label="B 类 · 僧侣图标" />)}{player.privilegePairs.map((card: string | null, i: number) => card && card !== 'skip' && !pieceFlights.some(flight => flight.kind === 'privilege-card' && flight.playerIndex === playerIndex && flight.pairIndex === i) && <img key={`privilege-${i}`} className="board-privilege-card" src={`/Images/privilege_card_front_${card}.png`} style={{ left: `${privilegeCardPositions[i].left}%`, top: `${privilegeCardPositions[i].top}%`, height: `${privilegeCardPositions[i].height}%` }} title={`第 ${i + 1} 组：特权卡 ${card}`} alt={`第 ${i + 1} 组特权卡 ${card}`} />)}{scoreTargetIndices.map(index => { const point = scoringDiscPositions[index], isMonk = index >= 6, label = index === 0 ? 'A 类' : index <= 5 ? resourceLabels[resources[index - 1]] : '僧侣图标'; return <button key={`score-target-${index}`} type="button" className={`score-disc-target ${isMonk ? 'monk' : 'hex'}`} data-score-target-index={index} style={{ left: `${point.left}%`, top: `${point.top}%` }} title={`点击放置${label}计分圆片`} aria-label={`点击放置${label}计分圆片`} onClick={() => onScoreTarget(index)} />; })}</div>;
}
function ScoreDisc({ index, label }: { index: number; label: string }) {
  const point = scoringDiscPositions[index];
  return <img className="player-score-disc" src="/Images/scoring_disc.png" style={{ left: `${point.left}%`, top: `${point.top}%` }} title={label} aria-label={label} alt="紫色计分圆片" />;
}
function shedChoiceInstruction(choice: ShedChoice) {
  if (choice.mode === 'one') return '任选 1 块';
  if (choice.mode === 'opposite') return '点选一块，自动勾选其对角板块';
  if (choice.mode === 'nonAdjacent') return '选择 3 块互不相邻的板块，非法位置会禁用';
  return '任选 4 块';
}
createRoot(document.getElementById('root')!).render(<App />);
