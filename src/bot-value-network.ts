import { gardenCells, monkNames, resources, shedProductionProgress, type AleState, type Resource } from './game';
import { botValueModel } from './bot-value-model';

export type BotValueModel = {
  version: 1;
  inputSize: number;
  hiddenSize: number;
  inputWeights: readonly number[];
  inputBias: readonly number[];
  outputWeights: readonly number[];
  outputBias: number;
  blend: number;
  validationImprovement: number;
  trainingGames: number;
};

const activeModel = botValueModel as BotValueModel | null;
const featureNeighbors = gardenCells.map((cell, index) => gardenCells.flatMap((other, otherIndex) => {
  if (otherIndex === index || Math.abs(other.row - cell.row) > 1) return [];
  const dx = Math.abs(other.x - cell.x), dz = Math.abs(other.z - cell.z);
  return (dz < .05 && Math.abs(dx - 1.77) < .12) || (dz > 1.4 && dz < 1.65 && Math.abs(dx - .88) < .12) ? [otherIndex] : [];
}));
const unit = (value: number, scale = 1) => Math.max(-1, Math.min(1, value / scale));
export const BOT_VALUE_FEATURE_COUNT = 91;

/** Stable, public-state-only features for both training and browser inference. */
export function extractBotValueFeatures(G: AleState, playerIndex: number, heuristicValue: number): number[] {
  const p = G.players[playerIndex];
  if (!p) return Array(BOT_VALUE_FEATURE_COUNT).fill(0);
  const features: number[] = [];
  const add = (value: number, scale = 1) => features.push(unit(value, scale));
  const tracks = resources.map(resource => p.tracks[resource]);
  const board = p.board;
  const tiles = board.map(cell => cell.tile);
  const placed = tiles.filter(Boolean);
  const playerScores = G.players.map((other, index) => index === playerIndex ? 0 : other.tracks.wood + other.tracks.yeast + other.tracks.hops + other.tracks.water + other.tracks.barley);
  const otherAverage = playerScores.length ? playerScores.reduce((sum, value) => sum + value, 0) / playerScores.length : 0;

  add(G.round, Math.max(1, G.maxRounds));
  add(G.maxRounds - G.round, Math.max(1, G.maxRounds));
  add(p.position, Math.max(1, G.track.length));
  add(p.coins, 36);
  add(p.brewer, 20);
  for (const value of tracks) add(value, 20);
  add(Math.min(...tracks), 20);
  add(tracks.reduce((sum, value) => sum + value, 0) / tracks.length, 20);
  add(Math.max(...tracks) - Math.min(...tracks), 20);
  add(otherAverage - tracks.reduce((sum, value) => sum + value, 0) / tracks.length, 20);
  add(p.scores.x === undefined ? 0 : 1);
  add(p.scores.resource.filter(Boolean).length, resources.length);
  add(p.scores.monk.filter(Boolean).length, monkNames.length);
  add((p.scores.x !== undefined ? 1 : 0) + p.scores.resource.filter(Boolean).length + p.scores.monk.filter(Boolean).length, 10);

  for (const resource of resources) {
    const matching = tiles.flatMap((tile, index) => tile?.resource === resource ? [{ tile, index }] : []);
    add(matching.filter(({ index }) => gardenCells[index].side === 'sun').length, 6);
    add(matching.filter(({ index }) => gardenCells[index].side === 'shade').length, 6);
  }
  for (const resource of resources) {
    const matching = tiles.flatMap((tile, index) => tile?.resource === resource ? [{ tile, index }] : []);
    add(matching.filter(({ index }) => gardenCells[index].side === 'sun').reduce((sum, item) => sum + item.tile!.value, 0), 24);
    add(matching.filter(({ index }) => gardenCells[index].side === 'shade').reduce((sum, item) => sum + item.tile!.value, 0), 24);
  }
  for (const monk of monkNames) add(tiles.filter(tile => tile?.kind === 'monk' && tile.monk === monk).length, 6);
  add(placed.length, gardenCells.length);
  add(tiles.filter(tile => tile?.kind === 'resource').length, gardenCells.length);
  add(tiles.filter(tile => tile?.kind === 'monk').length, gardenCells.length);
  add(tiles.filter((tile, index) => tile && gardenCells[index].side === 'sun').length, gardenCells.length);
  add(tiles.filter((tile, index) => tile && gardenCells[index].side === 'shade').length, gardenCells.length);

  let activeResourceNeighbors = 0;
  for (let index = 0; index < tiles.length; index++) {
    const tile = tiles[index];
    if (tile?.kind !== 'monk') continue;
    const monkIndex = monkNames.indexOf(tile.monk as typeof monkNames[number]);
    if (monkIndex >= 0 && !p.scores.monk[monkIndex]) activeResourceNeighbors += featureNeighbors[index].filter(neighbor => tiles[neighbor]?.kind === 'resource').length;
  }
  add(activeResourceNeighbors, 20);
  add(tiles.filter(tile => tile?.kind === 'resource' && !p.scores.resource.includes(tile.resource as Resource)).length, 20);
  add(board.filter(cell => cell.hut && cell.completed).length, 8);
  let totalShedFill = 0, maxShedFill = 0, totalShedYield = 0;
  for (let index = 0; index < board.length; index++) {
    if (!board[index].hut || board[index].completed) continue;
    const progress = shedProductionProgress(board, index);
    totalShedFill += progress.filled;
    maxShedFill = Math.max(maxShedFill, progress.filled);
    totalShedYield += progress.value;
  }
  add(totalShedFill, 48);
  add(maxShedFill, 6);
  add(totalShedYield, 100);

  add(p.privileges.length, 5);
  for (const card of ['A', 'B', 'C', 'D', 'E']) add(p.privileges.includes(card) ? 1 : 0, 1);
  for (const card of ['A', 'B', 'C', 'D', 'E']) add(p.privilegePairs.includes(card) ? 1 : 0, 1);
  add(p.claimedBarrels.filter(barrel => barrel.size === 'large').length, 7);
  add(p.claimedBarrels.filter(barrel => barrel.size === 'small').length, 7);
  add(p.retired ? 1 : 0);
  add(p.startSlot === 0 ? 1 : 0);
  add(heuristicValue, 100);

  const expansion = G.expansion?.players[playerIndex];
  add(expansion?.cartPosition ?? 0, 27);
  add(expansion?.cartBarrels ?? 0, 12);
  add(expansion?.deliveredBarrels ?? 0, 12);
  add(expansion?.breweryDeliveries.reduce((sum, value) => sum + value, 0) ?? 0, 12);
  add(expansion?.storageExtensions.filter(extension => extension !== null).length ?? 0, 7);
  add(expansion?.storageExtensions.filter(extension => extension?.kind === 'effect').length ?? 0, 7);
  add(expansion?.breweryScores.reduce((sum, value) => sum + value, 0) ?? 0, 24);
  add((expansion?.storage.filter(cargo => cargo === 'barrel').length ?? 0) + (expansion?.temporaryStorage === 'barrel' ? 1 : 0), 10);
  add((expansion?.storage.filter(cargo => cargo === 'straw').length ?? 0) + (expansion?.temporaryStorage === 'straw' ? 1 : 0), 10);
  add(expansion?.temporaryStorage ? 1 : 0);
  add(expansion?.cartStepBonus ?? 0, 6);
  add(expansion?.cartPosition ? 27 - expansion.cartPosition : 0, 27);
  add(G.expansion?.cartDieValue ?? 0, 6);
  add(G.expansionEnabled ? 1 : 0);

  // Opponent context lets the network learn that denying a scarce space or
  // winning a race for a barrel changes value even when own assets are equal.
  const opponents = G.players.filter((_, index) => index !== playerIndex);
  add(opponents.reduce((sum, other) => sum + other.coins, 0) / Math.max(1, opponents.length), 36);
  add(Math.max(0, ...opponents.map(other => other.brewer)), 20);
  add(Math.max(0, ...opponents.map(other => other.claimedBarrels.length)), 13);
  add(opponents.filter(other => other.retired).length, 3);
  add(G.resources.reduce((sum, pile) => sum + pile.length, 0), 40);
  add(G.monks.reduce((sum, pile) => sum + pile.length, 0), 40);
  add(G.scores.reduce((sum, count) => sum + count, 0), 6);
  add(G.track.filter(space => space.type === 'resource' || space.type === 'monk' || space.type === 'score').filter((space, index) => index > p.position).length, G.track.length);

  return features;
}

export function predictBotValueCorrection(features: number[]): number {
  const model = activeModel;
  if (!model || model.version !== 1 || model.inputSize !== features.length || model.hiddenSize < 1 || model.blend <= 0) return 0;
  let output = model.outputBias;
  for (let hidden = 0; hidden < model.hiddenSize; hidden++) {
    let activation = model.inputBias[hidden];
    const offset = hidden * model.inputSize;
    for (let input = 0; input < model.inputSize; input++) activation += model.inputWeights[offset + input] * features[input];
    output += model.outputWeights[hidden] * Math.tanh(activation);
  }
  return Math.max(-24, Math.min(24, output * model.blend));
}

export function getActiveBotValueModel() { return activeModel; }
