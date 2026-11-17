import { strict as assert } from 'node:assert';
import { InitializeGame } from 'boardgame.io/internal';
import { HeavenAle, gardenCells } from '../src/game';
import { chooseBotMove } from '../src/bot';
import { createExpansionState } from '../src/expansion';

const game = { ...HeavenAle, setup: (args: any) => HeavenAle.setup!(args, { expansionEnabled: true }) };
const hutIndexes = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
function setupPlan(coins: number) {
  const state: any = InitializeGame({ game, numPlayers: 2, seed: 'expansion-store-plan' });
  const G = structuredClone(state.G);
  G.setupStage = 'expansion-stores'; G.confirmationKind = null;
  G.players[0].coins = coins;
  const board = G.expansion.players[0], order: number[] = [];
  for (let i = 0; i < 7; i++) {
    const move = chooseBotMove(G, '0', 'expert');
    assert.equal(move?.name, 'assignExpansionStoreTile');
    const [hut, tile] = move!.args as number[];
    board.hutStoreTiles[hutIndexes.indexOf(hut)] = tile;
    order.push(tile);
  }
  assert.equal(new Set(order).size, 7);
  return order;
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

assert.equal(new Set(setupPlan(4)).size, 7);
assert.equal(new Set(setupPlan(20)).size, 7);
assert.deepEqual(cargoChoice(4), { name: 'finishExpansionCargo', args: [] });
assert.deepEqual(cargoChoice(20), { name: 'takeExpansionCargo', args: ['straw', -1] });
console.log('Expansion bot setup assigns all seven unique tiles.');
console.log('Cargo selection respects the 4-coin cost and takes straw when it completes a barrel/straw pair.');
