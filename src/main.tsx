import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { LobbyClient } from 'boardgame.io/client';
import { HeavenAle, availableBarrelIds, barrelGoals, barrelTokenPositions, canBuyFrom, canMoveTo, canScore, canSelectShedCell, gardenCells, lowestResources, monkNames, playerBoardPercent, privilegeCardPositions, productionTrackPositions, resourceColors, resourceLabels, resources, scoreBreakdown, scoreChoices, scoringDiscPositions, shedProductionProgress, startSlots, tileBaseCost, validShedSelection, type AleState, type Resource, type ShedChoice, type Tile } from './game';
import { chooseBotMove, type BotDifficulty } from './bot';
import './style.css';
import './garden-layout.css';

type AnyClient = ReturnType<typeof Client>;
const gameName = 'heaven-and-ale';
function App() {
  const [screen, setScreen] = useState<'home' | 'game'>('home');
  const [client, setClient] = useState<AnyClient | null>(null);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [playerCount, setPlayerCount] = useState(2);
  const [botSeats, setBotSeats] = useState<number[]>([]);
  const [botNames, setBotNames] = useState(['机器人1', '机器人2', '机器人3', '机器人4']);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('normal');
  const [activeBotSeats, setActiveBotSeats] = useState<number[]>([]);
  const [playerName, setPlayerName] = useState('酿酒师');
  const [serverUrl, setServerUrl] = useState(import.meta.env.VITE_GAME_SERVER || 'http://localhost:8000');
  const [roomCode, setRoomCode] = useState('');
  const [roomInfo, setRoomInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const startLocal = (count: number, bots: number[], difficulty: BotDifficulty = 'normal', names: string[] = []) => {
    const setup = HeavenAle.setup!;
    const botSeatSet = new Set(bots);
    const localGame = {
      ...HeavenAle,
      setup: (args: any) => {
        const G = setup(args);
        G.players.forEach((player, i) => {
          if (botSeatSet.has(i)) player.name = names[i]?.trim() || `机器人${i + 1}`;
        });
        return G;
      },
    };
    const c = Client({ game: localGame, numPlayers: count });
    c.start(); setClient(c); setScreen('game'); setActiveBotSeats(bots);
    setRoomInfo(bots.length === count ? `机器人对局 · 全部由${difficulty === 'expert' ? '专家' : '普通'}机器人操控` : bots.length ? `本地混合对局 · ${difficulty === 'expert' ? '专家' : '普通'}机器人 × ${bots.length}` : '本地热座 · 轮流操作');
  };
  const createRoom = async () => {
    setBusy(true); setRoomInfo('正在连接游戏服务…');
    try {
      const lobby = new LobbyClient({ server: serverUrl });
      const created = await lobby.createMatch(gameName, { numPlayers: playerCount });
      const joined = await lobby.joinMatch(gameName, created.matchID, { playerName });
      const c = Client({ game: HeavenAle, multiplayer: SocketIO({ server: serverUrl }), matchID: created.matchID, playerID: String(joined.playerID), credentials: joined.playerCredentials });
      c.start(); setClient(c); setActiveBotSeats([]); setRoomCode(created.matchID); setRoomInfo(`房间 ${created.matchID} 已创建。分享房间号，其他玩家可从首页加入。`); setScreen('game');
    } catch (e) { setRoomInfo(`连接失败：${e instanceof Error ? e.message : '请确认 boardgame.io 服务端已启动。'}`); }
    setBusy(false);
  };
  const joinRoom = async () => {
    if (!roomCode.trim()) return;
    setBusy(true); setRoomInfo('正在加入房间…');
    try {
      const lobby = new LobbyClient({ server: serverUrl });
      const joined = await lobby.joinMatch(gameName, roomCode.trim(), { playerName });
      const c = Client({ game: HeavenAle, multiplayer: SocketIO({ server: serverUrl }), matchID: roomCode.trim(), playerID: String(joined.playerID), credentials: joined.playerCredentials });
      c.start(); setClient(c); setActiveBotSeats([]); setScreen('game'); setRoomInfo(`已加入房间 ${roomCode.trim()}`);
    } catch (e) { setRoomInfo(`加入失败：${e instanceof Error ? e.message : '请检查房间号和服务器地址。'}`); }
    setBusy(false);
  };

  useEffect(() => { if (!client) return; const unsub = client.subscribe((state: any) => setSnapshot(state)); return () => { unsub(); client.stop(); }; }, [client]);
  if (screen === 'game' && client && snapshot) return <GameView client={client} state={snapshot} roomInfo={roomInfo} roomCode={roomCode} botSeats={activeBotSeats} botDifficulty={botDifficulty} onExit={() => { client.stop(); setClient(null); setSnapshot(null); setScreen('home'); setActiveBotSeats([]); }} />;
  return <main className="landing">
    <div className="landing-image" />
    <header className="topbar"><div className="brand-mark">H<span>&</span>A</div><div>一座修道院，一场酿造竞赛</div><div className="online-status"><i /> 桌游数字版</div></header>
    <section className="hero">
      <div className="eyebrow"><span>STRATEGY · 2–4 PLAYERS</span><span className="eyeline" /></div>
      <h1>天堂与美酒</h1>
      <p className="hero-sub">在阳光与荫凉之间，酿出你的胜利。</p>
      <div className="hero-copy">经营修道院花园，购入资源与僧侣，平衡金币和生产力。<br />每一步都在为最后那杯啤酒积蓄力量。</div>
      <div className="setup-grid">
        <div className="setup-card primary-card"><div className="card-kicker">QUICK TABLE</div><h2>开始本地对局</h2><p>先选择席位人数，再为每个席位指定真人或机器人；支持混合对局和全机器人观战。</p><label>总玩家人数<select value={playerCount} onChange={e => { const count = Number(e.target.value); setPlayerCount(count); setBotSeats(current => current.filter(seat => seat < count)); }}><option value={2}>2 位修道院长</option><option value={3}>3 位修道院长</option><option value={4}>4 位修道院长</option></select></label><div className="bot-seat-toolbar"><span>玩家席位</span><div><button type="button" onClick={() => setBotSeats(Array.from({ length: playerCount }, (_, i) => i))}>全部设为机器人</button><button type="button" onClick={() => setBotSeats([])}>全部设为真人</button></div></div><div className="bot-seat-list">{Array.from({ length: playerCount }, (_, seat) => { const isBot = botSeats.includes(seat); return <div className="bot-seat-row" key={seat}><label className="bot-seat-toggle"><input type="checkbox" checked={isBot} onChange={e => setBotSeats(current => e.target.checked ? [...current, seat].sort((a, b) => a - b) : current.filter(id => id !== seat))} />玩家 {seat + 1} · {isBot ? '机器人' : '真人'}</label>{isBot && <input aria-label={`玩家 ${seat + 1} 机器人的名称`} value={botNames[seat]} maxLength={18} onChange={e => setBotNames(current => current.map((name, i) => i === seat ? e.target.value : name))} placeholder={`机器人${seat + 1}`} />}</div>; })}</div>{botSeats.length > 0 && <label>机器人难度<select value={botDifficulty} onChange={e => setBotDifficulty(e.target.value as BotDifficulty)}><option value="normal">普通 · 约 3 秒/步</option><option value="expert">专家 · 约 12 秒/步</option></select></label>}<button className="btn btn-gold" onClick={() => startLocal(playerCount, botSeats, botDifficulty, botNames)}>开始本地对局 <span>↗</span></button></div>
        <div className="setup-card online-card"><div className="card-kicker">PLAY TOGETHER</div><h2>线上房间</h2><p>创建私人房间，或输入朋友分享的房间号。</p><label>显示名称<input value={playerName} onChange={e => setPlayerName(e.target.value)} maxLength={18} /></label><label>游戏服务器<input value={serverUrl} onChange={e => setServerUrl(e.target.value)} /></label><div className="online-actions"><button className="btn btn-outline" disabled={busy} onClick={createRoom}>创建房间</button><div className="join-row"><input placeholder="房间号" value={roomCode} onChange={e => setRoomCode(e.target.value)} /><button className="btn btn-light" disabled={busy} onClick={joinRoom}>加入</button></div></div>{roomInfo && <div className="room-message">{roomInfo}</div>}</div>
      </div>
      <div className="feature-row"><span>✦ 依照官方规则设计</span><span>✦ 共享房间码联机</span><span>✦ 支持 2–4 人</span></div>
    </section>
    <footer>HEAVEN & ALE <span>·</span> 修道院酿造记</footer>
  </main>;
}

function GameView({ client, state, roomInfo, roomCode, botSeats, botDifficulty, onExit }: { client: AnyClient; state: any; roomInfo: string; roomCode: string; botSeats: number[]; botDifficulty: BotDifficulty; onExit: () => void }) {
  const G = state.G as AleState, ctx = state.ctx, currentPlayerIndex = Number(ctx.currentPlayer);
  const currentPlayer = G.players[currentPlayerIndex] ?? G.players[0];
  const gameover = ctx.gameover as { winner?: string; winners?: string[]; draw?: boolean; scores?: number[] } | undefined;
  const winnerIds = gameover?.winners ?? (gameover?.winner !== undefined ? [String(gameover.winner)] : []);
  const moves = (client as any).moves;
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [scoreChoice, setScoreChoice] = useState<string>('1');
  const [scoreCategory, setScoreCategory] = useState<'A' | 'B' | 'C'>('A');
  const [privilegeCardChoice, setPrivilegeCardChoice] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [toast, setToast] = useState('');
  const [botSearchStatus, setBotSearchStatus] = useState<{ playerID: number; iterations: number } | null>(null);
  const [viewingPlayerIndex, setViewingPlayerIndex] = useState(currentPlayerIndex);
  useEffect(() => setViewingPlayerIndex(currentPlayerIndex), [currentPlayerIndex]);
  const me = G.players[viewingPlayerIndex] ?? currentPlayer;
  const isViewingCurrent = viewingPlayerIndex === currentPlayerIndex;
  const action = G.pending;
  const activePlayer = action ? G.players[Number(action.player)] : currentPlayer;
  const garden = gardenCells;
  const activeSeat = Number(ctx.currentPlayer);
  const isBotTurn = botSeats.includes(activeSeat) && G.phase !== 'finished';
  const canMove = !isBotTurn && !action && !G.confirmationKind && !G.privilegePrompts.length && !currentPlayer.retired && G.phase === 'play';
  const trackMove = (index: number) => { moves.moveTo(index); setSelectedTileId(null); };
  const currentActionSpace = action ? G.track[action.space] : null;
  const activeShedChoice = G.shedChoices[0];
  const market = action?.type === 'resource' ? G.resources[currentActionSpace?.sourceIndex ?? -1] : action?.type === 'monk' ? G.monks[currentActionSpace?.sourceIndex ?? -1] : [];
  const selectedTile = market?.find(tile => tile.id === selectedTileId) ?? market?.[0];
  const canPlace = !isBotTurn && isViewingCurrent && !!action && ['resource', 'monk'].includes(action.type) && !!selectedTile;
  const placeTile = (index: number) => { if (!selectedTile) return; moves.buyTile(selectedTile.id, index); setSelectedTileId(null); };
  const startSlotTaken = (slot: number) => G.players.some(p => p.startSlot === slot);
  const lastToReturn = G.phase === 'play' && !!action && action.type === 'start' && G.players.every(p => p.retired || p === activePlayer);
  const forceFirstPlayerSlot = lastToReturn && !startSlotTaken(0);
  const canChooseStartSlot = (slot: number) => !isBotTurn && !G.startChoice && !startSlotTaken(slot) && (G.phase === 'setup' ? slot !== 0 && currentPlayer.startSlot === null : action?.type === 'start' && (!forceFirstPlayerSlot || slot === 0));
  const chooseStartSlot = (slot: number) => moves.chooseStartSlot(slot);
  const currentScoreSpace = action ? G.track[action.space] : null;
  const privilegePrompt = G.privilegePrompts[0];
  const privilegeResources = privilegeCardChoice === 'A' ? resources.filter(resource => activePlayer.board.some(cell => cell.tile?.resource === resource)) : privilegeCardChoice === 'B' ? lowestResources(activePlayer) : [];
  const choosePrivilegeCard = (card: string | null) => {
    if (card === 'A') setPrivilegeCardChoice(card);
    else if (card === 'B') {
      const choices = lowestResources(activePlayer);
      if (choices.length === 1) { moves.choosePrivilege(card, choices[0]); setPrivilegeCardChoice(null); }
      else setPrivilegeCardChoice(card);
    }
    else { moves.choosePrivilege(card); setPrivilegeCardChoice(null); }
  };
  const choosePrivilegeResource = (resource: Resource) => {
    moves.choosePrivilege(privilegeCardChoice, resource);
    setPrivilegeCardChoice(null);
  };
  const scoreCategories: ('A' | 'B' | 'C')[] = currentScoreSpace?.scoreType === 'ABC' ? ['A', 'B', 'C'] : currentScoreSpace?.scoreType ? [currentScoreSpace.scoreType] : [];
  const selectedScoreCategory = scoreCategories.includes(scoreCategory) ? scoreCategory : scoreCategories[0] || 'A';
  const scoreOptions = scoreChoices(activePlayer, selectedScoreCategory).map(String);
  const selectedScoreOption = scoreOptions.includes(scoreChoice) ? scoreChoice : scoreOptions[0];
  const submitScore = () => {
    if (!selectedScoreOption) return;
    const option = selectedScoreCategory === 'A' ? Number(selectedScoreOption) : selectedScoreOption;
    moves.takeScore(selectedScoreCategory, option);
  };
  return <main className="table-screen">
    <BotController client={client} botSeats={botSeats} difficulty={botDifficulty} onThinking={setBotSearchStatus} />
    <header className="table-header"><div className="brand-mark small">H<span>&</span>A</div><div className="table-title"><b>天堂与美酒</b><small>{roomInfo}{roomCode && ` · 房间 ${roomCode}`}</small></div><div className="round-chip">第 {G.round} / {G.maxRounds} 轮</div><button className="icon-btn" onClick={() => setShowRules(true)}>规则</button><button className="icon-btn" onClick={onExit}>离开</button></header>
    {G.phase === 'finished' && <div className="game-over-banner"><b>{gameover?.draw ? '平分，共享胜利：' : '获胜者：'}{winnerIds.map(id => G.players[Number(id)]?.name).filter(Boolean).join('、')}</b><span> · </span>{G.players.map((p, i) => <span key={i}>{p.name}：{gameover?.scores?.[i] ?? scoreBreakdown(p).total} 分{i < G.players.length - 1 ? '　' : ''}</span>)}</div>}
    <div className={`game-layout ${isBotTurn ? 'bot-thinking' : ''}`}>
      <section className="center-play"><div className="board-heading"><div><span className="eyebrow">ROUND {G.round}</span><h2>公共行动轨道</h2></div>{isBotTurn ? <span className="bot-thinking-pill"><i className="bot-thinking-dot" />{G.players[activeSeat]?.name} 正在思考</span> : <span className="board-tip">前进不能后退 · 经过的格子不触发行动</span>}</div>
        <div className="main-board-wrap"><img src="/Images/main_board.png" alt="天堂与美酒主版图" className="main-board-art" /><div className="track-overlay">
          {G.track.map((space, i) => {
            const occupants = G.players.filter(p => p.position === i); const here = canMove && i > currentPlayer.position; const stock = space.type === 'resource' ? G.resources[space.sourceIndex ?? -1] : space.type === 'monk' ? G.monks[space.sourceIndex ?? -1] : []; const supplySpace = space.type === 'resource' || space.type === 'monk'; const good = here && canMoveTo(G, currentPlayer, i); const x = (space.x / 1904) * 100, y = (space.y / 1176) * 100; return <button key={i} disabled={!good} onClick={() => trackMove(i)} style={{ left: `${x}%`, top: `${y}%` }} className={`track-space ${space.type} ${good ? 'available-space' : ''} ${currentPlayer.position === i ? 'current-space' : ''}`} title={`${i + 1} · ${space.label}`}>
              {space.type === 'score' ? <span className="space-score-discs">{Array.from({ length: G.scores[space.sourceIndex ?? -1] || 0 }, (_, disc) => <img key={disc} src="/Images/scoring_disc.png" alt="紫色计分圆片" />)}</span> : supplySpace ? <span className="space-supply">{(stock || []).map(tile => <TileFace key={tile.id} tile={tile} />)}</span> : <span>{space.type === 'barrel' ? '▣' : space.type === 'start' ? '⌂' : '✦'}</span>}
              {!supplySpace && space.type !== 'score' && <small>{space.label}</small>}
              {occupants.length > 0 && <i className="occupants">{occupants.map(p => <img key={p.color} className={G.players.indexOf(p) === currentPlayerIndex ? 'is-active-player' : ''} src={`/Images/player_figure_${p.color}.png`} alt={p.name} title={`${p.name}${G.players.indexOf(p) === currentPlayerIndex ? ' · 正在行动' : ''}`} />)}</i>}
            </button>;
          })}
          {G.barrels.map(stock => { const pos = barrelTokenPositions[stock.id - 1], goalTitle = `目标 ${stock.id}：${barrelGoals[stock.id - 1]}`, claims = G.players.flatMap(p => p.claimedBarrels.filter(b => b.id === stock.id).map(b => ({ player: p, size: b.size }))); return <div className={`barrel-goal-cell ${stock.remaining === 0 ? 'exhausted' : ''}`} key={`barrel-${stock.id}`} style={{ left: `${pos.left}%`, top: `${pos.top}%` }} title={goalTitle}>{stock.remaining === 2 ? <><img className="barrel-goal-token small-under" src={`/Images/barrel_goal_${stock.id}.png`} alt="" /><img className="barrel-goal-token large-front" src={`/Images/barrel_goal_${stock.id}.png`} alt={`酒桶成就 ${stock.id}`} /></> : stock.remaining === 1 ? <img className="barrel-goal-token small-alone" src={`/Images/barrel_goal_${stock.id}.png`} alt={`酒桶成就 ${stock.id}，小酒桶`} /> : <img className="barrel-goal-token exhausted-token" src={`/Images/barrel_goal_${stock.id}.png`} alt={`已领取的酒桶成就 ${stock.id}`} />}{claims.length > 0 && <div className="barrel-claim-badges">{claims.map(({ player, size }) => <span key={`${player.color}-${size}`} className={`barrel-claim-badge ${player.color}`} title={`${player.name} 已领取${size === 'large' ? '大酒桶（4分）' : '小酒桶（2分）'}`}><img src={`/Images/player_figure_${player.color}.png`} alt="" /><b>{size === 'large' ? '大' : '小'}</b></span>)}</div>}</div>; })}
          {startSlots.map((slot, i) => { const occupant = G.players.find(p => p.startSlot === i); const selectable = canChooseStartSlot(i); return <button key={`start-${i}`} disabled={!selectable} onClick={() => chooseStartSlot(i)} className={`start-slot slot-${i} ${occupant ? 'occupied' : ''} ${selectable ? 'selectable' : ''} ${forceFirstPlayerSlot && i === 0 ? 'forced' : ''}`} style={{ left: `${slot.x / 1904 * 100}%`, top: `${slot.y / 1176 * 100}%` }} title={`${slot.label}：${slot.reward}`}><span className="start-slot-caption">{slot.label}<small>{slot.reward}</small></span>{occupant && <img className="start-player-figure" src={`/Images/player_figure_${occupant.color}.png`} alt={occupant.name} />}</button>; })}
        </div></div>
        <div className="action-area">
          {G.phase === 'setup' && !G.startChoice && <div className="action-panel start-guide"><span className="eyebrow">STARTING POSITIONS</span><h3>逆时针选择起始奖励</h3><p>首位玩家（{G.players[G.startPlayer]?.name}）已在“首位玩家格”，无奖励。现在轮到 {currentPlayer.name}，请点击主板起始区域中的空位。</p></div>}
          {G.startChoice && <div className="action-panel compact-panel"><span className="eyebrow">START BONUS</span><h3>选择推进的资源</h3><p className="panel-desc">将选中的资源标记向前推进 2 格；若已在第 20 格，按规则获得钱币。</p><div className="score-picker">{resources.map(r => <button key={r} onClick={() => moves.chooseStartResource(r)} style={{ borderColor: resourceColors[r] }}>{resourceLabels[r]}</button>)}</div></div>}
          {!action && !activeShedChoice && !G.confirmationKind && G.phase === 'play' && <div className="empty-action"><div className="action-glyph">✦</div><div><b>{currentPlayer.retired ? '本轮已结束' : `轮到 ${currentPlayer.name}`}</b><p>{currentPlayer.retired ? '等待仍在公共轨上行动的玩家。' : '沿公共轨向前移动；可以进入任意空起始格并领取该格奖励。'}</p></div><span className="move-hint">{canMove ? '选择高亮行动格' : '等待对手'}</span></div>}
          {action?.type === 'resource' || action?.type === 'monk' ? <div className="action-panel"><div className="panel-title"><div><span className="eyebrow">{action.type === 'resource' ? 'GARDEN GOODS' : 'BROTHERHOOD'}</span><h3>{action.type === 'resource' ? '选择资源板块' : '选择僧侣板块'}</h3></div><div className="cost-note">钱币足够时可连续购买多个</div></div><div className="purchase-flow"><div className="flow-step"><b>1</b><span>选择板块</span></div><div className="shop-row">{market?.map((tile: Tile) => <button key={tile.id} className={`shop-tile ${tile.resource || 'monk-tile'} ${selectedTile?.id === tile.id ? 'selected' : ''}`} onClick={() => setSelectedTileId(tile.id)} disabled={market.length === 1}><TileFace tile={tile} /><b>{tileBaseCost(tile, currentActionSpace?.sourceIndex)} ◉</b><small>{tile.kind === 'resource' ? resourceLabels[tile.resource!] : tile.monk}</small></button>)}</div><div className="flow-step"><b>2</b><span>{selectedTile ? '选择花园空格' : '先选板块'}</span></div><span className="selection-hint">{selectedTile ? '阳面价格为阴面标价的 2 倍；只显示你付得起的位置。点击位置完成放置。' : market?.length === 1 ? '唯一板块已自动选中。' : '选择板块后，花园会高亮所有当前可放置的位置。'}</span></div>{!activeShedChoice && <button className="btn btn-outline finish-purchase" disabled={(action.purchases ?? 0) < 1} onClick={() => moves.finishPurchase()}>{(action.purchases ?? 0) < 1 ? '至少购买 1 块板块后才能结束' : '结束购买并确认行动'}</button>}</div> : null}
          {action?.type === 'score' && <div className="action-panel compact-panel"><div className="panel-title"><div><span className="eyebrow">SCORING TOKEN</span><h3>将紫色圆片放到对应图标</h3></div><div className="score-discs">{G.scores.map((n, i) => n > 0 && <span key={i}>◉ {n}</span>)}</div></div><p className="panel-desc">每个玩家版图上的计分图标只能放置一次；A 按产值计分，C 按资源计分，B 触发该类僧侣。</p>{currentScoreSpace?.scoreType === 'ABC' && <div className="score-picker score-category-picker">{scoreCategories.map(category => <button key={category} className={selectedScoreCategory === category ? 'selected' : ''} onClick={() => { setScoreCategory(category); setScoreChoice(''); }}>{category} 类</button>)}</div>}<div className="score-picker">{scoreOptions.map(option => <button key={option} className={selectedScoreOption === option ? 'selected' : ''} onClick={() => setScoreChoice(option)}>{selectedScoreCategory === 'A' ? `产值 ${option}` : selectedScoreCategory === 'C' ? resourceLabels[option as Resource] : <img className="score-monk-icon" src={`/Images/monk_tile_${String.fromCharCode(65 + monkNames.indexOf(option))}.png`} alt="僧侣图标" title="僧侣板块" />}</button>)}</div><button className="btn btn-gold" disabled={!selectedScoreOption} onClick={submitScore}>放置圆片并计分 <span>↗</span></button></div>}
          {privilegePrompt && <div className="action-panel compact-panel privilege-prompt"><span className="eyebrow">PRIVILEGE REWARD</span><h3>{`完成第 ${privilegePrompt.pairIndex + 1} 组计分标记`}</h3><p className="panel-desc">{'立即放置一张尚未弃置的特权卡到对应组右侧，或永久跳过。'}</p>{privilegePrompt.kind === 'pair' && <div className="privilege-pick-list">{activePlayer.privileges.filter((card: string) => card !== 'A' || activePlayer.board.some((cell: any) => !!cell.tile?.resource)).map((card: string) => <button key={card} onClick={() => choosePrivilegeCard(card)}><img src={`/Images/privilege_card_front_${card}.png`} alt={`特权卡 ${card}`} /><span>{card}{card === 'A' ? ' · 资源轨道' : card === 'B' ? ' · 最后资源推进' : card === 'C' ? ' · 酒桶终局 +1' : card === 'D' ? ' · +12 金币' : ' · 酿酒师 +5'}</span></button>)}<button className="skip-privilege" onClick={() => choosePrivilegeCard('skip')}>本组不放置<br /><small>之后不能补放</small></button></div>}{privilegeCardChoice === 'A' && <p className="panel-desc">只显示至少有 1 块对应资源板块的种类。</p>}{privilegeResources.length > 0 && <div className="score-picker privilege-resource-picker">{privilegeResources.map(resource => <button key={resource} onClick={() => choosePrivilegeResource(resource)} style={{ borderColor: resourceColors[resource] }}>{resourceLabels[resource]}</button>)}</div>}</div>}
          {!action && G.confirmationKind === 'turn' && G.log[0]?.includes('到达酒桶成就格') && <div className="action-panel compact-panel"><span className="eyebrow">CELLAR ACHIEVEMENTS</span><h3>酒桶成就已领取</h3><p className="panel-desc">{G.log[0]}</p></div>}
          {action?.type === 'start' && !G.startChoice && <div className="action-panel start-guide"><span className="eyebrow">RETURN TO START</span><h3>选择起始区域空位</h3><p>{forceFirstPlayerSlot ? '其他玩家都已返回，首位玩家格空置；你必须停在首位玩家格。' : '点击主板起始区域中任一空位，立即领取该格奖励并结束本轮。'}</p></div>}
          {activeShedChoice && <div className="action-panel shed-choice-panel"><span className="eyebrow">SHED BONUS</span><h3>棚屋奖励 · 周围产值 {activeShedChoice.value}</h3><p>酿酒师轨道 +{activeShedChoice.brewerAdvance} 格。请选择激活的相邻板块：{shedChoiceInstruction(activeShedChoice)}</p><div className="shed-choice-status">已选 {activeShedChoice.selected.length} / {activeShedChoice.activateCount} 块 · 点击花园中高亮的相邻板块</div><button className="btn btn-gold" disabled={!validShedSelection(activeShedChoice)} onClick={() => moves.completeShedChoice()}>完成棚屋激活选择</button></div>}
          {G.undoSnapshot && <div className="action-confirm-bar"><span>{G.confirmationKind ? '行动已完成，请确认或撤回。' : activeShedChoice ? '请选择棚屋奖励板块，或撤回整次行动。' : action?.type === 'resource' || action?.type === 'monk' ? '可继续购买；结束购买后可确认或撤回整次行动。' : '可以撤回当前选择，重新选行动格。'}</span><button className="btn btn-undo" onClick={() => { moves.undoAction(); setSelectedTileId(null); }}>撤回</button>{G.confirmationKind && <button className="btn btn-gold btn-confirm" onClick={() => moves.confirmAction()}>确认行动</button>}</div>}
        </div>
      </section>
      <aside className={`right-rail ${!isViewingCurrent ? 'is-inspecting-opponent' : ''}`}><div className="garden-heading"><div><span className="eyebrow">{isViewingCurrent ? 'YOUR MONASTERY' : 'PLAYER BOARD'}</span><h2>{me.name} 的花园</h2>{!isViewingCurrent && <small className="inspection-hint">正在查看对手版图 · 只读</small>}</div><div className="garden-legend"></div></div><div className="garden-board-reserved"><Garden player={me} selectedTile={isViewingCurrent && canPlace ? selectedTile : undefined} sourceIndex={currentActionSpace?.sourceIndex} coins={activePlayer.coins} canPlace={isViewingCurrent && canPlace} activePlayer={me} shedChoice={isViewingCurrent ? activeShedChoice : undefined} onShedToggle={(i) => { if (isViewingCurrent) moves.toggleShedChoice(i); }} onSelect={(i) => { if (isViewingCurrent) placeTile(i); }} cells={garden} /></div><div className="rail-heading">特权卡 · 点击弃置可得 3 金币</div><div className="privileges">{['A', 'B', 'C', 'D', 'E'].filter(card => !me.privilegePairs.includes(card)).map(card => { const inHand = me.privileges.includes(card); const earned = me.privilegePairs.includes(card); const blocked = !isViewingCurrent || (!!G.confirmationKind && G.confirmationKind !== 'turn') || !!privilegePrompt; return <div className={`privilege ${inHand ? '' : 'used'}`} key={card}><img src={`/Images/privilege_card_front_${card}.png`} alt={`特权卡 ${card}`} />{inHand ? <button disabled={blocked} onClick={() => moves.discardPrivilege(card)}>弃置 +3</button> : <span>{earned ? '已放置' : '已弃置'}</span>}</div>; })}</div><div className="rail-heading">已领取酒桶 <span className="count">{me.claimedBarrels.length}</span></div><div className="barrel-strip">{me.claimedBarrels.map((b, i) => <span key={`${b.id}-${i}`} className={`barrel-claimed-item ${b.size}`} title={`目标 ${b.id}：${barrelGoals[b.id - 1]} ${b.size === 'large' ? '大酒桶，4分' : '小酒桶，2分'}`}><img src={`/Images/barrel_goal_${b.id}.png`} alt={`目标 ${b.id}`} /><small>{b.size === 'large' ? '大 · 4分' : '小 · 2分'}</small></span>)}</div><div className="score-summary"><span>当前金币</span><b>◉ {me.coins}</b><span>酒桶计分</span><b>{me.claimedBarrels.reduce((n, b) => n + (b.size === 'large' ? 4 : 2), 0) + (me.privilegePairs.includes('C') ? me.claimedBarrels.length : 0)} 分</b></div></aside>
      <aside className="far-right-rail"><div className="rail-heading">玩家信息 · 点击查看版图</div><div className="player-roster">{G.players.map((p, i) => {
        const scoring = scoreBreakdown(p); const short: Record<Resource, string> = { wood: '木', yeast: '酵', hops: '花', water: '水', barley: '麦' }; return <div className={`player-info-unit ${i === viewingPlayerIndex ? 'is-viewing' : ''}`} key={i} role="button" tabIndex={0} aria-label={`查看${p.name}的玩家版图`} onClick={() => setViewingPlayerIndex(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewingPlayerIndex(i); } }}>
          <div className={`player-card ${i === Number(ctx.currentPlayer) ? 'is-turn' : ''} ${p.retired ? 'is-done' : ''}`}><div className={`avatar ${p.color}`}>{p.name.slice(-1)}</div><div className="player-name">{p.name}<small>{botSeats.includes(i) ? `${botDifficulty === 'expert' ? '专家' : '普通'}机器人${i === Number(ctx.currentPlayer) ? botSearchStatus?.playerID === i ? ` · 搜索中 ${botSearchStatus.iterations} 次` : ' · 正在行动' : ''}` : p.retired ? '本轮已休息' : i === Number(ctx.currentPlayer) ? '正在行动' : '等待中'}</small></div><div className="money">◉ {p.coins}</div></div>
          <div className="player-live-details" title={`按当前状态预演终局：资源归并后最低为 ${scoring.minResource}，生产 ${scoring.productionScore} 分；酒桶 ${scoring.barrelScore} 分；起始奖励 ${scoring.startBonus} 分。`}>
            <div className="player-resource-track">{resources.map(r => <span key={r} title={`${resourceLabels[r]}轨道：${p.tracks[r]}`}><i style={{ background: resourceColors[r] }} />{short[r]} <b>{p.tracks[r]}</b></span>)}</div>
            <div className="player-live-metrics"><span><small>酿酒师格</small><b>{p.brewer}</b></span><span><small>交换比</small><b>{scoring.exchangeRate}:1</b></span><span><small>胜利点</small><b>{scoring.victoryPoints}</b></span><span><small>基数</small><b>{scoring.minResource}</b></span><span><small>酒桶分</small><b>{scoring.barrelScore}</b></span><span className="live-total"><small>实时计分</small><b>{scoring.total}</b></span></div>
          </div>
        </div>;
      })}</div><div className="rail-heading log-heading">行动日志</div><div className="log-list">{G.log.slice(0, 80).map((line, i) => <p key={i} className={line.startsWith('[[TURN:') ? 'log-turn-divider' : ''}>{renderLog(line, G.players)}</p>)}</div></aside>
    </div>
    {showRules && <div className="modal-backdrop" onClick={() => setShowRules(false)}><div className="rules-modal" onClick={e => e.stopPropagation()}><button className="close-modal" onClick={() => setShowRules(false)}>×</button><span className="eyebrow">HOW TO PLAY</span><h2>修道院经营要点</h2><p>每回合沿公共轨道向前移动，并执行落点行动。购买资源与僧侣板块后，将它们放入花园的向阳或阴凉空格。</p><ul><li>阴凉板块按面值购买；资源激活时获得金币。</li><li>向阳板块花费双倍；资源激活时推进对应生产轨道。</li><li>计分行动会激活对应产值、资源或僧侣，帮助提升最终分数。</li><li>返回起点领取奖励，本轮休息；所有人都返回后开始新一轮。</li></ul><p className="fine-print">线上联机需要先启动项目内的 boardgame.io 服务端。各回合在玩家设备上依次进行。</p></div></div>}
    {toast && <div className="toast" onClick={() => setToast('')}>{toast} <span>×</span></div>}
  </main>;
}

function BotController({ client, botSeats, difficulty, onThinking }: { client: AnyClient; botSeats: number[]; difficulty: BotDifficulty; onThinking: (status: { playerID: number; iterations: number } | null) => void }) {
  useEffect(() => {
    if (!botSeats.length) return;
    let timer: number | undefined;
    let worker: Worker | undefined;
    let requestID = 0;
    const onState = (state: any) => {
      requestID++;
      const request = requestID;
      if (timer !== undefined) window.clearTimeout(timer);
      worker?.terminate(); worker = undefined;
      const playerID = Number(state?.ctx?.currentPlayer);
      if (!state || state.G.phase === 'finished' || !botSeats.includes(playerID)) { onThinking(null); return; }
      onThinking({ playerID, iterations: 0 });
      timer = window.setTimeout(() => {
        const current = (client as any).getState();
        if (!current || current._stateID !== state._stateID) return;
        const finish = (decision: ReturnType<typeof chooseBotMove>) => {
          if (request !== requestID) return;
          worker?.terminate(); worker = undefined;
          onThinking(null);
          const latest = (client as any).getState();
          if (latest?._stateID !== current._stateID || latest.ctx.currentPlayer !== current.ctx.currentPlayer) return;
          if (decision) (client as any).moves[decision.name]?.(...decision.args);
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
      }, 100);
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
  return tile.resource ? <div className="tile-image resource-face"><img src={`/Images/${tile.resource}_${tile.value}.png`} alt="" /></div> : <div className="tile-image monk-face"><img src={`/Images/monk_tile_${['A', 'B', 'C', 'D'][Math.max(0, ['修士', '酿酒师', '园丁', '院长'].indexOf(tile.monk || ''))]}.png`} alt="" /></div>;
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
function Garden({ player, activePlayer, selectedTile, sourceIndex, coins, canPlace, shedChoice, onShedToggle, onSelect, cells }: { player: any; activePlayer: any; selectedTile?: Tile; sourceIndex?: number; coins: number; canPlace: boolean; shedChoice?: ShedChoice; onShedToggle: (n: number) => void; onSelect: (n: number) => void; cells: typeof gardenCells }) {
  const markers = [...resources.map(resource => ({ key: resource, label: resourceLabels[resource], value: player.tracks[resource], color: resourceColors[resource] })), { key: 'brewer', label: '酿酒师', value: player.brewer, color: '#eee4c8' }];
  const markerGroups = new Map<number, typeof markers>();
  markers.forEach(marker => markerGroups.set(marker.value, [...(markerGroups.get(marker.value) || []), marker]));
  return <div className={`garden-board ${canPlace ? 'placement-active' : ''} ${shedChoice ? 'shed-choice-active' : ''}`} style={{ backgroundImage: `url('/Images/board_${player.color}.png')` }}>{cells.map((g, i) => {
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
    const title = shedCandidate ? `${tile?.resource ? resourceLabels[tile.resource] : tile?.monk} · 棚屋奖励候选板块${shedSelected ? ' · 已选择' : shedUnavailable ? ' · 当前组合不符合规则' : ''}` : g.hut ? cell?.completed ? `已完成棚屋 · 产值 ${shedProgress?.value ?? 0} · 类型 ${cell.shedType}` : `棚屋位置：已放板块产值 ${shedProgress?.value ?? 0}（${shedProgress?.filled ?? 0}/6）` : `${g.row + 1} 行 · ${g.side === 'sun' ? '向阳' : '阴凉'}${eligible ? ` · ${cost} 金币 · 点击放置` : ''}`;
    return <button key={i} onClick={() => shedTarget ? onShedToggle(i) : eligible && onSelect(i)} disabled={!eligible && !shedTarget} className={`garden-cell ${g.side || ''} ${g.hut ? 'hut-cell' : ''} ${eligible ? 'eligible' : ''} ${hiddenCandidate ? 'hidden-candidate' : ''} ${tile ? 'filled' : ''} ${cell?.completed ? 'completed' : ''} ${shedTarget ? 'shed-target' : ''} ${shedUnavailable ? 'shed-unavailable' : ''} ${shedSelected ? 'shed-selected' : ''}`} style={{ left: `${point.left}%`, top: `${point.top}%` }} title={title}>{g.hut ? <>{cell?.completed && <img className="shed-image" src={`/Images/shed_tile_${cell.shedType}.png`} alt="棚屋奖励" />}{hasShedYield && <span className="hut-yield-badge" aria-label={`棚屋周围产值 ${shownShedYield}`}>{shownShedYield}</span>}</> : tile ? <TileFace tile={tile} /> : <span className="plus">{eligible ? `${cost}` : ''}</span>}{shedSelected && <span className="shed-check" aria-label="已选择激活">✓</span>}</button>;
  })}{markers.map(marker => {
    const pos = productionTrackPositions[marker.value]; if (!pos) return null;
    const group = markerGroups.get(marker.value)!, offset = markerClusterOffset(group.indexOf(marker), group.length);
    return marker.key === 'brewer' ? <img key={marker.key} className="brewer-marker-art" src={`/Images/brewmaster_${player.color}.png`} style={{ left: `${pos.left + offset[0]}%`, top: `${pos.top + offset[1]}%`, zIndex: 9 }} title={`${marker.label}：${marker.value}`} alt="酿酒师标记" /> : <span key={marker.key} className="production-marker" style={{ left: `${pos.left + offset[0]}%`, top: `${pos.top + offset[1]}%`, zIndex: 10 + group.indexOf(marker), '--marker-color': marker.color } as React.CSSProperties} title={`${marker.label}：${marker.value}`} aria-label={`${marker.label} ${marker.value}`} />;
  })}{player.scores.x !== undefined && <ScoreDisc index={0} label="A 类计分" />}{player.scores.resource.map((resource: Resource | null, i: number) => resource && <ScoreDisc key={`resource-${resource}`} index={1 + resources.indexOf(resource)} label={`C 类 · ${resourceLabels[resource]}`} />)}{player.scores.monk.map((used: boolean, i: number) => used && <ScoreDisc key={`monk-${i}`} index={6 + i} label="B 类 · 僧侣图标" />)}{player.privilegePairs.map((card: string | null, i: number) => card && card !== 'skip' && <img key={`privilege-${i}`} className="board-privilege-card" src={`/Images/privilege_card_front_${card}.png`} style={{ left: `${privilegeCardPositions[i].left}%`, top: `${privilegeCardPositions[i].top}%`, height: `${privilegeCardPositions[i].height}%` }} title={`第 ${i + 1} 组：特权卡 ${card}`} alt={`第 ${i + 1} 组特权卡 ${card}`} />)}</div>;
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
