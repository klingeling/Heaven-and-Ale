import { strict as assert } from 'node:assert';
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import { HeavenAle } from '../src/game';
import { chooseBotMove } from '../src/bot';
import { createExpansionState } from '../src/expansion';

const game = { ...HeavenAle, setup: (args: any) => HeavenAle.setup!(args, { expansionEnabled: true }) };
const reducer = CreateGameReducer({ game, isClient: false });
function setupPlan(coins: number) {
  const state: any = InitializeGame({ game, numPlayers: 2, seed: 'expansion-store-plan' });
  const G = structuredClone(state.G);
  G.setupStage = 'expansion-stores'; G.confirmationKind = null;
  const playerID = String(state.ctx.currentPlayer);
  G.players[Number(playerID)].coins = coins;
  const move = chooseBotMove(G, playerID, 'expert');
  assert.equal(move?.name, 'assignExpansionStoreLayout');
  const [layout] = move!.args as [number[]];
  assert.equal(layout.length, 7);
  assert.equal(new Set(layout).size, 7);
  const next = reducer({ ...state, G }, { type: 'MAKE_MOVE', payload: { type: move!.name, args: move!.args, playerID } });
  assert.deepEqual(next.G.expansion.storeSetupReady[Number(playerID)], true);
  assert.equal(next.G.confirmationKind, 'setup');
  return layout;
}

function cargoChoice(coins: number) {
  const state: any = InitializeGame({ game, numPlayers: 2, seed: `cargo-choice-${coins}` });
  const G = structuredClone(state.G), player = G.players[0];
  G.phase = 'play'; G.setupStage = null; G.confirmationKind = null;
  player.coins = coins;
  G.expansion = createExpansionState(2, G.track.length); G.expansionEnabled = true;
  const board = G.expansion.players[0];
  board.storageUnlocked = Array(10).fill(true);
  board.storage = Array(10).fill('barrel');
  board.storage[4] = 'straw';
  board.temporaryStorage = null;
  G.expansion.cargoByTrackSpace[5] = ['barrel', 'straw'];
  G.pending = { space: 5, type: 'resource', player: '0', baseDone: true, cargoDone: false, cartDone: true, cargoTaken: 1, actionsDone: 0 };
  return chooseBotMove(G, '0', 'expert');
}

function batchCargoChoice() {
  const state: any = InitializeGame({ game, numPlayers: 2, seed: 'cargo-batch-choice' });
  const G = structuredClone(state.G);
  G.phase = 'play'; G.setupStage = null; G.confirmationKind = null;
  G.expansion = createExpansionState(2, G.track.length); G.expansionEnabled = true;
  G.expansion.cargoByTrackSpace[5] = ['barrel', 'straw'];
  G.pending = { space: 5, type: 'resource', player: '0', baseDone: true, cargoDone: false, cartDone: true, actionsDone: 0 };
  return chooseBotMove(G, '0', 'expert');
}

const lowCashLayout = setupPlan(4), highCashLayout = setupPlan(20);
assert.equal(new Set(lowCashLayout).size, 7);
assert.equal(new Set(highCashLayout).size, 7);
assert.deepEqual(cargoChoice(4), { name: 'finishExpansionCargo', args: [] });
assert.deepEqual(cargoChoice(20), { name: 'takeExpansionCargo', args: ['straw', -1] });
assert.equal(batchCargoChoice()?.name, 'takeExpansionCargoBatch');
console.log('Expansion bot submits one complete, unique seven-tile layout.');
console.log('Cargo selection respects the 4-coin cost, chooses useful pairs, and batches multi-item pickups.');
