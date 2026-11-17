import type { Game } from 'boardgame.io';
import { INITIAL_BARREL_SUPPLY, INITIAL_STRAW_SUPPLY, STORAGE_UNLOCK_ORDER, UNLOCKABLE_STORAGE_SLOTS, canStoreExpansionCargo, cartGateBeforeLocation, cartRoute, createExpansionState, emptyExpansionStorageSlots, ensureExpansionStorageLayout, initializeFirstExpansionRound, maximumCartLoad, removeStoredCargo, seedRoundCargo, simulateCartMove, storedCargoCount, validCartLoadChoices, type ExpansionCargo, type ExpansionState } from './expansion';

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
export type PrivilegePrompt = { kind: 'pair'; pairIndex: number; playerIndex?: number };
export type AleState = {
  players: PlayerState[]; round: number; maxRounds: number; track: ActionSpace[]; resources: Tile[][]; monks: Tile[][];
  /** The expansion is opt-in; false leaves the base game state and rules unchanged. */
  expansionEnabled: boolean;
  expansion: ExpansionState | null;
  resourceDecks: Tile[][]; monkDecks: Tile[][]; scores: number[]; barrels: { id: number; remaining: number }[]; phase: 'setup' | 'play' | 'finished';
  setupStage: 'starts' | 'expansion-stores' | null;
  pending: { space: number; type: ActionSpace['type']; player: string; purchases?: number; baseDone?: boolean; cargoDone?: boolean; cargoTaken?: number; cartDone?: boolean; actionsDone?: number } | null; log: string[];
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
  [1515, 590],
].map(([x, y]) => ({ left: x / 1904 * 100, top: y / 1176 * 100 }));
export const startSlots = [
  { label: '首位玩家', reward: '无奖励', ...point(220, 165) },
  { label: '钱币', reward: '+2钱币', ...point(80, 165) },
  { label: '酿酒师', reward: '酿酒师+1', ...point(145, 80) },
  { label: '资源', reward: '任一资源+2', ...point(142, 240) },
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

function redactExpansionStoreSetup(G: AleState, playerID: string | null): AleState {
  if (G.phase !== 'setup' || G.setupStage !== 'expansion-stores' || !G.expansion || G.expansion.storeSetupReady.every(Boolean)) return G;
  const viewer = playerID === null ? -1 : Number(playerID);
  const sanitize = (state: any, depth = 0): any => {
    if (!state || typeof state !== 'object' || depth > 3) return state;
    const expansion = state.expansion;
    const maskedExpansion = expansion ? {
      ...expansion,
      players: expansion.players?.map((board: any, index: number) => index === viewer ? board : { ...board, hutStoreTiles: Array(7).fill(null) }),
    } : expansion;
    const sanitizeSnapshot = (value: unknown) => {
      if (typeof value !== 'string') return value;
      try { return JSON.stringify(sanitize(JSON.parse(value), depth + 1)); }
      catch { return value; }
    };
    return {
      ...state,
      expansion: maskedExpansion,
      undoSnapshot: sanitizeSnapshot(state.undoSnapshot),
      stepUndoSnapshots: Array.isArray(state.stepUndoSnapshots) ? state.stepUndoSnapshots.map(sanitizeSnapshot) : state.stepUndoSnapshots,
    };
  };
  return sanitize(G) as AleState;
}

export const HeavenAle: Game<AleState> = {
  name: 'heaven-and-ale',
  playerView: ({ G, playerID }) => redactExpansionStoreSetup(G, playerID ?? null),
  setup: ({ ctx, random }, setupData?: { expansionEnabled?: boolean }) => {
    const count = Math.max(2, Math.min(4, ctx.numPlayers));
    const players = Array.from({ length: count }, (_, i) => emptyPlayer(i, playerColors[i]));
    const startPlayer = random.Shuffle(Array.from({ length: count }, (_, i) => i))[0] ?? 0;
    players[startPlayer].startSlot = 0;
    const expansionEnabled = setupData?.expansionEnabled === true;
    const expansion = expansionEnabled ? createExpansionState(count, track.length) : null;
    const G: AleState = { players, round: 1, expansionEnabled, expansion,
      maxRounds: count === 2 ? 3 : count === 3 ? 4 : 6, track, resources: [], monks: [], resourceDecks: [], monkDecks: [], scores: [1, 1, 1, 1, 1, 1],
      barrels: Array.from({ length: expansionEnabled ? 13 : 12 }, (_, i) => ({ id: i + 1, remaining: 2 })), phase: 'setup', setupStage: 'starts', pending: null, log: [`随机决定${players[startPlayer].name}为首位玩家并放在起始玩家格；其他玩家逆时针选择起始奖励。`],
      startPlayer, firstTurnAfterSetup: false, startChoice: null, undoSnapshot: null, stepUndoSnapshots: [], confirmationKind: null, shedChoices: [], privilegePrompts: [] };
    makeDeck(G, random, G.maxRounds);
    return G;
  },
  turn: { minMoves: 1, maxMoves: 99,
    order: {
      first: ({ G }) => G.phase === 'setup' ? (G.setupStage === 'expansion-stores' ? G.startPlayer : (G.startPlayer + G.players.length - 1) % G.players.length) : G.startPlayer,
      next: ({ G, ctx }) => {
        if (G.phase === 'setup' && G.setupStage === 'expansion-stores' && G.expansion) {
          for (let step = 1; step <= G.players.length; step++) {
            const candidate = (Number(ctx.currentPlayer) + step) % G.players.length;
            if (!G.expansion.storeSetupReady[candidate]) return candidate;
          }
          return undefined;
        }
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
      if (G.expansionEnabled && G.expansion) {
        G.expansion.storePrompts ??= [];
        if (G.phase === 'setup') {
          G.expansion.cargoByTrackSpace = G.track.map(() => []);
          G.expansion.barrelSupply = INITIAL_BARREL_SUPPLY;
          G.expansion.strawSupply = INITIAL_STRAW_SUPPLY;
          G.expansion.cartDieSpace = -1;
          G.expansion.cartDieValue = 0;
          G.expansion.cartDieWrappedThisRound = false;
        }
        G.expansion.cartDieWrappedThisRound ??= false;
        G.expansion.turnEndDieStopPlayer ??= null;
        G.expansion.players.forEach(board => {
          board.hutStoreTiles ??= Array(7).fill(null);
          board.hutStoreUsed ??= Array(board.hutStoreTiles.length).fill(false);
          ensureExpansionStorageLayout(board);
          board.cartStepBonus ??= 0; board.cartBarrels ??= 0; board.cartPosition ??= 0;
          board.breweryScores ??= [3, 4, 8]; board.breweryDeliveries ??= [0, 0, 0]; board.deliveredBarrels ??= 0;
          const legacyBreweryTiles = Array.isArray(board.storageExtensions) ? board.storageExtensions.map(extension => extension?.kind === 'effect' && (extension.tileId === 3 || extension.tileId === 4) ? extension.tileId : null) : [];
          board.breweryUpgradeTiles ??= [
            legacyBreweryTiles.includes(3) || board.breweryScores[0] === 5 ? 3 : null,
            legacyBreweryTiles.includes(4) || board.breweryScores[1] === 6 ? 4 : null,
          ];
          board.breweryUpgradeTiles.length = 2;
          board.breweryUpgradeTiles[0] ??= null; board.breweryUpgradeTiles[1] ??= null;
          board.storageExtensions = board.storageExtensions.map(extension => extension?.kind === 'effect' && (extension.tileId === 3 || extension.tileId === 4) ? null : extension);
        });
        if (!G.barrels.some(barrel => barrel.id === 13)) G.barrels.push({ id: 13, remaining: 2 });
        if (G.expansion.cartMovement) {
          G.expansion.cartMovement.completion ??= 'action';
          G.expansion.cartMovement.startPosition ??= G.expansion.players[G.expansion.cartMovement.playerIndex]?.cartPosition ?? 0;
        }
      }
      if (G.firstTurnAfterSetup) G.firstTurnAfterSetup = false;
      // Recover safely if a stale or partially restored state reaches the
      // start of a turn with every player already retired. Without this,
      // auto-skipping retired seats can repeatedly call onBegin forever.
      if (G.phase === 'play' && G.players.every(player => player.retired)) finishRound(G);
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
        if (G.players.every(p => p.startSlot !== null)) beginPlayOrExpansionStoreSetup(G);
      } else {
        if (G.pending && G.pending.type === 'start' && G.pending.player === ctx.currentPlayer && (G.pending.cargoDone !== undefined || G.pending.cartDone !== undefined)) {
          G.pending.baseDone = true; G.pending.actionsDone = 1;
          finishExpansionActionIfReady(G);
        } else G.pending = null;
      }
      G.confirmationKind = mode === 'setup' ? 'setup' : G.pending?.type === 'start' ? null : 'return';
    },
    chooseStartResource: ({ G, ctx }, resource: Resource) => {
      const choice = G.startChoice, player = G.players[Number(ctx.currentPlayer)];
      if (!choice || choice.player !== ctx.currentPlayer || !player || G.confirmationKind || !resources.includes(resource)) return;
      saveStepSnapshot(G);
      finalizeStartChoice(G, player, choice.slot, resource, choice.mode);
      G.startChoice = null;
      if (choice.mode === 'setup') {
        if (G.players.every(p => p.startSlot !== null)) beginPlayOrExpansionStoreSetup(G);
      } else {
        if (G.pending && G.pending.type === 'start' && G.pending.player === ctx.currentPlayer && (G.pending.cargoDone !== undefined || G.pending.cartDone !== undefined)) {
          G.pending.baseDone = true; G.pending.actionsDone = 1;
          finishExpansionActionIfReady(G);
        } else G.pending = null;
      }
      G.confirmationKind = choice.mode === 'setup' ? 'setup' : G.pending?.type === 'start' ? null : 'return';
    },
    assignExpansionStoreTile: { move: ({ G, ctx }, hutIndex: number, tileId: number, pairedHutIndex?: number, pairedTileId?: number) => {
      const playerIndex = Number(ctx.currentPlayer), board = G.expansion?.players[playerIndex];
      if (G.phase !== 'setup' || G.setupStage !== 'expansion-stores' || !G.expansion || !board || G.confirmationKind || G.expansion.storeSetupReady[playerIndex]) return;
      const hutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
      if (!hutIndexes.includes(hutIndex) || !Number.isInteger(tileId) || tileId < 1 || tileId > 7) return;
      const storeSlot = hutIndexes.indexOf(hutIndex);
      const hasPairedAssignment = pairedHutIndex !== undefined || pairedTileId !== undefined;
      let pairedSlot = -1;
      if (hasPairedAssignment) {
        if (pairedHutIndex === undefined || pairedTileId === undefined || !hutIndexes.includes(pairedHutIndex) || !Number.isInteger(pairedTileId) || pairedTileId < 1 || pairedTileId > 7 || pairedTileId === tileId) return;
        pairedSlot = hutIndexes.indexOf(pairedHutIndex);
        const emptySlots = board.hutStoreTiles.flatMap((id, slot) => id === null ? [slot] : []);
        const remainingIds = Array.from({ length: 7 }, (_, index) => index + 1).filter(id => !board.hutStoreTiles.includes(id));
        if (pairedSlot === storeSlot || !emptySlots.includes(storeSlot) || !emptySlots.includes(pairedSlot) || emptySlots.length !== 2 || remainingIds.length !== 2 || !remainingIds.includes(tileId) || !remainingIds.includes(pairedTileId)) return;
      }
      saveActionSnapshot(G); saveStepSnapshot(G);
      const previousSlot = board.hutStoreTiles.indexOf(tileId);
      if (previousSlot >= 0 && previousSlot !== storeSlot) board.hutStoreTiles[previousSlot] = board.hutStoreTiles[storeSlot];
      board.hutStoreTiles[storeSlot] = tileId;
      if (hasPairedAssignment) board.hutStoreTiles[pairedSlot] = pairedTileId!;
    }, redact: true },
    assignExpansionStoreLayout: { move: ({ G, ctx }, tileIds: number[]) => {
      const playerIndex = Number(ctx.currentPlayer), board = G.expansion?.players[playerIndex];
      if (G.phase !== 'setup' || G.setupStage !== 'expansion-stores' || !G.expansion || !board || G.confirmationKind || G.expansion.storeSetupReady[playerIndex]) return;
      if (!Array.isArray(tileIds) || tileIds.length !== 7 || new Set(tileIds).size !== 7 || tileIds.some(id => !Number.isInteger(id) || id < 1 || id > 7)) return;
      if (board.hutStoreTiles.some(id => id !== null)) return;
      saveActionSnapshot(G); saveStepSnapshot(G);
      board.hutStoreTiles = [...tileIds];
      G.expansion.storeSetupReady[playerIndex] = true;
      G.confirmationKind = 'setup';
      G.log.unshift(`${G.players[playerIndex].name} 完成了 7 个存储板块的策略布局，等待确认。`);
    }, redact: true },
    placeRemainingExpansionStoreTiles: { move: ({ G, ctx }, tileIds: number[]) => {
      const playerIndex = Number(ctx.currentPlayer), board = G.expansion?.players[playerIndex];
      if (G.phase !== 'setup' || G.setupStage !== 'expansion-stores' || !G.expansion || !board || G.confirmationKind || G.expansion.storeSetupReady[playerIndex] || !Array.isArray(tileIds)) return;
      const hutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
      const emptySlots = board.hutStoreTiles.flatMap((id, slot) => id === null ? [slot] : []);
      const remainingIds = Array.from({ length: 7 }, (_, index) => index + 1).filter(id => !board.hutStoreTiles.includes(id));
      if (tileIds.length !== emptySlots.length || tileIds.length !== remainingIds.length || new Set(tileIds).size !== tileIds.length || tileIds.some(id => !remainingIds.includes(id))) return;
      saveActionSnapshot(G); saveStepSnapshot(G);
      emptySlots.forEach((slot, index) => { board.hutStoreTiles[slot] = tileIds[index]; });
      G.log.unshift(`${G.players[playerIndex].name} 随机放置了剩余的 ${tileIds.length} 个存储板块。`);
    }, redact: true },
    finishExpansionStoreSetup: ({ G, ctx }) => {
      const playerIndex = Number(ctx.currentPlayer), board = G.expansion?.players[playerIndex];
      if (G.phase !== 'setup' || G.setupStage !== 'expansion-stores' || !G.expansion || !board || G.confirmationKind || G.expansion.storeSetupReady[playerIndex] || board.hutStoreTiles.some(id => id === null)) return;
      saveActionSnapshot(G); saveStepSnapshot(G);
      G.expansion.storeSetupReady[playerIndex] = true;
      G.confirmationKind = 'setup';
      G.log.unshift(`${G.players[playerIndex].name} 完成扩展存储板块配置。`);
    },
    resolveExpansionStore: ({ G, ctx }, side: 'front' | 'back', cargo: ExpansionCargo[] = [], destinations: number[] = [], breweryIndex?: number) => {
      const expansion = G.expansion, prompt = expansion?.storePrompts?.[0];
      if (!G.expansionEnabled || !expansion || !prompt || prompt.playerIndex !== Number(ctx.currentPlayer) || G.confirmationKind) return;
      const board = expansion.players[prompt.playerIndex], player = G.players[prompt.playerIndex];
      const hutSlot = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []).indexOf(prompt.hutIndex);
      if (!board || !player || hutSlot < 0 || board.hutStoreUsed[hutSlot] || board.hutStoreTiles[hutSlot] !== prompt.tileId) return;
      if (side === 'back') {
        const slot = STORAGE_UNLOCK_ORDER.find(candidate => board.storageExtensions[UNLOCKABLE_STORAGE_SLOTS.indexOf(candidate)] === null);
        const extensionIndex = slot === undefined ? -1 : UNLOCKABLE_STORAGE_SLOTS.indexOf(slot);
        if (extensionIndex < 0 || slot === undefined) return;
        saveStepSnapshot(G);
        board.storageExtensions[extensionIndex] = { kind: 'storage' };
        board.storageUnlocked[slot] = true;
        G.log.unshift(`${player.name} 将存储板块 ${prompt.tileId} 翻至背面，增加 1 个常规存储格。`);
      } else {
        if (prompt.tileId === 7) {
          if (!cargo.length || new Set(cargo).size !== cargo.length || cargo.some(kind => kind !== 'barrel' && kind !== 'straw')) return;
          if (cargo.includes('barrel') && expansion.barrelSupply < 1 || cargo.includes('straw') && expansion.strawSupply < 1) return;
          const regularSlots = emptyExpansionStorageSlots(board);
          const targets = destinations.length ? destinations : cargo.map((_, index) => regularSlots[index] ?? -99);
          if (targets.length !== cargo.length || new Set(targets).size !== targets.length) return;
          const temporaryCount = targets.filter(slot => slot === -1).length;
          if (temporaryCount > 1 || temporaryCount && (board.temporaryStorage != null || player.coins < 4 * temporaryCount)) return;
          if (targets.some(slot => slot !== -1 && (!Number.isInteger(slot) || !regularSlots.includes(slot)))) return;
          saveStepSnapshot(G);
          cargo.forEach((kind, index) => {
            const slot = targets[index];
            if (slot === -1) { player.coins -= 4; board.temporaryStorage = kind; }
            else board.storage[slot] = kind;
            if (kind === 'barrel') expansion.barrelSupply--; else expansion.strawSupply--;
          });
          const placed = cargo.map((kind, index) => `${kind === 'barrel' ? '桶装酒' : '干草'}放入${targets[index] === -1 ? '临时存储格' : '常规存储格'}`).join('，');
          G.log.unshift(`${player.name} 使用存储板块 7，从供应堆获得${cargo.map(kind => kind === 'barrel' ? '1桶桶装酒' : '1捆干草').join('和')}（${placed}${temporaryCount ? `，支付 ${temporaryCount * 4} 钱币` : ''}）。`);
        } else if (prompt.tileId === 1 || prompt.tileId === 2) {
          const extensionIndex = board.storageExtensions.findIndex(extension => extension === null);
          if (extensionIndex < 0) return;
          saveStepSnapshot(G);
          const bonus = prompt.tileId === 1 ? 2 : 3;
          board.storageExtensions[extensionIndex] = { kind: 'effect', tileId: prompt.tileId };
          board.cartStepBonus += bonus;
          G.log.unshift(`${player.name} 使用存储板块 ${prompt.tileId}，今后推车骰子移动距离永久增加 ${bonus} 格。`);
        } else if (prompt.tileId === 3 || prompt.tileId === 4) {
          if (breweryIndex !== 0 && breweryIndex !== 1) return;
          board.breweryUpgradeTiles ??= [null, null];
          if (board.breweryUpgradeTiles[breweryIndex] !== null) return;
          saveStepSnapshot(G);
          const score = prompt.tileId === 3 ? 5 : 6;
          board.breweryUpgradeTiles[breweryIndex] = prompt.tileId;
          board.breweryScores[breweryIndex] = score;
          G.log.unshift(`${player.name} 使用存储板块 ${prompt.tileId} 覆盖第 ${breweryIndex + 1} 酒馆的基础计分，每桶改为 ${score} 分。`);
        } else if (prompt.tileId === 5 || prompt.tileId === 6) {
          const steps = prompt.tileId === 5 ? 4 : 6, choices = validCartLoadChoices(board, steps);
          if (!choices.length) return;
          saveStepSnapshot(G);
          G.log.unshift(`${player.name} 使用存储板块 ${prompt.tileId}，立即推动推车 ${steps} 格（不计骰子加成）。`);
          expansion.cartMovement = { playerIndex: prompt.playerIndex, remaining: steps, nextLocation: -1, loadChoices: choices, completion: 'store', startPosition: board.cartPosition, deliveredAtStart: board.deliveredBarrels };
        } else return;
      }
      board.hutStoreUsed[hutSlot] = true;
      expansion.storePrompts.shift();
      if (side === 'front' && (prompt.tileId === 5 || prompt.tileId === 6)) advanceExpansionCart(G);
      if (!expansion.cartMovement && !expansion.storePrompts.length && !G.shedChoices.length) finishPurchaseIfNoOptions(G, player);
    },
    skipExpansionBaseAction: ({ G, ctx }) => {
      const pending = G.pending, player = G.players[Number(ctx.currentPlayer)], expansion = G.expansion;
      if (!G.expansionEnabled || !expansion || !pending || pending.player !== ctx.currentPlayer || pending.baseDone || G.confirmationKind || !player) return;
      if (!canTakeExpansionCargo(G, player, pending.space) && !canUseExpansionCart(G, player, pending.space)) return;
      saveStepSnapshot(G);
      pending.baseDone = true;
      G.log.unshift(`${player.name} 跳过基础行动，改执行该格可用的扩展行动。`);
    },
    takeExpansionCargo: ({ G, ctx }, kind: ExpansionCargo, storageSlot: number) => {
      const pending = G.pending, playerIndex = Number(ctx.currentPlayer), player = G.players[playerIndex], expansion = G.expansion;
      if (!G.expansionEnabled || !expansion || !pending || pending.player !== ctx.currentPlayer || !pending.baseDone || pending.cargoDone || G.confirmationKind || !player) return;
      if (kind !== 'barrel' && kind !== 'straw') return;
      const cargoPile = expansion.cargoByTrackSpace[pending.space], cargoIndex = cargoPile?.indexOf(kind) ?? -1, board = expansion.players[playerIndex];
      if (cargoIndex < 0 || !board) return;
      if (storageSlot === -1) {
        if (board.temporaryStorage || player.coins < 4) return;
      } else {
        if (!Number.isInteger(storageSlot) || storageSlot < 0 || storageSlot >= board.storage.length || !board.storageUnlocked[storageSlot] || board.storage[storageSlot] !== null) return;
      }
      saveStepSnapshot(G);
      if (storageSlot === -1) { player.coins -= 4; board.temporaryStorage = kind; }
      else board.storage[storageSlot] = kind;
      cargoPile.splice(cargoIndex, 1);
      pending.cargoTaken = (pending.cargoTaken ?? 0) + 1;
      G.log.unshift(`${player.name} 从第 ${pending.space + 1} 格拿取${kind === 'barrel' ? '1 桶桶装酒' : '1 捆干草'}${storageSlot === -1 ? '，放入临时存储格并支付4钱币' : `，放入存储格 ${storageSlot + 1}`}。`);
    },
    takeExpansionCargoBatch: ({ G, ctx }, picks: { kind: ExpansionCargo; storageSlot: number }[]) => {
      const pending = G.pending, playerIndex = Number(ctx.currentPlayer), player = G.players[playerIndex], expansion = G.expansion;
      if (!G.expansionEnabled || !expansion || !pending || pending.player !== ctx.currentPlayer || !pending.baseDone || pending.cargoDone || G.confirmationKind || !player || !Array.isArray(picks) || picks.length < 2 || picks.length > 8) return;
      const cargoPile = expansion.cargoByTrackSpace[pending.space], board = expansion.players[playerIndex];
      if (!cargoPile || !board) return;
      const nextPile = [...cargoPile], nextStorage = [...board.storage];
      let nextTemporaryStorage = board.temporaryStorage, nextCoins = player.coins;
      for (const pick of picks) {
        if (!pick || (pick.kind !== 'barrel' && pick.kind !== 'straw')) return;
        const cargoIndex = nextPile.indexOf(pick.kind);
        if (cargoIndex < 0 || !Number.isInteger(pick.storageSlot)) return;
        if (pick.storageSlot === -1) {
          if (nextTemporaryStorage || nextCoins < 4) return;
          nextCoins -= 4; nextTemporaryStorage = pick.kind;
        } else {
          const slot = pick.storageSlot;
          if (slot < 0 || slot >= nextStorage.length || !board.storageUnlocked[slot] || nextStorage[slot] !== null) return;
          nextStorage[slot] = pick.kind;
        }
        nextPile.splice(cargoIndex, 1);
      }
      saveStepSnapshot(G);
      player.coins = nextCoins; board.storage = nextStorage; board.temporaryStorage = nextTemporaryStorage;
      cargoPile.splice(0, cargoPile.length, ...nextPile);
      pending.cargoTaken = (pending.cargoTaken ?? 0) + picks.length;
      const barrels = picks.filter(pick => pick.kind === 'barrel').length, straw = picks.length - barrels;
      G.log.unshift(`${player.name} 一次拿取桶装酒 ${barrels} 桶、干草 ${straw} 捆并放入存储格${picks.some(pick => pick.storageSlot === -1) ? '（临时存储格支付4钱币）' : ''}。`);
    },
    finishExpansionCargo: ({ G, ctx }) => {
      const pending = G.pending;
      if (!G.expansionEnabled || !G.expansion || !pending || pending.player !== ctx.currentPlayer || !pending.baseDone || pending.cargoDone || G.confirmationKind) return;
      if ((pending.actionsDone ?? 0) === 0 && (pending.cargoTaken ?? 0) === 0 && !canUseExpansionCart(G, G.players[Number(ctx.currentPlayer)], pending.space)) return;
      saveStepSnapshot(G);
      pending.cargoDone = true;
      finishExpansionActionIfReady(G);
    },
    skipExpansionCart: ({ G, ctx }) => {
      const pending = G.pending;
      if (!G.expansionEnabled || !G.expansion || !pending || pending.player !== ctx.currentPlayer || !pending.baseDone || !pending.cargoDone || pending.cartDone || G.confirmationKind || G.expansion.cartMovement) return;
      if (!canUseExpansionCart(G, G.players[Number(ctx.currentPlayer)], pending.space)) return;
      // Skipping the base action is only legal when another action on this
      // space is actually performed. Do not let a player skip both the base
      // action and every available expansion action to end with a no-op turn.
      if ((pending.purchases ?? 0) === 0 && (pending.actionsDone ?? 0) === 0 && (pending.cargoTaken ?? 0) === 0) return;
      saveStepSnapshot(G);
      pending.cartDone = true;
      G.log.unshift(`${G.players[Number(ctx.currentPlayer)].name} 跳过手推车行动。`);
      finishExpansionActionIfReady(G);
    },
    useExpansionCart: ({ G, ctx }) => {
      const pending = G.pending, playerIndex = Number(ctx.currentPlayer), player = G.players[playerIndex], expansion = G.expansion;
      if (!G.expansionEnabled || !expansion || !pending || pending.player !== ctx.currentPlayer || !pending.baseDone || !pending.cargoDone || pending.cartDone || G.confirmationKind || expansion.cartMovement || !player || !canUseExpansionCart(G, player, pending.space)) return;
      const board = expansion.players[playerIndex], steps = expansion.cartDieValue + board.cartStepBonus;
      const loadChoices = validCartLoadChoices(board, steps);
      saveStepSnapshot(G);
      expansion.cartMovement = { playerIndex, remaining: steps, nextLocation: -1, loadChoices, completion: 'action', startPosition: board.cartPosition, deliveredAtStart: board.deliveredBarrels };
      G.log.unshift(`${player.name} 使用手推车骰子，移动 ${steps} 格。`);
      advanceExpansionCart(G);
    },
    chooseExpansionCartLoad: ({ G, ctx }, loadCount: number) => {
      const expansion = G.expansion, movement = expansion?.cartMovement, pending = G.pending;
      if (!G.expansionEnabled || !expansion || !movement || !pending || movement.playerIndex !== Number(ctx.currentPlayer) || pending.player !== ctx.currentPlayer || movement.nextLocation < 0 || G.confirmationKind || !movement.loadChoices.includes(loadCount)) return;
      const board = expansion.players[movement.playerIndex], player = G.players[movement.playerIndex];
      if (!board || !player) return;
      const startedAt = movement.startPosition ?? board.cartPosition;
      const otherActionDone = (pending.purchases ?? 0) > 0 || (pending.actionsDone ?? 0) > 0 || (pending.cargoTaken ?? 0) > 0;
      const cartActionDone = loadCount > 0 || startedAt !== 0 || board.deliveredBarrels > (movement.deliveredAtStart ?? board.deliveredBarrels);
      if (movement.completion === 'action' && loadCount === 0 && !otherActionDone && !cartActionDone) return;
      saveStepSnapshot(G);
      if (loadCount === 0) {
        board.cartPosition = 0;
        G.log.unshift(startedAt === 0 && movement.completion === 'action'
          ? `${player.name} 未装载桶装酒，推车留在修道院起点；视为跳过推车行动。`
          : `${player.name} 未装载桶装酒，推车移动后停在修道院起点。`);
        const completion = movement.completion;
        expansion.cartMovement = null;
        if (completion === 'action') {
          pending.cartDone = true;
          if (cartActionDone) pending.actionsDone = (pending.actionsDone ?? 0) + 1;
          finishExpansionActionIfReady(G);
          finishPurchaseIfNoOptions(G, player);
        }
        return;
      }
      const removedBarrels = removeStoredCargo(board, 'barrel', loadCount), removedStraw = removeStoredCargo(board, 'straw', loadCount);
      if (removedBarrels !== loadCount || removedStraw !== loadCount) return;
      board.cartBarrels += loadCount;
      movement.loadGatePassed = true;
      G.log.unshift(`${player.name} 装载 ${loadCount} 桶桶装酒，消耗 ${loadCount} 捆干草。`);
      movement.nextLocation = -1;
      movement.loadChoices = [];
      advanceExpansionCart(G);
    },
    moveTo: ({ G, ctx }, index: number) => {
      const player = G.players[Number(ctx.currentPlayer)];
      if (!player || !canMoveTo(G, player, index)) return;
      const space = G.track[index];
      if (space.type === 'start') {
        saveActionSnapshot(G);
        saveStepSnapshot(G);
        player.position = index; player.startSlot = null; G.pending = { space: index, type: 'start', player: ctx.currentPlayer, ...expansionPendingFields(G, player, index, false, 0) };
        return;
      }
      saveActionSnapshot(G);
      saveStepSnapshot(G);
      player.startSlot = null; player.position = index;
      if (space.type === 'barrel') {
        const claimed = awardBarrels(G, player);
        G.log.unshift(`${player.name} 到达酒桶成就格，领取 ${claimed.length} 个酒桶：${claimed.map(b => `目标 ${String(b.id).padStart(2, '0')} ${b.size === 'large' ? '大酒桶（4分）' : '小酒桶（2分）'}`).join('、')}。`);
        const expansionActions = expansionPendingFields(G, player, index, true, claimed.length ? 1 : 0);
        if (expansionActions.cargoDone !== undefined || expansionActions.cartDone !== undefined) G.pending = { space: index, type: space.type, player: ctx.currentPlayer, ...expansionActions };
        else { G.pending = null; G.confirmationKind = 'turn'; }
        return;
      }
      const expansionActions = expansionPendingFields(G, player, index, false, 0);
      const hasExpansionAction = expansionActions.cargoDone !== undefined || expansionActions.cartDone !== undefined;
      const baseActionAvailable = canPerformBaseAction(G, player, index);
      G.pending = {
        space: index, type: space.type, player: ctx.currentPlayer, purchases: 0,
        ...expansionActions,
        ...(hasExpansionAction && !baseActionAvailable ? { baseDone: true } : {}),
      };
    },
    buyTile: ({ G, ctx }, tileId: string, cellIndex: number) => {
      const p = G.players[Number(ctx.currentPlayer)], pending = G.pending;
      if (G.confirmationKind || !pending || pending.player !== ctx.currentPlayer || pending.baseDone || !['resource', 'monk'].includes(pending.type)) return;
      const space = G.track[pending.space];
      const market = pending.type === 'resource' ? G.resources[space.sourceIndex ?? -1] : G.monks[space.sourceIndex ?? -1];
      const tileIndex = market?.findIndex(t => t.id === tileId) ?? -1, cell = p.board[cellIndex], side = gardenCells[cellIndex]?.side;
      if ((G.expansion?.storePrompts?.length ?? 0) > 0 || tileIndex < 0 || !cell || cell.hut || cell.tile || !side) return;
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
      if (G.confirmationKind || (G.expansion?.storePrompts?.length ?? 0) > 0 || G.shedChoices.length || !pending || pending.baseDone || pending.player !== ctx.currentPlayer || !['resource', 'monk'].includes(pending.type) || (pending.purchases ?? 0) < 1) return;
      saveStepSnapshot(G);
      if (pending.cargoDone !== undefined || pending.cartDone !== undefined) {
        pending.baseDone = true; pending.actionsDone = 1;
        finishExpansionActionIfReady(G);
        return;
      }
      G.pending = null;
      G.confirmationKind = 'turn';
    },
    takeScore: ({ G, ctx }, category: 'A' | 'B' | 'C', option: string | number) => {
      const p = G.players[Number(ctx.currentPlayer)], pending = G.pending;
      if (G.confirmationKind || !pending || pending.baseDone || pending.player !== ctx.currentPlayer || pending.type !== 'score') return;
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
        G.privilegePrompts.push({ kind: 'pair', pairIndex, playerIndex: Number(ctx.currentPlayer) });
        G.log.unshift(`${p.name} 完成第 ${pairIndex + 1} 组计分标记，请放置一张特权卡或永久跳过。`);
      }
      if (pending.cargoDone !== undefined || pending.cartDone !== undefined) {
        pending.baseDone = true; pending.actionsDone = 1;
        G.confirmationKind = null;
        finishExpansionActionIfReady(G);
      } else {
        G.pending = null;
        G.confirmationKind = G.privilegePrompts.length ? null : 'turn';
      }
    },
    toggleShedChoice: ({ G, ctx }, cellIndex: number) => {
      const choice = G.shedChoices[0], player = G.players[Number(ctx.currentPlayer)];
      if (!choice || !player || (G.expansion?.storePrompts?.length ?? 0) > 0 || G.confirmationKind || !canSelectShedCell(choice, cellIndex)) return;
      saveStepSnapshot(G);
      const selectedAt = choice.selected.indexOf(cellIndex);
      if (selectedAt >= 0 && choice.mode === 'opposite') choice.selected = [];
      else if (selectedAt >= 0) choice.selected.splice(selectedAt, 1);
      else if (choice.mode === 'opposite') {
        const position = choice.candidates.indexOf(cellIndex);
        choice.selected = [cellIndex, choice.candidates[(position + 3) % choice.candidates.length]];
      } else choice.selected.push(cellIndex);
    },
    completeShedChoice: ({ G, ctx }, selectedCells?: number[]) => {
      const choice = G.shedChoices[0], player = G.players[Number(ctx.currentPlayer)];
      if (!choice || !player || (G.expansion?.storePrompts?.length ?? 0) > 0 || G.confirmationKind) return;
      let plannedSelection: number[] | undefined;
      if (selectedCells !== undefined) {
        if (!Array.isArray(selectedCells) || new Set(selectedCells).size !== selectedCells.length || choice.selected.some(index => !selectedCells.includes(index))) return;
        const planned = { ...choice, selected: [...selectedCells] };
        if (selectedCells.some(index => !choice.candidates.includes(index)) || !validShedSelection(planned)) return;
        plannedSelection = [...selectedCells];
      }
      if (!validShedSelection(plannedSelection ? { ...choice, selected: plannedSelection } : choice)) return;
      saveStepSnapshot(G);
      if (plannedSelection) choice.selected = plannedSelection;
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
      if ((G.confirmationKind && G.confirmationKind !== 'turn') || !prompt || !p || (prompt.playerIndex !== undefined && prompt.playerIndex !== Number(ctx.currentPlayer))) return;
      if (prompt.kind === 'pair' && card === 'skip') {
        saveStepSnapshot(G);
        p.privilegePairs[prompt.pairIndex] = 'skip';
        G.log.unshift(`${p.name} 跳过第 ${prompt.pairIndex + 1} 组特权卡奖励；之后不能补放。`);
        G.privilegePrompts.shift(); if (!G.privilegePrompts.length) G.confirmationKind = G.pending?.baseDone ? null : 'turn';
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
      G.privilegePrompts.shift(); if (!G.privilegePrompts.length) G.confirmationKind = G.pending?.baseDone ? null : 'turn';
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
    confirmAction: ({ G, ctx, events, random }) => {
      if (!G.confirmationKind || G.privilegePrompts.length > 0 || G.shedChoices.length > 0 || G.startChoice || (G.expansion?.storePrompts?.length ?? 0) > 0 || G.expansion?.cartMovement) return;
      const kind = G.confirmationKind;
      // A missing undo snapshot should disable undo, not strand a valid
      // confirmation forever. This can occur in older/restored local saves.
      if (!G.undoSnapshot) G.log.unshift('对局恢复提示：确认行动时缺少撤回快照，已继续结算。');
      G.undoSnapshot = null; G.stepUndoSnapshots = []; G.confirmationKind = null;
      if (G.phase === 'setup' && G.setupStage === 'expansion-stores' && kind === 'setup' && G.expansion?.storeSetupReady.every(Boolean)) {
        initializeFirstExpansionRound(G.expansion, G.track.length - 1, random.Die(6));
        G.phase = 'play'; G.setupStage = null; G.firstTurnAfterSetup = true;
        G.log.unshift('扩展首轮设置完成：推车骰子与首批桶装酒、干草已放置。');
        G.log.unshift('所有玩家完成并确认扩展准备，游戏开始。');
      }
      if (G.phase === 'play' && kind !== 'free' && kind !== 'setup' && G.expansionEnabled && G.expansion) updateExpansionCartDie(G, Number(ctx.currentPlayer), () => random.Die(6));
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
  if (!pending || (G.expansion?.storePrompts?.length ?? 0) > 0 || !['resource', 'monk'].includes(pending.type) || (pending.purchases ?? 0) < 1 || G.shedChoices.length) return;
  const space = G.track[pending.space];
  const market = pending.type === 'resource' ? G.resources[space.sourceIndex ?? -1] : G.monks[space.sourceIndex ?? -1];
  if (canBuyFrom(p, market ?? [], space.sourceIndex)) return;
  if (pending.cargoDone !== undefined || pending.cartDone !== undefined) {
    pending.baseDone = true; pending.actionsDone = 1;
    finishExpansionActionIfReady(G);
    return;
  }
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
  if (mode === 'return') {
    const playerIndex = G.players.indexOf(player);
    if (G.expansion && player.position === G.expansion.cartDieSpace) G.expansion.turnEndDieStopPlayer = playerIndex;
    player.position = -1; player.retired = true;
  }
  G.log.unshift(`${player.name} 选择${startSlots[slot].label}位置，获得${startSlots[slot].reward}${slot === 3 && resource ? `（${resourceLabels[resource]} +2）` : ''}。`);
}
function beginPlayOrExpansionStoreSetup(G: AleState) {
  if (G.expansionEnabled && G.expansion) {
    G.setupStage = 'expansion-stores';
    G.log.unshift('起始奖励选择完成。每位玩家将自己的7块存储板块自由分配到7个棚屋上。');
    return;
  }
  G.phase = 'play'; G.setupStage = null; G.firstTurnAfterSetup = true;
  G.log.unshift('起始奖励选择完成，游戏开始。');
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
      if (G.expansionEnabled && G.expansion) {
        const playerIndex = G.players.indexOf(p), hutSlot = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []).indexOf(i);
        const tileId = G.expansion.players[playerIndex]?.hutStoreTiles[hutSlot];
        if (tileId && !G.expansion.players[playerIndex].hutStoreUsed[hutSlot]) G.expansion.storePrompts.push({ playerIndex, hutIndex: i, tileId });
      }
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
  return G.barrels.filter(stock => stock.remaining > 0 && !p.claimedBarrels.some(barrel => barrel.id === stock.id)
    && (stock.id === 13 ? !!G.expansion && (G.expansion.players[G.players.indexOf(p)]?.deliveredBarrels ?? 0) >= 3 : barrelMet(p, stock.id))).map(stock => stock.id);
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
  if (space.type==='start' || canPerformBaseAction(G, p, index)) return true;
  return G.expansionEnabled && (canTakeExpansionCargo(G, p, index) || canUseExpansionCart(G, p, index));
}
function canPerformBaseAction(G: AleState, p: PlayerState, index: number) {
  const space = G.track[index];
  if (!space) return false;
  if (space.type === 'resource') return canBuyFrom(p, G.resources[space.sourceIndex ?? -1] ?? [], space.sourceIndex);
  if (space.type === 'monk') return canBuyFrom(p, G.monks[space.sourceIndex ?? -1] ?? [], space.sourceIndex);
  if (space.type === 'score') return G.scores[space.sourceIndex ?? -1] > 0 && canScore(p, space.scoreType);
  if (space.type === 'barrel') return availableBarrelIds(G, p).length > 0;
  return space.type === 'start';
}
export function canTakeExpansionCargo(G: AleState, p: PlayerState, spaceIndex: number) {
  const expansion = G.expansion, playerIndex = G.players.indexOf(p);
  return !!expansion && playerIndex >= 0 && !!expansion.cargoByTrackSpace[spaceIndex]?.length && canStoreExpansionCargo(expansion.players[playerIndex], p.coins);
}
export function canUseExpansionCart(G: AleState, p: PlayerState, spaceIndex: number) {
  const expansion = G.expansion, playerIndex = G.players.indexOf(p);
  if (!expansion || playerIndex < 0 || expansion.cartDieSpace !== spaceIndex) return false;
  const board = expansion.players[playerIndex], steps = expansion.cartDieValue + board.cartStepBonus;
  return validCartLoadChoices(board, steps).some(load => {
    const result = simulateCartMove(board, board.cartPosition, steps, load);
    // Declining to load is a skipped-cart outcome only if the cart began at
    // the Abbey. Reaching the Abbey from elsewhere still performs movement.
    return !!result && !(board.cartPosition === 0 && load === 0 && result.stoppedAtLoadGate && result.position === 0 && result.barrels === board.cartBarrels);
  });
}
function expansionPendingFields(G: AleState, p: PlayerState, spaceIndex: number, baseDone: boolean, actionsDone: number) {
  if (!G.expansionEnabled || !G.expansion) return {};
  const cargoAvailable = canTakeExpansionCargo(G, p, spaceIndex), cartAvailable = canUseExpansionCart(G, p, spaceIndex);
  if (!cargoAvailable && !cartAvailable) return {};
  return { baseDone, cargoDone: !cargoAvailable, cartDone: !cartAvailable, actionsDone };
}
function finishExpansionActionIfReady(G: AleState) {
  const pending = G.pending;
  if (!pending || !pending.baseDone || pending.cargoDone === false || pending.cartDone === false) return;
  if (pending.cargoDone === undefined && pending.cartDone === undefined) return;
  const kind = pending.type;
  G.pending = null;
  G.confirmationKind = kind === 'start' ? 'return' : G.privilegePrompts.length ? null : 'turn';
}
function advanceExpansionCart(G: AleState) {
  const expansion = G.expansion, movement = expansion?.cartMovement, pending = G.pending;
  if (!expansion || !movement || !pending) return;
  const board = expansion.players[movement.playerIndex], player = G.players[movement.playerIndex];
  if (!board || !player) return;
  while (movement.remaining > 0) {
    const next = (board.cartPosition + 1) % cartRoute.length;
    const gate = cartGateBeforeLocation[next];
    if (gate === 'load' && !movement.loadGatePassed) {
      movement.nextLocation = next;
      return;
    }
    if (gate === 'deliver-one') {
      if (board.cartBarrels > 0) {
        board.cartBarrels--;
        board.breweryDeliveries[(cartRoute[next].brewery ?? 1) - 1]++;
        board.deliveredBarrels++;
        G.log.unshift(`${player.name} 穿过酒厂门，向第 ${cartRoute[next].brewery} 酒馆交付 1 桶桶装酒。`);
      }
    } else if (gate === 'deliver-all') {
      const delivered = board.cartBarrels;
      board.breweryDeliveries[2] += delivered;
      board.deliveredBarrels += delivered;
      board.cartBarrels = 0;
      G.log.unshift(`${player.name} 穿过第四道门，向第 3 酒馆交付剩余 ${delivered} 桶桶装酒。`);
    }
    if (gate === 'load') movement.loadGatePassed = false;
    board.cartPosition = next;
    movement.remaining--;
  }
  const location = cartRoute[board.cartPosition];
  G.log.unshift(`${player.name} 的推车停在${location.name}${board.cartBarrels ? `，车上剩余 ${board.cartBarrels} 桶` : ''}。`);
  const completion = movement.completion;
  expansion.cartMovement = null;
  if (completion === 'action') {
    pending.cartDone = true;
    pending.actionsDone = (pending.actionsDone ?? 0) + 1;
    finishExpansionActionIfReady(G);
    finishPurchaseIfNoOptions(G, player);
  }
}
function updateExpansionCartDie(G: AleState, endingPlayer: number, rollDie: () => number) {
  const expansion = G.expansion;
  if (!expansion || !G.players[endingPlayer]) return;
  const oldSpace = expansion.cartDieSpace;
  const playerStoppedOnDie = G.players[endingPlayer].position === oldSpace || expansion.turnEndDieStopPlayer === endingPlayer;
  expansion.turnEndDieStopPlayer = null;
  const allPassed = !expansion.cartDieWrappedThisRound && G.players.every(player => player.retired || player.position >= oldSpace);
  if (!playerStoppedOnDie && !allPassed) return;
  const roll = rollDie();
  if (!Number.isInteger(roll) || roll < 1) return;
  if (playerStoppedOnDie) {
    // Count forward from the die's old cell. The old cell is step zero, so a
    // roll of one places the die on the next cell, including the start cell
    // when movement wraps around the end of the track.
    expansion.cartDieSpace = (oldSpace + roll) % G.track.length;
    G.log.unshift(`${G.players[endingPlayer].name} 回合结束时停在推车骰子格；掷出 ${roll}，骰子从原格顺时针移动 ${roll} 格至第 ${expansion.cartDieSpace + 1} 格。`);
  } else {
    // The last player to pass the old die space rolls it, but the special
    // rule places it one cell ahead of the foremost pawn regardless of roll.
    const startPosition = G.track.findIndex(space => space.type === 'start');
    // A returned player is physically at the round's endpoint (the start
    // area), even though finalizeStartChoice clears their linear track index.
    // Treat that endpoint as furthest so the next cell wraps to track space 0.
    const furthest = G.players.some(player => player.retired)
      ? startPosition
      : Math.max(...G.players.map(player => player.position >= 0 ? player.position : -1));
    expansion.cartDieSpace = (furthest + 1) % G.track.length;
    G.log.unshift(`${G.players[endingPlayer].name} 是最后一个经过推车骰子格的玩家；掷出 ${roll}，骰子放到最前方玩家棋子前一格（第 ${expansion.cartDieSpace + 1} 格）。`);
  }
  expansion.cartDieValue = roll;
  // If the die lands behind every pawn (including at the first cell after
  // the start/finish), they have already passed this new position for this
  // round. Avoid treating every later turn as another all-passed event.
  if (G.players.every(player => player.retired || player.position >= expansion.cartDieSpace)) expansion.cartDieWrappedThisRound = true;
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
  if (G.expansion) G.expansion.cartDieWrappedThisRound = false;
  G.firstTurnAfterSetup = true;
  for (let i = 0; i < 15; i++) { const tile = G.resourceDecks[G.round - 1]?.[i]; if (tile) G.resources[i].push(tile); }
  for (let i = 0; i < 4; i++) { const tile = G.monkDecks[G.round - 1]?.[i]; if (tile) G.monks[i].push(tile); }
  if (G.expansionEnabled && G.expansion) {
    const barrels = Math.min(4, G.expansion.barrelSupply), straw = Math.min(4, G.expansion.strawSupply);
    seedRoundCargo(G.expansion.cargoByTrackSpace, G.expansion.cartDieSpace, G.expansion.cartDieValue, barrels, straw);
    G.expansion.barrelSupply -= barrels; G.expansion.strawSupply -= straw;
    G.log.unshift(`扩展补充：主版图加入桶装酒 ${barrels} 个、干草 ${straw} 捆。`);
  }
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
export function scoreBreakdown(p: PlayerState, expansionBoard?: ExpansionState['players'][number]) {
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
  const expansionBarrelScore = expansionBoard
    ? expansionBoard.breweryDeliveries.reduce((sum, count, index) => sum + count * expansionBoard.breweryScores[index], 0)
      + storedCargoCount(expansionBoard, 'barrel') * 0.5
      + expansionBoard.cartBarrels * (cartRoute[expansionBoard.cartPosition]?.score ?? 0)
    : 0;
  const startBonus = p.startSlot === 0 ? 1 : 0;
  return { exchangeRate, victoryPoints, tracks, minResource, productionScore, barrelScore, expansionBarrelScore, startBonus, total: productionScore + barrelScore + expansionBarrelScore + startBonus };
}
function scoreWinner(G: AleState) {
  const totals = G.players.map((p, index) => scoreBreakdown(p, G.expansionEnabled ? G.expansion?.players[index] : undefined).total), highest = Math.max(...totals);
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
  '向任意酒馆交付至少3桶桶装酒（可分散交付）。',
];
