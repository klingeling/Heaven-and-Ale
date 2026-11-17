import type { Resource } from './game';

/** Cargo tokens placed on action spaces by the Heaven & Ale expansion. */
export type ExpansionCargo = 'barrel' | 'straw';
export type StorageExtension = { kind: 'storage' } | { kind: 'effect'; tileId: number } | null;
export type CartLocationKind = 'start' | 'house' | 'forest' | 'brewery';
export type CartLocation = { name: string; kind: CartLocationKind; score: number; brewery?: 1 | 2 | 3; left: number; top: number };

export type ExpansionPlayerBoard = {
  /** Ten regular printed storage positions. Each position holds one cargo token. */
  storage: (ExpansionCargo | null)[];
  /** Locked and printed-open status for each regular storage position. */
  storageUnlocked: boolean[];
  /** Seven extension positions: a back-side tile unlocks storage; a persistent front occupies one as a reminder. */
  storageExtensions: StorageExtension[];
  /** The printed temporary-storage space; using it costs 4 coins per token. */
  temporaryStorage: ExpansionCargo | null;
  /** Barrels currently loaded on the cart. Straw is consumed when loading. */
  cartBarrels: number;
  /** Position on the transport path, in clockwise route order. */
  cartPosition: number;
  /** Front-side store tiles assigned to the player's seven hut spaces. */
  hutStoreTiles: (number | null)[];
  /** Whether each assigned store tile has already been resolved at its hut. */
  hutStoreUsed: boolean[];
  /** One-shot effects on the transport board. */
  cartStepBonus: number;
  breweryScores: [number, number, number];
  /** Store tiles 3/4 covering the printed score at brewery 1/2. */
  breweryUpgradeTiles: (3 | 4 | null)[];
  breweryDeliveries: [number, number, number];
  deliveredBarrels: number;
};

export type ExpansionState = {
  cargoByTrackSpace: ExpansionCargo[][];
  barrelSupply: number;
  strawSupply: number;
  cartDieSpace: number;
  cartDieValue: number;
  cartDieWrappedThisRound: boolean;
  turnEndDieStopPlayer: number | null;
  cartMovement: { playerIndex: number; remaining: number; nextLocation: number; loadChoices: number[]; completion: 'action' | 'store'; startPosition?: number; loadGatePassed?: boolean; deliveredAtStart?: number } | null;
  players: ExpansionPlayerBoard[];
  storeSetupReady: boolean[];
  storePrompts: { playerIndex: number; hutIndex: number; tileId: number }[];
};

export const expansionCargoLabels: Record<ExpansionCargo, string> = {
  barrel: '桶装酒',
  straw: '干草',
};

export const STORE_TILE_COUNT = 7;
export const REGULAR_STORAGE_SLOT_COUNT = 10;
export const BUILT_IN_STORAGE_SLOTS = [4, 8, 9] as const;
export const UNLOCKABLE_STORAGE_SLOTS = [0, 1, 2, 3, 5, 6, 7] as const;
/** Unlock nearest to the printed built-in storage slots first. */
export const STORAGE_UNLOCK_ORDER = [3, 7, 2, 6, 1, 5, 0] as const;
export const INITIAL_BARREL_SUPPLY = 32;
export const INITIAL_STRAW_SUPPLY = 20;
export const CARGO_PER_TYPE_PER_ROUND = 4;
export const TEMPORARY_STORAGE_COST = 4;

/** The printed cart road, clockwise from the Abbey gate in the upper right.
 * Coordinates are percentages of board_ex_*.jpg and intentionally centralized
 * so they can be tuned without touching the game rules. */
export const cartRoute: CartLocation[] = [
  { name: '修道院起点', kind: 'start', score: 0, left: 73, top: 22 },
  { name: '酒馆民居 1', kind: 'house', score: 1, left: 75, top: 38 },
  { name: '酒馆民居 2', kind: 'house', score: 1, left: 75, top: 50 },
  { name: '树林1', kind: 'forest', score: 0, left: 72, top: 62 },
  { name: '酒馆民居 3', kind: 'house', score: 1, left: 70, top: 75 },
  { name: '酒馆民居 4', kind: 'house', score: 1, left: 72, top: 87 },
  { name: '树林2', kind: 'forest', score: 0, left: 52, top: 95 },
  { name: '酒馆民居 5', kind: 'house', score: 2, left: 18, top: 91 },
  { name: '酒馆民居 6', kind: 'house', score: 2, left: 18, top: 79 },
  { name: '第1酒馆', kind: 'brewery', score: 0, brewery: 1, left: 15, top: 64 },
  { name: '第2酒馆', kind: 'brewery', score: 0, brewery: 2, left: 15, top: 48 },
  { name: '第3酒馆', kind: 'brewery', score: 0, brewery: 3, left: 15, top: 33 },
  { name: '树林3', kind: 'forest', score: 0, left: 32, top: 25 },
];

/** Gate effects are applied on entering the following location. */
export const cartGateBeforeLocation: Record<number, 'load' | 'deliver-one' | 'deliver-all'> = {
  1: 'load',
  9: 'deliver-one',
  10: 'deliver-one',
  11: 'deliver-all',
};

export function emptyExpansionPlayerBoard(): ExpansionPlayerBoard {
  const storage: (ExpansionCargo | null)[] = Array(REGULAR_STORAGE_SLOT_COUNT).fill(null);
  const storageUnlocked = Array(REGULAR_STORAGE_SLOT_COUNT).fill(false);
  BUILT_IN_STORAGE_SLOTS.forEach(slot => { storageUnlocked[slot] = true; });
  storage[4] = 'barrel';
  storage[8] = 'straw';
  return {
    storage,
    storageUnlocked,
    storageExtensions: Array(UNLOCKABLE_STORAGE_SLOTS.length).fill(null),
    temporaryStorage: null,
    cartBarrels: 0,
    cartPosition: 0,
    hutStoreTiles: Array(STORE_TILE_COUNT).fill(null),
    hutStoreUsed: Array(STORE_TILE_COUNT).fill(false),
    cartStepBonus: 0,
    breweryScores: [3, 4, 8],
    breweryUpgradeTiles: [null, null],
    breweryDeliveries: [0, 0, 0],
    deliveredBarrels: 0,
  };
}

/** Upgrade saves that used a sequential list of storage slots to the printed 10-slot layout. */
export function ensureExpansionStorageLayout(board: ExpansionPlayerBoard) {
  if (!Array.isArray(board.storageUnlocked)) {
    const legacy = board.storage ?? [];
    const storage: (ExpansionCargo | null)[] = Array(REGULAR_STORAGE_SLOT_COUNT).fill(null);
    const unlocked = Array(REGULAR_STORAGE_SLOT_COUNT).fill(false);
    BUILT_IN_STORAGE_SLOTS.forEach(slot => { unlocked[slot] = true; });
    storage[4] = legacy[0] ?? null;
    storage[8] = legacy[1] ?? null;
    const remaining = legacy.slice(2).filter((cargo): cargo is ExpansionCargo => cargo === 'barrel' || cargo === 'straw');
    const migrationSlots = [9, ...UNLOCKABLE_STORAGE_SLOTS];
    for (const cargo of remaining) {
      const slot = migrationSlots.find(index => storage[index] === null);
      if (slot === undefined) break;
      storage[slot] = cargo;
      if (!(BUILT_IN_STORAGE_SLOTS as readonly number[]).includes(slot)) unlocked[slot] = true;
    }
    board.storage = storage;
    board.storageUnlocked = unlocked;
    board.storageExtensions ??= UNLOCKABLE_STORAGE_SLOTS.map(slot => unlocked[slot] ? { kind: 'storage' } : null);
    return;
  }
  board.storage ??= Array(REGULAR_STORAGE_SLOT_COUNT).fill(null);
  while (board.storage.length < REGULAR_STORAGE_SLOT_COUNT) board.storage.push(null);
  board.storageUnlocked.length = REGULAR_STORAGE_SLOT_COUNT;
  UNLOCKABLE_STORAGE_SLOTS.forEach(slot => { board.storageUnlocked[slot] ??= false; });
  BUILT_IN_STORAGE_SLOTS.forEach(slot => { board.storageUnlocked[slot] = true; });
  if (!Array.isArray(board.storageExtensions)) {
    board.storageExtensions = UNLOCKABLE_STORAGE_SLOTS.map(slot => board.storageUnlocked[slot] ? { kind: 'storage' } : null);
  }
  board.storageExtensions = Array.from({ length: UNLOCKABLE_STORAGE_SLOTS.length }, (_, index) => board.storageExtensions[index] ?? null);
  board.storageExtensions.forEach((extension, extensionIndex) => {
    const slot = UNLOCKABLE_STORAGE_SLOTS[extensionIndex];
    if (extension?.kind === 'storage') board.storageUnlocked[slot] = true;
    if (extension?.kind === 'effect') board.storageUnlocked[slot] = false;
  });
}

/**
 * Place one cargo token every cart-die value, clockwise. The source space is
 * step zero, so a die roll of 1 places the token on the next space.
 * Repeated placements on one action space are kept as separate cargo tokens.
 */
export function seedRoundCargo(
  cargoByTrackSpace: ExpansionCargo[][],
  startSpace: number,
  dieValue: number,
  barrelCount = CARGO_PER_TYPE_PER_ROUND,
  strawCount = CARGO_PER_TYPE_PER_ROUND,
) {
  const routeLength = cargoByTrackSpace.length;
  if (!routeLength || dieValue < 1 || !Number.isInteger(dieValue)) return;
  let cursor = startSpace;
  const addBatch = (kind: ExpansionCargo, count: number) => {
    for (let i = 0; i < count; i++) {
      for (let step = 0; step < dieValue; step++) cursor = (cursor + 1) % routeLength;
      cargoByTrackSpace[cursor].push(kind);
    }
  };
  addBatch('barrel', barrelCount);
  addBatch('straw', strawCount);
}

export function createExpansionState(playerCount: number, trackSpaceCount: number): ExpansionState {
  const cargoByTrackSpace = Array.from({ length: trackSpaceCount }, () => [] as ExpansionCargo[]);
  return {
    cargoByTrackSpace,
    barrelSupply: INITIAL_BARREL_SUPPLY,
    strawSupply: INITIAL_STRAW_SUPPLY,
    cartDieSpace: -1,
    cartDieValue: 0,
    cartDieWrappedThisRound: false,
    turnEndDieStopPlayer: null,
    cartMovement: null,
    players: Array.from({ length: playerCount }, emptyExpansionPlayerBoard),
    storeSetupReady: Array(playerCount).fill(false),
    storePrompts: [],
  };
}

/** Set the first-round die and cargo only after all players finish expansion setup. */
export function initializeFirstExpansionRound(expansion: ExpansionState, startSpace: number, dieValue: number) {
  const routeLength = expansion.cargoByTrackSpace.length;
  if (!routeLength || !Number.isInteger(dieValue) || dieValue < 1) return;
  let dieSpace = startSpace;
  for (let step = 0; step < dieValue; step++) dieSpace = (dieSpace + 1) % routeLength;
  expansion.cartDieSpace = dieSpace;
  expansion.cartDieValue = dieValue;
  expansion.cartDieWrappedThisRound = false;
  const barrels = Math.min(CARGO_PER_TYPE_PER_ROUND, expansion.barrelSupply);
  const straw = Math.min(CARGO_PER_TYPE_PER_ROUND, expansion.strawSupply);
  seedRoundCargo(expansion.cargoByTrackSpace, dieSpace, dieValue, barrels, straw);
  expansion.barrelSupply -= barrels;
  expansion.strawSupply -= straw;
}

export function getExpansionResourceCounts(board: { tile?: { resource?: Resource } }[]) {
  const counts: Record<Resource, number> = { wood: 0, yeast: 0, hops: 0, water: 0, barley: 0 };
  board.forEach(cell => { if (cell.tile?.resource) counts[cell.tile.resource]++; });
  return counts;
}

export function emptyExpansionStorageSlots(board: ExpansionPlayerBoard) {
  return board.storage.flatMap((cargo, index) => cargo === null && board.storageUnlocked?.[index] ? [index] : []);
}

export function canStoreExpansionCargo(board: ExpansionPlayerBoard, coins: number) {
  return emptyExpansionStorageSlots(board).length > 0 || (!board.temporaryStorage && coins >= TEMPORARY_STORAGE_COST);
}

export function storedCargoCount(board: ExpansionPlayerBoard, kind: ExpansionCargo) {
  return board.storage.filter(cargo => cargo === kind).length + Number(board.temporaryStorage === kind);
}

export function maximumCartLoad(board: ExpansionPlayerBoard) {
  return Math.min(storedCargoCount(board, 'barrel'), storedCargoCount(board, 'straw'));
}

export function simulateCartMove(board: ExpansionPlayerBoard, startPosition: number, steps: number, loadCount: number) {
  let position = startPosition, barrels = board.cartBarrels, remaining = steps, stoppedAtLoadGate = false, loaded = false;
  if (!Number.isInteger(loadCount) || loadCount < 0 || loadCount > maximumCartLoad(board)) return null;
  while (remaining > 0) {
    const next = (position + 1) % cartRoute.length;
    const gate = cartGateBeforeLocation[next];
    if (gate === 'load') {
      if (loadCount === 0) { position = 0; stoppedAtLoadGate = true; remaining = 0; break; }
      barrels += loadCount; loadCount = 0; loaded = true;
    } else if (gate === 'deliver-one') {
      if (barrels > 0) barrels--;
    } else if (gate === 'deliver-all') {
      barrels = 0;
    }
    position = next;
    remaining--;
  }
  if (loadCount > 0 && !loaded) return null;
  return { position, barrels, stoppedAtLoadGate };
}

export function validCartLoadChoices(board: ExpansionPlayerBoard, steps: number) {
  const max = maximumCartLoad(board), choices: number[] = [];
  for (let load = 0; load <= max; load++) {
    const result = simulateCartMove(board, board.cartPosition, steps, load);
    // If the cart is already at the monastery gate, declining to load leaves
    // it exactly where it started. That is not a completed cart action and
    // must not make the die space a legal substitute for a base action.
    if (result && !(load === 0 && result.stoppedAtLoadGate && result.position === board.cartPosition)) choices.push(load);
  }
  return choices;
}

export function removeStoredCargo(board: ExpansionPlayerBoard, kind: ExpansionCargo, count: number) {
  let remaining = count;
  for (let i = 0; i < board.storage.length && remaining > 0; i++) {
    if (board.storage[i] !== kind) continue;
    board.storage[i] = null; remaining--;
  }
  if (remaining > 0 && board.temporaryStorage === kind) { board.temporaryStorage = null; remaining--; }
  return count - remaining;
}
