import type { Game } from 'boardgame.io';

export type Resource = 'wood' | 'yeast' | 'hops' | 'water' | 'barley';
export type Tile = { id: string; kind: 'resource' | 'monk'; value: number; tier?: 'I' | 'II'; resource?: Resource; monk?: string };
export type Cell = { hut?: boolean; tile?: Tile; side?: 'sun' | 'shade'; completed?: boolean; shedType?: number; shedValue?: number };
export type PlayerState = {
  name: string; color: string; coins: number; board: Cell[]; position: number; startSlot: number | null; retired: boolean;
  brewer: number; tracks: Record<Resource, number>; scores: { x?: number; monk: boolean[]; resource: (Resource | null)[] };
  privileges: string[]; privilegePairs: (string | 'skip' | null)[]; claimedBarrels: { id: number; size: 'small' | 'large' }[];
  roundBonusTaken?: boolean; finalAdjusted?: boolean;
};
export type ActionSpace = { type: 'resource' | 'monk' | 'score' | 'barrel' | 'start'; label: string; scoreType?: 'A' | 'B' | 'C' | 'ABC'; sourceIndex?: number; x: number; y: number };
export type ShedChoice = { hutIndex: number; value: number; brewerAdvance: number; activateCount: number; mode: 'one' | 'opposite' | 'nonAdjacent' | 'any'; candidates: number[]; selected: number[] };
export type PrivilegePrompt = { kind: 'pair'; pairIndex: number };
export type AleState = {
  players: PlayerState[]; round: number; maxRounds: number; track: ActionSpace[]; resources: Tile[][]; monks: Tile[][];
  resourceDecks: Tile[][]; monkDecks: Tile[][]; scores: number[]; barrels: { id: number; remaining: number }[]; phase: 'setup' | 'play' | 'finished';
  pending: { space: number; type: ActionSpace['type']; player: string; purchases?: number } | null; log: string[];
  startPlayer: number; firstTurnAfterSetup: boolean; startChoice: { player: string; slot: number; mode: 'setup' | 'return' } | null;
  undoSnapshot: string | null; stepUndoSnapshots?: string[]; confirmationKind: 'setup' | 'turn' | 'return' | 'free' | null;
  shedChoices: ShedChoice[]; privilegePrompts: PrivilegePrompt[];
  logCycle?: { round: number; turn: number; players: number[] };
};

export const resources: Resource[] = ['wood', 'yeast', 'hops', 'water', 'barley'];
export const resourceLabels: Record<Resource, string> = { wood: '木头', yeast: '酵母', hops: '啤酒花', water: '水', barley: '大麦' };
export const resourceColors: Record<Resource, string> = { wood: '#725044', yeast: '#f1f2ef', hops: '#9fca7c', water: '#4d82c4', barley: '#f0cf70' };
// Shared production track on the player board, transcribed from TTSMOD's
// Punkteleiste snap points. Values run from -9 up the left edge to 0, then
// from 1 to 20 across the top and around the short right/bottom edge.
const productionTrackSnapPoints: [number, number][] = [
  [6.9, 7.2], [6.9, 5.65], [6.9, 4.28], [6.9, 2.91], [6.9, 1.54], [6.9, 0.17],
  [6.9, -1.2], [6.9, -2.57], [6.9, -3.94], [6.9, -5.31],
  [7.33, -6.93], [6.33, -6.93], [5.32, -6.93], [4.29, -6.93], [3.17, -6.93],
  [2.18, -6.93], [1.19, -6.93], [0.18, -6.93], [-0.94, -6.93], [-1.94, -6.93],
  [-2.96, -6.93], [-4.4, -6.93], [-4.4, -5.91], [-4.4, -4.92], [-2.98, -4.88],
  [-1.95, -4.88], [-0.95, -4.88], [0.18, -4.88], [1.19, -4.88], [2.34, -4.88],
];
export const productionTrackPositions: Record<number, { left: number; top: number }> = Object.fromEntries(
  productionTrackSnapPoints.map(([x, z], i) => {
    const value = i - 9;
    return [value, playerBoardPercent(x, z)];
  }),
);
// Ten purple scoring discs sit on the printed icons along the right edge of
// each player board. Increasing Z maps downward on this board image, so these
// TTS snap points are kept in top-to-bottom order (X, five resources, four monks).
const scoringDiscSnaps: [number, number][] = [
  [-7.52, -7.05], [-7.52, -5.925], [-7.52, -3.74], [-7.52, -2.535],
  [-7.52, -0.55], [-7.52, 0.670], [-7.52, 2.76], [-7.52, 3.974],
  [-7.52, 5.97], [-7.52, 7.20],
];
export const scoringDiscPositions = scoringDiscSnaps.map(([x, z]) => playerBoardPercent(x, z));
export const privilegeCardPositions = [0, 1, 2, 3, 4].map(pair => {
  const first = scoringDiscPositions[pair * 2], second = scoringDiscPositions[pair * 2 + 1];
  return {
    left: 100,
    top: (first.top + second.top) / 2,
    height: Math.abs(first.top - second.top) + 3.2,
  };
});
export function playerBoardPercent(x: number, z: number) {
  // Calibrated to the printed circles using the TTS snap positions and this
  // 1523px board image, so both the hexes and the -9..20 track share one map.
  return { left: ((764.95 - 91.91 * x) / 1523) * 100, top: ((756.18 + 92.42 * z) / 1523) * 100 };
}
export const playerColors = ['black', 'yellow', 'blue', 'red'];
const monkNames = ['僧侣A', '僧侣B', '僧侣C', '僧侣D'];
export { monkNames };

export function scoreChoices(p: PlayerState, category: 'A' | 'B' | 'C') {
  if (category === 'A') return p.scores.x === undefined ? [1, 2, 3, 4, 5].filter(value => p.board.some(c => c.tile?.kind === 'resource' && c.tile.value === value)) : [];
  if (category === 'B') return monkNames.map((name, index) => p.scores.monk[index] ? null : name).filter((name): name is string => !!name && p.board.some(c => c.tile?.kind === 'monk' && c.tile.monk === name));
  return resources.filter(resource => !p.scores.resource.includes(resource) && p.board.some(c => c.tile?.resource === resource));
}
export function lowestResources(p: PlayerState) {
  const lowest = Math.min(...resources.map(r => p.tracks[r]));
  return resources.filter(r => p.tracks[r] === lowest);
}
function monkIconToken(monk?: string) {
  const index = monkNames.indexOf(monk || '');
  return `[[MONK:${String.fromCharCode(65 + Math.max(0, index))}]]`;
}
export function canScore(p: PlayerState, scoreType: ActionSpace['scoreType']) {
  if (!scoreType) return false;
  return (scoreType === 'ABC' ? ['A', 'B', 'C'] as const : [scoreType]).some(category => scoreChoices(p, category).length > 0);
}

// Individual garden snap points from TTSMOD; retaining each real Z value avoids
// row-level averaging that caused the outer hexes to drift off their artwork.
const gardenRows: { sites: { x: number; z: number; side: 'sun' | 'shade' | 'hut' }[] }[] = [
  { sites: [{ x: 0.260, z: -2.890, side: 'sun' }, { x: -1.520, z: -2.890, side: 'shade' }] },
  { sites: [{ x: 1.150, z: -1.370, side: 'sun' }, { x: -0.600, z: -1.370, side: 'hut' }, { x: -2.410, z: -1.370, side: 'shade' }] },
  { sites: [{ x: 3.830, z: 0.160, side: 'sun' }, { x: 2.050, z: 0.160, side: 'sun' }, { x: 0.250, z: 0.160, side: 'sun' }, { x: -1.540, z: 0.160, side: 'shade' }, { x: -3.320, z: 0.160, side: 'shade' }, { x: -5.100, z: 0.160, side: 'shade' }] },
  { sites: [{ x: 4.720, z: 1.690, side: 'sun' }, { x: 2.920, z: 1.690, side: 'hut' }, { x: 1.140, z: 1.690, side: 'sun' }, { x: -0.600, z: 1.690, side: 'hut' }, { x: -2.410, z: 1.690, side: 'shade' }, { x: -4.220, z: 1.690, side: 'hut' }, { x: -5.970, z: 1.690, side: 'shade' }] },
  { sites: [{ x: 3.830, z: 3.220, side: 'sun' }, { x: 2.050, z: 3.220, side: 'sun' }, { x: 0.250, z: 3.210, side: 'sun' }, { x: -1.540, z: 3.200, side: 'shade' }, { x: -3.320, z: 3.200, side: 'shade' }, { x: -5.100, z: 3.200, side: 'shade' }] },
  { sites: [{ x: 4.720, z: 4.750, side: 'sun' }, { x: 2.920, z: 4.750, side: 'hut' }, { x: 1.140, z: 4.750, side: 'sun' }, { x: -0.600, z: 4.750, side: 'hut' }, { x: -2.410, z: 4.750, side: 'shade' }, { x: -4.220, z: 4.750, side: 'hut' }, { x: -5.970, z: 4.730, side: 'shade' }] },
  { sites: [{ x: 3.830, z: 6.290, side: 'sun' }, { x: 2.050, z: 6.290, side: 'sun' }, { x: 0.250, z: 6.290, side: 'sun' }, { x: -1.540, z: 6.290, side: 'shade' }, { x: -3.320, z: 6.290, side: 'shade' }, { x: -5.100, z: 6.290, side: 'shade' }] },
];
export const gardenCells = gardenRows.flatMap((row, rowIndex) => row.sites.map((site, col) => ({
  row: rowIndex, col, x: site.x, z: site.z, hut: site.side === 'hut', side: site.side === 'hut' ? undefined : site.side,
})));

// Public-board supply locations follow the TTS Lua positions and the clockwise printed route.
const resourcePoints = [[370,120],[525,120],[1000,120],[1157,120],[1465,120],[1640,130],[1770,430],[1770,750],[1635,1060],[1300,1060],[950,1060],[595,1060],[435,1060],[265,1060],[110,450]];
const monkPoints = [[685,100],[1780,260],[1127,1082],[100,750]];
const scorePoints = [[845,120],[1320,120],[1780,600],[1465,1075],[780,1075],[130,925]];
const point = (x: number, y: number) => ({ x, y });
const resourcesOnRoute = resourcePoints.map(([x,y], sourceIndex) => ({ type: 'resource' as const, label: '资源', sourceIndex, ...point(x,y) }));
const monksOnRoute = monkPoints.map(([x,y], sourceIndex) => ({ type: 'monk' as const, label: '僧侣', sourceIndex, ...point(x,y) }));
const scoresOnRoute = scorePoints.map(([x,y], sourceIndex) => ({ type: 'score' as const, label: '计分', sourceIndex, scoreType: (['A','B','C','ABC','ABC','ABC'] as const)[sourceIndex], ...point(x,y) }));
const barrelA = { type: 'barrel' as const, label: '酒桶', ...point(1760, 920) };
const barrelB = { type: 'barrel' as const, label: '酒桶', ...point(140, 605) };
export const barrelTokenPositions = [
  [531, 402], [706, 402], [876, 402], [1045, 402], [1212, 402], [1381, 402],
  [531, 784], [706, 784], [876, 784], [1045, 784], [1212, 784], [1381, 784],
].map(([x, y]) => ({ left: x / 1904 * 100, top: y / 1176 * 100 }));
export const startSlots = [
  { label: '首位玩家', reward: '无奖励', ...point(205, 151) },
  { label: '钱币', reward: '+2钱币', ...point(76, 151) },
  { label: '酿酒师', reward: '酿酒师+1', ...point(135, 64) },
  { label: '资源', reward: '任一资源+2', ...point(135, 245) },
];
const route = [
  resourcesOnRoute[0], resourcesOnRoute[1], monksOnRoute[0], scoresOnRoute[0], resourcesOnRoute[2], resourcesOnRoute[3], scoresOnRoute[1], resourcesOnRoute[4], resourcesOnRoute[5],
  monksOnRoute[1], resourcesOnRoute[6], scoresOnRoute[2], resourcesOnRoute[7], barrelA, resourcesOnRoute[8], scoresOnRoute[3], resourcesOnRoute[9], monksOnRoute[2], resourcesOnRoute[10], scoresOnRoute[4], resourcesOnRoute[11], resourcesOnRoute[12], resourcesOnRoute[13], scoresOnRoute[5], monksOnRoute[3], barrelB, resourcesOnRoute[14],
];
const track: ActionSpace[] = [...route, { type: 'start', label: '回到起点', ...point(240, 300) }];
const emptyPlayer = (id: number, color: string): PlayerState => ({
  name: `玩家${id + 1}`, color, coins: 25, board: gardenCells.map(c => ({ hut: c.hut, side: c.side })), position: -1, startSlot: null, retired: false,
  brewer: -9, tracks: { wood: 1, yeast: -2, hops: -4, water: -6, barley: -8 },
  scores: { monk: [false, false, false, false], resource: [null, null, null, null, null] }, privileges: ['A', 'B', 'C', 'D', 'E'], privilegePairs: [null, null, null, null, null], claimedBarrels: [],
});
const makeDeck = (G: AleState, random: { Shuffle<T>(items: T[]): T[] }, rounds: number) => {
  const resourceTiles = (tier: 'I' | 'II'): Tile[] => {
    const tiles: Tile[] = [];
    for (const resource of resources) for (let value = 1; value <= 5; value++) for (let copy = 0; copy < 2; copy++) {
      tiles.push({ id: `${resource}-${value}-${tier}-${copy + 1}`, kind: 'resource', value, resource, tier });
    }
    return tiles;
  };
  // The physical game has two 50-tile resource stacks. Shuffle each tier
  // separately, then exhaust I before drawing from II.
  const orderedResources = [...random.Shuffle(resourceTiles('I')), ...random.Shuffle(resourceTiles('II'))];
  const resourcesForGame = orderedResources.slice(0, rounds * 15);
  G.resourceDecks = Array.from({ length: rounds }, (_, i) => resourcesForGame.slice(i * 15, i * 15 + 15));

  const monkTiles = (tier: 'I' | 'II'): Tile[] => monkNames.flatMap((monk, monkIndex) =>
    Array.from({ length: 3 }, (_, copy) => ({ id: `monk-${tier}-${monkIndex}-${copy + 1}`, kind: 'monk' as const, value: 1 + ((monkIndex * 3 + copy) % 5), monk, tier }))
  );
  // There are 12 tiles in each monk tier (3 of each type). Two-player games
  // stop after I; three-player games use one II batch; four-player games use
  // all of II after the first three rounds.
  const orderedMonks = [...random.Shuffle(monkTiles('I')), ...random.Shuffle(monkTiles('II'))];
  const monksForGame = orderedMonks.slice(0, rounds * 4);
  G.monkDecks = Array.from({ length: rounds }, (_, i) => monksForGame.slice(i * 4, i * 4 + 4));
  G.resources = Array.from({ length: 15 }, (_, i) => [G.resourceDecks[0][i]]);
  G.monks = Array.from({ length: 4 }, (_, i) => [G.monkDecks[0][i]]);
};

export const HeavenAle: Game<AleState> = {
  name: 'heaven-and-ale',
  setup: ({ ctx, random }) => {
    const count = Math.max(2, Math.min(4, ctx.numPlayers));
    const players = Array.from({ length: count }, (_, i) => emptyPlayer(i, playerColors[i]));
    players[0].startSlot = 0;
    const G: AleState = { players, round: 1,
      maxRounds: count === 2 ? 3 : count === 3 ? 4 : 6, track, resources: [], monks: [], resourceDecks: [], monkDecks: [], scores: [1, 1, 1, 1, 1, 1],
      barrels: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, remaining: 2 })), phase: 'setup', pending: null, log: ['首位玩家已放在起始玩家格；其他玩家逆时针选择起始奖励。'],
      startPlayer: 0, firstTurnAfterSetup: false, startChoice: null, undoSnapshot: null, stepUndoSnapshots: [], confirmationKind: null, shedChoices: [], privilegePrompts: [] };
    makeDeck(G, random, G.maxRounds);
    return G;
  },
  turn: { minMoves: 1, maxMoves: 99,
    order: {
      first: ({ G }) => G.phase === 'setup' ? (G.startPlayer + G.players.length - 1) % G.players.length : G.startPlayer,
      next: ({ G, ctx }) => {
        if (G.phase === 'setup') return (Number(ctx.currentPlayer) + G.players.length - 1) % G.players.length;
        if (G.firstTurnAfterSetup) return G.startPlayer;
        for (let step = 1; step <= G.players.length; step++) {
          const nextPlayer = (Number(ctx.currentPlayer) + step) % G.players.length;
          if (!G.players[nextPlayer].retired) return nextPlayer;
        }
        return undefined;
      },
    },
    onBegin: ({ G, ctx, events }) => {
      if (G.firstTurnAfterSetup) G.firstTurnAfterSetup = false;
      if (G.phase === 'play' && !G.players[Number(ctx.currentPlayer)]?.retired) {
        const cycle = G.logCycle;
        if (!cycle || cycle.round !== G.round || G.players.every((p, i) => p.retired || cycle.players.includes(i))) {
          const turn = cycle?.round === G.round ? cycle.turn + 1 : 1;
          G.logCycle = { round: G.round, turn, players: [] };
          G.log.unshift(`[[TURN:${G.round}:${turn}]]`);
        }
        G.logCycle!.players.push(Number(ctx.currentPlayer));
      }
      if (G.phase === 'play' && G.players[Number(ctx.currentPlayer)]?.retired) events.endTurn();
    } },
  moves: {
    setPlayerName: ({ G, playerID }, name: string) => {
      const player = G.players[Number(playerID)];
      if (!player || typeof name !== 'string') return;
      const trimmed = name.trim().slice(0, 18);
      if (trimmed) player.name = trimmed;
    },
    chooseStartSlot: ({ G, ctx }, slot: number) => {
      const player = G.players[Number(ctx.currentPlayer)];
      if (!player || G.confirmationKind || G.startChoice || ![0, 1, 2, 3].includes(slot)) return;
      const mode = G.phase === 'setup' ? 'setup' : 'return';
      if (mode === 'setup') {
        if (player.startSlot !== null || slot === 0 || G.players.some(p => p.startSlot === slot)) return;
      } else {
        if (!G.pending || G.pending.type !== 'start' || G.pending.player !== ctx.currentPlayer || G.players.some(p => p.startSlot === slot)) return;
        const lastToReturn = G.players.every(p => p.retired || p === player);
        if (lastToReturn && G.players.every(p => p === player || p.retired) && !G.players.some(p => p.startSlot === 0) && slot !== 0) return;
      }
      saveActionSnapshot(G);
      saveStepSnapshot(G);
      if (slot === 3) { G.startChoice = { player: ctx.currentPlayer, slot, mode }; return; }
      finalizeStartChoice(G, player, slot, undefined, mode);
      if (mode === 'setup') {
        if (G.players.every(p => p.startSlot !== null)) { G.phase = 'play'; G.firstTurnAfterSetup = true; G.log.unshift('起始奖励选择完成，游戏开始。'); }
      } else {
        G.pending = null;
      }
      G.confirmationKind = mode === 'setup' ? 'setup' : 'return';
    },
    chooseStartResource: ({ G, ctx }, resource: Resource) => {
      const choice = G.startChoice, player = G.players[Number(ctx.currentPlayer)];
      if (!choice || choice.player !== ctx.currentPlayer || !player || G.confirmationKind || !resources.includes(resource)) return;
      saveStepSnapshot(G);
      finalizeStartChoice(G, player, choice.slot, resource, choice.mode);
      G.startChoice = null;
      if (choice.mode === 'setup') {
        if (G.players.every(p => p.startSlot !== null)) { G.phase = 'play'; G.firstTurnAfterSetup = true; G.log.unshift('起始奖励选择完成，游戏开始。'); }
      } else {
        G.pending = null;
      }
      G.confirmationKind = choice.mode === 'setup' ? 'setup' : 'return';
    },
    moveTo: ({ G, ctx }, index: number) => {
      const player = G.players[Number(ctx.currentPlayer)];
      if (!player || !canMoveTo(G, player, index)) return;
      const space = G.track[index];
      if (space.type === 'start') {
        saveActionSnapshot(G);
        saveStepSnapshot(G);
        player.position = index; player.startSlot = null; G.pending = { space: index, type: 'start', player: ctx.currentPlayer };
        return;
      }
      saveActionSnapshot(G);
      saveStepSnapshot(G);
      player.startSlot = null; player.position = index;
      if (space.type === 'barrel') {
        const claimed = awardBarrels(G, player);
        G.log.unshift(`${player.name} 到达酒桶成就格，领取 ${claimed.length} 个酒桶：${claimed.map(b => `目标 ${String(b.id).padStart(2, '0')} ${b.size === 'large' ? '大酒桶（4分）' : '小酒桶（2分）'}`).join('、')}。`);
        G.pending = null; G.confirmationKind = 'turn';
        return;
      }
      G.pending = { space: index, type: space.type, player: ctx.currentPlayer, purchases: 0 };
    },
    buyTile: ({ G, ctx }, tileId: string, cellIndex: number) => {
      const p = G.players[Number(ctx.currentPlayer)], pending = G.pending;
      if (G.confirmationKind || !pending || pending.player !== ctx.currentPlayer || !['resource', 'monk'].includes(pending.type)) return;
      const space = G.track[pending.space];
      const market = pending.type === 'resource' ? G.resources[space.sourceIndex ?? -1] : G.monks[space.sourceIndex ?? -1];
      const tileIndex = market?.findIndex(t => t.id === tileId) ?? -1, cell = p.board[cellIndex], side = gardenCells[cellIndex]?.side;
      if (tileIndex < 0 || !cell || cell.hut || cell.tile || !side) return;
      const tile = market[tileIndex], baseCost = tileBaseCost(tile, space.sourceIndex), cost = baseCost * (side === 'sun' ? 2 : 1);
      if (p.coins < cost) return;
      saveStepSnapshot(G);
      p.coins -= cost; cell.tile = tile; cell.side = side; market.splice(tileIndex, 1);
      pending.purchases = (pending.purchases ?? 0) + 1;
      G.log.unshift(`${p.name} 在第${pending.space + 1}格「${space.label}」购买${tile.kind === 'resource' ? resourceLabels[tile.resource!] : monkIconToken(tile.monk)}板块，花费 ${cost}。`);
      settleHuts(G, p);
      // Stay on the action space so the player may buy more tiles from this
      // supply. Any resulting shed choice is resolved before buying again.
      G.confirmationKind = null;
      if (G.shedChoices.length === 0) finishPurchaseIfNoOptions(G, p);
    },
    finishPurchase: ({ G, ctx }) => {
      const pending = G.pending;
      if (G.confirmationKind || G.shedChoices.length || !pending || pending.player !== ctx.currentPlayer || !['resource', 'monk'].includes(pending.type) || (pending.purchases ?? 0) < 1) return;
      saveStepSnapshot(G);
      G.pending = null;
      G.confirmationKind = 'turn';
    },
    takeScore: ({ G, ctx }, category: 'A' | 'B' | 'C', option: string | number) => {
      const p = G.players[Number(ctx.currentPlayer)], pending = G.pending;
      if (G.confirmationKind || !pending || pending.player !== ctx.currentPlayer || pending.type !== 'score') return;
      const space = G.track[pending.space], markerIndex = space.sourceIndex ?? -1;
      if (G.scores[markerIndex] <= 0 || !['A', 'B', 'C'].includes(category) || (space.scoreType !== 'ABC' && space.scoreType !== category) || !scoreChoices(p, category).some(value => String(value) === String(option))) return;
      saveStepSnapshot(G);
      const choice = category;
      const rewards: string[] = [];
      if (choice === 'A') {
        const value = Number(option);
        p.scores.x = markerIndex;
        p.board.forEach(c => { if (c.tile?.kind === 'resource' && c.tile.value === value) rewards.push(activateWithSummary(p, c.tile, c.side)); });
      } else if (choice === 'B') {
        const monk = monkNames.indexOf(String(option));
        p.scores.monk[monk] = true;
        p.board.forEach((c, i) => {
          if (c.tile?.kind !== 'monk' || c.tile.monk !== monkNames[monk]) return;
          const neighbors = gardenNeighbors(i).filter(j => !!p.board[j].tile);
          const triggerRewards = neighbors.flatMap(j => {
            const neighbor = p.board[j];
            return neighbor.tile ? [activateWithSummary(p, neighbor.tile, neighbor.side)] : [];
          });
          rewards.push(`${monkIconToken(monkNames[monk])}触发（${neighbors.length} 块相邻板块）：${triggerRewards.join('、') || '没有已放置板块'}`);
        });
      } else if (choice === 'C') {
        const res = option as Resource;
        p.scores.resource[p.scores.resource.indexOf(null)] = res;
        p.board.forEach(c => { if (c.tile?.resource === res) rewards.push(activateWithSummary(p, c.tile, c.side)); });
      } else return;
      G.scores[markerIndex]--;
      G.log.unshift(`${p.name} 完成 ${choice} 类计分（${choice === 'A' ? `产值 ${option}` : choice === 'B' ? monkIconToken(String(option)) : resourceLabels[option as Resource]}）：${rewards.join('；') || '没有相邻板块可激活'}。`);
      const discIndex = choice === 'A' ? 0 : choice === 'C' ? 1 + resources.indexOf(option as Resource) : 6 + monkNames.indexOf(String(option));
      const pairIndex = Math.floor(discIndex / 2), occupied = new Set(scoreDiscIndexes(p));
      if (p.privilegePairs[pairIndex] === null && occupied.has(pairIndex * 2) && occupied.has(pairIndex * 2 + 1)) {
        G.privilegePrompts.push({ kind: 'pair', pairIndex });
        G.log.unshift(`${p.name} 完成第 ${pairIndex + 1} 组计分标记，请放置一张特权卡或永久跳过。`);
      }
      G.pending = null;
      G.confirmationKind = G.privilegePrompts.length ? null : 'turn';
    },
    toggleShedChoice: ({ G, ctx }, cellIndex: number) => {
      const choice = G.shedChoices[0], player = G.players[Number(ctx.currentPlayer)];
      if (!choice || !player || G.confirmationKind || !canSelectShedCell(choice, cellIndex)) return;
      saveStepSnapshot(G);
      const selectedAt = choice.selected.indexOf(cellIndex);
      if (selectedAt >= 0 && choice.mode === 'opposite') choice.selected = [];
      else if (selectedAt >= 0) choice.selected.splice(selectedAt, 1);
      else if (choice.mode === 'opposite') {
        const position = choice.candidates.indexOf(cellIndex);
        choice.selected = [cellIndex, choice.candidates[(position + 3) % choice.candidates.length]];
      } else choice.selected.push(cellIndex);
    },
    completeShedChoice: ({ G, ctx }) => {
      const choice = G.shedChoices[0], player = G.players[Number(ctx.currentPlayer)];
      if (!choice || !player || G.confirmationKind || !validShedSelection(choice)) return;
      saveStepSnapshot(G);
      const rewards: string[] = [];
      for (const index of choice.selected) {
        const cell = player.board[index];
        if (cell.tile) rewards.push(activateWithSummary(player, cell.tile, cell.side));
      }
      G.log.unshift(`${player.name} 围住棚屋（产值 ${choice.value}）的激活奖励：${rewards.join('；')}。`);
      G.shedChoices.shift();
      if (G.shedChoices.length === 0) {
        if (G.pending) finishPurchaseIfNoOptions(G, player);
        else G.confirmationKind = 'turn';
      }
    },
    choosePrivilege: ({ G, ctx }, card: string, choice?: Resource) => {
      const p = G.players[Number(ctx.currentPlayer)], prompt = G.privilegePrompts[0];
      if (G.confirmationKind || !prompt || !p) return;
      if (prompt.kind === 'pair' && card === 'skip') {
        saveStepSnapshot(G);
        p.privilegePairs[prompt.pairIndex] = 'skip';
        G.log.unshift(`${p.name} 跳过第 ${prompt.pairIndex + 1} 组特权卡奖励；之后不能补放。`);
        G.privilegePrompts.shift(); if (!G.privilegePrompts.length) G.confirmationKind = 'turn';
        return;
      }
      if (!['A', 'B', 'C', 'D', 'E'].includes(card || '')) return;
      if (prompt.kind !== 'pair' || !p.privileges.includes(card!)) return;
      if (card === 'A') {
        if (!choice || !resources.includes(choice)) return;
        const count = p.board.filter(c => c.tile?.resource === choice).length;
        if (count === 0) return;
        saveStepSnapshot(G);
        advance(p, choice, count);
        G.log.unshift(`特权卡 A：${resourceLabels[choice]} 资源板块共 ${count} 块，生产轨道推进 ${count} 格。`);
      } else if (card === 'B') {
        const options = lowestResources(p), selected = choice ?? (options.length === 1 ? options[0] : undefined), steps = scoreDiscIndexes(p).length;
        if (!selected || !options.includes(selected)) return;
        saveStepSnapshot(G);
        advance(p, selected, steps);
        G.log.unshift(`特权卡 B：已有 ${steps} 个紫色标记，${resourceLabels[selected]} 资源轨推进 ${steps} 格。`);
      } else if (card === 'C') {
        saveStepSnapshot(G);
        G.log.unshift(`特权卡 C：游戏结束时每个酒桶额外得 1 分。`);
      } else if (card === 'D') {
        saveStepSnapshot(G);
        p.coins += 12; G.log.unshift(`特权卡 D：获得12个钱币。`);
      } else if (card === 'E') {
        saveStepSnapshot(G);
        p.brewer = Math.min(20, p.brewer + 5); G.log.unshift(`特权卡 E：酿酒师向前推进 5 格。`);
      }
      p.privileges = p.privileges.filter(c => c !== card);
      p.privilegePairs[prompt.pairIndex] = card;
      G.privilegePrompts.shift(); if (!G.privilegePrompts.length) G.confirmationKind = 'turn';
    },
    discardPrivilege: ({ G, ctx }, card: string) => {
      const p = G.players[Number(ctx.currentPlayer)];
      if (!p || G.phase !== 'play' || p.retired || (G.confirmationKind && G.confirmationKind !== 'turn') || G.privilegePrompts.length || !p.privileges.includes(card)) return;
      saveActionSnapshot(G);
      saveStepSnapshot(G);
      p.privileges = p.privileges.filter(c => c !== card);
      p.coins += 3;
      G.log.unshift(`${p.name} 弃置特权卡 ${card}，获得3个钱币。`);
    },
    undoAction: ({ G }) => {
      if (!G.undoSnapshot) return;
      const snapshot = JSON.parse(G.undoSnapshot) as AleState;
      Object.assign(G, snapshot);
    },
    undoStep: ({ G }) => {
      const history = G.stepUndoSnapshots ?? [];
      if (!history.length) return;
      const snapshot = JSON.parse(history[history.length - 1]) as AleState;
      history.pop();
      Object.assign(G, snapshot);
      G.stepUndoSnapshots = history;
    },
    confirmAction: ({ G, events }) => {
      if (!G.undoSnapshot || !G.confirmationKind) return;
      const kind = G.confirmationKind;
      G.undoSnapshot = null; G.stepUndoSnapshots = []; G.confirmationKind = null;
      if (kind === 'return') finishRound(G);
      if (kind !== 'free') events.endTurn();
    },
  },
  endIf: ({ G }) => G.phase === 'finished' ? scoreWinner(G) : undefined,
};

function advance(p: PlayerState, resource: Resource, by: number) {
  for (let i = 0; i < by; i++) { if (p.tracks[resource] >= 20) p.coins++; else p.tracks[resource]++; }
}
function saveActionSnapshot(G: AleState) {
  if (G.undoSnapshot) return;
  G.undoSnapshot = JSON.stringify({ ...G, undoSnapshot: null, confirmationKind: null });
}
function saveStepSnapshot(G: AleState) {
  G.stepUndoSnapshots ??= [];
  const snapshot = { ...G, stepUndoSnapshots: [] };
  G.stepUndoSnapshots.push(JSON.stringify(snapshot));
}
function finishPurchaseIfNoOptions(G: AleState, p: PlayerState) {
  const pending = G.pending;
  if (!pending || !['resource', 'monk'].includes(pending.type) || (pending.purchases ?? 0) < 1 || G.shedChoices.length) return;
  const space = G.track[pending.space];
  const market = pending.type === 'resource' ? G.resources[space.sourceIndex ?? -1] : G.monks[space.sourceIndex ?? -1];
  if (canBuyFrom(p, market ?? [], space.sourceIndex)) return;
  G.pending = null;
  G.confirmationKind = 'turn';
}
function scoreDiscIndexes(p: PlayerState) {
  const indexes: number[] = [];
  if (p.scores.x !== undefined) indexes.push(0);
  p.scores.resource.forEach(resource => { if (resource) indexes.push(1 + resources.indexOf(resource)); });
  p.scores.monk.forEach((used, i) => { if (used) indexes.push(6 + i); });
  return indexes;
}
function finalizeStartChoice(G: AleState, player: PlayerState, slot: number, resource: Resource | undefined, mode: 'setup' | 'return') {
  player.startSlot = slot;
  if (slot === 1) player.coins += 2;
  else if (slot === 2) player.brewer = Math.min(20, player.brewer + 1);
  else if (slot === 3 && resource) advance(player, resource, 2);
  if (mode === 'return') { player.position = -1; player.retired = true; }
  G.log.unshift(`${player.name} 选择${startSlots[slot].label}位置，获得${startSlots[slot].reward}${slot === 3 && resource ? `（${resourceLabels[resource]} +2）` : ''}。`);
}
function activate(p: PlayerState, tile: Tile, side?: 'sun' | 'shade') {
  if (tile.resource) { if (side === 'sun') advance(p, tile.resource, tile.value); else p.coins += tile.value; }
  else p.brewer = Math.min(20, p.brewer + 1);
}
function gardenNeighbors(index: number) {
  const spot = gardenCells[index];
  return gardenCells.flatMap((other, j) => {
    if (index === j || Math.abs(spot.row - other.row) > 1) return [];
    const dx = Math.abs(spot.x - other.x), dz = Math.abs(spot.z - other.z);
    return (dz < 0.05 && Math.abs(dx - 1.77) < 0.12) || (dz > 1.4 && dz < 1.65 && Math.abs(dx - 0.88) < 0.12) ? [j] : [];
  });
}
export function validShedSelection(choice: ShedChoice) {
  const selected = choice.selected;
  if (choice.mode === 'one') return selected.length === 1;
  if (choice.mode === 'opposite') {
    if (selected.length !== 2) return false;
    const a = choice.candidates.indexOf(selected[0]), b = choice.candidates.indexOf(selected[1]);
    return Math.abs(a - b) === 3;
  }
  if (choice.mode === 'nonAdjacent') {
    return selected.length === 3 && selected.every((cell, i) => selected.slice(i + 1).every(other => !gardenNeighbors(cell).includes(other)));
  }
  return selected.length === 4;
}
export function canSelectShedCell(choice: ShedChoice, cellIndex: number) {
  if (!choice.candidates.includes(cellIndex)) return false;
  if (choice.selected.includes(cellIndex)) return true;
  if (choice.mode === 'opposite') return choice.selected.length === 0;
  if (choice.mode === 'one' || choice.mode === 'any') return choice.selected.length < choice.activateCount;
  if (choice.selected.length >= choice.activateCount) return false;
  const required = [...choice.selected, cellIndex];
  const candidates = choice.candidates;
  for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) for (let c = b + 1; c < candidates.length; c++) {
    const set = [candidates[a], candidates[b], candidates[c]];
    const nonAdjacent = set.every((cell, i) => set.slice(i + 1).every(other => !gardenNeighbors(cell).includes(other)));
    if (nonAdjacent && required.every(cell => set.includes(cell))) return true;
  }
  return false;
}
export function shedProductionProgress(board: Cell[], hutIndex: number) {
  const neighbors = gardenNeighbors(hutIndex), filled = neighbors.filter(index => !!board[index]?.tile);
  const calculatedValue = filled.reduce((sum, index) => {
    const tile = board[index]?.tile;
    return sum + (tile?.resource ? tile.value : 0);
  }, 0);
  const value = board[hutIndex]?.shedValue ?? calculatedValue;
  return { value, filled: filled.length, total: neighbors.length };
}
function activateWithSummary(p: PlayerState, tile: Tile, side?: 'sun' | 'shade') {
  const beforeCoins = p.coins, beforeBrewer = p.brewer, beforeTrack = tile.resource ? p.tracks[tile.resource] : 0;
  activate(p, tile, side);
  if (tile.resource) {
    const coins = p.coins - beforeCoins;
    if (side === 'sun') {
      const steps = p.tracks[tile.resource] - beforeTrack;
      return `${resourceLabels[tile.resource]}（向阳）+${steps} 格${coins > 0 ? `、钱币 +${coins}` : ''}`;
    }
    return `${resourceLabels[tile.resource]}（阴凉）钱币 +${coins}`;
  }
  const brewerSteps = p.brewer - beforeBrewer;
  return `${monkIconToken(tile.monk)}激活，酿酒师 +${brewerSteps} 格`;
}
function settleHuts(G: AleState, p: PlayerState) {
  p.board.forEach((hut, i) => {
    if (!hut.hut || hut.completed) return;
    const spot = gardenCells[i];
    const neighbors = gardenNeighbors(i).sort((a, b) => Math.atan2(gardenCells[a].x - spot.x, gardenCells[a].z - spot.z) - Math.atan2(gardenCells[b].x - spot.x, gardenCells[b].z - spot.z));
    if (neighbors.length === 6 && neighbors.every(j => p.board[j].tile)) {
      const value = neighbors.reduce((n, j) => n + (p.board[j].tile?.resource ? p.board[j].tile.value : 0), 0);
      const range = value <= 7 ? 0 : value <= 11 ? 1 : value <= 17 ? 2 : value <= 23 ? 3 : 4;
      const brewerAdvance = range === 0 ? 6 : range === 1 ? 3 : range <= 3 ? 1 : 0;
      const activateCount = range === 0 ? 0 : range === 1 ? 1 : range === 2 ? 2 : range === 3 ? 3 : 4;
      const mode = range === 1 ? 'one' : range === 2 ? 'opposite' : range === 3 ? 'nonAdjacent' : 'any';
      p.brewer = Math.min(20, p.brewer + brewerAdvance);
      hut.completed = true; hut.shedType = range; hut.shedValue = value;
      G.log.unshift(`${p.name} 围住棚屋，周围产值 ${value}：酿酒师推进 ${brewerAdvance} 格，可激活 ${activateCount} 块相邻板块。`);
      if (activateCount > 0) G.shedChoices.push({ hutIndex: i, value, brewerAdvance, activateCount, mode, candidates: neighbors, selected: [] });
    }
  });
}
export function barrelMet(p: PlayerState, id: number) {
  const tiles = p.board.flatMap(c => c.tile ? [c.tile] : []), hutCounts = new Map<number, number>();
  p.board.filter(c => c.completed && c.shedType !== undefined).forEach(c => hutCounts.set(c.shedType!, (hutCounts.get(c.shedType!) || 0) + 1));
  switch (id) {
    case 1: return p.brewer >= 1; case 2: return resources.every(r => p.tracks[r] >= 1);
    case 3: return tiles.filter(t => t.kind === 'resource' && t.value === 1).length >= 6;
    case 4: return tiles.filter(t => t.kind === 'resource' && t.value === 5).length >= 6;
    case 5: return p.scores.monk.every(Boolean); case 6: return p.scores.resource.every(Boolean);
    case 7: return [...hutCounts.values()].some(count => count >= 3); case 8: return hutCounts.size >= 4;
    case 9: return resources.some(r => p.tracks[r] >= 20); case 10: return p.privilegePairs.filter(card => card !== null && card !== 'skip').length >= 3;
    case 11: return p.board.filter(c => c.side === 'sun' && c.tile).length >= 15;
    case 12: return p.board.filter(c => c.side === 'shade' && c.tile).length >= 15;
    default: return false;
  }
}
export function availableBarrelIds(G: AleState, p: PlayerState) {
  return G.barrels.filter(stock => stock.remaining > 0 && !p.claimedBarrels.some(barrel => barrel.id === stock.id) && barrelMet(p, stock.id)).map(stock => stock.id);
}
function awardBarrels(G: AleState, p: PlayerState) {
  const claimed: { id: number; size: 'large' | 'small' }[] = [];
  for (const id of availableBarrelIds(G, p)) {
    const stock = G.barrels.find(barrel => barrel.id === id)!;
    const size = stock.remaining === 2 ? 'large' : 'small';
    stock.remaining--;
    p.claimedBarrels.push({ id, size });
    claimed.push({ id, size });
  }
  return claimed;
}
export function tileBaseCost(tile: Tile, sourceIndex?: number) {
  return tile.kind === 'monk' ? [4, 3, 2, 1][sourceIndex ?? 0] ?? 4 : tile.value;
}
export function canBuyFrom(p: PlayerState, market: Tile[], sourceIndex?: number) {
  return gardenCells.some((spot, i) => !spot.hut && !!spot.side && !p.board[i]?.tile && market.some(tile => p.coins >= tileBaseCost(tile, sourceIndex) * (spot.side === 'sun' ? 2 : 1)));
}
export function canMoveTo(G: AleState, p: PlayerState, index: number) {
  if (G.phase !== 'play' || p.retired || G.pending || G.confirmationKind || G.privilegePrompts.length || index <= p.position || index >= G.track.length) return false;
  const space=G.track[index];
  if (space.type==='resource') return canBuyFrom(p,G.resources[space.sourceIndex ?? -1] ?? [],space.sourceIndex);
  if (space.type==='monk') return canBuyFrom(p,G.monks[space.sourceIndex ?? -1] ?? [],space.sourceIndex);
  if (space.type==='score') return G.scores[space.sourceIndex ?? -1]>0 && canScore(p,space.scoreType);
  if (space.type==='barrel') return availableBarrelIds(G,p).length>0;
  return space.type==='start';
}
function finishRound(G: AleState) {
  if (!G.players.every(p => p.retired)) return;
  if (G.round >= G.maxRounds) {
    G.players.forEach(applyFinalResourceAdjustments);
    G.log.unshift('最后一轮结束：所有玩家完成资源交换与钱币兑换，开始终局计分。');
    G.phase = 'finished'; return;
  }
  G.startPlayer = G.players.findIndex(p => p.startSlot === 0);
  if (G.startPlayer < 0) G.startPlayer = 0;
  G.round++; G.players.forEach(p => { p.retired = false; p.position = -1; });
  G.firstTurnAfterSetup = true;
  for (let i = 0; i < 15; i++) { const tile = G.resourceDecks[G.round - 1]?.[i]; if (tile) G.resources[i].push(tile); }
  for (let i = 0; i < 4; i++) { const tile = G.monkDecks[G.round - 1]?.[i]; if (tile) G.monks[i].push(tile); }
  G.scores = G.scores.map((_, i) => G.round === G.maxRounds && G.players.length <= 3 && (i === 1 || i === 2 || G.players.length === 3 && i === 3) ? 2 : 1);
  G.log.unshift(`第 ${G.round} 轮开始。`);
}
const brewerScoring = (brewer: number) => {
  if (brewer >= 20) return { exchangeRate: 1, victoryPoints: 6 };
  if (brewer >= 18) return { exchangeRate: 2, victoryPoints: 6 };
  if (brewer >= 15) return { exchangeRate: 2, victoryPoints: 5 };
  if (brewer >= 12) return { exchangeRate: 2, victoryPoints: 4 };
  if (brewer >= 9) return { exchangeRate: 3, victoryPoints: 4 };
  if (brewer >= 5) return { exchangeRate: 3, victoryPoints: 3 };
  if (brewer >= 1) return { exchangeRate: 4, victoryPoints: 3 };
  return { exchangeRate: 5, victoryPoints: 2 };
};
function equalizeResourceTracks(initial: Record<Resource, number>, exchangeRate: number) {
  const tracks = { ...initial };
  const seen = new Set<string>();
  for (;;) {
    const signature = resources.map(r => tracks[r]).join(',');
    if (seen.has(signature)) break;
    seen.add(signature);
    const lowest = Math.min(...resources.map(r => tracks[r]));
    // At 1:1, taking one step from a marker only one step above the minimum
    // just swaps which resource is lowest, so that trade cannot improve score.
    const donors = resources.filter(r => tracks[r] > lowest + (exchangeRate === 1 ? 1 : 0)).sort((a, b) => tracks[b] - tracks[a]);
    const available = donors.reduce((sum, r) => sum + (tracks[r] - lowest), 0);
    if (available < exchangeRate) break;
    const target = resources.find(r => tracks[r] === lowest)!;
    let cost = exchangeRate;
    for (const donor of donors) {
      const moved = Math.min(cost, tracks[donor] - lowest);
      tracks[donor] -= moved;
      cost -= moved;
      if (!cost) break;
    }
    if (cost) break;
    tracks[target]++;
  }
  return tracks;
}
function applyFinalResourceAdjustments(p: PlayerState) {
  if (p.finalAdjusted) return;
  const { exchangeRate } = brewerScoring(p.brewer);
  const tracks = equalizeResourceTracks(p.tracks, exchangeRate);
  let coinSteps = Math.floor(p.coins / 10), usedCoinSteps = 0;
  while (coinSteps > 0) {
    const lowest = Math.min(...resources.map(r => tracks[r]));
    const target = resources.find(r => tracks[r] === lowest && tracks[r] < 20);
    if (!target) break;
    tracks[target]++;
    coinSteps--; usedCoinSteps++;
  }
  p.tracks = tracks;
  p.coins -= usedCoinSteps * 10;
  p.finalAdjusted = true;
}
export function scoreBreakdown(p: PlayerState) {
  const { exchangeRate, victoryPoints } = brewerScoring(p.brewer);
  const tracks = p.finalAdjusted ? { ...p.tracks } : equalizeResourceTracks(p.tracks, exchangeRate);
  if (!p.finalAdjusted) {
    let coinSteps = Math.floor(p.coins / 10);
    while (coinSteps > 0) {
      const lowest = Math.min(...resources.map(r => tracks[r]));
      const target = resources.find(r => tracks[r] === lowest && tracks[r] < 20);
      if (!target) break;
      tracks[target]++; coinSteps--;
    }
  }
  const minResource = Math.min(...resources.map(r => tracks[r]));
  const productionScore = resources.some(r => tracks[r] < 1) ? 0 : minResource * victoryPoints;
  const barrelScore = p.claimedBarrels.reduce((sum, barrel) => sum + (barrel.size === 'large' ? 4 : 2), 0) + (p.privilegePairs.includes('C') ? p.claimedBarrels.length : 0);
  const startBonus = p.startSlot === 0 ? 1 : 0;
  return { exchangeRate, victoryPoints, tracks, minResource, productionScore, barrelScore, startBonus, total: productionScore + barrelScore + startBonus };
}
function scoreWinner(G: AleState) {
  const totals = G.players.map(p => scoreBreakdown(p).total), highest = Math.max(...totals);
  const winners = totals.flatMap((total, index) => total === highest ? [String(index)] : []);
  return winners.length > 1 ? { draw: true, winners, scores: totals } : { winner: winners[0], scores: totals };
}
export const barrelGoals = [
  '你的酿酒师必须至少到达棕色生产点“1”的位置。',
  '你的所有资源标记物必须至少到达棕色生产点“1”的位置。',
  '你的玩家面板中至少放置了6块产值为1的资源板块。',
  '你的玩家面板中至少放置了6块产值为5的资源板块。',
  '在4个僧侣计分点中都必须有1个计分标记。',
  '在5个资源计分点中都必须有1个计分标记。',
  '你的玩家面板上必须至少放置3块相同类型的棚屋板块。',
  '你的玩家面板上必须至少放置4块不同类型的棚屋板块。',
  '你的资源标记物必须至少有1个到达棕色生产点“20”的位置。',
  '你的特权配对旁边必须至少放置3张特权卡。',
  '一共放置了15块僧侣或资源板块在你玩家面板的向阳侧中。',
  '一共放置了15块僧侣或资源板块在你玩家面板的阴凉侧中。',
];
