import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { HeavenAle, availableBarrelIds, barrelGoals, barrelTokenPositions, canBuyFrom, canMoveTo, canScore, canSelectShedCell, canTakeExpansionCargo, gardenCells, lowestResources, monkNames, playerBoardPercent, playerColors, privilegeCardPositions, productionTrackPositions, resourceColors, resourceLabels, resources, scoreBreakdown, scoreChoices, scoringDiscPositions, shedProductionProgress, startSlots, tileBaseCost, validShedSelection, type AleState, type Resource, type ShedChoice, type Tile } from './game';
import { chooseBotMove, type BotDifficulty } from './bot';
import { BUILT_IN_STORAGE_SLOTS, UNLOCKABLE_STORAGE_SLOTS, cartRoute, emptyExpansionStorageSlots, ensureExpansionStorageLayout, storedCargoCount, validCartLoadChoices, type ExpansionCargo, type ExpansionPlayerBoard, type StorageExtension } from './expansion';
import './style.css';
import './garden-layout.css';
import './readable-text.css';

type AnyClient = ReturnType<typeof Client>;
type MotionPoint = { x: number; y: number };
type MovementTrail = { id: string; kind: PieceFlight['kind']; playerIndex?: number; resourceKey?: Resource; pathPoints: MotionPoint[]; durationMs: number; started: boolean; scrollX: number; scrollY: number };
type PieceFlight = { id: string; kind: 'tile' | 'disc' | 'barrel' | 'coin' | 'meeple' | 'resource-marker' | 'brewer-marker' | 'privilege-card' | 'store-card' | 'expansion-cargo' | 'cart' | 'die'; tile?: Tile; card?: string; storeId?: number; pairIndex?: number; sourceIndex?: number; targetIndex?: number; scoreIndex?: number; targetTrackIndex?: number; targetStartSlot?: number; targetRouteIndex?: number; sourceStorageIndex?: number; targetStorageIndex?: number; sourceTemporaryStorage?: boolean; targetTemporaryStorage?: boolean; cargoKind?: ExpansionCargo; cargoCount?: number; dieValue?: number; playerColor?: string; playerName?: string; resourceKey?: Resource; playerIndex?: number; barrelId?: number; barrelSize?: 'large' | 'small'; left: number; top: number; width: number; height: number; dx: number; dy: number; scale: number; delayMs?: number; durationMs?: number; pathPoints?: MotionPoint[]; started: boolean };
function smoothMotionPath(points: MotionPoint[]) {
  if (!points.length) return '';
  let smoothPoints = points.map(point => ({ ...point }));
  // Coordinates come from board artwork and can be a little uneven. Smooth
  // intermediate waypoints while pinning the true start and destination.
  for (let pass = 0; pass < 2 && smoothPoints.length > 2; pass++) {
    const current = smoothPoints;
    smoothPoints = current.map((point, index) => {
      if (index === 0 || index === current.length - 1) return point;
      const previous = current[index - 1], next = current[index + 1];
      return { x: previous.x * .2 + point.x * .6 + next.x * .2, y: previous.y * .2 + point.y * .6 + next.y * .2 };
    });
  }
  let path = `M ${smoothPoints[0].x.toFixed(1)} ${smoothPoints[0].y.toFixed(1)}`;
  if (smoothPoints.length === 2) return `${path} L ${smoothPoints[1].x.toFixed(1)} ${smoothPoints[1].y.toFixed(1)}`;
  for (let index = 0; index < smoothPoints.length - 1; index++) {
    const previous = smoothPoints[Math.max(0, index - 1)];
    const start = smoothPoints[index];
    const end = smoothPoints[index + 1];
    const next = smoothPoints[Math.min(smoothPoints.length - 1, index + 2)];
    const control1 = { x: start.x + (end.x - previous.x) / 6, y: start.y + (end.y - previous.y) / 6 };
    const control2 = { x: end.x - (next.x - start.x) / 6, y: end.y - (next.y - start.y) / 6 };
    path += ` C ${control1.x.toFixed(1)} ${control1.y.toFixed(1)}, ${control2.x.toFixed(1)} ${control2.y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
  }
  return path;
}
function movementTrailKey(kind: PieceFlight['kind'], playerIndex?: number, resourceKey?: Resource) {
  return kind === 'resource-marker' ? `${kind}:${playerIndex}:${resourceKey}` : `${kind}:${playerIndex}`;
}
const gameName = 'heaven-and-ale';
const BOT_AFTER_ANIMATION_PAUSE_MS = 500;
const meepleSpriteColorIndex: Record<string, number> = { black: 0, yellow: 1, blue: 2, red: 3 };
const meepleSpritePosition = (color: string) => `${(meepleSpriteColorIndex[color] ?? 0) * (100 / 3)}% center`;
const trackMarkerColorIndex: Record<Resource, number> = { wood: 2, yeast: 5, hops: 0, water: 1, barley: 6 };
const trackMarkerSpritePosition = (resource: Resource) => `${trackMarkerColorIndex[resource] * (100 / 9)}% center`;
function liveScoreTitle(player: AleState['players'][number], scoring: ReturnType<typeof scoreBreakdown>, expansionBoard?: ExpansionPlayerBoard) {
  const largeBarrels = player.claimedBarrels.filter(barrel => barrel.size === 'large').length;
  const smallBarrels = player.claimedBarrels.length - largeBarrels;
  const barrelBaseScore = largeBarrels * 4 + smallBarrels * 2;
  const privilegeBarrelBonus = player.privilegePairs.includes('C') ? player.claimedBarrels.length : 0;
  const lines = [
    '实时计分（按当前状态预演终局）',
    `生产：归并后最低资源格 ${scoring.minResource} × 酿酒师胜利倍率 ${scoring.victoryPoints} = ${scoring.productionScore} 分${resources.some(resource => scoring.tracks[resource] < 1) ? '（有资源未到达 1 格，因此生产分为 0）' : ''}`,
    `酒桶：大酒桶 ${largeBarrels} × 4 + 小酒桶 ${smallBarrels} × 2 = ${barrelBaseScore} 分${privilegeBarrelBonus ? `；酒桶特权卡 +${privilegeBarrelBonus} 分` : ''}，共 ${scoring.barrelScore} 分`,
  ];
  if (expansionBoard) {
    const deliveries = expansionBoard.breweryDeliveries.reduce((sum, count, index) => sum + count * expansionBoard.breweryScores[index], 0);
    const storedBarrels = storedCargoCount(expansionBoard, 'barrel');
    const cartBarrelValue = cartRoute[expansionBoard.cartPosition]?.score ?? 0;
    lines.push(`扩展得分：酒馆交付 ${deliveries} 分 + 存储桶装酒 ${storedBarrels} × 0.5 + 马车 ${expansionBoard.cartBarrels} × 地点分 ${cartBarrelValue} = ${scoring.expansionBarrelScore} 分`);
  }
  lines.push(`起始玩家奖励：${scoring.startBonus} 分`, `合计：${scoring.total} 分`);
  return lines.join('\n');
}
function GameOverScoreModal({ game, gameover, winnerNames, onExit, onClose }: { game: AleState; gameover: any; winnerNames: string[]; onExit: () => void; onClose: () => void }) {
  const players = game.players.map((player, index) => {
    const expansion = game.expansionEnabled ? game.expansion?.players[index] : undefined;
    return { player, expansion, scoring: scoreBreakdown(player, expansion) };
  });
  const fmt = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
  const icon = (kind: string, badge?: string) => <span className={`score-sheet-icon ${kind}`} aria-hidden="true">{badge && <b>{badge}</b>}</span>;
  const row = (label: string, symbol: React.ReactNode, values: string[], className = '') => ({ label, symbol, values, className });
  const rows = [
    row('基数', icon('resource'), players.map(({ scoring }) => fmt(scoring.minResource))),
    row('倍率', icon('brewer'), players.map(({ scoring }) => `×${scoring.victoryPoints}`)),
    row('酿造', icon('beer'), players.map(({ scoring }) => `${fmt(scoring.productionScore)}`), 'score-row-highlight'),
    row('大桶', icon('barrel', '4'), players.map(({ player }) => { const count = player.claimedBarrels.filter(barrel => barrel.size === 'large').length; return `${count} × 4 = ${count * 4}`; })),
    row('小桶', icon('barrel small', '2'), players.map(({ player }) => { const count = player.claimedBarrels.filter(barrel => barrel.size === 'small').length; return `${count} × 2 = ${count * 2}`; })),
    row('桶特权', <img className="score-sheet-icon privilege" src="/Images/privilege_card_front_C.png" alt="" />, players.map(({ player }) => player.privilegePairs.includes('C') ? `+${player.claimedBarrels.length}` : '—')),
    row('先手', icon('first-player', '+1'), players.map(({ player }) => player.startSlot === 0 ? '+1' : '—')),
  ];
  if (game.expansionEnabled) {
    rows.push(
      row('交付', icon('barrel'), players.map(({ expansion }) => expansion ? fmt(expansion.breweryDeliveries.reduce((sum, count, index) => sum + count * expansion.breweryScores[index], 0)) : '0'), 'score-expansion-row'),
      row('马车', icon('cart'), players.map(({ expansion }) => { if (!expansion) return '0'; const count = expansion.cartBarrels, locationScore = cartRoute[expansion.cartPosition]?.score ?? 0; return `${count} × ${locationScore} = ${count * locationScore}`; }), 'score-expansion-row'),
      row('存储', icon('storage'), players.map(({ expansion }) => { const count = expansion ? storedCargoCount(expansion, 'barrel') : 0; return `${count} × 0.5 = ${fmt(count * 0.5)}`; }), 'score-expansion-row'),
    );
  }
  return <div className="modal-backdrop game-score-backdrop" onClick={onClose}><section className="game-score-modal" role="dialog" aria-modal="true" aria-labelledby="final-score-title" tabIndex={-1} onClick={event => event.stopPropagation()}>
    <header className="game-score-header"><button type="button" className="score-modal-close" aria-label="关闭计分表" onClick={onClose}>×</button><span className="eyebrow">终局计分</span><h2 id="final-score-title">天堂与美酒 · 最终计分</h2><p>{gameover?.draw ? `平分，共享胜利：${winnerNames.join('、')}` : `获胜者：${winnerNames.join('、')}`}</p></header>
    <div className="game-score-table-wrap"><table className="game-score-table"><thead><tr><th>计分项目</th>{players.map(({ player }) => <th key={player.name}>{player.name}</th>)}</tr></thead><tbody>
      {rows.map(({ label, symbol, values, className }) => <tr className={className} key={label}><th scope="row"><span className="score-sheet-row-label">{symbol}<span>{label}</span></span></th>{values.map((value, index) => <td key={index}>{value}</td>)}</tr>)}
      <tr className="score-total-row"><th scope="row">总分</th>{players.map(({ scoring }, index) => <td key={index}>{gameover?.scores?.[index] ?? scoring.total}</td>)}</tr>
    </tbody></table></div>
  </section></div>;
}
const localSaveKey = 'heaven-and-ale-local-session-v1';
type LocalSave = { version: 1; sessionId?: string; playerCount: number; botSeats: number[]; botDifficulty: BotDifficulty; playerNames: string[]; playerColors?: string[]; expansionEnabled?: boolean; state: any; initialState: any; log: any[]; savedAt: number; botNames?: string[] };
type MatchHistoryEntry = { id: string; mode: 'local' | 'online'; roomCode?: string; playedAt: number; playerCount: number; playerNames: string[]; botSeats: number[]; expansionEnabled: boolean; scores: number[]; winnerNames: string[]; state: any; initialState: any };
const matchHistoryKey = 'heaven-and-ale-match-history-v1';
function readMatchHistory(): MatchHistoryEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(matchHistoryKey) || '[]');
    return Array.isArray(value) ? value.filter(item => item?.id && item?.state?.G?.phase === 'finished') : [];
  } catch { return []; }
}
function saveMatchHistoryEntry(entry: MatchHistoryEntry) {
  const current = readMatchHistory();
  if (current.some(item => item.id === entry.id)) return current;
  const next = [entry, ...current].slice(0, 12);
  try { localStorage.setItem(matchHistoryKey, JSON.stringify(next)); } catch {
    // Final board snapshots are useful for review; trim older entries if storage is tight.
    const trimmed = next.slice(0, 4);
    try { localStorage.setItem(matchHistoryKey, JSON.stringify(trimmed)); return trimmed; } catch { return current; }
  }
  return next;
}
function removeMatchHistoryEntry(id: string) {
  const next = readMatchHistory().filter(item => item.id !== id);
  try { localStorage.setItem(matchHistoryKey, JSON.stringify(next)); } catch { /* leave the in-memory list usable */ }
  return next;
}
type OnlineRoomSession = { matchID: string; playerID: string; credentials: string; playerName: string; numPlayers: number; host: boolean; botSeats: number[]; botDifficulty?: BotDifficulty; expansionEnabled?: boolean; botCredentials: { playerID: string; credentials: string }[] };
type LobbyRoom = { matchID: string; players: { id: number; name?: string; isConnected?: boolean; data?: Record<string, unknown> }[]; setupData?: { expansionEnabled?: boolean }; gameover?: unknown; updatedAt?: number };
type BotSearchUpdate = { playerID: number; iterations: number; thinking: boolean; updatedAt: number };
const onlineNameKey = 'heaven-and-ale-online-player-name-v1';
const onlineSessionKey = (matchID: string) => `heaven-and-ale-online-room-${matchID}`;
const onlineSessionPrefix = 'heaven-and-ale-online-room-';
function saveOnlineSession(session: OnlineRoomSession) {
  localStorage.setItem(onlineSessionKey(session.matchID), JSON.stringify(session));
}
function loadOnlineSession(matchID: string): OnlineRoomSession | null {
  try { const value = localStorage.getItem(onlineSessionKey(matchID)); return value ? JSON.parse(value) as OnlineRoomSession : null; }
  catch { return null; }
}
function readOnlineSessions(): OnlineRoomSession[] {
  const sessions: OnlineRoomSession[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(onlineSessionPrefix)) continue;
    try { const session = JSON.parse(localStorage.getItem(key) || 'null') as OnlineRoomSession | null; if (session?.matchID && session.playerID && session.credentials) sessions.push(session); }
    catch { /* ignore malformed saved room credentials */ }
  }
  return sessions.sort((a, b) => a.matchID.localeCompare(b.matchID));
}
const requiredAbandonVotes = (playerCount: number, botSeats: number[] = []) => Math.max(1, playerCount - botSeats.length);
const readAbandonVotes = (room: LobbyRoom, botSeats: number[]) => room.players.filter(player => !botSeats.includes(Number(player.id)) && player.data?.abandonVote === true).map(player => Number(player.id));
function readLocalSave(): LocalSave | null {
  try {
    const raw = localStorage.getItem(localSaveKey);
    if (!raw) return null;
    const saved = JSON.parse(raw) as LocalSave;
    if (saved.version !== 1 || !saved.state?.G || !saved.initialState) return null;
    for (const gameState of [saved.state, saved.initialState]) {
      gameState.G?.expansion?.players?.forEach((board: ExpansionPlayerBoard) => ensureExpansionStorageLayout(board));
      gameState.G?.players?.forEach((player: { name: string }, i: number) => {
        if (/^修道院\s*\d+$/.test(player.name)) player.name = `玩家${i + 1}`;
      });
    }
    saved.playerNames ??= saved.state.G.players.map((player: { name: string }, i: number) => saved.botSeats.includes(i) ? player.name || saved.botNames?.[i] || `机器人${i + 1}` : player.name || `玩家${i + 1}`);
    saved.playerColors ??= saved.state.G.players.map((player: { color: string }) => player.color);
    saved.expansionEnabled ??= saved.state.G.expansionEnabled === true;
    return saved;
  } catch { return null; }
}
function makeLocalGame(_bots: number[], names: string[], expansionEnabled = false, colors: string[] = playerColors) {
  const setup = HeavenAle.setup!;
  return {
    ...HeavenAle,
    playerView: ({ G }: { G: AleState }) => G,
    setup: (args: any) => {
      return setup(args, { expansionEnabled, playerNames: names, playerColors: colors });
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
  const [localPlayerColors, setLocalPlayerColors] = useState<string[]>([...playerColors]);
  const [localExpansionEnabled, setLocalExpansionEnabled] = useState(false);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('normal');
  const [activeBotSeats, setActiveBotSeats] = useState<number[]>([]);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(onlineNameKey) || '玩家1');
  const [onlinePlayerCount, setOnlinePlayerCount] = useState(2);
  const [onlineBotCount, setOnlineBotCount] = useState(0);
  const [onlineBotDifficulty, setOnlineBotDifficulty] = useState<BotDifficulty>('normal');
  const [onlineExpansionEnabled, setOnlineExpansionEnabled] = useState(false);
  const [serverUrl, setServerUrl] = useState(import.meta.env.VITE_GAME_SERVER || 'http://localhost:8000');
  const [roomCode, setRoomCode] = useState(() => new URLSearchParams(window.location.search).get('room') || '');
  const [roomInfo, setRoomInfo] = useState('');
  const [openRooms, setOpenRooms] = useState<LobbyRoom[]>([]);
  const [abandonVoteState, setAbandonVoteState] = useState<{ votes: number[]; passed: boolean }>({ votes: [], passed: false });
  const abandonDeleteStartedRef = React.useRef(false);
  const [roomDeleteTarget, setRoomDeleteTarget] = useState<OnlineRoomSession | null>(null);
  const [onlineRoom, setOnlineRoom] = useState<OnlineRoomSession | null>(null);
  const [roomMatch, setRoomMatch] = useState<LobbyRoom | null>(null);
  const [remoteBotClients, setRemoteBotClients] = useState<{ seat: number; client: AnyClient }[]>([]);
  const [busy, setBusy] = useState(false);
  const [savedLocal, setSavedLocal] = useState<LocalSave | null>(readLocalSave);
  const [matchHistory, setMatchHistory] = useState<MatchHistoryEntry[]>(readMatchHistory);
  const [replayMode, setReplayMode] = useState(false);
  const [localConfig, setLocalConfig] = useState<Omit<LocalSave, 'state' | 'initialState' | 'log' | 'savedAt' | 'version' | 'botNames'> | null>(null);

  const startLocal = (count: number, bots: number[], difficulty: BotDifficulty = 'normal', names: string[] = [], expansionEnabled = false, colors: string[] = playerColors) => {
    const selectedBots = [...new Set(bots)].filter(seat => Number.isInteger(seat) && seat >= 0 && seat < count).sort((a, b) => a - b);
    const selectedNames = Array.from({ length: count }, (_, i) => names[i]?.trim() || (selectedBots.includes(i) ? `机器人${i + 1}` : `玩家${i + 1}`));
    const selectedColors: string[] = [];
    for (let i = 0; i < count; i++) {
      const proposed = colors[i];
      const color = playerColors.includes(proposed) && !selectedColors.includes(proposed) ? proposed : playerColors.find(candidate => !selectedColors.includes(candidate)) || playerColors[i];
      selectedColors.push(color);
    }
    const config = { sessionId: crypto.randomUUID(), playerCount: count, botSeats: selectedBots, botDifficulty: difficulty, playerNames: selectedNames, playerColors: selectedColors, expansionEnabled };
    const c = Client({ game: makeLocalGame(selectedBots, selectedNames, expansionEnabled, selectedColors), numPlayers: count, debug: false });
    c.start(); setLocalConfig(config); setClient(c); setSnapshot((c as any).store.getState()); setReplayMode(false); setScreen('game'); setActiveBotSeats(selectedBots); setBotSeats(selectedBots); setPlayerNames(selectedNames);
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
    if (saved.state.G.phase === 'finished') { localStorage.removeItem(localSaveKey); setSavedLocal(null); return; }
    const c = Client({ game: makeLocalGame(saved.botSeats, saved.playerNames, saved.expansionEnabled, saved.playerColors), numPlayers: saved.playerCount, debug: false });
    c.store.dispatch({ type: 'SYNC', state: saved.state, initialState: saved.initialState, log: saved.log, clientOnly: true });
    c.start();
    setLocalConfig({ sessionId: saved.sessionId || crypto.randomUUID(), playerCount: saved.playerCount, botSeats: saved.botSeats, botDifficulty: saved.botDifficulty, playerNames: saved.playerNames, playerColors: saved.playerColors, expansionEnabled: saved.expansionEnabled });
    setClient(c); setSnapshot((c as any).store.getState()); setReplayMode(false); setActiveBotSeats(saved.botSeats); setPlayerNames(saved.playerNames); setLocalPlayerColors(saved.playerColors || [...playerColors]); setBotDifficulty(saved.botDifficulty); setScreen('game');
    setRoomInfo(saved.botSeats.length === saved.playerCount ? `已恢复 · 全部由${saved.botDifficulty === 'expert' ? '专家' : '普通'}机器人操控` : saved.botSeats.length ? `已恢复本地混合对局 · ${saved.botDifficulty === 'expert' ? '专家' : '普通'}机器人 × ${saved.botSeats.length}` : '已恢复本地热座对局');
  };
  useEffect(() => { if (savedLocal && !new URLSearchParams(window.location.search).has('room')) resumeLocal(); }, []);
  const setSavedName = (value: string) => {
    setPlayerName(value);
    localStorage.setItem(onlineNameKey, value);
  };
  const recordFinishedMatch = (state: any) => {
    const game = state?.G as AleState | undefined;
    if (!game || game.phase !== 'finished') return;
    const mode = localConfig ? 'local' : onlineRoom ? 'online' : null;
    if (!mode) return;
    const roomCode = mode === 'online' ? onlineRoom?.matchID : undefined;
    const id = mode === 'local' ? `local:${localConfig?.sessionId || state._stateID}` : `online:${roomCode}`;
    const players = game.players.map((player, index) => {
      const liveRoomName = roomMatch?.players.find(roomPlayer => Number(roomPlayer.id) === index)?.name;
      return { ...player, name: liveRoomName || player.name || `玩家${index + 1}` };
    });
    const savedGame = { ...game, players };
    const scores = players.map((player, index) => scoreBreakdown(player, savedGame.expansionEnabled ? savedGame.expansion?.players[index] : undefined).total);
    const gameover = state.ctx?.gameover;
    const winnerIndexes: number[] = gameover?.winners?.map(Number) ?? (gameover?.winner !== undefined ? [Number(gameover.winner)] : scores.flatMap((score, index) => score === Math.max(...scores) ? [index] : []));
    const entry: MatchHistoryEntry = {
      id, mode, roomCode, playedAt: Date.now(), playerCount: players.length, playerNames: players.map(player => player.name),
      botSeats: mode === 'local' ? localConfig?.botSeats ?? [] : onlineRoom?.botSeats ?? [],
      expansionEnabled: savedGame.expansionEnabled === true, scores, winnerNames: winnerIndexes.map(index => players[index]?.name).filter((name): name is string => !!name),
      state: { ...state, G: savedGame }, initialState: (client as any)?.getInitialState?.() ?? state,
    };
    setMatchHistory(saveMatchHistoryEntry(entry));
  };
  const openMatchHistory = (entry: MatchHistoryEntry) => {
    const c = Client({ game: makeLocalGame(entry.botSeats, entry.playerNames, entry.expansionEnabled), numPlayers: entry.playerCount, debug: false });
    c.store.dispatch({ type: 'SYNC', state: entry.state, initialState: entry.initialState, log: [], clientOnly: true });
    c.start();
    setClient(c); setSnapshot((c as any).store.getState()); setLocalConfig(null); setOnlineRoom(null); setRoomMatch(null); setReplayMode(true); setActiveBotSeats([]); setScreen('game');
    setRoomInfo(`终局复盘 · ${entry.mode === 'online' ? `线上房间 ${entry.roomCode}` : '本地对局'}`);
  };
  const recordFinishedMatchRef = React.useRef(recordFinishedMatch);
  useEffect(() => { recordFinishedMatchRef.current = recordFinishedMatch; });
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
    abandonDeleteStartedRef.current = false;
    saveOnlineSession(session);
    const room = matchAsRoom(match);
    const votes = readAbandonVotes(room, session.botSeats);
    setOnlineRoom(session); setRoomMatch(room); setAbandonVoteState({ votes, passed: votes.length >= requiredAbandonVotes(session.numPlayers, session.botSeats) }); setRoomCode(session.matchID);
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
      const created = await lobby.createMatch(gameName, { numPlayers: count, setupData: { expansionEnabled: onlineExpansionEnabled } });
      const host = await lobby.joinMatch(gameName, created.matchID, { playerID: '0', playerName: name });
      const botCredentials: OnlineRoomSession['botCredentials'] = [];
      for (const seat of botSeats) {
        const joinedBot = await lobby.joinMatch(gameName, created.matchID, { playerID: String(seat), playerName: `机器人${seat + 1}`, data: { isBot: true, botDifficulty: onlineBotDifficulty } });
        botCredentials.push({ playerID: String(joinedBot.playerID), credentials: joinedBot.playerCredentials });
      }
      const match = await lobby.getMatch(gameName, created.matchID);
      await enterWaitingRoom({ matchID: created.matchID, playerID: String(host.playerID), credentials: host.playerCredentials, playerName: name, numPlayers: count, host: true, botSeats, botDifficulty: onlineBotDifficulty, expansionEnabled: onlineExpansionEnabled, botCredentials }, match);
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
      if (existing) {
        const match = await lobby.getMatch(gameName, code);
        const botSeats = match.players.filter(player => player.data?.isBot === true).map(player => Number(player.id));
        const botDifficulty = (match.players.find(player => player.data?.isBot === true)?.data?.botDifficulty as BotDifficulty | undefined) || existing.botDifficulty;
        session = { ...existing, playerName: name, botSeats, botDifficulty, expansionEnabled: match.setupData?.expansionEnabled === true };
        await enterWaitingRoom(session, match);
      } else {
        const joined = await lobby.joinMatch(gameName, code, { playerName: name });
        const match = await lobby.getMatch(gameName, code);
        const botSeats = match.players.filter(player => player.data?.isBot === true).map(player => Number(player.id));
        const botDifficulty = match.players.find(player => player.data?.isBot === true)?.data?.botDifficulty as BotDifficulty | undefined;
        session = { matchID: code, playerID: String(joined.playerID), credentials: joined.playerCredentials, playerName: name, numPlayers: match.players.length, host: false, botSeats, botDifficulty, expansionEnabled: match.setupData?.expansionEnabled === true, botCredentials: [] };
        await enterWaitingRoom(session, match);
      }
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
      setLocalConfig(null); setClient(main); setRemoteBotClients(bots); setActiveBotSeats([]); setBotSeats(onlineRoom.botSeats); setReplayMode(false);
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
  const updateRoomName = async () => {
    if (!onlineRoom) return;
    const name = playerName.trim().slice(0, 18);
    if (!name) { setRoomInfo('名称不能为空。'); return; }
    setBusy(true);
    try {
      await new LobbyClient({ server: serverUrl }).updatePlayer(gameName, onlineRoom.matchID, { playerID: onlineRoom.playerID, credentials: onlineRoom.credentials, newName: name });
      const updated = { ...onlineRoom, playerName: name };
      setOnlineRoom(updated); saveOnlineSession(updated); setSavedName(name); setRoomInfo('玩家名称已更新。');
      const match = await new LobbyClient({ server: serverUrl }).getMatch(gameName, onlineRoom.matchID);
      setRoomMatch(matchAsRoom(match));
    } catch (e) { setRoomInfo(`名称更新失败：${e instanceof Error ? e.message : '请重试。'}`); }
    setBusy(false);
  };
  const voteToAbandon = async () => {
    if (!onlineRoom) return;
    const own = roomMatch?.players.find(player => Number(player.id) === Number(onlineRoom.playerID));
    const newVote = own?.data?.abandonVote !== true;
    try {
      await new LobbyClient({ server: serverUrl }).updatePlayer(gameName, onlineRoom.matchID, {
        playerID: onlineRoom.playerID,
        credentials: onlineRoom.credentials,
        data: { ...(own?.data || {}), abandonVote: newVote },
      });
      const match = await new LobbyClient({ server: serverUrl }).getMatch(gameName, onlineRoom.matchID);
      const room = matchAsRoom(match), votes = readAbandonVotes(room, onlineRoom.botSeats);
      setRoomMatch(room); setAbandonVoteState({ votes, passed: votes.length >= requiredAbandonVotes(onlineRoom.numPlayers, onlineRoom.botSeats) });
    } catch (e) { setRoomInfo(`投票失败：${e instanceof Error ? e.message : '请重试。'}`); }
  };
  const leaveAbandonedRoom = async () => {
    if (!onlineRoom) { returnHome(); return; }
    if (onlineRoom.host) {
      try {
        const response = await fetch(`${serverUrl.replace(/\/$/, '')}/admin/matches/${encodeURIComponent(onlineRoom.matchID)}/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerID: onlineRoom.playerID, credentials: onlineRoom.credentials }),
        });
        if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
      } catch (e) { setRoomInfo(`删除放弃的对局失败：${e instanceof Error ? e.message : '请重试。'}`); return; }
    }
    localStorage.removeItem(onlineSessionKey(onlineRoom.matchID));
    returnHome();
  };
  const deleteRoomAndHistory = async (session: OnlineRoomSession) => {
    setBusy(true);
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, '')}/admin/matches/${encodeURIComponent(session.matchID)}/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerID: session.playerID, credentials: session.credentials }),
      });
      if (!response.ok) throw new Error(response.status === 403 ? '只有创建房间的房主可以删除。' : `服务器返回 ${response.status}`);
      localStorage.removeItem(onlineSessionKey(session.matchID));
      setMatchHistory(removeMatchHistoryEntry(`online:${session.matchID}`));
      setOpenRooms(rooms => rooms.filter(room => room.matchID !== session.matchID));
      setRoomDeleteTarget(null); setRoomInfo(`房间 ${session.matchID} 及其对局记录已删除。`);
    } catch (e) { setRoomInfo(`删除失败：${e instanceof Error ? e.message : '请确认服务端已更新。'}`); }
    setBusy(false);
  };
  const publishBotSearch = async (status: BotSearchUpdate | null) => {
    if (!onlineRoom?.host || !status) return;
    const botSession = onlineRoom.botCredentials.find(bot => Number(bot.playerID) === status.playerID);
    if (!botSession) return;
    const previous = roomMatch?.players.find(player => Number(player.id) === status.playerID)?.data || {};
    try {
      await new LobbyClient({ server: serverUrl }).updatePlayer(gameName, onlineRoom.matchID, {
        playerID: botSession.playerID, credentials: botSession.credentials,
        data: { ...previous, botSearch: status },
      });
    } catch { /* search telemetry is best-effort; it must not interrupt the bot */ }
  };
  useEffect(() => { if (roomCode && screen === 'home' && !busy) void joinRoom(roomCode); }, []);
  useEffect(() => {
    if ((screen !== 'waiting' && screen !== 'game') || !onlineRoom) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const match = await new LobbyClient({ server: serverUrl }).getMatch(gameName, onlineRoom.matchID);
        if (!cancelled) {
          const room = matchAsRoom(match), votes = readAbandonVotes(room, onlineRoom.botSeats);
          setRoomMatch(room); setAbandonVoteState({ votes, passed: votes.length >= requiredAbandonVotes(onlineRoom.numPlayers, onlineRoom.botSeats) });
        }
      } catch { if (!cancelled) {
        if (abandonVoteState.passed && !onlineRoom.host) { localStorage.removeItem(onlineSessionKey(onlineRoom.matchID)); returnHome(); }
        else setRoomInfo('无法读取房间状态，房间可能已结束或服务暂时休眠。');
      } }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [screen, onlineRoom?.matchID, onlineRoom?.numPlayers, onlineRoom?.host, serverUrl, abandonVoteState.passed]);

  useEffect(() => {
    if (screen !== 'game' || !onlineRoom?.host || !abandonVoteState.passed || abandonDeleteStartedRef.current) return;
    abandonDeleteStartedRef.current = true;
    void leaveAbandonedRoom();
  }, [screen, onlineRoom?.matchID, onlineRoom?.host, abandonVoteState.passed]);

  useEffect(() => { if (!client) return; const persist = (state: any = (client as any).store.getState()) => {
    if (localConfig) {
      try {
        const record: LocalSave = { version: 1, ...localConfig, state, initialState: client.getInitialState(), log: (client as any).log ?? [], savedAt: Date.now() };
        localStorage.setItem(localSaveKey, JSON.stringify(record)); setSavedLocal(record);
      } catch (error) { console.warn('本地对局保存失败', error); }
    }
    recordFinishedMatchRef.current(state);
  };
  const unsub = client.subscribe((state: any) => { setSnapshot(state); persist(state); });
  setSnapshot((client as any).store.getState()); persist();
  return () => { unsub(); client.stop(); };
  }, [client, localConfig]);
  const returnHome = () => { const liveState = (client as any)?.store?.getState?.() ?? snapshot; recordFinishedMatch(liveState); if (localConfig && liveState?.G?.phase === 'finished') { localStorage.removeItem(localSaveKey); setSavedLocal(null); } client?.stop(); remoteBotClients.forEach(({ client: botClient }) => botClient.stop()); setRemoteBotClients([]); setClient(null); setSnapshot(null); setScreen('home'); setReplayMode(false); setActiveBotSeats([]); setLocalConfig(null); setOnlineRoom(null); setRoomMatch(null); setRoomCode(''); setPlayerCount(2); setBotSeats([]); setPlayerNames(['玩家1', '玩家2', '玩家3', '玩家4']); setLocalPlayerColors([...playerColors]); setBotDifficulty('normal'); const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.replaceState({}, '', url); };
  const abandonLocalGame = () => { localStorage.removeItem(localSaveKey); setSavedLocal(null); returnHome(); };
  if (screen === 'game' && client && snapshot) return <GameView client={client} state={snapshot} roomInfo={roomInfo} roomCode={roomCode} botSeats={localConfig ? activeBotSeats : onlineRoom?.botSeats || []} remoteBotClients={remoteBotClients} ownPlayerSeat={onlineRoom ? Number(onlineRoom.playerID) : undefined} playerName={onlineRoom?.playerName} onlinePlayerNames={roomMatch ? Array.from({ length: roomMatch.players.length }, (_, i) => roomMatch.players.find(player => Number(player.id) === i)?.name || `玩家${i + 1}`) : undefined} remoteBotDifficulty={onlineRoom?.botDifficulty || 'normal'} botDifficulty={localConfig ? botDifficulty : onlineRoom?.botDifficulty || 'normal'} isLocal={!!localConfig || replayMode} localHandoffEnabled={!!localConfig && localConfig.playerCount > localConfig.botSeats.length} isRoomHost={!!onlineRoom?.host} onlineVoteState={abandonVoteState} sharedBotSearches={(roomMatch?.players.map(player => player.data?.botSearch).filter(Boolean) || []) as BotSearchUpdate[]} onBotSearchUpdate={publishBotSearch} onVoteToAbandon={voteToAbandon} onLeaveAbandoned={leaveAbandonedRoom} onExit={returnHome} onAbandon={abandonLocalGame} />;
  if (screen === 'waiting' && onlineRoom) {
    const players = roomMatch?.players || [];
    const full = players.length >= onlineRoom.numPlayers && players.slice(0, onlineRoom.numPlayers).every(p => !!p.name);
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(onlineRoom.matchID)}`;
    return <main className="landing waiting-screen"><div className="landing-image" /><header className="topbar"><div className="brand-mark"><img src="/Images/ha-cover.png" alt="Heaven & Ale" /></div><b>天堂与美酒 · 等候室</b></header><section className="waiting-room setup-card"><div className="card-kicker">TABLE {onlineRoom.matchID}</div><h1>{full ? '所有玩家已到齐' : '等待玩家加入'}</h1><p>房主开始游戏前，所有席位需要有人就座。分享此桌的专属链接即可邀请朋友加入。</p><div className="expansion-room-badge">{onlineRoom.expansionEnabled ? '扩展规则已启用' : '基础规则'}</div><label>你的玩家名称<div className="share-link-row"><input value={playerName} maxLength={18} onChange={e => setSavedName(e.target.value)} /><button className="btn btn-light" disabled={busy} onClick={() => void updateRoomName()}>更新名称</button></div></label><label>房间链接<div className="share-link-row"><input readOnly value={shareUrl} /><button className="btn btn-light" onClick={() => { void navigator.clipboard?.writeText(shareUrl); setRoomInfo('已复制房间链接。'); }}>复制</button></div></label><div className="waiting-seats">{Array.from({ length: onlineRoom.numPlayers }, (_, seat) => { const occupant = players.find(p => Number(p.id) === seat); return <div className={`waiting-seat ${occupant?.name ? 'is-filled' : ''}`} key={seat}><span className="seat-number">{seat + 1}</span><div><b>{occupant?.name || '等待玩家…'}</b><small>{onlineRoom.botSeats.includes(seat) ? '机器人席位' : occupant?.isConnected ? '已连接' : occupant?.name ? '已加入' : '空位'}</small></div>{occupant?.name && <i />}</div>; })}</div>{roomInfo && <div className="room-message">{roomInfo}</div>}<div className="waiting-actions"><button className="btn btn-outline" onClick={leaveWaitingRoom}>离开房间</button><button className="btn btn-gold" disabled={!full || busy} onClick={startOnlineGame}>{busy ? '连接中…' : full ? '进入对局' : '等待所有玩家加入'}</button></div><small className="waiting-footnote">房间状态每 2.5 秒自动刷新 · 昵称会保存在此设备</small></section></main>;
  }
  const myOnlineRooms = readOnlineSessions();
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
          {savedLocal && savedLocal.state.G.phase !== 'finished' && <button className="btn btn-outline resume-local" onClick={resumeLocal}>继续上次本地对局 · {new Date(savedLocal.savedAt).toLocaleString()}</button>}
          <label>游戏人数<select value={playerCount} onChange={e => { const count = Number(e.target.value); setPlayerCount(count); setBotSeats(current => current.filter(seat => seat < count)); }}><option value={2}>两人游戏</option><option value={3}>三人游戏</option><option value={4}>四人游戏</option></select></label>
          <label className="expansion-toggle"><input type="checkbox" checked={localExpansionEnabled} onChange={e => setLocalExpansionEnabled(e.target.checked)} /><span><b>启用扩展</b><small>包括运输板、推车路线、酒厂交付和棚屋奖励</small></span></label>
          <div className="bot-seat-toolbar"><span>玩家席位</span><div><button type="button" onClick={() => setAllSeatModes(false)}>全部设为真实玩家</button><button type="button" onClick={() => setAllSeatModes(true)}>全部设为机器人</button></div></div>
          <div className="bot-seat-list">{Array.from({ length: playerCount }, (_, seat) => { const isBot = botSeats.includes(seat); return <div className="bot-seat-row" key={seat}>
            <div className="bot-seat-toggle"><input className="bot-seat-name" aria-label={`玩家 ${seat + 1} 名称`} value={playerNames[seat]} maxLength={18} onChange={e => setPlayerNames(current => current.map((name, i) => i === seat ? e.target.value : name))} onBlur={e => { if (!e.target.value.trim()) setPlayerNames(current => current.map((name, i) => i === seat ? `${isBot ? '机器人' : '玩家'}${seat + 1}` : name)); }} /><div className="bot-seat-options" role="group" aria-label={`玩家 ${seat + 1} 类型`}><button type="button" className={!isBot ? 'selected' : ''} aria-pressed={!isBot} onClick={() => setSeatMode(seat, false)}>真实玩家</button><button type="button" className={isBot ? 'selected' : ''} aria-pressed={isBot} onClick={() => setSeatMode(seat, true)}>机器人</button></div></div>
            <div className="seat-color-options" role="group" aria-label={`${playerNames[seat]}的颜色`}><span>颜色</span>{playerColors.map(color => { const colorLabels: Record<string, string> = { black: '黑色', yellow: '黄色', blue: '蓝色', red: '红色' }; const colorValues: Record<string, string> = { black: '#30302e', yellow: '#e4c843', blue: '#198fc8', red: '#d94a3e' }; const selected = localPlayerColors[seat] === color; return <button key={color} type="button" className={selected ? 'selected' : ''} aria-label={colorLabels[color]} aria-pressed={selected} title={colorLabels[color]} style={{ ['--seat-color' as any]: colorValues[color] }} onClick={() => setLocalPlayerColors(current => { const otherSeat = current.indexOf(color); return current.map((value, index) => index === seat ? color : index === otherSeat ? current[seat] : value); })} />; })}</div>
          </div>; })}</div>
          {botSeats.length > 0 && <label>机器人难度<select value={botDifficulty} onChange={e => setBotDifficulty(e.target.value as BotDifficulty)}><option value="normal">普通 · 约 3 秒/步</option><option value="expert">专家 · 约 12 秒/步</option></select></label>}
          <button className="btn btn-gold" onClick={() => startLocal(playerCount, botSeats, botDifficulty, playerNames, localExpansionEnabled, localPlayerColors)}>开始本地对局 <span>↗</span></button>
        </div>
        <div className="setup-card online-card"><div className="card-kicker">PLAY TOGETHER</div><h2>线上大厅</h2><p>浏览公开等候桌，或创建一桌并邀请朋友加入。</p><label>玩家名称<input value={playerName} onChange={e => setSavedName(e.target.value)} onBlur={() => { if (!playerName.trim()) setSavedName('玩家1'); }} maxLength={18} /></label><label>游戏服务器<input value={serverUrl} onChange={e => setServerUrl(e.target.value)} /></label><div className="online-create-options"><label>总人数<select value={onlinePlayerCount} onChange={e => { const n = Number(e.target.value); setOnlinePlayerCount(n); setOnlineBotCount(current => Math.min(current, n - 1)); }}><option value={2}>2 人</option><option value={3}>3 人</option><option value={4}>4 人</option></select></label><label>机器人席位<select value={onlineBotCount} onChange={e => setOnlineBotCount(Number(e.target.value))}>{Array.from({ length: onlinePlayerCount }, (_, n) => n < onlinePlayerCount ? <option key={n} value={n}>{n === 0 ? '不加入机器人' : `加入 ${n} 个机器人`}</option> : null).slice(0, onlinePlayerCount)}</select></label></div><label className="expansion-toggle"><input type="checkbox" checked={onlineExpansionEnabled} onChange={e => setOnlineExpansionEnabled(e.target.checked)} /><span><b>启用扩展</b><small>包括运输板、推车路线、酒厂交付和棚屋奖励</small></span></label>{onlineBotCount > 0 && <label>机器人难度<select value={onlineBotDifficulty} onChange={e => setOnlineBotDifficulty(e.target.value as BotDifficulty)}><option value="normal">普通</option><option value="expert">专家</option></select></label>}<div className="online-actions"><button className="btn btn-outline" disabled={busy} onClick={createRoom}>创建等候桌</button><div className="join-row"><input placeholder="房间号 / 链接" value={roomCode} onChange={e => { const v = e.target.value; const match = v.match(/[?&]room=([^&]+)/); setRoomCode(match ? decodeURIComponent(match[1]) : v); }} /><button className="btn btn-light" disabled={busy} onClick={() => void joinRoom()}>加入</button></div></div>{roomInfo && <div className="room-message">{roomInfo}</div>}<div className="lobby-list-heading"><b>可加入的房间</b><button onClick={() => void refreshRooms()}>刷新</button></div><div className="lobby-room-list">{openRooms.filter(room => room.players?.some(p => p.name)).map(room => { const occupied = room.players.filter(p => p.name).length, cap = room.players.length || 0; return <button className="lobby-room" key={room.matchID} disabled={busy || occupied >= cap} onClick={() => { setRoomCode(room.matchID); void joinRoom(room.matchID); }}><span><b>房间 {room.matchID}</b><small>{room.players.filter(p => p.name).map(p => p.name).join('、')}</small></span><em>{occupied}/{cap} 人 · {occupied >= cap ? '已满' : '等待中'}{room.setupData?.expansionEnabled ? ' · 扩展' : ''}</em></button>; })}{openRooms.filter(room => room.players?.some(p => p.name)).length === 0 && <div className="lobby-empty">当前没有公开等候桌</div>}</div></div>
      </div>
      {myOnlineRooms.length > 0 && <section className="my-online-rooms setup-card"><div className="lobby-list-heading"><b>我加入的房间</b><span>保存在此设备</span></div><div className="lobby-room-list">{myOnlineRooms.map(session => { const room = openRooms.find(item => item.matchID === session.matchID); const occupied = room?.players.filter(p => p.name).length ?? 0; return <div className="lobby-room my-room" key={session.matchID}><span><b>{room?.players.find(p => Number(p.id) === Number(session.playerID))?.name || session.playerName} · 房间 {session.matchID}</b><small>{room?.players.filter(p => p.name).map(p => p.name).join('、') || '房间暂不可用'}</small></span><em>{room ? `${occupied}/${room.players.length} 人` : '离线 / 已结束'}</em><button className="btn btn-light" onClick={() => { setRoomCode(session.matchID); void joinRoom(session.matchID); }}>重新进入</button>{session.host && <button className="btn btn-danger" onClick={() => setRoomDeleteTarget(session)}>删除房间</button>}</div>; })}</div></section>}
      {matchHistory.length > 0 && <section className="match-history-section setup-card"><div className="lobby-list-heading"><b>对局历史</b><span>只保留正常结束的对局</span></div><div className="match-history-list">{matchHistory.map(entry => <article className="match-history-item" key={entry.id}><div className="match-history-main"><b>{entry.playerNames.join(' · ')}</b><small>{new Date(entry.playedAt).toLocaleString()} · {entry.mode === 'online' ? `线上 ${entry.roomCode}` : '本地'} · {entry.expansionEnabled ? '扩展' : '基础'}</small><small>冠军：{entry.winnerNames.join('、')}　·　{entry.scores.map((score, index) => `${entry.playerNames[index]} ${score}分`).join('　')}</small></div><button className="btn btn-light" onClick={() => openMatchHistory(entry)}>终局复盘</button></article>)}</div></section>}
      {roomDeleteTarget && <div className="modal-backdrop" onClick={() => setRoomDeleteTarget(null)}><div className="rules-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-room-title" onClick={e => e.stopPropagation()}><button className="close-modal" onClick={() => setRoomDeleteTarget(null)}>×</button><span className="eyebrow">DELETE TABLE</span><h2 id="delete-room-title">删除房间和全部记录？</h2><p>房间 {roomDeleteTarget.matchID} 将从服务器永久删除，其他玩家也无法再通过链接进入。</p><div className="confirm-actions"><button className="btn btn-outline" disabled={busy} onClick={() => setRoomDeleteTarget(null)}>取消</button><button className="btn btn-danger" disabled={busy} onClick={() => void deleteRoomAndHistory(roomDeleteTarget)}>{busy ? "正在删除…" : "删除房间"}</button></div></div></div>}
      <div className="feature-row"><span>✦ 依照官方规则设计</span><span>✦ 共享房间码联机</span><span>✦ 支持 2–4 人</span></div>
    </section>
    <footer>HEAVEN & ALE <span>·</span> 天堂与美酒</footer>
  </main>;
}

function GameView({ client, state, roomInfo, roomCode, botSeats, remoteBotClients, ownPlayerSeat, playerName, onlinePlayerNames, remoteBotDifficulty, botDifficulty, isLocal, localHandoffEnabled, isRoomHost, onlineVoteState, sharedBotSearches, onBotSearchUpdate, onVoteToAbandon, onLeaveAbandoned, onExit, onAbandon }: { client: AnyClient; state: any; roomInfo: string; roomCode: string; botSeats: number[]; remoteBotClients: { seat: number; client: AnyClient }[]; ownPlayerSeat?: number; playerName?: string; onlinePlayerNames?: string[]; remoteBotDifficulty: BotDifficulty; botDifficulty: BotDifficulty; isLocal: boolean; localHandoffEnabled: boolean; isRoomHost: boolean; onlineVoteState: { votes: number[]; passed: boolean }; sharedBotSearches: BotSearchUpdate[]; onBotSearchUpdate: (status: BotSearchUpdate | null) => void; onVoteToAbandon: () => void; onLeaveAbandoned: () => void; onExit: () => void; onAbandon: () => void }) {
  const rawG = state.G as AleState;
  const G = onlinePlayerNames ? { ...rawG, players: rawG.players.map((player, i) => onlinePlayerNames[i] ? { ...player, name: onlinePlayerNames[i] } : player) } as AleState : rawG;
  const ctx = state.ctx, currentPlayerIndex = Number(ctx.currentPlayer);
  const handoffTurnKey = `${G.phase}:${G.round}:${ctx.turn ?? ''}:${currentPlayerIndex}:${G.setupStage ?? ''}`;
  const [handoffPlayerIndex, setHandoffPlayerIndex] = useState<number | null>(() => localHandoffEnabled && G.phase !== 'finished' && !botSeats.includes(currentPlayerIndex) ? currentPlayerIndex : null);
  const lastHandoffTurnKeyRef = React.useRef(handoffTurnKey);
  const lastTurnPlayerRef = React.useRef(currentPlayerIndex);
  useEffect(() => {
    const changedTurn = lastHandoffTurnKeyRef.current !== handoffTurnKey;
    lastHandoffTurnKeyRef.current = handoffTurnKey;
    if (!localHandoffEnabled || G.phase === 'finished') {
      lastTurnPlayerRef.current = currentPlayerIndex;
      setHandoffPlayerIndex(null);
      return;
    }
    if (!changedTurn) return;
    const previousPlayer = lastTurnPlayerRef.current;
    lastTurnPlayerRef.current = currentPlayerIndex;
    if (botSeats.includes(currentPlayerIndex)) {
      setHandoffPlayerIndex(null);
      return;
    }
    if (previousPlayer !== currentPlayerIndex) setHandoffPlayerIndex(currentPlayerIndex);
  }, [handoffTurnKey, localHandoffEnabled, G.phase, botSeats, currentPlayerIndex]);
  const localSeat = Number((client as any).playerID);
  const ownPlayerIndex = isLocal ? currentPlayerIndex : Number.isInteger(ownPlayerSeat) ? ownPlayerSeat! : Number.isInteger(localSeat) ? localSeat : currentPlayerIndex;
  const currentPlayer = G.players[currentPlayerIndex] ?? G.players[0];
  const gameover = ctx.gameover as { winner?: string; winners?: string[]; draw?: boolean; scores?: number[] } | undefined;
  const winnerIds = gameover?.winners ?? (gameover?.winner !== undefined ? [String(gameover.winner)] : []);
  const moves = (client as any).moves;
  const downloadGameDebug = () => {
    const liveState = (client as any).store?.getState?.() ?? state;
    const liveGame = liveState?.G as AleState | undefined;
    const payload = {
      format: 'heaven-and-ale-debug',
      version: 1,
      exportedAt: new Date().toISOString(),
      session: {
        mode: isLocal ? 'local' : 'online',
        roomCode: roomCode || undefined,
        botSeats,
        botDifficulty: isLocal ? botDifficulty : remoteBotDifficulty,
        playerNames: liveGame?.players?.map(player => player.name) ?? [],
      },
      stateID: liveState?._stateID,
      ctx: liveState?.ctx,
      diagnostics: {
        phase: liveGame?.phase,
        round: liveGame?.round,
        maxRounds: liveGame?.maxRounds,
        currentPlayer: liveState?.ctx?.currentPlayer,
        pending: liveGame?.pending,
        confirmationKind: liveGame?.confirmationKind,
        logCycle: liveGame?.logCycle,
        players: liveGame?.players?.map((player, seat) => ({ seat, name: player.name, position: player.position, retired: player.retired, coins: player.coins })),
        expansionPlayers: liveGame?.expansion?.players?.map((board, seat) => ({ seat, cartPosition: board.cartPosition, cartBarrels: board.cartBarrels, deliveredBarrels: board.deliveredBarrels, breweryDeliveries: board.breweryDeliveries })),
      },
      G: liveGame,
      actionHistory: (client as any).log ?? null,
      botSearch: {
        local: botSearchStatus,
        shared: sharedBotSearches,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `heaven-and-ale-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const ownsCurrentTurn = isLocal || Number((client as any).playerID) === currentPlayerIndex;
  useEffect(() => {
    const ownID = Number((client as any).playerID);
    if (!isLocal && playerName?.trim() && ownID === currentPlayerIndex && rawG.players[ownID]?.name !== playerName.trim()) moves.setPlayerName?.(playerName.trim());
  }, [state._stateID, client, playerName, isLocal, currentPlayerIndex]);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [selectedExpansionStoreId, setSelectedExpansionStoreId] = useState<number | null>(null);
  const previousUnplacedExpansionStores = React.useRef<number[] | null>(null);
  const lastPlacedExpansionStoreId = React.useRef<number | null>(null);
  const [selectedExpansionCargoKind, setSelectedExpansionCargoKind] = useState<ExpansionCargo | null>(null);
  const [pieceFlights, setPieceFlights] = useState<PieceFlight[]>([]);
  const [pageScroll, setPageScroll] = useState(() => ({ x: window.scrollX, y: window.scrollY }));
  useEffect(() => {
    const updateScroll = () => setPageScroll({ x: window.scrollX, y: window.scrollY });
    window.addEventListener('scroll', updateScroll, { passive: true });
    return () => window.removeEventListener('scroll', updateScroll);
  }, []);
  const trailStorageKey = `heaven-and-ale-movement-trails-${isLocal ? 'local' : roomCode || 'online'}-${(client as any).playerID ?? 'spectator'}`;
  const [movementTrails, setMovementTrails] = useState<MovementTrail[]>(() => {
    if (typeof window === 'undefined' || !G.confirmationKind) return [];
    try {
      const saved = JSON.parse(sessionStorage.getItem(trailStorageKey) || 'null') as { width: number; height: number; trails: MovementTrail[] } | null;
      if (!saved?.trails?.length) return [];
      const scaleX = window.innerWidth / Math.max(1, saved.width);
      const scaleY = window.innerHeight / Math.max(1, saved.height);
      return saved.trails.map(trail => ({
        ...trail,
        started: true,
        pathPoints: trail.pathPoints.map(point => ({ ...point, x: point.x * scaleX, y: point.y * scaleY })),
      }));
    } catch { return []; }
  });
  useEffect(() => {
    try {
      if (!G.confirmationKind || movementTrails.length === 0) {
        sessionStorage.removeItem(trailStorageKey);
        return;
      }
      sessionStorage.setItem(trailStorageKey, JSON.stringify({ width: window.innerWidth, height: window.innerHeight, trails: movementTrails }));
    } catch { /* session storage is only a visual convenience */ }
  }, [movementTrails, G.confirmationKind, trailStorageKey]);
  const reverseCartMotionRef = React.useRef(false);
  const undoStepTargetStateIdRef = React.useRef<number | null>(null);
  const previousConfirmationKindRef = React.useRef(G.confirmationKind);
  useEffect(() => {
    const previous = previousConfirmationKindRef.current;
    previousConfirmationKindRef.current = G.confirmationKind;
    const justUndidStep = undoStepTargetStateIdRef.current === state._stateID;
    if (undoStepTargetStateIdRef.current !== null && state._stateID >= undoStepTargetStateIdRef.current) undoStepTargetStateIdRef.current = null;
    if (previous && !G.confirmationKind && !justUndidStep) setMovementTrails([]);
  }, [G.confirmationKind, state._stateID]);
  const pathAnimationsRef = React.useRef(new Map<string, Animation>());
  useLayoutEffect(() => {
    const liveIds = new Set(pieceFlights.map(flight => flight.id));
    for (const [id, animation] of pathAnimationsRef.current) {
      if (!liveIds.has(id)) { animation.cancel(); pathAnimationsRef.current.delete(id); }
    }
    for (const flight of pieceFlights) {
      if (!flight.started || !flight.pathPoints || flight.pathPoints.length < 2 || pathAnimationsRef.current.has(flight.id)) continue;
      const element = [...document.querySelectorAll<HTMLElement>('[data-piece-flight-id]')].find(item => item.dataset.pieceFlightId === flight.id);
      if (!element) continue;
      const first = flight.pathPoints[0];
      const frames: Keyframe[] = flight.pathPoints.map((point, index) => {
        const progress = index / (flight.pathPoints!.length - 1);
        return {
          transform: `translate(${point.x - first.x}px, ${point.y - first.y}px) scale(${1 + (flight.scale - 1) * progress})`,
          offset: progress,
        };
      });
      const animation = element.animate(frames, { duration: flight.durationMs ?? 980, delay: flight.delayMs ?? 0, easing: 'linear', fill: 'both' });
      pathAnimationsRef.current.set(flight.id, animation);
    }
  }, [pieceFlights]);
  const [deferredGameAction, setDeferredGameAction] = useState<'undoStep' | 'undoAction' | 'confirmAction' | null>(null);
  const deferredGameActionRef = React.useRef<typeof deferredGameAction>(null);
  const [scoreChoice, setScoreChoice] = useState<string>('');
  const [scoreCategory, setScoreCategory] = useState<'A' | 'B' | 'C'>('A');
  const [showProductionChoices, setShowProductionChoices] = useState(true);
  const [privilegeCardChoice, setPrivilegeCardChoice] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [showAbandonConfirm, setShowAbandonConfirm] = useState(false);
  const [showUnstoredCargoPrompt, setShowUnstoredCargoPrompt] = useState(false);
  const [showFinalScore, setShowFinalScore] = useState(() => state.G.phase === 'finished');
  useEffect(() => { if (G.phase === 'finished') setShowFinalScore(true); }, [G.phase]);
  const [toast, setToast] = useState('');
  const [botSearchStatus, setBotSearchStatus] = useState<{ playerID: number; iterations: number } | null>(null);
  const onBotSearchUpdateRef = React.useRef(onBotSearchUpdate);
  const lastBotStatusRef = React.useRef<{ playerID: number; iterations: number } | null>(null);
  const lastBotStatusSyncRef = React.useRef(0);
  useEffect(() => { onBotSearchUpdateRef.current = onBotSearchUpdate; }, [onBotSearchUpdate]);
  const reportBotThinking = React.useCallback((status: { playerID: number; iterations: number } | null) => {
    setBotSearchStatus(status);
    if (status) lastBotStatusRef.current = status;
    const now = Date.now();
    if (status || lastBotStatusRef.current) {
      const last = lastBotStatusRef.current;
      if (last && (!status || now - lastBotStatusSyncRef.current >= 900)) {
        lastBotStatusSyncRef.current = now;
        onBotSearchUpdateRef.current({ playerID: last.playerID, iterations: status?.iterations ?? last.iterations, thinking: !!status, updatedAt: now });
      }
    }
  }, []);
  const [viewingPlayerIndex, setViewingPlayerIndex] = useState(ownPlayerIndex);
  // Tile faces are small but numerous. Browsers may defer decoding an image
  // until it becomes visible, which makes an opponent-board switch look like
  // its tiles are appearing late. Warm the shared tile artwork once when the
  // table opens so switching boards only changes the board state, not loading.
  useEffect(() => {
    const urls = [
      ...resources.flatMap(resource => Array.from({ length: 5 }, (_, index) => `/Images/${resource}_${index + 1}.png`)),
      ...['A', 'B', 'C', 'D'].map(code => `/Images/monk_tile_${code}.png`),
    ];
    for (const url of urls) {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      void image.decode().catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    if (botSeats.includes(currentPlayerIndex)) setViewingPlayerIndex(currentPlayerIndex);
    else if (isLocal || ownPlayerIndex === currentPlayerIndex) setViewingPlayerIndex(ownPlayerIndex);
  }, [currentPlayerIndex, ownPlayerIndex, isLocal, botSeats]);
  useEffect(() => {
    const logList = document.querySelector<HTMLElement>('.far-right-rail .log-list');
    if (logList) logList.scrollTop = logList.scrollHeight;
  }, [G.log[0]]);
  const me = G.players[viewingPlayerIndex] ?? currentPlayer;
  const viewingScoring = scoreBreakdown(me, G.expansionEnabled ? G.expansion?.players[viewingPlayerIndex] : undefined);
  const isViewingCurrent = viewingPlayerIndex === currentPlayerIndex;
  const isViewingOwn = viewingPlayerIndex === ownPlayerIndex;
  const action = G.pending;
  const activePlayer = action ? G.players[Number(action.player)] : currentPlayer;
  const garden = gardenCells;
  const activeSeat = Number(ctx.currentPlayer);
  const isBotTurn = botSeats.includes(activeSeat) && G.phase !== 'finished';
  const sharedActiveBotSearch = sharedBotSearches.find(search => search.playerID === activeSeat && Date.now() - search.updatedAt < 12000);
  const activeBotSearch = botSearchStatus?.playerID === activeSeat ? botSearchStatus : sharedActiveBotSearch?.thinking ? sharedActiveBotSearch : undefined;
  const canControlTurn = ownsCurrentTurn && !isBotTurn && !onlineVoteState.passed;
  const isExpansionStoreSetup = G.phase === 'setup' && G.setupStage === 'expansion-stores' && !!G.expansion;
  const activeExpansionBoard = G.expansion?.players[activeSeat];
  const canConfigureExpansionStores = isExpansionStoreSetup && isViewingCurrent && canControlTurn && !G.confirmationKind && !G.expansion?.storeSetupReady?.[activeSeat];
  useEffect(() => { setSelectedExpansionStoreId(null); previousUnplacedExpansionStores.current = null; lastPlacedExpansionStoreId.current = null; }, [activeSeat, isExpansionStoreSetup]);
  useEffect(() => {
    if (!isExpansionStoreSetup || !activeExpansionBoard) {
      setSelectedExpansionStoreId(null);
      previousUnplacedExpansionStores.current = null;
      return;
    }
    const unplaced = Array.from({ length: 7 }, (_, index) => index + 1).filter(id => !activeExpansionBoard.hutStoreTiles.includes(id));
    const previous = previousUnplacedExpansionStores.current;
    const returnedIds = previous ? unplaced.filter(id => !previous.includes(id)) : [];
    const returnedByUndo = returnedIds.includes(lastPlacedExpansionStoreId.current ?? -1) ? lastPlacedExpansionStoreId.current! : returnedIds[0];
    if (returnedIds.length) lastPlacedExpansionStoreId.current = null;
    setSelectedExpansionStoreId(current => returnedByUndo ?? (current !== null && unplaced.includes(current) ? current : unplaced[0] ?? null));
    previousUnplacedExpansionStores.current = unplaced;
  }, [activeSeat, isExpansionStoreSetup, activeExpansionBoard?.hutStoreTiles.join(',')]);
  const expansionStorePrompt = G.expansion?.storePrompts?.[0];
  const [selectedStoreCargoKind, setSelectedStoreCargoKind] = useState<ExpansionCargo | null>(null);
  const [pendingStoreCargoPlacements, setPendingStoreCargoPlacements] = useState<{ kind: ExpansionCargo; slot: number }[]>([]);
  useEffect(() => {
    setPendingStoreCargoPlacements([]);
    const hasBarrel = !!expansionStorePrompt && (G.expansion?.barrelSupply ?? 0) > 0;
    const hasStraw = !!expansionStorePrompt && (G.expansion?.strawSupply ?? 0) > 0;
    setSelectedStoreCargoKind(hasBarrel ? 'barrel' : hasStraw ? 'straw' : null);
  }, [expansionStorePrompt?.playerIndex, expansionStorePrompt?.hutIndex, expansionStorePrompt?.tileId]);
  const storePromptBoard = expansionStorePrompt ? G.expansion?.players[expansionStorePrompt.playerIndex] : undefined;
  const availableStoreCargoKinds: ExpansionCargo[] = expansionStorePrompt?.tileId === 7
    ? (['barrel', 'straw'] as const).filter(kind => kind === 'barrel'
      ? (G.expansion?.barrelSupply ?? 0) > 0 && !pendingStoreCargoPlacements.some(item => item.kind === kind)
      : (G.expansion?.strawSupply ?? 0) > 0 && !pendingStoreCargoPlacements.some(item => item.kind === kind))
    : [];
  const storeCargoSlots = storePromptBoard ? emptyExpansionStorageSlots(storePromptBoard).filter(slot => !pendingStoreCargoPlacements.some(item => item.slot === slot)) : [];
  const storeTemporaryAvailable = !!storePromptBoard && !storePromptBoard.temporaryStorage && (G.players[expansionStorePrompt?.playerIndex ?? -1]?.coins ?? 0) >= 4 && !pendingStoreCargoPlacements.some(item => item.slot === -1);
  const selectStoreCargoSlot = (slot: number) => {
    const chosenKind = selectedStoreCargoKind ?? availableStoreCargoKinds[0];
    if (!canControlTurn || !chosenKind || !availableStoreCargoKinds.includes(chosenKind)) return;
    setPendingStoreCargoPlacements(current => [...current, { kind: chosenKind, slot }]);
    const remaining = availableStoreCargoKinds.filter(kind => kind !== chosenKind);
    setSelectedStoreCargoKind(remaining[0] ?? null);
  };
  const finishStoreCargoPlacement = () => {
    if (!canControlTurn || expansionStorePrompt?.tileId !== 7 || !pendingStoreCargoPlacements.length) return;
    moves.resolveExpansionStore('front', pendingStoreCargoPlacements.map(item => item.kind), pendingStoreCargoPlacements.map(item => item.slot));
  };
  const expansionStoreEffects: Record<number, string> = {
    1: '推车骰子每次移动永久 +2 格。', 2: '推车骰子每次移动永久 +3 格。',
    3: '选择覆盖一个尚未升级的酒馆计分格；之后每桶得 5 分。', 4: '选择覆盖一个尚未升级的酒馆计分格；之后每桶得 6 分。',
    5: '立即推动推车 4 格，不加骰子奖励。', 6: '立即推动推车 6 格，不加骰子奖励。',
    7: '从供应堆拿 1 桶桶装酒和/或 1 捆干草，可放入常规格；也可放临时格，每个支付 4 钱币。',
  };
  const expansionHutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
  const humanPlayerSeats = G.players.map((_, index) => index).filter(index => !botSeats.includes(index));
  const canMove = canControlTurn && !action && !G.confirmationKind && !G.privilegePrompts.length && !currentPlayer.retired && G.phase === 'play';
  const trackMove = (index: number) => { if (!canMove || !canMoveTo(G, currentPlayer, index)) return 0; const moveTime = animateMeepleMove(currentPlayerIndex, index); const barrelTime = G.track[index]?.type === 'barrel' ? animateBarrels(currentPlayerIndex) : 0; moves.moveTo(index); setSelectedTileId(null); return Math.max(moveTime, barrelTime); };
  const currentActionSpace = action ? G.track[action.space] : null;
  const expansionCargoPile = action && G.expansion ? G.expansion.cargoByTrackSpace[action.space] ?? [] : [];
  const expansionBoardCargoPlacement = expansionStorePrompt?.tileId === 7 && canControlTurn && viewingPlayerIndex === expansionStorePrompt.playerIndex
    ? { kind: selectedStoreCargoKind ?? availableStoreCargoKinds[0] ?? 'barrel' as ExpansionCargo, slots: storeCargoSlots, temporaryAvailable: storeTemporaryAvailable, pending: pendingStoreCargoPlacements, onSelectSlot: selectStoreCargoSlot }
    : action?.baseDone && !action.cargoDone && selectedExpansionCargoKind && expansionCargoPile.includes(selectedExpansionCargoKind)
      ? { kind: selectedExpansionCargoKind, slots: activeExpansionBoard ? emptyExpansionStorageSlots(activeExpansionBoard) : [], temporaryAvailable: !!activeExpansionBoard && !activeExpansionBoard.temporaryStorage && activePlayer.coins >= 4, pending: [], onSelectSlot: (slot: number) => moves.takeExpansionCargo(selectedExpansionCargoKind, slot) }
      : undefined;
  const hasStorableCargoRemaining = !!activeExpansionBoard && expansionCargoPile.length > 0 && (emptyExpansionStorageSlots(activeExpansionBoard).length > 0 || (!activeExpansionBoard.temporaryStorage && activePlayer.coins >= 4));
  const remainingCargoReminder = [
    expansionCargoPile.filter(kind => kind === 'barrel').length ? `桶装酒 ${expansionCargoPile.filter(kind => kind === 'barrel').length} 桶` : '',
    expansionCargoPile.filter(kind => kind === 'straw').length ? `干草 ${expansionCargoPile.filter(kind => kind === 'straw').length} 捆` : '',
  ].filter(Boolean).join('、');
  useEffect(() => {
    if (action?.baseDone && !action.cargoDone && expansionCargoPile.length) {
      if (!selectedExpansionCargoKind || !expansionCargoPile.includes(selectedExpansionCargoKind)) setSelectedExpansionCargoKind(expansionCargoPile[0] ?? null);
    } else if (selectedExpansionCargoKind) setSelectedExpansionCargoKind(null);
  }, [selectedExpansionCargoKind, action?.space, action?.baseDone, action?.cargoDone, state._stateID]);
  const canTakeCargoHere = !!action && canTakeExpansionCargo(G, activePlayer, action.space);
  const canUseCartHere = !!action && !!G.expansion && G.expansion.cartDieSpace === action.space && action.cartDone === false;
  const activeShedChoice = G.shedChoices[0];
  const market = action?.type === 'resource' ? G.resources[currentActionSpace?.sourceIndex ?? -1] : action?.type === 'monk' ? G.monks[currentActionSpace?.sourceIndex ?? -1] : [];
  const selectedTile = market?.find(tile => tile.id === selectedTileId) ?? market?.[0];
  const canPlace = canControlTurn && isViewingCurrent && !expansionStorePrompt && !!action && !action.baseDone && ['resource', 'monk'].includes(action.type) && !!selectedTile;
  const executeGameAction = (kind: 'undoStep' | 'undoAction' | 'confirmAction') => {
    if (kind === 'undoStep') {
      reverseCartMotionRef.current = true;
      undoStepTargetStateIdRef.current = Number(state._stateID) + 1;
      const snapshots = G.stepUndoSnapshots ?? [];
      const snapshotJson = snapshots[snapshots.length - 1];
      if (snapshotJson) {
        const snapshot = JSON.parse(snapshotJson) as AleState;
        const movedMarkers = new Set<string>();
        G.players.forEach((player, playerIndex) => {
          const previous = snapshot.players[playerIndex];
          if (!previous) return;
          if (player.position !== previous.position || player.startSlot !== previous.startSlot) movedMarkers.add(movementTrailKey('meeple', playerIndex));
          if (player.brewer !== previous.brewer) movedMarkers.add(movementTrailKey('brewer-marker', playerIndex));
          resources.forEach(resource => {
            if (player.tracks[resource] !== previous.tracks[resource]) movedMarkers.add(movementTrailKey('resource-marker', playerIndex, resource));
          });
        });
        G.expansion?.players.forEach((board, playerIndex) => {
          if (board.cartPosition !== snapshot.expansion?.players[playerIndex]?.cartPosition) movedMarkers.add(movementTrailKey('cart', playerIndex));
        });
        if (movedMarkers.size) setMovementTrails(current => {
          const remaining = [...current];
          for (const key of movedMarkers) {
            let lastIndex = -1;
            for (let index = remaining.length - 1; index >= 0; index--) {
              if (movementTrailKey(remaining[index].kind, remaining[index].playerIndex, remaining[index].resourceKey) === key) { lastIndex = index; break; }
            }
            if (lastIndex >= 0) remaining.splice(lastIndex, 1);
          }
          return remaining;
        });
      }
    } else if (kind === 'undoAction') reverseCartMotionRef.current = true;
    if (kind === 'undoStep') moves.undoStep();
    else if (kind === 'undoAction') moves.undoAction();
    else moves.confirmAction();
    if (kind === 'undoAction') setMovementTrails([]);
    if (kind !== 'confirmAction') { setSelectedTileId(null); setPrivilegeCardChoice(null); }
  };
  const requestGameAction = (kind: 'undoStep' | 'undoAction' | 'confirmAction') => {
    if (!canControlTurn) return;
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
    const durationMs = data.pathPoints?.length
      ? kind === 'meeple'
        ? Math.min(500, Math.max(160, (data.pathPoints.length - 1) * 28))
        : Math.min(2800, Math.max(760, (data.pathPoints.length - 1) * 165))
      : kind === 'coin' ? 680 : 980;
    const flight: PieceFlight = { id, kind, left: from.left, top: from.top, width: from.width, height: from.height, dx: target.left + target.width / 2 - (from.left + from.width / 2), dy: target.top + target.height / 2 - (from.top + from.height / 2), scale, durationMs, started: false, ...data };
    const reversingStepUndo = undoStepTargetStateIdRef.current === state._stateID;
    const pathPoints = flight.pathPoints;
    setPieceFlights(current => [...current, flight]);
    if (!reversingStepUndo && pathPoints && pathPoints.length > 1) setMovementTrails(current => [...current, { id, kind, playerIndex: flight.playerIndex, resourceKey: flight.resourceKey, pathPoints, durationMs, started: false, scrollX: window.scrollX, scrollY: window.scrollY }]);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setPieceFlights(current => current.map(item => item.id === id ? { ...item, started: true } : item));
      setMovementTrails(current => current.map(item => item.id === id ? { ...item, started: true } : item));
    }));
    const duration = flight.durationMs ?? 980, delay = data.delayMs ?? 0, total = duration + delay + 140;
    window.setTimeout(() => setPieceFlights(current => current.filter(item => item.id !== id)), total);
    return total;
  };
  const startPieceFlightFromRects = (kind: PieceFlight['kind'], from: { left: number; top: number; width: number; height: number }, target: { left: number; top: number; width: number; height: number }, data: Partial<PieceFlight> = {}) => {
    if (from.width < 2 || from.height < 2 || target.width < 2 || target.height < 2) return 0;
    const scale = Math.min(target.width / from.width, target.height / from.height);
    const id = `${kind}-${Date.now()}-${Math.random()}`;
    const durationMs = data.pathPoints?.length
      ? kind === 'meeple'
        ? Math.min(500, Math.max(160, (data.pathPoints.length - 1) * 28))
        : Math.min(2800, Math.max(760, (data.pathPoints.length - 1) * 165))
      : 980;
    const flight: PieceFlight = { id, kind, left: from.left, top: from.top, width: from.width, height: from.height, dx: target.left + target.width / 2 - (from.left + from.width / 2), dy: target.top + target.height / 2 - (from.top + from.height / 2), scale, durationMs, started: false, ...data };
    const reversingStepUndo = undoStepTargetStateIdRef.current === state._stateID;
    const pathPoints = flight.pathPoints;
    setPieceFlights(current => [...current, flight]);
    if (!reversingStepUndo && pathPoints && pathPoints.length > 1) setMovementTrails(current => [...current, { id, kind, playerIndex: flight.playerIndex, resourceKey: flight.resourceKey, pathPoints, durationMs, started: false, scrollX: window.scrollX, scrollY: window.scrollY }]);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setPieceFlights(current => current.map(item => item.id === id ? { ...item, started: true } : item));
      setMovementTrails(current => current.map(item => item.id === id ? { ...item, started: true } : item));
    }));
    const duration = flight.durationMs ?? 980, delay = data.delayMs ?? 0, total = duration + delay + 140;
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
    let pathPoints: MotionPoint[] | undefined;
    if (targetTrackIndex !== undefined) {
      pathPoints = [{ x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 }];
      const step = player.position < targetTrackIndex ? 1 : -1;
      for (let index = player.position < 0 ? 0 : player.position + step; step > 0 ? index <= targetTrackIndex : index >= targetTrackIndex; index += step) {
        const rect = document.querySelector<HTMLElement>(`[data-track-index="${index}"]`)?.getBoundingClientRect();
        if (rect) pathPoints.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }
    }
    return startPieceFlight('meeple', source, targetRect, { playerIndex, playerName: player.name, playerColor: player.color, targetTrackIndex, targetStartSlot, pathPoints });
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
      const markerRect = (value: number, widthRatio: number, heightRatio: number, offset: [number, number] = [0, 0], scale = 1) => {
        const point = productionTrackPositions[value]; if (!point) return null;
        const width = rect.width * widthRatio * scale, height = rect.height * heightRatio * scale;
        return { left: rect.left + rect.width * (point.left + offset[0]) / 100 - width / 2, top: rect.top + rect.height * (point.top + offset[1]) / 100 - height / 2, width, height };
      };
      const markerCluster = (key: Resource | 'brewer', value: number, snapshot: typeof current[number]) => {
        const markers = [...resources.map(resource => ({ key: resource, value: snapshot.tracks[resource] })), { key: 'brewer' as const, value: snapshot.brewer }];
        const group = markers.filter(marker => marker.value === value);
        return { offset: markerClusterOffset(group.findIndex(marker => marker.key === key), group.length), scale: markerClusterScale(group.length, value) };
      };
      const markerMotion = (key: Resource | 'brewer', fromValue: number, toValue: number, widthRatio: number, heightRatio: number) => {
        const fromCluster = markerCluster(key, fromValue, old), toCluster = markerCluster(key, toValue, now);
        const from = markerRect(fromValue, widthRatio, heightRatio, fromCluster.offset, fromCluster.scale);
        const to = markerRect(toValue, widthRatio, heightRatio, toCluster.offset, toCluster.scale);
        if (!from || !to) return null;
        const center = (value: number, offset: [number, number]) => {
          const position = markerRect(value, widthRatio, heightRatio, offset);
          return position ? { x: position.left + position.width / 2, y: position.top + position.height / 2 } : null;
        };
        const points: MotionPoint[] = [{ x: from.left + from.width / 2, y: from.top + from.height / 2 }];
        const step = fromValue < toValue ? 1 : -1;
        for (let value = fromValue + step; step > 0 ? value <= toValue : value >= toValue; value += step) {
          const offset = value === toValue ? toCluster.offset : [0, 0] as [number, number];
          const point = center(value, offset);
          if (point) points.push(point);
        }
        return { from, to, pathPoints: points };
      };
      resources.forEach(resource => {
        if (old.tracks[resource] === now.tracks[resource]) return;
        const motion = markerMotion(resource, old.tracks[resource], now.tracks[resource], .06, .06);
        if (motion) startPieceFlightFromRects('resource-marker', motion.from, motion.to, { playerIndex, resourceKey: resource, pathPoints: motion.pathPoints });
      });
      if (old.brewer !== now.brewer) {
        const motion = markerMotion('brewer', old.brewer, now.brewer, .06, .09);
        if (motion) startPieceFlightFromRects('brewer-marker', motion.from, motion.to, { playerIndex, playerColor: G.players[playerIndex].color, pathPoints: motion.pathPoints });
      }
    }
  }, [state._stateID, viewingPlayerIndex]);
  const expansionSnapshotRef = React.useRef<any>(null);
  useLayoutEffect(() => {
    const expansion = G.expansion;
    const current = expansion ? {
      dieSpace: expansion.cartDieSpace,
      dieValue: expansion.cartDieValue,
      cargoByTrackSpace: expansion.cargoByTrackSpace.map((pile: ExpansionCargo[]) => [...pile]),
      pending: G.pending ? { space: G.pending.space, cargoTaken: G.pending.cargoTaken ?? 0 } : null,
      players: expansion.players.map((board: ExpansionPlayerBoard, playerIndex: number) => ({
        coins: G.players[playerIndex]?.coins ?? 0,
        storage: [...board.storage], temporaryStorage: board.temporaryStorage,
        cartPosition: board.cartPosition, cartBarrels: board.cartBarrels,
        breweryDeliveries: [...board.breweryDeliveries], deliveredBarrels: board.deliveredBarrels,
      })),
    } : null;
    const previous = expansionSnapshotRef.current;
    expansionSnapshotRef.current = current;
    if (!previous || !current || !G.expansionEnabled) return;

    const centeredRect = (rect: DOMRect, width: number, height = width) => ({
      left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2,
      width, height,
    });
    const trackRect = (index: number, size = 28) => {
      const element = document.querySelector<HTMLElement>(`[data-track-index="${index}"]`);
      const rect = element?.getBoundingClientRect();
      return rect && rect.width > 1 ? centeredRect(rect, Math.min(size, rect.width * .55)) : null;
    };
    const routeRect = (playerIndex: number, routeIndex: number, size = 38) => {
      const board = document.querySelector<HTMLElement>(`.expansion-transport-board[data-transport-player-index="${playerIndex}"]`);
      const location = cartRoute[routeIndex], rect = board?.getBoundingClientRect();
      if (!rect || !location) return null;
      const diameter = Math.min(size, rect.width * .12);
      return { left: rect.left + rect.width * location.left / 100 - diameter / 2, top: rect.top + rect.height * location.top / 100 - diameter / 2, width: diameter, height: diameter };
    };
    const reverseCartMotion = reverseCartMotionRef.current;
    reverseCartMotionRef.current = false;
    const routeMotion = (playerIndex: number, fromIndex: number, toIndex: number, reverse = false) => {
      const firstRect = routeRect(playerIndex, fromIndex, 38), lastRect = routeRect(playerIndex, toIndex, 38);
      if (!firstRect || !lastRect) return null;
      const points: MotionPoint[] = [{ x: firstRect.left + firstRect.width / 2, y: firstRect.top + firstRect.height / 2 }];
      let index = fromIndex;
      for (let step = 0; step < cartRoute.length && index !== toIndex; step++) {
        index = (index + (reverse ? -1 : 1) + cartRoute.length) % cartRoute.length;
        const rect = routeRect(playerIndex, index, 38);
        if (rect) points.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }
      return { from: firstRect, to: lastRect, pathPoints: points };
    };
    const trackCargoRect = (spaceIndex: number, kind: ExpansionCargo) => {
      const selector = kind === 'barrel'
        ? `[data-track-index="${spaceIndex}"] .expansion-track-cargo-token.barrel`
        : `[data-track-index="${spaceIndex}"] .expansion-cargo-token.straw-icon`;
      const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      if (rect && rect.width > 1 && rect.height > 1) {
        const width = rect.width / .75, height = rect.height / .75;
        return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
      }
      return trackRect(spaceIndex, kind === 'barrel' ? 27 : 33);
    };
    const storageRect = (playerIndex: number, slot: number, temporary = false, size = Number.POSITIVE_INFINITY) => {
      const selector = temporary
        ? `.expansion-transport-board[data-transport-player-index="${playerIndex}"] [data-temporary-storage-marker]`
        : `.expansion-transport-board[data-transport-player-index="${playerIndex}"] [data-expansion-storage-index="${slot}"]`;
      const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      return rect && rect.width > 1 ? centeredRect(rect, Math.min(size, rect.width), Math.min(size, rect.height)) : null;
    };

    if (previous.dieSpace !== current.dieSpace) {
      const from = trackRect(previous.dieSpace, 26), to = trackRect(current.dieSpace, 26);
      if (from && to) startPieceFlightFromRects('die', from, to, { dieValue: current.dieValue, targetTrackIndex: current.dieSpace });
    }

    for (let playerIndex = 0; playerIndex < current.players.length; playerIndex++) {
      if (playerIndex !== viewingPlayerIndex) continue;
      const old = previous.players[playerIndex], now = current.players[playerIndex];
      if (!old || !now) continue;

      const coinsSpent = (old.coins ?? 0) - (now.coins ?? 0);
      if (!old.temporaryStorage && now.temporaryStorage && coinsSpent >= 4) {
        const target = document.querySelector<HTMLElement>(`.expansion-transport-board[data-transport-player-index="${playerIndex}"] [data-temporary-storage-marker]`);
        if (target) startCoinFlights([{ element: moneyIcon(playerIndex), amount: 4 }], target);
      }

      const takenDelta = (current.pending?.cargoTaken ?? 0) - (previous.pending?.cargoTaken ?? 0);
      if (takenDelta > 0 && current.pending) {
        const spaceIndex = current.pending.space;
        for (const kind of ['barrel', 'straw'] as const) {
          const oldCount = previous.cargoByTrackSpace[spaceIndex]?.filter((item: ExpansionCargo) => item === kind).length ?? 0;
          const newCount = current.cargoByTrackSpace[spaceIndex]?.filter((item: ExpansionCargo) => item === kind).length ?? 0;
          const gainedCount = oldCount - newCount;
          if (gainedCount <= 0) continue;
          const source = trackCargoRect(spaceIndex, kind);
          const targetSlots = now.storage.flatMap((item: ExpansionCargo | null, index: number) => item === kind && old.storage[index] !== kind ? [index] : []);
          const toTemporary = now.temporaryStorage === kind && old.temporaryStorage !== kind;
          const targets = targetSlots.map(slot => ({ slot, temporary: false }));
          if (toTemporary) targets.push({ slot: -1, temporary: true });
          targets.slice(0, gainedCount).forEach(({ slot, temporary }, index) => {
            const target = storageRect(playerIndex, slot, temporary);
            if (source && target) startPieceFlightFromRects('expansion-cargo', source, target, { cargoKind: kind, playerIndex, targetStorageIndex: slot >= 0 ? slot : undefined, targetTemporaryStorage: temporary, delayMs: index * 90 });
          });
        }
      }

      const loadedBarrels = Math.max(0, now.cartBarrels - old.cartBarrels);
      if (loadedBarrels > 0) {
        const cartTarget = routeRect(playerIndex, now.cartPosition, 38);
        let animated = 0;
        old.storage.forEach((item: ExpansionCargo | null, index: number) => {
          if (item !== 'barrel' || now.storage[index] !== null || !cartTarget || animated >= loadedBarrels) return;
          const source = storageRect(playerIndex, index);
          if (source) startPieceFlightFromRects('expansion-cargo', source, cartTarget, { cargoKind: 'barrel', playerIndex, sourceStorageIndex: index });
          animated++;
        });
        if (old.temporaryStorage === 'barrel' && now.temporaryStorage !== 'barrel' && cartTarget && animated < loadedBarrels) {
          const source = storageRect(playerIndex, -1, true);
          if (source) startPieceFlightFromRects('expansion-cargo', source, cartTarget, { cargoKind: 'barrel', playerIndex, sourceTemporaryStorage: true });
        }
        let strawAnimated = 0;
        old.storage.forEach((item: ExpansionCargo | null, index: number) => {
          if (item !== 'straw' || now.storage[index] !== null || strawAnimated >= loadedBarrels) return;
          const source = storageRect(playerIndex, index), gateTarget = routeRect(playerIndex, 0, 28);
          if (source && gateTarget) startPieceFlightFromRects('expansion-cargo', source, gateTarget, { cargoKind: 'straw', playerIndex, sourceStorageIndex: index });
          strawAnimated++;
        });
        if (old.temporaryStorage === 'straw' && now.temporaryStorage !== 'straw' && strawAnimated < loadedBarrels) {
          const source = storageRect(playerIndex, -1, true), gateTarget = routeRect(playerIndex, 0, 28);
          if (source && gateTarget) startPieceFlightFromRects('expansion-cargo', source, gateTarget, { cargoKind: 'straw', playerIndex, sourceTemporaryStorage: true });
        }
      }

      if (old.cartPosition !== now.cartPosition) {
        const motion = routeMotion(playerIndex, old.cartPosition, now.cartPosition, reverseCartMotion);
        if (motion) startPieceFlightFromRects('cart', motion.from, motion.to, { playerIndex, cargoCount: now.cartBarrels, targetRouteIndex: now.cartPosition, pathPoints: motion.pathPoints });
      }

      now.breweryDeliveries.forEach((count: number, breweryIndex: number) => {
        const delivered = count - (old.breweryDeliveries[breweryIndex] ?? 0);
        if (delivered <= 0) return;
        const from = routeRect(playerIndex, old.cartPosition, 28), to = routeRect(playerIndex, 9 + breweryIndex, 30);
        if (from && to) for (let barrel = 0; barrel < delivered; barrel++) startPieceFlightFromRects('expansion-cargo', from, to, { cargoKind: 'barrel', playerIndex, targetRouteIndex: 9 + breweryIndex, delayMs: barrel * 90 });
      });
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
    const aspect = source.naturalWidth / Math.max(1, source.naturalHeight);
    const slot = board.querySelector<HTMLElement>(`[data-privilege-target-index="${pairIndex}"]`);
    const measuredTarget = slot?.getBoundingClientRect();
    const boardLeft = boardRect.left + board.clientLeft, boardTop = boardRect.top + board.clientTop;
    const boardWidth = board.clientWidth, boardHeight = board.clientHeight;
    const height = boardHeight * position.height / 100;
    const width = height * aspect;
    const target = measuredTarget && measuredTarget.width > 2 && measuredTarget.height > 2
      ? { left: measuredTarget.left, top: measuredTarget.top, width: measuredTarget.width, height: measuredTarget.height }
      : { left: boardLeft + boardWidth - width * .18 - width, top: boardTop + boardHeight * position.top / 100 - height / 2, width, height };
    // The hand thumbnail is cropped into a tall slot, while the board card is
    // landscape. Start with a fitted landscape rect so the flight keeps the
    // card's 1.6:1 shape and lands at the exact clipped board-card bounds.
    const flightHeight = Math.min(sourceRect.height, sourceRect.width / aspect);
    const flightWidth = flightHeight * aspect;
    const from = { left: sourceRect.left + (sourceRect.width - flightWidth) / 2, top: sourceRect.top + (sourceRect.height - flightHeight) / 2, width: flightWidth, height: flightHeight };
    return startPieceFlightFromRects('privilege-card', from, target, { card, pairIndex, playerIndex });
  };
  const animateStorePlacement = (playerIndex: number, storeId: number, targetIndex: number) => {
    const board = G.expansion?.players[playerIndex], hutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
    const sourceSlot = board?.hutStoreTiles.indexOf(storeId) ?? -1;
    const sourceIndex = sourceSlot >= 0 ? hutIndexes[sourceSlot] : undefined;
    const sourceBoardCell = sourceIndex === undefined ? null : document.querySelector<HTMLElement>(`.garden-board[data-player-board-index="${playerIndex}"] [data-garden-index="${sourceIndex}"] .expansion-hut-store`);
    const source = sourceBoardCell || document.querySelector<HTMLElement>(`.expansion-store-tile[data-expansion-store-id="${storeId}"] img`);
    const boardSelector = `.garden-board[data-player-board-index="${playerIndex}"]`;
    const targetCell = document.querySelector<HTMLElement>(`${boardSelector} [data-garden-index="${targetIndex}"]`);
    const targetRect = targetCell?.getBoundingClientRect();
    if (!targetRect) return 0;
    const width = targetRect.width * .8, height = targetRect.height * .8;
    const target = { left: targetRect.left + (targetRect.width - width) / 2, top: targetRect.top + (targetRect.height - height) / 2, width, height };
    let duration = startPieceFlight('store-card', source, target, { storeId, sourceIndex, targetIndex, playerIndex });
    const targetSlot = hutIndexes.indexOf(targetIndex), displacedStoreId = board?.hutStoreTiles[targetSlot] ?? null;
    if (sourceIndex !== undefined && displacedStoreId !== null && sourceIndex !== targetIndex) {
      const reverseSource = document.querySelector<HTMLElement>(`${boardSelector} [data-garden-index="${targetIndex}"] .expansion-hut-store`);
      const reverseTargetCell = document.querySelector<HTMLElement>(`${boardSelector} [data-garden-index="${sourceIndex}"]`), reverseRect = reverseTargetCell?.getBoundingClientRect();
      if (reverseRect) duration = Math.max(duration, startPieceFlight('store-card', reverseSource, { left: reverseRect.left + (reverseRect.width - width) / 2, top: reverseRect.top + (reverseRect.height - height) / 2, width, height }, { storeId: displacedStoreId, sourceIndex: targetIndex, targetIndex: sourceIndex, playerIndex }));
    }
    return duration;
  };
  const randomizeRemainingExpansionStores = () => {
    const board = G.expansion?.players[activeSeat];
    if (!canConfigureExpansionStores || !board) return;
    const hutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
    const emptySlots = board.hutStoreTiles.flatMap((id, slot) => id === null ? [slot] : []);
    const tileIds = Array.from({ length: 7 }, (_, index) => index + 1).filter(id => !board.hutStoreTiles.includes(id));
    if (!emptySlots.length || emptySlots.length !== tileIds.length) return;
    for (let index = tileIds.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [tileIds[index], tileIds[swapIndex]] = [tileIds[swapIndex], tileIds[index]];
    }
    lastPlacedExpansionStoreId.current = null;
    tileIds.forEach((tileId, index) => animateStorePlacement(activeSeat, tileId, hutIndexes[emptySlots[index]]));
    moves.placeRemainingExpansionStoreTiles(tileIds);
    setSelectedExpansionStoreId(null);
  };
  const placeExpansionStoreTarget = (hutIndex: number, clickedStoreId?: number) => {
    const board = G.expansion?.players[activeSeat], selected = selectedExpansionStoreId;
    if (!canConfigureExpansionStores || !board) return;
    if (!selected) { if (clickedStoreId) setSelectedExpansionStoreId(clickedStoreId); return; }
    if (clickedStoreId === selected) { setSelectedExpansionStoreId(null); return; }
    const hutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
    const targetSlot = hutIndexes.indexOf(hutIndex);
    if (targetSlot < 0) return;
    const wasUnplaced = !board.hutStoreTiles.includes(selected);
    const targetWasEmpty = board.hutStoreTiles[targetSlot] === null;
    if (!wasUnplaced) {
      animateStorePlacement(activeSeat, selected, hutIndex);
      moves.assignExpansionStoreTile(hutIndex, selected);
      setSelectedExpansionStoreId(null);
      return;
    }
    lastPlacedExpansionStoreId.current = selected;

    const remainingIds = Array.from({ length: 7 }, (_, index) => index + 1).filter(id => !board.hutStoreTiles.includes(id) && id !== selected);
    if (clickedStoreId && !remainingIds.includes(clickedStoreId)) remainingIds.push(clickedStoreId);
    const remainingEmptyHuts = board.hutStoreTiles.flatMap((id, slot) => id === null && slot !== targetSlot ? [hutIndexes[slot]] : []);
    if (targetWasEmpty && remainingIds.length === 1 && remainingEmptyHuts.length === 1) {
      animateStorePlacement(activeSeat, selected, hutIndex);
      animateStorePlacement(activeSeat, remainingIds[0], remainingEmptyHuts[0]);
      moves.assignExpansionStoreTile(hutIndex, selected, remainingEmptyHuts[0], remainingIds[0]);
      setSelectedExpansionStoreId(null);
      return;
    }
    animateStorePlacement(activeSeat, selected, hutIndex);
    moves.assignExpansionStoreTile(hutIndex, selected);
    setSelectedExpansionStoreId(remainingIds[0] ?? null);
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
  const startScoreFlight = (scoreIndex: number, sourceScoreIndex: number, playerIndex: number) => {
    const source = [...document.querySelectorAll<HTMLElement>('[data-score-source-index]')].find(element => element.dataset.scoreSourceIndex === String(sourceScoreIndex));
    const board = document.querySelector<HTMLElement>(`.right-rail .garden-board[data-player-board-index="${playerIndex}"]`)?.getBoundingClientRect();
    const point = scoringDiscPositions[scoreIndex];
    const targetSize = board ? board.width * .05 : 0;
    const target = board && point ? { left: board.left + board.width * point.left / 100 - targetSize / 2, top: board.top + board.height * point.top / 100 - targetSize / 2, width: targetSize, height: targetSize } : null;
    return startPieceFlight('disc', source || null, target, { scoreIndex, playerIndex });
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
    if (isLocal && botSeats.includes(playerIndex) && current.G.expansionEnabled && ['takeExpansionCargo', 'chooseExpansionCartLoad', 'useExpansionCart', 'resolveExpansionStore'].includes(decision.name)) setViewingPlayerIndex(playerIndex);
    if (decision.name === 'assignExpansionStoreLayout') {
      const tileIds = decision.args[0] as number[], hutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
      return tileIds.reduce((duration, tileId, slot) => Math.max(duration, animateStorePlacement(playerIndex, tileId, hutIndexes[slot])), 0);
    }
    if (decision.name === 'assignExpansionStoreTile') {
      const hutIndex = Number(decision.args[0]), tileId = Number(decision.args[1]);
      let duration = animateStorePlacement(playerIndex, tileId, hutIndex);
      if (decision.args[2] !== undefined && decision.args[3] !== undefined)
        duration = Math.max(duration, animateStorePlacement(playerIndex, Number(decision.args[3]), Number(decision.args[2])));
      return duration;
    }
    if (decision.name === 'placeRemainingExpansionStoreTiles') {
      const board = current.G.expansion?.players[playerIndex], hutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
      const slots = board?.hutStoreTiles.flatMap((tile: number | null, slot: number) => tile === null ? [slot] : []) ?? [];
      return (decision.args[0] as number[]).reduce((duration, tileId, index) => Math.max(duration, animateStorePlacement(playerIndex, tileId, hutIndexes[slots[index]])), 0);
    }
    if (decision.name === 'buyTile') return animateBotTilePlacement(String(decision.args[0]), Number(decision.args[1]));
    if (decision.name === 'takeScore') {
      const category = String(decision.args[0]), option = String(decision.args[1]);
      const index = category === 'A' ? 0 : category === 'C' ? 1 + resources.indexOf(option as Resource) : 6 + monkNames.indexOf(option);
      const discTime = startScoreFlight(index, current.G.track[current.G.pending?.space ?? -1]?.sourceIndex ?? -1, playerIndex);
      const coinTime = animateActivationCoins(player, playerIndex, scoreActivationCells(player, category, option));
      return Math.max(discTime, coinTime);
    }
    if (decision.name === 'completeShedChoice') {
      const selected = Array.isArray(decision.args[0]) ? decision.args[0] as number[] : current.G.shedChoices[0]?.selected ?? [];
      return Math.max(1120, animateActivationCoins(player, playerIndex, selected));
    }
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
    if (decision.name === 'takeExpansionCargo' || decision.name === 'chooseExpansionCartLoad' || decision.name === 'useExpansionCart') return 1120;
    if (decision.name === 'resolveExpansionStore' && [5, 6].includes(Number(current.G.expansion?.storePrompts?.[0]?.tileId))) return 1120;
    if (decision.name === 'confirmAction' && current.G.confirmationKind !== 'free' && current.G.expansionEnabled && current.G.expansion) {
      const expansion = current.G.expansion;
      const playerStoppedOnDie = player.position === expansion.cartDieSpace;
      const everybodyPassed = current.G.players.every((p: any) => p.retired || p.position >= expansion.cartDieSpace);
      if (playerStoppedOnDie || everybodyPassed) return 1120;
    }
    return 0;
  };
  const placeTile = (index: number) => {
    if (!canPlace || !selectedTile || action?.baseDone) return;
    animatePurchase(selectedTile, index, currentPlayerIndex, currentActionSpace?.sourceIndex);
    moves.buyTile(selectedTile.id, index); setSelectedTileId(null);
  };
  const startSlotTaken = (slot: number) => G.players.some(p => p.startSlot === slot);
  const lastToReturn = G.phase === 'play' && !!action && action.type === 'start' && G.players.every(p => p.retired || p === activePlayer);
  const forceFirstPlayerSlot = lastToReturn && !startSlotTaken(0);
  const canChooseStartSlot = (slot: number) => canControlTurn && !G.confirmationKind && !G.startChoice && !startSlotTaken(slot) && (G.phase === 'setup' ? slot !== 0 && currentPlayer.startSlot === null : action?.type === 'start' && (!forceFirstPlayerSlot || slot === 0));
  const chooseStartSlot = (slot: number) => { if (!canChooseStartSlot(slot)) return; animateMeepleMove(currentPlayerIndex, undefined, slot); animateStartSlotCoins(currentPlayerIndex, slot); moves.chooseStartSlot(slot); };
  const chooseStartResource = (resource: Resource) => { if (!canControlTurn || !G.startChoice) return; animateTrackAdvanceCoins(currentPlayerIndex, activePlayer, resource, 2); moves.chooseStartResource(resource); };
  const completeShedChoice = () => { if (!canControlTurn || !activeShedChoice || !validShedSelection(activeShedChoice)) return; animateActivationCoins(activePlayer, currentPlayerIndex, activeShedChoice.selected); moves.completeShedChoice(); };
  const currentScoreSpace = action ? G.track[action.space] : null;
  const privilegePrompt = G.privilegePrompts[0];
  const privilegeResources = privilegeCardChoice === 'A' ? resources.filter(resource => activePlayer.board.some(cell => cell.tile?.resource === resource)) : privilegeCardChoice === 'B' ? lowestResources(activePlayer) : [];
  const choosePrivilegeCard = (card: string | null) => {
    if (!canControlTurn || !privilegePrompt) return;
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
    if (!canControlTurn || !privilegeCardChoice) return;
    const steps = privilegeCardChoice === 'A' ? activePlayer.board.filter((cell: any) => cell.tile?.resource === resource).length : Number(activePlayer.scores.x !== undefined) + activePlayer.scores.resource.filter(Boolean).length + activePlayer.scores.monk.filter(Boolean).length;
    if (privilegePrompt && privilegeCardChoice) animatePrivilegePlacement(currentPlayerIndex, privilegeCardChoice, privilegePrompt.pairIndex);
    animateTrackAdvanceCoins(currentPlayerIndex, activePlayer, resource, steps);
    moves.choosePrivilege(privilegeCardChoice, resource);
    setPrivilegeCardChoice(null);
  };
  const scoreCategories: ('A' | 'B' | 'C')[] = currentScoreSpace?.scoreType === 'ABC' ? ['A', 'B', 'C'] : currentScoreSpace?.scoreType ? [currentScoreSpace.scoreType] : [];
  const selectedScoreCategory = scoreCategories.includes(scoreCategory) ? scoreCategory : scoreCategories[0] || 'A';
  const scoreOptions = scoreChoices(activePlayer, selectedScoreCategory).map(String);
  const productionScoreOptions = scoreCategories.includes('A') ? scoreChoices(activePlayer, 'A').map(String) : [];
  const monkScoreOptions = scoreCategories.includes('B') ? scoreChoices(activePlayer, 'B').map(String) : [];
  const resourceScoreOptions = scoreCategories.includes('C') ? scoreChoices(activePlayer, 'C').map(String) : [];
  const needsExplicitProductionChoice = selectedScoreCategory === 'A';
  const selectedScoreOption = scoreOptions.includes(scoreChoice) ? scoreChoice : needsExplicitProductionChoice ? '' : scoreOptions[0];
  useEffect(() => {
    setScoreChoice('');
    setScoreCategory('A');
    setShowProductionChoices(true);
  }, [action?.player, action?.space, action?.type, currentScoreSpace?.scoreType]);
  const placeScoreChoice = (category: 'A' | 'B' | 'C', choice: string) => {
    if (!canControlTurn || !scoreCategories.includes(category) || !scoreChoices(activePlayer, category).some(value => String(value) === choice)) return;
    const option = category === 'A' ? Number(choice) : choice;
    const scoreIndex = category === 'A' ? 0 : category === 'C' ? 1 + resources.indexOf(String(option) as Resource) : 6 + monkNames.indexOf(String(option));
    startScoreFlight(scoreIndex, currentScoreSpace?.sourceIndex ?? -1, currentPlayerIndex);
    animateActivationCoins(activePlayer, currentPlayerIndex, scoreActivationCells(activePlayer, category, String(option)));
    moves.takeScore(category, option);
  };
  const submitScore = () => selectedScoreOption && placeScoreChoice(selectedScoreCategory, selectedScoreOption);
  const scoreTargetIndices = action?.type === 'score' && !action.baseDone && isViewingCurrent && canControlTurn ? [
    ...(scoreCategories.includes('A') && scoreChoices(activePlayer, 'A').length ? [0] : []),
    ...(scoreCategories.includes('C') ? resources.flatMap((resource, i) => scoreChoices(activePlayer, 'C').some(value => String(value) === resource) ? [i + 1] : []) : []),
    ...(scoreCategories.includes('B') ? monkNames.flatMap((monk, i) => scoreChoices(activePlayer, 'B').some(value => String(value) === monk) ? [i + 6] : []) : []),
  ] : [];
  const placeScoreFromBoard = (index: number) => {
    if (!canControlTurn || !action || action.baseDone || action.type !== 'score') return;
    if (index === 0) {
      const choices = scoreChoices(activePlayer, 'A').map(String);
      const choice = choices.length === 1 ? choices[0] : selectedScoreCategory === 'A' && selectedScoreOption && choices.includes(selectedScoreOption) ? selectedScoreOption : '';
      if (!choice) { setToast('请先选择要激活的产值'); return; }
      if (choice) placeScoreChoice('A', choice);
      return;
    }
    if (index >= 1 && index <= 5) placeScoreChoice('C', resources[index - 1]);
    else if (index >= 6 && index <= 9) placeScoreChoice('B', monkNames[index - 6]);
  };
  const playerCount = G.players.length;
  const fallbackOrder = Array.from({ length: playerCount }, (_, index) => index);
  const isSeatOrder = (order: unknown): order is number[] => Array.isArray(order) && order.length === playerCount && new Set(order).size === playerCount && order.every(seat => Number.isInteger(seat) && seat >= 0 && seat < playerCount);
  const playerOrder = isSeatOrder(G.playerOrder) ? G.playerOrder : fallbackOrder;
  const firstOrder = isSeatOrder(G.firstRoundOrder) ? G.firstRoundOrder : [...playerOrder.slice(playerOrder.indexOf(G.startPlayer)), ...playerOrder.slice(0, playerOrder.indexOf(G.startPlayer))];
  const roundOrderStart = playerOrder.indexOf(G.startPlayer);
  const roundOrder = [...playerOrder.slice(roundOrderStart), ...playerOrder.slice(0, roundOrderStart)];
  const actionOrder = roundOrder;
  const ownOrderPosition = actionOrder.indexOf(ownPlayerIndex);
  const rosterOrder = ownOrderPosition < 0 ? actionOrder : [...actionOrder.slice(ownOrderPosition), ...actionOrder.slice(0, ownOrderPosition)];
  return <main className={`table-screen ${G.expansionEnabled ? 'expansion-enabled' : ''}`} onDragStartCapture={event => event.preventDefault()}>
    {isLocal && <BotController client={client} botSeats={botSeats} difficulty={botDifficulty} onThinking={reportBotThinking} onBeforeMove={animateBotMove} />}
    {remoteBotClients.map(({ client: botClient, seat }) => <OnlineBotDriver key={seat} client={botClient} seat={seat} name={`机器人${seat + 1}`} difficulty={remoteBotDifficulty} onThinking={reportBotThinking} onBeforeMove={animateBotMove} />)}
    {movementTrails.filter(trail => trail.started).map(trail => {
      const pathData = smoothMotionPath(trail.pathPoints);
      const offsetX = pageScroll.x - (trail.scrollX ?? 0), offsetY = pageScroll.y - (trail.scrollY ?? 0);
      return <svg key={`trail-${trail.id}`} className="movement-trail" style={{ transform: `translate(${-offsetX}px, ${-offsetY}px)` }} viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="movement-trail-line" d={pathData} pathLength={1} style={{ ['--flight-duration' as any]: `${trail.durationMs}ms` }} />
        <polygon className="movement-trail-arrow" points="-12,-8 12,0 -12,8">
          <animateMotion dur={`${trail.durationMs}ms`} path={pathData} rotate="auto" fill="freeze" />
        </polygon>
      </svg>;
    })}
    {pieceFlights.map(flight => {
      return <React.Fragment key={flight.id}>
        <div data-piece-flight-id={flight.id} className={`tile-flight ${flight.started ? flight.pathPoints ? 'path-moving' : 'is-moving' : ''} flight-${flight.kind} ${flight.kind === 'meeple' ? 'player-meeple' : flight.kind === 'resource-marker' ? 'production-marker' : flight.kind === 'brewer-marker' ? 'brewer-marker-art' : ''}`} aria-hidden="true" style={{ left: flight.left, top: flight.top, width: flight.width, height: flight.height, ['--tile-flight-x' as any]: `${flight.dx}px`, ['--tile-flight-y' as any]: `${flight.dy}px`, ['--tile-flight-scale' as any]: flight.scale, ['--flight-delay' as any]: `${flight.delayMs ?? 0}ms`, ['--flight-duration' as any]: `${flight.durationMs ?? 980}ms`, backgroundPosition: flight.kind === 'resource-marker' ? trackMarkerSpritePosition(flight.resourceKey!) : flight.kind === 'brewer-marker' ? meepleSpritePosition(flight.playerColor || 'black') : flight.kind === 'meeple' ? meepleSpritePosition(flight.playerColor || 'black') : undefined }}>{flight.kind === 'tile' && flight.tile ? <TileFace tile={flight.tile} /> : flight.kind === 'disc' ? <img src="/Images/scoring_disc.png" alt="" /> : flight.kind === 'coin' ? <i className="player-coin-icon" /> : flight.kind === 'barrel' ? <BarrelGoalArt id={flight.barrelId || 0} /> : flight.kind === 'expansion-cargo' ? flight.cargoKind === 'barrel' ? <img className="transport-cargo-token barrel-icon" src="/Images/barrel_cargo_icon.png" alt="" /> : <img className="transport-cargo-token straw-icon" src="/Images/straw_cube_icon.png" alt="" /> : flight.kind === 'cart' ? <span className="transport-cart-marker flight-cart-marker">{(flight.cargoCount ?? 0) > 0 && <span className="cart-cargo-stack">{Array.from({ length: flight.cargoCount ?? 0 }, (_, index) => <img key={index} src="/Images/barrel_cargo_icon.png" alt="" />)}</span>}<img className="cart-horse-icon" src="/Images/cart_horse_icon.png" alt="" /></span> : flight.kind === 'die' ? <DiceFace value={flight.dieValue ?? 1} /> : flight.kind === 'privilege-card' ? <img src={`/Images/privilege_card_front_${flight.card}.png`} alt="" /> : flight.kind === 'store-card' ? <img src={`/Images/store_${flight.storeId}.png`} alt="" /> : null}</div>
      </React.Fragment>;
    })}
    <header className="table-header"><div className="brand-mark small"><img src="/Images/ha-cover.png" alt="Heaven & Ale" /></div><div className="table-title"><b>天堂与美酒</b><small>{roomInfo}{roomCode && ` · 房间 ${roomCode}`}</small></div>{G.expansionEnabled && <span className="expansion-room-badge">扩展对局</span>}<div className="round-chip">第 {G.round} / {G.maxRounds} 轮</div>{G.phase === 'finished' && <button className="icon-btn final-score-reopen" onClick={() => setShowFinalScore(true)}>最终计分</button>}<button className="icon-btn" onClick={() => setShowRules(true)}>规则</button><button className="icon-btn" onClick={onExit}>回到主页</button>{G.phase !== 'finished' && !isLocal && roomCode && !onlineVoteState.passed && <button className="icon-btn abandon-vote-button" onClick={onVoteToAbandon}>{onlineVoteState.votes.includes(Number((client as any).playerID)) ? "撤回放弃票" : "投票放弃"} {onlineVoteState.votes.length}/{requiredAbandonVotes(G.players.length, botSeats)}</button>}{G.phase !== 'finished' && isLocal && <button className="icon-btn abandon-btn" onClick={() => setShowAbandonConfirm(true)}>放弃游戏</button>}</header>
    {G.phase !== 'finished' && !isLocal && roomCode && onlineVoteState.votes.length > 0 && <div className="abandon-vote-progress"><b>放弃游戏投票 · {onlineVoteState.votes.length}/{requiredAbandonVotes(G.players.length, botSeats)}</b><span>{humanPlayerSeats.map(seat => `${G.players[seat].name}：${onlineVoteState.votes.includes(seat) ? '已投票' : '未投票'}`).join('　')}</span></div>}
    {G.phase !== 'finished' && !isLocal && onlineVoteState.passed && <div className="abandon-vote-banner"><b>所有真人玩家已同意，正在删除本局和记录。</b>{isRoomHost && <button className="btn btn-gold" onClick={onLeaveAbandoned}>重试删除</button>}</div>}
    {G.phase === 'finished' && showFinalScore && <GameOverScoreModal game={G} gameover={gameover} winnerNames={winnerIds.map(id => G.players[Number(id)]?.name).filter((name): name is string => !!name)} onExit={onExit} onClose={() => setShowFinalScore(false)} />}
    <div className={`game-layout ${isBotTurn ? 'bot-thinking' : ''}`}>
      <section className="center-play"><div className="board-heading"><div><h2>主游戏版图</h2></div>{isBotTurn ? <span className="bot-thinking-pill"><i className="bot-thinking-dot" />{G.players[activeSeat]?.name} 正在思考 · 搜索 {activeBotSearch?.iterations ?? 0} 次</span> : <span className="board-tip"></span>}</div>
        <div className="main-board-wrap"><img src="/Images/main_board_clear.jpg" alt="天堂与美酒主版图" className="main-board-art" /><div className="track-overlay">
          {G.track.map((space, i) => {
            const occupants = G.players.filter((p, playerIndex) => p.position === i && Number(G.startChoice?.player ?? -1) !== playerIndex); const here = canMove && i > currentPlayer.position; const stock = space.type === 'resource' ? G.resources[space.sourceIndex ?? -1] : space.type === 'monk' ? G.monks[space.sourceIndex ?? -1] : []; const supplySpace = space.type === 'resource' || space.type === 'monk'; const good = here && canMoveTo(G, currentPlayer, i); const cargo = G.expansionEnabled ? G.expansion?.cargoByTrackSpace[i] ?? [] : []; const dieFlyingTo = pieceFlights.some(flight => flight.kind === 'die' && flight.targetTrackIndex === i); const dieHere = G.expansionEnabled && G.expansion?.cartDieSpace === i && !dieFlyingTo; const hasExpansionIndicators = G.expansionEnabled && (cargo.length > 0 || dieHere); const x = (space.x / 1904) * 100, y = (space.y / 1176) * 100; return <button key={i} data-track-index={i} disabled={!good} onClick={() => trackMove(i)} style={{ left: `${x}%`, top: `${y}%` }} className={`track-space ${space.type} ${good ? 'available-space' : ''} ${currentPlayer.position === i ? 'current-space' : ''} ${hasExpansionIndicators ? 'has-expansion-indicators' : ''}`} title={`${i + 1} · ${space.label}`}>
              {space.type === 'score' ? <span className="space-score-discs">{Array.from({ length: G.scores[space.sourceIndex ?? -1] || 0 }, (_, disc) => <img key={disc} data-score-source-index={space.sourceIndex} src="/Images/scoring_disc.png" alt="紫色计分圆片" />)}</span> : supplySpace ? <span className="space-supply">{(stock || []).map(tile => <span key={tile.id} className="space-supply-tile" data-tile-id={tile.id}><TileFace tile={tile} /></span>)}</span> : <span>{space.type === 'barrel' ? '▣' : space.type === 'start' ? '⌂' : '✦'}</span>}
              {!supplySpace && space.type !== 'score' && <small>{space.label}</small>}
              {hasExpansionIndicators && <span className="expansion-track-indicators" title={[...cargo.map(item => item === 'barrel' ? '桶装酒' : '干草'), ...(dieHere ? [`骰子 ${G.expansion?.cartDieValue} 点`] : [])].join('、')}>
                {cargo.map((kind, cargoIndex) => kind === 'barrel' ? <img key={`barrel-${cargoIndex}`} className="expansion-track-cargo-token barrel" src="/Images/barrel_cargo_icon.png" alt="桶装酒" /> : <img key={`straw-${cargoIndex}`} className="expansion-cargo-token straw-icon" src="/Images/straw_cube_icon.png" alt="干草" />)}
                {dieHere && <span className="expansion-track-die"><DiceFace value={G.expansion?.cartDieValue ?? 1} /></span>}
              </span>}
              {occupants.some(p => !pieceFlights.some(flight => flight.kind === 'meeple' && flight.playerIndex === G.players.indexOf(p) && flight.targetTrackIndex === i)) && <i className="occupants">{occupants.filter(p => !pieceFlights.some(flight => flight.kind === 'meeple' && flight.playerIndex === G.players.indexOf(p) && flight.targetTrackIndex === i)).map(p => <span key={p.color} role="img" className={`player-meeple ${G.players.indexOf(p) === currentPlayerIndex ? 'is-active-player' : ''}`} style={{ backgroundPosition: meepleSpritePosition(p.color) }} aria-label={p.name} data-player-name={p.name} data-player-index={G.players.indexOf(p)} title={`${p.name}${G.players.indexOf(p) === currentPlayerIndex ? ' · 正在行动' : ''}`} />)}</i>}
            </button>;
          })}
          {G.barrels.map(stock => { const pos = barrelTokenPositions[stock.id - 1], goalTitle = `目标 ${stock.id}：${barrelGoals[stock.id - 1]}`, claims = G.players.flatMap(p => p.claimedBarrels.filter(b => b.id === stock.id).map(b => ({ player: p, size: b.size }))); return <div data-barrel-source-id={stock.id} className={`barrel-goal-cell ${stock.remaining === 0 ? 'exhausted' : ''}`} key={`barrel-${stock.id}`} style={{ left: `${pos.left}%`, top: `${pos.top}%` }} title={goalTitle}>{stock.remaining === 2 ? <><BarrelGoalArt id={stock.id} className="small-under" /><BarrelGoalArt id={stock.id} className="large-front" /></> : stock.remaining === 1 ? <BarrelGoalArt id={stock.id} className="small-alone" /> : <BarrelGoalArt id={stock.id} className="exhausted-token" />}{claims.length > 0 && <div className="barrel-claim-badges">{claims.map(({ player, size }) => <span key={`${player.color}-${size}`} className={`barrel-claim-badge ${player.color}`} title={`${player.name} 已领取${size === 'large' ? '大酒桶（4分）' : '小酒桶（2分）'}`}><img src={`/Images/player_figure_${player.color}.png`} alt="" /><b>{size === 'large' ? '大' : '小'}</b></span>)}</div>}</div>; })}
          {startSlots.map((slot, i) => { const occupant = G.players.find(p => p.startSlot === i); const selectable = canChooseStartSlot(i); const flyingOut = occupant && pieceFlights.some(flight => flight.kind === 'meeple' && flight.playerIndex === G.players.indexOf(occupant) && flight.targetStartSlot === i); return <button key={`start-${i}`} disabled={!selectable} onClick={() => chooseStartSlot(i)} className={`start-slot slot-${i} ${occupant ? 'occupied' : ''} ${selectable ? 'selectable' : ''} ${forceFirstPlayerSlot && i === 0 ? 'forced' : ''}`} style={{ left: `${slot.x / 1904 * 100}%`, top: `${slot.y / 1176 * 100}%` }} aria-label={`${slot.label}：${slot.reward}`}><span className="start-slot-caption">{slot.label}<small>{slot.reward}</small></span>{occupant && !flyingOut && <span role="img" className="start-player-figure player-meeple" style={{ backgroundPosition: meepleSpritePosition(occupant.color) }} aria-label={occupant.name} data-player-name={occupant.name} data-player-index={G.players.indexOf(occupant)} />}</button>; })}
        </div></div>
        <div className="action-area">
          {isExpansionStoreSetup && !canConfigureExpansionStores && <div className="action-panel compact-panel expansion-setup-wait"><span className="eyebrow">PRIVATE SETUP</span><h3>{G.expansion!.storeSetupReady.every(Boolean) ? "所有玩家已完成配置" : G.expansion!.storeSetupReady[activeSeat] ? "配置已提交" : `${currentPlayer.name}正在秘密配置`}</h3><p className="panel-desc">{G.expansion!.storeSetupReady.every(Boolean) ? "确认后所有存储板块配置会同时公开。" : "配置内容对其他线上玩家隐藏；全员完成后统一公开。"}</p></div>}{isExpansionStoreSetup && activeExpansionBoard && canConfigureExpansionStores && <div className="action-panel expansion-setup-panel"><span className="eyebrow">EXPANSION SETUP</span><div className="expansion-setup-title"><h3>放置 7 个存储板块</h3>{!G.expansion!.storeSetupReady[activeSeat] && activeExpansionBoard.hutStoreTiles.some(id => id === null) && <button className="btn btn-outline" disabled={!canConfigureExpansionStores} onClick={randomizeRemainingExpansionStores}>随机放置剩余</button>}</div><p className="panel-desc">左侧只显示尚未放置的板块。放置后自动选中下一个；剩余一个板块和一个空棚屋时会自动放置。已放置 {activeExpansionBoard.hutStoreTiles.filter(id => id !== null).length}/7。</p><div className="expansion-store-shop">{Array.from({ length: 7 }, (_, index) => index + 1).filter(tileId => !activeExpansionBoard.hutStoreTiles.includes(tileId)).map(tileId => { const flying = pieceFlights.some(flight => flight.kind === 'store-card' && flight.storeId === tileId && flight.playerIndex === activeSeat); return <button type="button" key={tileId} data-expansion-store-id={tileId} className={`expansion-store-tile ${selectedExpansionStoreId === tileId ? 'selected' : ''} ${flying ? 'is-flying' : ''}`} disabled={!canConfigureExpansionStores} onClick={() => setSelectedExpansionStoreId(tileId)} title="选择此存储板块"><img src={`/Images/store_${tileId}.png`} alt="存储板块正面" /></button>; })}</div><p className="selection-hint">{G.expansion!.storeSetupReady[activeSeat] ? '配置已完成，等待其他玩家。' : selectedExpansionStoreId ? '已选存储板块 · 点击目标棚屋进行放置或互换' : '选择一个存储板块，再点击目标棚屋'}</p>{!G.expansion!.storeSetupReady[activeSeat] && <button className="btn btn-gold" disabled={!canConfigureExpansionStores || activeExpansionBoard.hutStoreTiles.some(id => id === null)} onClick={() => { moves.finishExpansionStoreSetup(); setSelectedExpansionStoreId(null); }}>完成配置</button>}</div>}
          {expansionStorePrompt && G.expansion && <div className="action-panel compact-panel expansion-store-prompt">
            <span className="eyebrow">SHED STORE TILE</span>
            <h3>{expansionStorePrompt.tileId === 7 ? '选择货物并放入存储格' : '选择存储板块的用法'}</h3>
            {expansionStorePrompt.tileId === 7 ? <>
              <p className="panel-desc">点选桶装酒或干草图标，再点击右侧上方的空存储格；临时格需支付 4 钱币。</p>
              <div className="store-cargo-icon-choices">{(['barrel', 'straw'] as const).map(kind => {
                const alreadyPlaced = pendingStoreCargoPlacements.some(item => item.kind === kind);
                const enabled = availableStoreCargoKinds.includes(kind) && (storeCargoSlots.length > 0 || storeTemporaryAvailable);
                return <button type="button" key={kind} className={`store-cargo-icon-choice ${selectedStoreCargoKind === kind && !alreadyPlaced ? 'selected' : ''} ${alreadyPlaced ? 'placed' : ''}`} disabled={!canControlTurn || !enabled} aria-label={kind === 'barrel' ? '选择桶装酒' : '选择干草'} title={kind === 'barrel' ? '桶装酒' : '干草'} onClick={() => setSelectedStoreCargoKind(kind)}>
                  <img className={kind === 'straw' ? 'hay-icon' : ''} src={kind === 'barrel' ? '/Images/barrel_cargo_icon.png' : '/Images/straw_cube_icon.png'} alt="" />{alreadyPlaced && <small>✓</small>}
                </button>;
              })}</div>
              {pendingStoreCargoPlacements.length > 0 && <button className="btn btn-gold store-cargo-finish" disabled={!canControlTurn} onClick={finishStoreCargoPlacement}>完成放置 · {pendingStoreCargoPlacements.length}</button>}
            </> : <>
              <p className="panel-desc">{expansionStoreEffects[expansionStorePrompt.tileId]}{[1, 2].includes(expansionStorePrompt.tileId) ? ' 正面持续效果会占用一个扩展位作提醒。' : ''} 翻到背面则增加一个对应颜色的存储格。</p>
              <img className="expansion-store-choice-image" src={`/Images/store_${expansionStorePrompt.tileId}.png`} alt={`存储板块 ${expansionStorePrompt.tileId}`} />
              {[3, 4].includes(expansionStorePrompt.tileId) ? <div className="expansion-store-effects">{(G.expansion.players[expansionStorePrompt.playerIndex]?.breweryUpgradeTiles ?? [null, null]).map((upgrade, breweryIndex) => upgrade === null && <button key={breweryIndex} className="btn btn-gold" disabled={!canControlTurn} onClick={() => moves.resolveExpansionStore('front', [], [], breweryIndex)}>覆盖第 {breweryIndex + 1} 酒馆（{G.expansion!.players[expansionStorePrompt.playerIndex].breweryScores[breweryIndex]} → {expansionStorePrompt.tileId === 3 ? 5 : 6} 分/桶）</button>)}</div> : <button className="btn btn-gold" disabled={!canControlTurn || ([1, 2].includes(expansionStorePrompt.tileId) && !(G.expansion?.players[expansionStorePrompt.playerIndex]?.storageExtensions ?? []).some(extension => extension === null)) || ((expansionStorePrompt.tileId === 5 || expansionStorePrompt.tileId === 6) && !validCartLoadChoices(G.expansion.players[expansionStorePrompt.playerIndex], expansionStorePrompt.tileId === 5 ? 4 : 6).length)} onClick={() => moves.resolveExpansionStore('front')}>使用正面</button>}
            </>}
            <button className="btn btn-outline" disabled={!canControlTurn || !(G.expansion?.players[expansionStorePrompt.playerIndex]?.storageExtensions ?? []).some(extension => extension === null)} onClick={() => moves.resolveExpansionStore('back')}>翻到背面 · 增加 1 个存储格</button>
          </div>}
          {G.phase === 'setup' && G.setupStage !== 'expansion-stores' && !G.startChoice && <div className="action-panel start-guide"><span className="eyebrow">STARTING POSITIONS</span><h3>逆时针选择起始奖励</h3><p>首位玩家（{G.players[G.startPlayer]?.name}）已在“首位玩家格”。现在轮到{currentPlayer.name}，请点击主板起始区域中的空位</p></div>}
          {G.startChoice && <div className="action-panel compact-panel"><span className="eyebrow">START BONUS</span><h3>选择推进的资源</h3><p className="panel-desc">将选中的资源标记向前推进2格；若已在第20格，每推进1格获得1个钱币</p><div className="score-picker start-resource-picker">{resources.map(resource => <button key={resource} disabled={!canControlTurn} onClick={() => chooseStartResource(resource)} style={{ borderColor: resourceColors[resource] }} aria-label={`${resourceLabels[resource]} +2`} title={`${resourceLabels[resource]} +2`}><img src={`/Images/resource_icon_${resource}.png`} alt="" /><span>{resourceLabels[resource]}</span></button>)}</div></div>}
          {!action && !activeShedChoice && !G.confirmationKind && G.phase === 'play' && <div className="empty-action"><div className="action-glyph">✦</div><div><b>{currentPlayer.retired ? '本轮已结束' : `轮到 ${currentPlayer.name}`}</b><p>{currentPlayer.retired ? '等待仍在公共轨上行动的玩家。' : '沿公共轨向前移动，进入一个可使用的行动格；可以进入一个空起始格，结束本轮行动'}</p></div><span className="move-hint">{canMove ? '选择行动格' : '等待对手'}</span></div>}
          {(action?.type === 'resource' || action?.type === 'monk') && !action.baseDone && !expansionStorePrompt ? <div className="action-panel"><div className="panel-title"><div><span className="eyebrow">{action.type === 'resource' ? 'GARDEN GOODS' : 'BROTHERHOOD'}</span><h3>{action.type === 'resource' ? '选择资源板块' : '选择僧侣板块'}</h3></div><div className="cost-note">钱币足够时可连续购买多个</div></div><div className="purchase-flow"><div className="flow-step"><b>1</b><span>选择板块</span></div><div className="shop-row">{market?.map((tile: Tile) => <button key={tile.id} data-shop-tile-id={tile.id} className={`shop-tile ${tile.resource || 'monk-tile'} ${selectedTile?.id === tile.id ? 'selected' : ''}`} onClick={() => { if (canControlTurn) setSelectedTileId(tile.id); }} disabled={!canControlTurn || market.length === 1}><TileFace tile={tile} /><small>{tile.kind === 'resource' ? resourceLabels[tile.resource!] : tile.monk}</small></button>)}</div><div className="flow-step"><b>2</b><span>{selectedTile ? '选择花园空格' : '先选板块'}</span></div><span className="selection-hint">{selectedTile ? '阳面价格为阴面的2倍。点击空格完成放置' : market?.length === 1 ? '唯一板块已自动选中。' : '选择板块后，花园会高亮所有当前可放置的位置。'}</span></div>{!activeShedChoice && !expansionStorePrompt && <button className="btn btn-outline finish-purchase" disabled={!canControlTurn || (action.purchases ?? 0) < 1 || pieceFlights.length > 0} onClick={() => moves.finishPurchase()}>{(action.purchases ?? 0) < 1 ? '至少购买1个板块' : '结束购买并继续'}</button>}</div> : null}
          {action?.type === 'score' && !action.baseDone && <div className="action-panel compact-panel"><div className="panel-title"><div><span className="eyebrow">SCORING TOKEN</span><h3>将紫色圆片放到对应图标</h3></div></div><p className="panel-desc">每个玩家版图上的计分图标只能放置一次；选择本次要触发的产值、僧侣或资源。</p><div className="score-picker score-choice-list">
            {productionScoreOptions.length > 0 && <div className="score-choice-group"><button type="button" disabled={!canControlTurn} className={`score-choice-parent ${scoreCategory === 'A' && !!scoreChoice ? 'selected' : ''} ${showProductionChoices ? 'expanded' : ''}`} aria-expanded={showProductionChoices} onClick={() => { if (!canControlTurn) return; setScoreCategory('A'); setScoreChoice(''); setShowProductionChoices(current => !current); }}>产值 X <span>{showProductionChoices ? '▴' : '▾'}</span></button>{showProductionChoices && <div className="score-choice-submenu">{productionScoreOptions.map(option => <button type="button" key={option} disabled={!canControlTurn} className={scoreCategory === 'A' && scoreChoice === option ? 'selected' : ''} onClick={() => { if (!canControlTurn) return; setScoreCategory('A'); setScoreChoice(option); }}>{option}</button>)}</div>}</div>}
            {monkScoreOptions.map(option => <button type="button" key={`monk-${option}`} disabled={!canControlTurn} className={`score-monk-option ${scoreCategory === 'B' && scoreChoice === option ? 'selected' : ''}`} aria-label={`僧侣 ${option}`} title={`僧侣 ${option}`} onClick={() => { if (!canControlTurn) return; setScoreCategory('B'); setScoreChoice(option); setShowProductionChoices(false); }}><img className="score-monk-icon" src={`/Images/monk_tile_${String.fromCharCode(65 + monkNames.indexOf(option))}.png`} alt="" /></button>)}
            {resourceScoreOptions.map(option => <button type="button" key={`resource-${option}`} disabled={!canControlTurn} className={`score-resource-option ${scoreCategory === 'C' && scoreChoice === option ? 'selected' : ''}`} onClick={() => { if (!canControlTurn) return; setScoreCategory('C'); setScoreChoice(option); setShowProductionChoices(false); }}><img src={`/Images/resource_icon_${option}.png`} alt="" /><span>{resourceLabels[option as Resource]}</span></button>)}
          </div><button className="btn btn-gold" disabled={!canControlTurn || !selectedScoreOption} onClick={submitScore}>放置圆片<span>↗</span></button></div>}
          {G.expansionEnabled && action && !action.baseDone && (canTakeCargoHere || canUseCartHere) && <div className="action-panel compact-panel"><span className="eyebrow">可选扩展行动</span><div><button className="btn btn-outline" disabled={!canControlTurn || !!activeShedChoice} onClick={() => moves.skipExpansionBaseAction()}>跳过基础行动，执行扩展行动</button></div></div>}
          {G.expansionEnabled && action?.baseDone && !action.cargoDone && <div className="action-panel compact-panel expansion-cargo-panel"><span className="eyebrow">CARGO STORAGE</span><h3>从此行动格拿取货物</h3><p className="panel-desc">先选择图标，再点击右侧扩展版图上一个空存储格；临时存储格需要支付 4 钱币。</p><div className="expansion-cargo-actions">{expansionCargoPile.map((kind, index) => { const firstOfKind = expansionCargoPile.indexOf(kind); return <button type="button" className={`expansion-cargo-pick ${selectedExpansionCargoKind === kind && firstOfKind === index ? 'selected' : ''}`} key={`${kind}-${index}`} disabled={!canControlTurn} aria-label={`选择${kind === 'barrel' ? '桶装酒' : '干草'}`} title={kind === 'barrel' ? '桶装酒' : '干草'} onClick={() => { setSelectedExpansionCargoKind(kind); if (!isViewingCurrent) setViewingPlayerIndex(activeSeat); }}>{kind === 'barrel' ? <img src="/Images/barrel_cargo_icon.png" alt="" /> : <img className="hay-icon" src="/Images/straw_cube_icon.png" alt="" />}</button>; })}</div><p className="selection-hint">{selectedExpansionCargoKind ? '已选货物 · 点击扩展版图上的空格放入' : '请选择要放入存储格的货物'}</p><button className="btn btn-outline" disabled={!canControlTurn || ((action.actionsDone ?? 0) === 0 && (action.cargoTaken ?? 0) === 0 && !canUseCartHere)} onClick={() => hasStorableCargoRemaining ? setShowUnstoredCargoPrompt(true) : moves.finishExpansionCargo()}>结束拿取货物</button></div>}
          {G.expansionEnabled && action?.baseDone && action.cargoDone && action.cartDone === false && !G.expansion?.cartMovement && <div className="action-panel compact-panel expansion-cart-panel"><span className="eyebrow">CART DIE</span><h3>运输推车</h3><p className="panel-desc">使用主版图此格的骰子，移动 {G.expansion?.cartDieValue} 格{activeExpansionBoard?.cartStepBonus ? `（含加成 +${activeExpansionBoard.cartStepBonus}）` : ''}。门只能经过，不能停留。</p><button className="btn btn-gold" disabled={!canControlTurn} onClick={() => moves.useExpansionCart()}>掷骰并移动推车</button><button className="btn btn-outline" disabled={!canControlTurn || ((action.purchases ?? 0) === 0 && (action.actionsDone ?? 0) === 0 && (action.cargoTaken ?? 0) === 0)} onClick={() => moves.skipExpansionCart()}>跳过推车行动</button></div>}
          {G.expansionEnabled && (G.expansion?.cartMovement?.nextLocation ?? -1) >= 0 && action && <div className="action-panel compact-panel expansion-cart-panel"><span className="eyebrow">FIRST GATE · LOAD BARRELS</span><h3>装载桶装酒</h3><p className="panel-desc">每装 1 桶消耗 1 捆干草。若推车从其他位置移动到此处，可以不装载并停在修道院起点；若从起点出发，则必须装载或先完成其他行动。</p><div className="expansion-cart-loads">{G.expansion!.cartMovement!.loadChoices.map(count => { const movement = G.expansion!.cartMovement!, onlySkip = count === 0 && movement.completion === 'action' && (movement.startPosition ?? activeExpansionBoard?.cartPosition) === 0 && activeExpansionBoard?.deliveredBarrels === (movement.deliveredAtStart ?? activeExpansionBoard?.deliveredBarrels) && (action.purchases ?? 0) === 0 && (action.actionsDone ?? 0) === 0 && (action.cargoTaken ?? 0) === 0; return <button key={count} className="btn btn-outline" disabled={!canControlTurn || onlySkip} onClick={() => moves.chooseExpansionCartLoad(count)}>{count === 0 ? '不装载，留在起点' : `装载 ${count} 桶`}</button>; })}</div></div>}
          {privilegePrompt && <div className="action-panel compact-panel privilege-prompt"><span className="eyebrow">PRIVILEGE REWARD</span><h3>{`完成第 ${privilegePrompt.pairIndex + 1} 组计分标记`}</h3><p className="panel-desc">{'立即放置一张尚未弃置的特权卡到对应组右侧，或永久跳过。'}</p>{privilegePrompt.kind === 'pair' && <div className="privilege-pick-list">{activePlayer.privileges.filter((card: string) => card !== 'A' || activePlayer.board.some((cell: any) => !!cell.tile?.resource)).map((card: string) => <button key={card} disabled={!canControlTurn} onClick={() => choosePrivilegeCard(card)}><img src={`/Images/privilege_card_front_${card}.png`} alt={`特权卡 ${card}`} /><span>{card}{card === 'A' ? ' · 资源轨道' : card === 'B' ? ' · 最后资源推进' : card === 'C' ? ' · 酒桶终局 +1' : card === 'D' ? ' · +12钱币' : ' · 酿酒师 +5'}</span></button>)}<button className="skip-privilege" disabled={!canControlTurn} onClick={() => choosePrivilegeCard('skip')}>本组不放置<br /><small>之后不能补放</small></button></div>}{privilegeCardChoice === 'A' && <p className="panel-desc">只显示至少有 1 块对应资源板块的种类。</p>}{privilegeResources.length > 0 && <div className="score-picker privilege-resource-picker">{privilegeResources.map(resource => <button key={resource} disabled={!canControlTurn} onClick={() => choosePrivilegeResource(resource)} style={{ borderColor: resourceColors[resource] }}>{resourceLabels[resource]}</button>)}</div>}</div>}
          {!action && G.confirmationKind === 'turn' && G.log[0]?.includes('到达酒桶成就格') && <div className="action-panel compact-panel"><span className="eyebrow">CELLAR ACHIEVEMENTS</span><h3>酒桶成就已领取</h3><p className="panel-desc">{G.log[0]}</p></div>}
          {action?.type === 'start' && !G.startChoice && <div className="action-panel start-guide"><span className="eyebrow">RETURN TO START</span><h3>选择起始区域空位</h3><p>{forceFirstPlayerSlot ? '其他玩家都已返回，首位玩家格空置；你必须停在首位玩家格。' : '点击主板起始区域中任一空位，立即领取该格奖励并结束本轮。'}</p></div>}
          {activeShedChoice && !expansionStorePrompt && <div className="action-panel shed-choice-panel"><span className="eyebrow">SHED BONUS</span><h3>棚屋奖励 · 周围产值 {activeShedChoice.value}</h3><p>酿酒师轨道 +{activeShedChoice.brewerAdvance} 格。请选择激活的相邻板块：{shedChoiceInstruction(activeShedChoice)}</p><div className="shed-choice-status">已选 {activeShedChoice.selected.length} / {activeShedChoice.activateCount} 块 · 点击花园中高亮的相邻板块</div><button className="btn btn-gold" disabled={!canControlTurn || !validShedSelection(activeShedChoice)} onClick={completeShedChoice}>完成棚屋激活选择</button></div>}
          {!isLocal && !onlineVoteState.passed && !canControlTurn && G.confirmationKind && <div className="action-confirm-bar spectator-waiting"><b>{isBotTurn ? `${currentPlayer.name} 正在处理本次行动` : `等待 ${currentPlayer.name} 确认行动`}</b><span>对方确认后将继续</span></div>}
          {/* {isBotTurn && <div className="action-confirm-bar bot-action-status"><b>{currentPlayer.name} 正在思考</b><span>搜索次数：{activeBotSearch?.iterations ?? 0}</span></div>} */}
          {(G.undoSnapshot || G.confirmationKind) && canControlTurn && <div className="action-confirm-bar"><span>{G.confirmationKind ? '行动已完成，请确认或撤回。' : activeShedChoice ? '请选择棚屋奖励板块，或撤回整次行动。' : action?.type === 'resource' || action?.type === 'monk' ? '可继续购买；结束购买后可确认或撤回整次行动。' : '可以撤回当前选择，重新选行动格。'}</span>{G.undoSnapshot && G.stepUndoSnapshots?.length ? <button className="btn btn-undo" onClick={() => requestGameAction('undoStep')}>撤回上一步</button> : null}{G.undoSnapshot && <button className="btn btn-undo" onClick={() => requestGameAction('undoAction')}>撤回整次行动</button>}{G.confirmationKind && !G.privilegePrompts.length && !G.shedChoices.length && !G.startChoice && <button className="btn btn-gold btn-confirm" onClick={() => requestGameAction('confirmAction')}>确认行动</button>}</div>}
        </div>
      </section>
      <aside className={`right-rail ${!isViewingOwn ? 'is-inspecting-opponent' : ''}`}><div className="garden-heading"><div><h2>{me.name}的修道院</h2>{!isViewingOwn && <small className="inspection-hint">正在查看对手版图 · 只读</small>}</div><div className="garden-legend"></div></div><div className={`garden-board-pair ${G.expansionEnabled && G.expansion ? 'has-expansion' : ''}`}>{G.expansionEnabled && G.expansion && <div className="expansion-board-reserved"><ExpansionTransportBoard board={G.expansion.players[viewingPlayerIndex]} color={me.color} playerIndex={viewingPlayerIndex} pieceFlights={pieceFlights} storeEffectLabels={expansionStoreEffects} cargoPlacement={expansionBoardCargoPlacement} /></div>}<div className="garden-board-reserved"><Garden player={me} playerIndex={viewingPlayerIndex} pieceFlights={pieceFlights} selectedTile={isViewingCurrent && canPlace ? selectedTile : undefined} sourceIndex={currentActionSpace?.sourceIndex} coins={activePlayer.coins} canPlace={isViewingCurrent && canPlace} activePlayer={me} shedChoice={isViewingCurrent && canControlTurn && !expansionStorePrompt ? activeShedChoice : undefined} flightTileId={pieceFlights.find(flight => flight.kind === 'tile')?.tile?.id} flightTargetIndex={pieceFlights.find(flight => flight.kind === 'tile')?.targetIndex} flightScoreIndex={pieceFlights.find(flight => flight.kind === 'disc' && flight.playerIndex === viewingPlayerIndex)?.scoreIndex} scoreTargetIndices={scoreTargetIndices} onScoreTarget={placeScoreFromBoard} onShedToggle={(i) => { if (canControlTurn && isViewingCurrent) moves.toggleShedChoice(i); }} onSelect={(i) => { if (canControlTurn && isViewingCurrent) placeTile(i); }} cells={garden} storeTiles={G.expansionEnabled ? G.expansion?.players[viewingPlayerIndex]?.hutStoreTiles : undefined} storeSetup={canConfigureExpansionStores} selectedStoreId={selectedExpansionStoreId} storeSetupReady={G.expansion?.storeSetupReady?.[viewingPlayerIndex] ?? false} onStoreTarget={placeExpansionStoreTarget} /></div></div><div className="rail-heading">特权卡 · 点击弃置可得3个钱币</div><div className="privileges">{['A', 'B', 'C', 'D', 'E'].filter(card => !me.privilegePairs.includes(card)).map(card => { const inHand = me.privileges.includes(card); const earned = me.privilegePairs.includes(card); const blocked = G.phase !== 'play' || !canControlTurn || !isViewingCurrent || (!!G.confirmationKind && G.confirmationKind !== 'turn') || !!privilegePrompt; return <div className={`privilege ${inHand ? '' : 'used'}`} data-privilege-card={card} key={card}><img src={`/Images/privilege_card_front_${card}.png`} alt={`特权卡 ${card}`} />{inHand ? <button disabled={blocked} onClick={() => { if (blocked || G.phase !== 'play') return; animatePrivilegeCoins(currentPlayerIndex, card, 3); moves.discardPrivilege(card); }}>弃置 +3</button> : <span>{earned ? '已放置' : '已弃置'}</span>}</div>; })}</div><div className="rail-heading">已领取酒桶 <span className="count">{me.claimedBarrels.length}</span></div><div className="barrel-strip">{me.claimedBarrels.map((b, i) => <span key={`${b.id}-${i}`} className={`barrel-claimed-item ${b.size}`} style={{ visibility: pieceFlights.some(flight => flight.kind === 'barrel' && flight.playerIndex === viewingPlayerIndex && flight.barrelId === b.id && flight.barrelSize === b.size) ? 'hidden' : 'visible' }} title={`酒桶${b.id}：${barrelGoals[b.id - 1]} ${b.size === 'large' ? '大酒桶，4分' : '小酒桶，2分'}`}><BarrelGoalArt id={b.id} className="claimed-barrel-art" /><small>{b.size === 'large' ? '大 · 4分' : '小 · 2分'}</small></span>)}</div><div className="score-summary"><span>当前钱币</span><b><i className="player-coin-icon" aria-label="钱币" /> {me.coins}</b><span>酒桶计分</span><b>{viewingScoring.barrelScore + viewingScoring.expansionBarrelScore} 分</b></div></aside>
      <aside className="far-right-rail"><div className="rail-heading">玩家信息 · 点击查看版图</div><div className="player-roster">{rosterOrder.map(i => { const p = G.players[i];
        const scoring = scoreBreakdown(p, G.expansionEnabled ? G.expansion?.players[i] : undefined); const searchStatus = botSearchStatus?.playerID === i ? botSearchStatus : sharedBotSearches.find(status => status.playerID === i && status.thinking && Date.now() - status.updatedAt < 12000); return <div className={`player-info-unit ${i === viewingPlayerIndex ? 'is-viewing' : ''}`} data-player-index={i} key={i} role="button" tabIndex={0} aria-label={`查看${p.name}的玩家版图`} onClick={() => setViewingPlayerIndex(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewingPlayerIndex(i); } }}>
          <div className={`player-card ${i === Number(ctx.currentPlayer) ? 'is-turn' : ''} ${p.retired ? 'is-done' : ''}`}><div className={`avatar ${p.color}`} title={`首轮第 ${firstOrder.indexOf(i) + 1} 个行动`} aria-label={`首轮行动顺序第 ${firstOrder.indexOf(i) + 1} 位`}>{firstOrder.indexOf(i) + 1}</div><div className="player-name"><span className="player-name-score">{p.name}{G.phase === 'play' && i === G.startPlayer && <span className="round-first-player-icon" title="本轮先手" aria-label="本轮先手"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 14V2m1 1h8l-2.4 3L12 9H4" /></svg></span>}{i === ownPlayerIndex && !botSeats.includes(i) && <b className="self-player-badge">你</b>}<b title={liveScoreTitle(p, scoring, G.expansionEnabled ? G.expansion?.players[i] : undefined)}>★ {scoring.total}</b></span><small>{botSeats.includes(i) ? `${botDifficulty === 'expert' ? '专家' : '普通'}机器人${i === Number(ctx.currentPlayer) ? searchStatus ? ` · 搜索中 ${searchStatus.iterations} 次` : ' · 正在行动' : ''}` : p.retired ? '本轮已休息' : i === Number(ctx.currentPlayer) ? '正在行动' : '等待中'}</small></div><div className="money"><i className="player-coin-icon" aria-label="钱币" /> {p.coins}</div></div>
          <div className="player-live-details" title={`按当前状态预演终局：资源归并后最低为 ${scoring.minResource}，生产 ${scoring.productionScore} 分；酒桶 ${scoring.barrelScore} 分；起始奖励 ${scoring.startBonus} 分。`}>
            <div className="player-info-table">
              <div className="player-info-row resource-icon-row">{resources.map(resource => <span key={resource} className="resource-stat" title={`${resourceLabels[resource]}：${p.tracks[resource]}`}><img className="player-board-resource" src={`/Images/resource_icon_${resource}.png`} alt="" /><b>{p.tracks[resource]}</b></span>)}</div>
              <div className="player-info-row player-metric-combined-row">
                <span title={`酿酒师：${p.brewer}`}><i className="player-info-brewer" style={{ backgroundPosition: meepleSpritePosition(p.color) }} /><b>{p.brewer}</b></span>
                <span title={`资源交换比：${scoring.exchangeRate}:1`}><b className="exchange-ratio-value">{scoring.exchangeRate}:1</b></span>
                <span title={`胜利点数：${scoring.victoryPoints}`}><i className="player-info-beer" role="img" aria-label="啤酒" /><b>x{scoring.victoryPoints}</b></span>
                <span title={`交换后最少资源：${scoring.minResource}`}><b className="base-value">{scoring.minResource}</b></span>
                <span title={`酒桶分数：${scoring.barrelScore}`}><i className="player-info-barrel" role="img" aria-label="酒桶" /><b>{scoring.barrelScore}</b></span>
              </div>
            </div>
          </div>
        </div>;
      })}</div><div className="rail-heading log-heading"><span>行动日志</span><button type="button" className="log-export-button" hidden onClick={downloadGameDebug} title="下载当前对局状态、日志及机器人搜索状态">导出对局</button></div><div className="log-list">{G.log.slice(0, 80).reverse().map((line, i) => <p key={i} className={line.startsWith('[[TURN:') ? 'log-turn-divider' : ''}>{renderLog(line, G.players)}</p>)}</div></aside>
    </div>
    {showUnstoredCargoPrompt && action?.baseDone && !action.cargoDone && hasStorableCargoRemaining && <div className="modal-backdrop" onClick={() => setShowUnstoredCargoPrompt(false)}><div className="rules-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="unstored-cargo-title" onClick={e => e.stopPropagation()}><button className="close-modal" onClick={() => setShowUnstoredCargoPrompt(false)}>×</button><span className="eyebrow">CARGO STORAGE</span><h2 id="unstored-cargo-title">还有货物可以拿取</h2><p>当前行动格还剩 {remainingCargoReminder}，并且你还有空存储格可用。要返回继续放置吗？</p><div className="confirm-actions"><button className="btn btn-outline" onClick={() => setShowUnstoredCargoPrompt(false)}>返回拿取</button><button className="btn btn-gold" onClick={() => { setShowUnstoredCargoPrompt(false); moves.finishExpansionCargo(); }}>仍然结束</button></div></div></div>}
    {showRules && <div className="modal-backdrop" onClick={() => setShowRules(false)}><div className="rules-modal" onClick={e => e.stopPropagation()}><button className="close-modal" onClick={() => setShowRules(false)}>×</button><span className="eyebrow">HOW TO PLAY</span><h2>修道院经营要点</h2><p>每回合沿公共轨道向前移动，并执行落点行动。购买资源与僧侣板块后，将它们放入花园的向阳或阴凉空格。</p><ul><li>阴凉板块按面值购买；资源激活时获得钱币。</li><li>向阳板块花费双倍；资源激活时推进对应生产轨道。</li><li>计分行动会激活对应产值、资源或僧侣，帮助提升最终分数。</li><li>返回起点领取奖励，本轮休息；所有人都返回后开始新一轮。</li></ul><p className="fine-print">线上联机需要先启动项目内的 boardgame.io 服务端。各回合在玩家设备上依次进行。</p></div></div>}
    {showAbandonConfirm && <div className="modal-backdrop" onClick={() => setShowAbandonConfirm(false)}><div className="rules-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="abandon-title" onClick={e => e.stopPropagation()}><button className="close-modal" onClick={() => setShowAbandonConfirm(false)}>×</button><span className="eyebrow">ABANDON GAME</span><h2 id="abandon-title">放弃当前对局？</h2><p>放弃后会删除本地存档，无法继续这场对局。</p><div className="confirm-actions"><button className="btn btn-outline" onClick={() => setShowAbandonConfirm(false)}>继续游戏</button><button className="btn btn-danger" onClick={onAbandon}>确认放弃</button></div></div></div>}
    {toast && <div className="toast" onClick={() => setToast('')}>{toast} <span>×</span></div>}
    {handoffPlayerIndex !== null && <div className="local-handoff-screen" role="dialog" aria-modal="true" aria-labelledby="local-handoff-title"><div className="local-handoff-card"><span className="eyebrow">LOCAL GAME · PASS THE DEVICE</span><div className="local-handoff-icon" aria-hidden="true">✦</div><h2 id="local-handoff-title">请将设备交给</h2><strong>{G.players[handoffPlayerIndex]?.name ?? currentPlayer.name}</strong><p>准备好后，点击下方按钮开始本回合。</p><button className="btn btn-gold" onClick={() => setHandoffPlayerIndex(null)}>我已接手，开始游戏</button></div></div>}
  </main>;
}

function OnlineBotDriver({ client, seat, name, difficulty, onThinking, onBeforeMove }: { client: AnyClient; seat: number; name: string; difficulty: BotDifficulty; onThinking: (status: { playerID: number; iterations: number } | null) => void; onBeforeMove: (decision: { name: string; args: unknown[] }, current: any) => number }) {
  const botSeats = useMemo(() => [seat], [seat]);
  useEffect(() => {
    const syncName = (state: any) => {
      if (Number(state?.ctx?.currentPlayer) === seat && state?.G?.players?.[seat]?.name !== name) (client as any).moves.setPlayerName?.(name);
    };
    const unsubscribe = (client as any).subscribe(syncName);
    syncName((client as any).getState());
    return unsubscribe;
  }, [client, seat, name]);
  return <BotController client={client} botSeats={botSeats} difficulty={difficulty} onThinking={onThinking} onBeforeMove={onBeforeMove} />;
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
    let lastProgressAt = 0;
    const onState = (state: any) => {
      requestID++;
      const request = requestID;
      if (timer !== undefined) window.clearTimeout(timer);
      worker?.terminate(); worker = undefined;
      const playerID = Number(state?.ctx?.currentPlayer);
      if (!state || state.G.phase === 'finished') { onThinking(null); return; }
      if (!botSeats.includes(playerID)) return;
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
        const fastPolicyStep = current.G.phase === 'setup' || current.G.startChoice || current.G.shedChoices.length > 0 || current.G.privilegePrompts.length > 0 || !!current.G.confirmationKind || (current.G.expansion?.storePrompts?.length ?? 0) > 0 || (current.G.expansion?.cartMovement?.nextLocation ?? -1) >= 0 || current.G.pending?.baseDone || current.G.pending?.type === 'start';
        if (fastPolicyStep) {
          finish(chooseBotMove(current.G, current.ctx.currentPlayer, difficulty));
          return;
        }
        worker = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = event => {
          if (event.data.requestID !== request) return;
          if (typeof event.data.progress === 'number') {
            const now = Date.now();
            if (event.data.progress === 1 || now - lastProgressAt >= 900) { lastProgressAt = now; onThinking({ playerID, iterations: event.data.progress }); }
            return;
          }
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
function BarrelGoalArt({ id, className = '' }: { id: number; className?: string }) {
  return <img className={`barrel-goal-token ${className}`} src={`/Images/barrel_goal_${id}.png`} alt={id ? `酒桶成就 ${id}` : ''} />;
}
function DiceFace({ value }: { value: number }) {
  const pips: Record<number, [number, number][]> = {
    1: [[16, 16]],
    2: [[9, 9], [23, 23]],
    3: [[9, 9], [16, 16], [23, 23]],
    4: [[9, 9], [23, 9], [9, 23], [23, 23]],
    5: [[9, 9], [23, 9], [16, 16], [9, 23], [23, 23]],
    6: [[9, 8], [23, 8], [9, 16], [23, 16], [9, 24], [23, 24]],
  };
  const face = Math.max(1, Math.min(6, Math.floor(value)));
  return <svg className="expansion-cart-die-face" viewBox="0 0 32 32" role="img" aria-label={`骰子 ${face} 点`}><rect x="1" y="1" width="30" height="30" rx="5" fill="#fff8e8" stroke="#30251b" strokeWidth="2" />{pips[face].map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r="2.6" fill="#211c17" />)}</svg>;
}
function ExpansionTransportBoard({ board, color, playerIndex, pieceFlights, storeEffectLabels, cargoPlacement }: { board: ExpansionPlayerBoard; color: string; playerIndex: number; pieceFlights: PieceFlight[]; storeEffectLabels: Record<number, string>; cargoPlacement?: { kind: ExpansionCargo; slots: number[]; temporaryAvailable: boolean; pending?: { kind: ExpansionCargo; slot: number }[]; onSelectSlot: (slot: number) => void } }) {
  const slots = [[14.5, 4.7], [28.8, 4.7], [43.5, 4.7], [58.3, 4.7], [72.9, 4.7], [14.5, 12.0], [28.8, 12.0], [43.5, 12.0], [58.3, 12.0], [72.9, 12.0]];
  const cargoGlyph = (cargo: 'barrel' | 'straw') => cargo === 'barrel'
    ? <img className="transport-cargo-token barrel-icon" src="/Images/barrel_cargo_icon.png" alt="桶装酒" title="桶装酒" />
    : <img className="transport-cargo-token straw-icon" src="/Images/straw_cube_icon.png" alt="干草" title="干草" />;
  const cartLocation = cartRoute[board.cartPosition] ?? cartRoute[0];
  const cartFlying = pieceFlights.some(flight => flight.kind === 'cart' && flight.playerIndex === playerIndex && flight.targetRouteIndex === board.cartPosition);
  const storageFlightHides = (index: number, temporary = false) => pieceFlights.some(flight => flight.kind === 'expansion-cargo' && flight.playerIndex === playerIndex && (temporary ? (flight.sourceTemporaryStorage || flight.targetTemporaryStorage) : (flight.sourceStorageIndex === index || flight.targetStorageIndex === index)));
  return <div className="expansion-transport-wrap">
    <div className="expansion-transport-board" data-transport-color={color} data-transport-player-index={playerIndex}>
      <img className="expansion-transport-art" src={`/Images/board_ex_${color}.jpg`} alt={`${color} 玩家运输板`} />
      {board.storage.map((cargo, index) => { const pos = slots[index]; if (!pos || !board.storageUnlocked?.[index]) return null; const pendingCargo = cargoPlacement?.pending?.find(item => item.slot === index)?.kind; const selectable = !!cargoPlacement && cargo === null && !pendingCargo && cargoPlacement.slots.includes(index); const hiddenByFlight = storageFlightHides(index); const unlockableSlot = !(BUILT_IN_STORAGE_SLOTS as readonly number[]).includes(index); return <button type="button" data-expansion-storage-index={index} className={`transport-storage-marker ${selectable ? 'selectable' : ''} ${pendingCargo ? 'pending' : ''}`} key={index} disabled={!selectable} onClick={() => cargoPlacement?.onSelectSlot(index)} aria-label={cargo ? `已解锁存储格，内有${cargo === 'barrel' ? '桶装酒' : '干草'}` : `将${cargoPlacement?.kind === 'barrel' ? '桶装酒' : '干草'}放入存储格`} title={cargo ? `已解锁存储格 · ${cargo === 'barrel' ? '桶装酒' : '干草'}` : selectable ? '点击放入选中的货物' : undefined} style={{ left: `${pos[0]}%`, top: `${pos[1]}%` }}>{unlockableSlot && <img className={`transport-storage-unlock-art ${cargo || pendingCargo ? 'occupied' : ''}`} src={`/Images/storage_slot_marker_${color}.png`} alt="已解锁存储格" />}{cargo && !hiddenByFlight ? cargoGlyph(cargo) : pendingCargo ? cargoGlyph(pendingCargo) : null}</button>; })}
      {board.storageExtensions?.map((extension: StorageExtension, extensionIndex) => { if (extension?.kind !== 'effect') return null; const slot = UNLOCKABLE_STORAGE_SLOTS[extensionIndex], pos = slots[slot]; if (!pos) return null; return <img key={`persistent-effect-${extensionIndex}`} className="transport-extension-effect" style={{ left: `${pos[0]}%`, top: `${pos[1]}%` }} src={`/Images/store_${extension.tileId}.png`} alt="" title={`持续效果：${storeEffectLabels[extension.tileId]}`} />; })}
      {board.breweryUpgradeTiles?.map((tileId, breweryIndex) => { if (!tileId) return null; const pos = breweryIndex === 0 ? [53, 64.5] : [53, 48.5]; return <img key={`brewery-upgrade-${breweryIndex}`} className="transport-brewery-upgrade" style={{ left: `${pos[0]}%`, top: `${pos[1]}%` }} src={`/Images/store_${tileId}.png`} alt={`覆盖第 ${breweryIndex + 1} 酒馆计分`} title={`第 ${breweryIndex + 1} 酒馆每桶 ${board.breweryScores[breweryIndex]} 分`} />; })}
      {cargoPlacement?.temporaryAvailable ? <button type="button" data-temporary-storage-marker className="transport-temp-marker selectable" title="临时存储格：放入需支付4钱币" aria-label="放入临时存储格并支付4钱币" style={{ left: "88.9%", top: "12.0%", right: "auto", transform: "translate(-50%, -50%)" }} onClick={() => cargoPlacement.onSelectSlot(-1)}><i /></button> : <div data-temporary-storage-marker className="transport-temp-marker" title="临时存储格：每次放入货物支付4钱币" style={{ left: "88.9%", top: "12.0%", right: "auto", transform: "translate(-50%, -50%)" }}>{board.temporaryStorage && !storageFlightHides(-1, true) ? cargoGlyph(board.temporaryStorage) : cargoPlacement?.pending?.find(item => item.slot === -1) ? cargoGlyph(cargoPlacement.pending.find(item => item.slot === -1)!.kind) : <i />}</div>}
      {!cartFlying && <div className="transport-cart-marker" style={{ left: `${cartLocation.left}%`, top: `${cartLocation.top}%` }} title={`马车位于${cartLocation.name}${board.cartBarrels > 0 ? `，装有 ${board.cartBarrels} 桶桶装酒` : '，未装载桶装酒'}`} aria-label={`马车位于${cartLocation.name}，装有${board.cartBarrels}桶桶装酒`}>{board.cartBarrels > 0 && <span className="cart-cargo-stack">{Array.from({ length: board.cartBarrels }, (_, index) => <img key={index} src="/Images/barrel_cargo_icon.png" alt="桶装酒" />)}</span>}<img className="cart-horse-icon" src="/Images/cart_horse_icon.png" alt="马车" /></div>}
      {board.breweryDeliveries.map((count, breweryIndex) => {
        const routeIndex = 9 + breweryIndex, location = cartRoute[routeIndex];
        const inFlight = pieceFlights.filter(flight => flight.kind === 'expansion-cargo' && flight.playerIndex === playerIndex && flight.cargoKind === 'barrel' && flight.targetRouteIndex === routeIndex).length;
        const visibleCount = Math.max(0, count - inFlight);
        return visibleCount > 0 ? <div key={`brewery-delivery-${breweryIndex}`} className="transport-brewery-delivery" style={{ left: `${Math.min(92, location.left + 20)}%`, top: `${location.top}%` }} title={`第 ${breweryIndex + 1} 酒馆已交付 ${count} 桶`} aria-label={`第 ${breweryIndex + 1} 酒馆已交付 ${count} 桶`}><img src="/Images/barrel_cargo_icon.png" alt="" /><b>×{visibleCount}</b></div> : null;
      })}
    </div>
    {/* <div className="expansion-transport-summary"><span><img className="summary-cart-icon" src="/Images/cart_horse_icon.png" alt="马车" />{Array.from({ length: board.cartBarrels }, (_, index) => <img key={index} src="/Images/barrel_cargo_icon.png" alt="桶装酒" />)}</span><span>已交付 <img src="/Images/barrel_cargo_icon.png" alt="" /> <b>{board.deliveredBarrels}</b></span><span>推车位置 <b>{cartLocation.name}</b></span></div> */}
  </div>;
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
    2: [[-1.6, 0], [1.6, 0]],
    3: [[-1.6, -2.4], [1.6, -2.4], [0, 1.6]],
    4: [[-1.6, -2.4], [1.6, -2.4], [-1.6, .8], [1.6, .8]],
    5: [[-1.6, -2.4], [0, -2.4], [1.6, -2.4], [-1.6, .8], [1.6, .8]],
    6: [[-1.6, -2.4], [0, -2.4], [1.6, -2.4], [-1.6, .8], [0, .8], [1.6, .8]],
  };
  return (layouts[count] || [[0, 0]])[index] || [0, 0];
}
function markerClusterScale(_count: number, _value: number) {
  return 1;
}
function Garden({ player, playerIndex, pieceFlights, activePlayer, selectedTile, sourceIndex, coins, canPlace, shedChoice, flightTileId, flightTargetIndex, flightScoreIndex, scoreTargetIndices, onScoreTarget, onShedToggle, onSelect, cells, storeTiles, storeSetup = false, selectedStoreId, storeSetupReady = false, onStoreTarget }: { player: any; playerIndex: number; pieceFlights: PieceFlight[]; activePlayer: any; selectedTile?: Tile; sourceIndex?: number; coins: number; canPlace: boolean; shedChoice?: ShedChoice; flightTileId?: string; flightTargetIndex?: number; flightScoreIndex?: number; scoreTargetIndices: number[]; onScoreTarget: (index: number) => void; onShedToggle: (n: number) => void; onSelect: (n: number) => void; cells: typeof gardenCells; storeTiles?: (number | null)[]; storeSetup?: boolean; selectedStoreId?: number | null; storeSetupReady?: boolean; onStoreTarget?: (index: number, storeId?: number) => void }) {
  const markers = [...resources.map(resource => ({ key: resource, label: resourceLabels[resource], value: player.tracks[resource], color: resourceColors[resource] })), { key: 'brewer', label: '酿酒师', value: player.brewer, color: '#eee4c8' }];
  const markerGroups = new Map<number, typeof markers>();
  markers.forEach(marker => markerGroups.set(marker.value, [...(markerGroups.get(marker.value) || []), marker]));
  let hutStoreSlot = 0;
  const selectedStoreSlot = selectedStoreId ? storeTiles?.indexOf(selectedStoreId) ?? -1 : -1;
  const boardExtension = ['black', 'yellow', 'blue', 'red'].includes(player.color) ? 'jpg' : 'png';
  return <div className={`garden-board ${canPlace ? 'placement-active' : ''} ${shedChoice ? 'shed-choice-active' : ''} ${storeSetup ? 'store-setup-active' : ''}`} data-player-board-index={playerIndex} style={{ backgroundImage: `url('/Images/board_${player.color}.${boardExtension}')` }}>{cells.map((g, i) => {
    const cell = player.board[i], tile = cell?.tile as Tile | undefined, point = playerBoardPercent(g.x, g.z), storeSlot = g.hut ? hutStoreSlot++ : -1, storeId = storeSlot >= 0 ? storeTiles?.[storeSlot] : undefined;
    const empty = !g.hut && !activePlayer.board[i]?.tile;
    const cost = selectedTile && g.side ? tileBaseCost(selectedTile, sourceIndex) * (g.side === 'sun' ? 2 : 1) : Infinity;
    const eligible = canPlace && empty && !!selectedTile && !!g.side && cost <= coins;
    const hiddenCandidate = canPlace && empty && !eligible;
    const shedCandidate = !!shedChoice?.candidates.includes(i);
    const shedTarget = shedCandidate && canSelectShedCell(shedChoice!, i);
    const shedUnavailable = shedCandidate && !shedTarget, shedSelected = !!shedChoice?.selected.includes(i);
    const storeSource = !!storeSetup && !!g.hut && !storeSetupReady && !selectedStoreId && !!storeId;
    const selectedStoreSource = !!storeSetup && !!g.hut && !storeSetupReady && !!selectedStoreId && selectedStoreSlot === storeSlot;
    const storeTarget = !!storeSetup && !!g.hut && !storeSetupReady && !!selectedStoreId && !selectedStoreSource && (selectedStoreSlot >= 0 || !storeId);
    const shedProgress = g.hut ? shedProductionProgress(activePlayer.board, i) : null;
    const activeShedHut = !!shedChoice && !!g.hut && shedChoice.hutIndex === i;
    const hasShedYield = !!shedProgress && !cell?.completed && shedProgress.filled > 0;
    const shownShedYield = cell?.shedValue ?? shedProgress?.value ?? 0;
    const title = storeTarget ? '点击在此棚屋放置或互换存储板块' : shedCandidate ? `${tile?.resource ? resourceLabels[tile.resource] : tile?.monk} · 棚屋奖励候选板块${shedSelected ? ' · 已选择' : shedUnavailable ? ' · 当前组合不符合规则' : ''}` : g.hut ? cell?.completed ? `已完成棚屋 · 产值 ${shedProgress?.value ?? 0} · 类型 ${cell.shedType}` : `棚屋位置：已放板块产值 ${shedProgress?.value ?? 0}（${shedProgress?.filled ?? 0}/6）` : `${g.row + 1} 行 · ${g.side === 'sun' ? '向阳' : '阴凉'}${eligible ? ` · ${cost}个钱币 · 点击放置` : ''}`;
    const storeCardFlying = !!storeId && pieceFlights.some(flight => flight.kind === 'store-card' && flight.playerIndex === playerIndex && flight.storeId === storeId && (flight.targetIndex === i || flight.sourceIndex === i));
    return <button key={i} data-garden-index={i} onClick={() => storeSetup ? (storeTarget || storeSource || selectedStoreSource) && onStoreTarget?.(i, storeId ?? undefined) : shedTarget ? onShedToggle(i) : eligible && onSelect(i)} disabled={storeSetup ? !(storeTarget || storeSource || selectedStoreSource) : !eligible && !shedTarget} className={`garden-cell ${g.side || ''} ${g.hut ? 'hut-cell' : ''} ${activeShedHut ? 'active-shed-hut' : ''} ${eligible ? 'eligible' : ''} ${hiddenCandidate ? 'hidden-candidate' : ''} ${tile ? 'filled' : ''} ${cell?.completed ? 'completed' : ''} ${shedTarget ? 'shed-target' : ''} ${shedUnavailable ? 'shed-unavailable' : ''} ${shedSelected ? 'shed-selected' : ''} ${storeTarget ? 'store-target' : ''} ${selectedStoreSource ? 'store-source-selected' : ''}`} style={{ left: `${point.left}%`, top: `${point.top}%` }} title={storeSetup && storeSource ? '点击选择此存储板块' : storeSetup && selectedStoreSource ? '再次点击取消选择' : title}>{g.hut ? <>{cell?.completed && <img className="shed-image" src={`/Images/shed_tile_${cell.shedType}.png`} alt="棚屋奖励" />}{!cell?.completed && storeId && !storeCardFlying && <img className="expansion-hut-store" src={`/Images/store_${storeId}.png`} alt="存储板块" />}{hasShedYield && <span className="hut-yield-badge" aria-label={`棚屋周围产值 ${shownShedYield}`}>{shownShedYield}</span>}</> : tile ? (flightTargetIndex === i && tile.id === flightTileId ? null : <TileFace tile={tile} />) : <span className="plus">{eligible ? `${cost}` : ''}</span>}{shedSelected && <span className="shed-check" aria-label="已选择激活">✓</span>}</button>;
  })}{markers.map(marker => {
    const pos = productionTrackPositions[marker.value]; if (!pos) return null;
    const group = markerGroups.get(marker.value)!, offset = markerClusterOffset(group.indexOf(marker), group.length), markerSize = 6 * markerClusterScale(group.length, marker.value);
    const markerFlying = pieceFlights.some(flight => flight.playerIndex === playerIndex && (marker.key === 'brewer' ? flight.kind === 'brewer-marker' : flight.kind === 'resource-marker' && flight.resourceKey === marker.key));
    if (markerFlying) return null;
    return marker.key === 'brewer' ? <span key={marker.key} role="img" className="brewer-marker-art" style={{ left: `${pos.left + offset[0]}%`, top: `${pos.top + offset[1]}%`, width: `${markerSize}%`, height: `${markerSize * 1.5}%`, zIndex: 9, backgroundPosition: meepleSpritePosition(player.color) }} title={`${marker.label}：${marker.value}`} aria-label="酿酒师标记" data-marker-label={`${marker.label} · ${marker.value}`} /> : <span key={marker.key} className="production-marker" data-resource-key={marker.key} style={{ left: `${pos.left + offset[0]}%`, top: `${pos.top + offset[1]}%`, width: `${markerSize}%`, height: `${markerSize}%`, zIndex: 10 + group.indexOf(marker), backgroundPosition: trackMarkerSpritePosition(marker.key as Resource) }} title={`${marker.label}：${marker.value}`} aria-label={`${marker.label} ${marker.value}`} data-marker-label={marker.label} />;
  })}{player.scores.x !== undefined && flightScoreIndex !== 0 && <ScoreDisc index={0} label={`A 类 · 产值 ${player.scores.x}`} value={player.scores.x} />}{player.scores.resource.map((resource: Resource | null) => { const index = resource ? 1 + resources.indexOf(resource) : -1; return resource && flightScoreIndex !== index && <ScoreDisc key={`resource-${resource}`} index={index} label={`C 类 · ${resourceLabels[resource]}`} />; })}{player.scores.monk.map((used: boolean, i: number) => used && flightScoreIndex !== 6 + i && <ScoreDisc key={`monk-${i}`} index={6 + i} label="B 类 · 僧侣图标" />)}{privilegeCardPositions.map((position, i) => <img key={`privilege-target-${i}`} data-privilege-target-index={i} className="board-privilege-card board-privilege-target" src="/Images/privilege_card_front_A.png" style={{ left: `${position.left}%`, top: `${position.top}%`, height: `${position.height}%` }} alt="" aria-hidden="true" />)}{player.privilegePairs.map((card: string | null, i: number) => card && card !== 'skip' && !pieceFlights.some(flight => flight.kind === 'privilege-card' && flight.playerIndex === playerIndex && flight.pairIndex === i) && <img key={`privilege-${i}`} className="board-privilege-card" src={`/Images/privilege_card_front_${card}.png`} style={{ left: `${privilegeCardPositions[i].left}%`, top: `${privilegeCardPositions[i].top}%`, height: `${privilegeCardPositions[i].height}%` }} title={`第 ${i + 1} 组：特权卡 ${card}`} alt={`第 ${i + 1} 组特权卡 ${card}`} />)}{scoreTargetIndices.map(index => { const point = scoringDiscPositions[index], isMonk = index >= 6, label = index === 0 ? 'A 类' : index <= 5 ? resourceLabels[resources[index - 1]] : '僧侣图标'; return <button key={`score-target-${index}`} type="button" className={`score-disc-target ${isMonk ? 'monk' : 'hex'}`} data-score-target-index={index} style={{ left: `${point.left}%`, top: `${point.top}%` }} title={`点击放置${label}计分圆片`} aria-label={`点击放置${label}计分圆片`} onClick={() => onScoreTarget(index)} />; })}</div>;
}
function ScoreDisc({ index, label, value }: { index: number; label: string; value?: number }) {
  const point = scoringDiscPositions[index];
  return <span className="player-score-disc-wrap" style={{ left: `${point.left}%`, top: `${point.top}%` }} title={label} aria-label={label}><img className="player-score-disc" src="/Images/scoring_disc.png" alt="紫色计分圆片" />{value !== undefined && <b className="player-score-disc-value">{value}</b>}</span>;
}
function shedChoiceInstruction(choice: ShedChoice) {
  if (choice.mode === 'one') return '任选 1 块';
  if (choice.mode === 'opposite') return '点选一块，自动勾选其对角板块';
  if (choice.mode === 'nonAdjacent') return '任选一块，自动勾选另外两块';
  return '任选 4 块';
}
createRoot(document.getElementById('root')!).render(<App />);
