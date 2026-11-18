import {
  availableBarrelIds, canBuyFrom, canMoveTo, canScore, canTakeExpansionCargo, canUseExpansionCart, gardenCells, lowestResources,
  monkNames, resources, scoreBreakdown, scoreChoices, shedProductionProgress, tileBaseCost,
  validShedSelection, type AleState, type PlayerState, type Resource, type ShedChoice, type Tile,
} from './game';
import { STORAGE_UNLOCK_ORDER, UNLOCKABLE_STORAGE_SLOTS, cartGateBeforeLocation, cartRoute, emptyExpansionStorageSlots, storedCargoCount, validCartLoadChoices, type ExpansionCargo, type ExpansionPlayerBoard } from './expansion';
import { extractBotValueFeatures, getActiveBotValueModel, predictBotValueCorrection, type BotValueModel } from './bot-value-network';

export type BotDifficulty = 'normal' | 'expert';
export type BotMove = { name: string; args: unknown[] };

const neighborCache = new Map<number, number[]>();
const neighbors = (index: number): number[] => {
  const cached = neighborCache.get(index); if (cached) return cached;
  const result = gardenCells.flatMap((spot, j) => {
  if (j === index || Math.abs(spot.row - gardenCells[index].row) > 1) return [];
  const dx = Math.abs(spot.x - gardenCells[index].x), dz = Math.abs(spot.z - gardenCells[index].z);
  return (dz < .05 && Math.abs(dx - 1.77) < .12) || (dz > 1.4 && dz < 1.65 && Math.abs(dx - .88) < .12) ? [j] : [];
  });
  neighborCache.set(index,result); return result;
};

function clonePlayer(p: PlayerState): PlayerState { return JSON.parse(JSON.stringify(p)) as PlayerState; }
function brewerRate(brewer: number) {
  if (brewer >= 20) return { vp: 6, exchange: 1 };
  if (brewer >= 18) return { vp: 6, exchange: 2 };
  if (brewer >= 15) return { vp: 5, exchange: 2 };
  if (brewer >= 12) return { vp: 4, exchange: 2 };
  if (brewer >= 9) return { vp: 4, exchange: 3 };
  if (brewer >= 5) return { vp: 3, exchange: 3 };
  if (brewer >= 1) return { vp: 3, exchange: 4 };
  return { vp: 2, exchange: 5 };
}
function advanceTrack(p: PlayerState, resource: Resource, steps: number) {
  for (let n = 0; n < steps; n++) {
    if (p.tracks[resource] >= 20) p.coins++;
    else p.tracks[resource]++;
  }
}
function activate(p: PlayerState, tile: Tile, side?: 'sun' | 'shade') {
  if (tile.kind === 'monk') p.brewer = Math.min(20, p.brewer + 1);
  else if (side === 'sun') advanceTrack(p, tile.resource!, tile.value);
  else p.coins += tile.value;
}
function evaluate(p: PlayerState, round: number, maxRounds: number) {
  const actual = scoreBreakdown(p);
  const future = clonePlayer(p);
  const remaining = Math.max(0, maxRounds - round);
  let engine = 0, shedProgress = 0;
  p.board.forEach((cell, index) => {
    const tile = cell.tile;
    if (!tile) return;
    if (tile.resource) {
      const colorReady = !p.scores.resource.includes(tile.resource);
      const valueReady = p.scores.x === undefined;
      const monks = neighbors(index).filter(i => {
        const monk = p.board[i].tile;
        return monk?.kind === 'monk' && !p.scores.monk[monkNames.indexOf(monk.monk!)];
      }).length;
      const activations = (colorReady ? .65 : 0) + (valueReady ? .25 : 0) + monks * .6;
      if (cell.side === 'sun') future.tracks[tile.resource] = Math.min(20, future.tracks[tile.resource] + tile.value * activations);
      else future.coins += tile.value * activations;
      // Cash scarcity is already reflected by the nonlinear coin term below;
      // making shade-tile engine value shrink as current cash rises can make
      // the evaluator claim that gaining a coin is harmful.
      engine += tile.value * activations * (cell.side === 'sun' ? .28 : .35);
    } else {
      const linked = neighbors(index).filter(i => !!p.board[i].tile).length;
      if (!p.scores.monk[monkNames.indexOf(tile.monk!)]) engine += linked * .45;
    }
  });
  p.board.forEach((cell,index) => {
    if (!cell.hut || cell.completed) return;
    const progress = shedProductionProgress(p.board,index);
    if (!progress.filled) return;
    // Concentrating placements around a shed has increasing value.
    const fraction = progress.filled / 6;
    shedProgress += fraction * fraction * 3.5;
    const expectedValue = progress.value * 6 / progress.filled;
    const brewerSteps = expectedValue <= 7 ? 6 : expectedValue <= 11 ? 3 : expectedValue <= 23 ? 1 : 0;
    future.brewer = Math.min(20, future.brewer + brewerSteps * fraction * fraction);
  });
  resources.forEach(r => future.tracks[r] = Math.round(future.tracks[r]));
  future.brewer = Math.round(future.brewer); future.coins = Math.floor(future.coins);
  const projected = scoreBreakdown(future);
  // A smooth penalty below the scoring track avoids treating all zero-score
  // positions as equal. All terms use victory-point-sized units.
  const shortfall = Math.min(0, actual.minResource) * actual.victoryPoints * .55;
  const progress = resources.reduce((sum,r) => sum + p.tracks[r] + 9, 0) * .12;
  // Continuous, diminishing cash value: spending 12 down to 11 must never
  // create an artificial reward. The first coins keep the engine running.
  const cash = (Math.min(p.coins,8)*.9 + Math.min(Math.max(0,p.coins-8),10)*.65
    + Math.min(Math.max(0,p.coins-18),10)*.3 + Math.max(0,p.coins-28)*.08) * (.7 + remaining*.22);
  const brewer = (p.brewer + 9) * .48;
  return actual.total + shortfall + Math.max(0, projected.total - actual.total) * .6
    + engine + shedProgress + progress + cash + brewer;
}

function activationValue(p: PlayerState, tile: Tile, side: 'sun' | 'shade' | undefined, round: number, maxRounds: number) {
  const next = clonePlayer(p), before = evaluate(p, round, maxRounds);
  activate(next, tile, side);
  return evaluate(next, round, maxRounds) - before;
}
function bestTrackResource(p: PlayerState, candidates: Resource[], steps: number, round: number, maxRounds: number) {
  return [...candidates].sort((a, b) => {
    const score = (resource: Resource) => {
      const next = clonePlayer(p), before = evaluate(p, round, maxRounds);
      advanceTrack(next, resource, steps);
      return evaluate(next, round, maxRounds) - before;
    };
    return score(b) - score(a);
  })[0];
}
function scoreDiscCount(p: PlayerState) {
  return (p.scores.x !== undefined ? 1 : 0) + p.scores.resource.filter(Boolean).length + p.scores.monk.filter(Boolean).length;
}
function shedCompletionValue(p: PlayerState, boardIndex: number, round: number, maxRounds: number) {
  const neighborsOfHut = gardenCells.flatMap((spot, i) => spot.hut && neighbors(i).includes(boardIndex) ? [i] : []);
  let bonus = 0;
  for (const hutIndex of neighborsOfHut) {
    const hut = p.board[hutIndex];
    if (hut.completed) continue;
    const cells = neighbors(hutIndex);
    if (cells.length !== 6 || !cells.every(i => p.board[i].tile)) continue;
    const value = cells.reduce((sum, i) => sum + (p.board[i].tile?.resource ? p.board[i].tile!.value : 0), 0);
    const range = value <= 7 ? 0 : value <= 11 ? 1 : value <= 17 ? 2 : value <= 23 ? 3 : 4;
    const brewerAdvance = range === 0 ? 6 : range === 1 ? 3 : range <= 3 ? 1 : 0;
    const activateCount = range === 0 ? 0 : range === 1 ? 1 : range === 2 ? 2 : range === 3 ? 3 : 4;
    const before = evaluate(p, round, maxRounds), after = clonePlayer(p);
    after.brewer = Math.min(20, after.brewer + brewerAdvance);
    after.board[hutIndex].completed = true;
    bonus += evaluate(after, round, maxRounds) - before;
    const activations = cells.map(i => {
      const tile = p.board[i].tile!;
      return activationValue(p, tile, p.board[i].side, round, maxRounds);
    }).sort((a, b) => b - a);
    bonus += activations.slice(0, activateCount).reduce((sum, value) => sum + value * .58, 0);
  }
  return bonus;
}

function placementCandidates(G: AleState, p: PlayerState, tile: Tile, sourceIndex: number, difficulty: BotDifficulty) {
  const before = evaluate(p, G.round, G.maxRounds);
  return gardenCells.flatMap((spot, index) => {
    if (spot.hut || !spot.side || p.board[index]?.tile) return [];
    const side = spot.side, cost = tileBaseCost(tile, sourceIndex) * (side === 'sun' ? 2 : 1);
    if (cost > p.coins) return [];
    const next = clonePlayer(p);
    next.coins -= cost;
    next.board[index].tile = tile;
    next.board[index].side = side;
    let score = evaluate(next, G.round, G.maxRounds) - before;
    const futureWeight = .16 + Math.min(.18, (G.maxRounds - G.round) * .035);
    score += activationValue(next, tile, side, G.round, G.maxRounds) * futureWeight;
    score += shedCompletionValue(next, index, G.round, G.maxRounds);
    if (tile.kind === 'monk') {
      const linked = neighbors(index).filter(i => !!p.board[i].tile);
      score += linked.reduce((sum, i) => sum + activationValue(p, p.board[i].tile!, p.board[i].side, G.round, G.maxRounds), 0) * .18;
    }
    if (difficulty === 'normal') score += Math.random() * .16;
    return [{ index, score }];
  });
}

function liquidityPurchaseValue(G: AleState, p: PlayerState) {
  if (G.round > 2) return 0;
  const richer=clonePlayer(p); richer.coins += 12;
  const opportunities: { value:number; distance:number }[]=[];
  G.track.forEach((space,index)=> {
    if(index<=p.position || (space.type!=='resource' && space.type!=='monk')) return;
    const source=space.sourceIndex ?? 0;
    const market=space.type==='resource'?G.resources[source] ?? []:G.monks[source] ?? [];
    const value=market.flatMap(tile=>placementCandidates(G,richer,tile,source,'expert').flatMap(place=> {
      const cost=tileBaseCost(tile,source)*(gardenCells[place.index].side==='sun'?2:1);
      return cost>p.coins && place.score>0?[place.score]:[];
    })).sort((a,b)=>b-a)[0];
    if(value) opportunities.push({value,distance:index-p.position});
  });
  opportunities.sort((a,b)=>b.value/(1+b.distance*.08)-a.value/(1+a.distance*.08));
  return opportunities.slice(0,2).reduce((sum,opportunity)=>sum+opportunity.value/(1+opportunity.distance*.08)*.8,0);
}

function bestScoreChoice(p: PlayerState, G: AleState, category: 'A' | 'B' | 'C', option: string | number, difficulty: BotDifficulty) {
  const before = evaluate(p, G.round, G.maxRounds), next = clonePlayer(p);
  const disc = category === 'A' ? 0 : category === 'C' ? 1 + resources.indexOf(option as Resource) : 6 + monkNames.indexOf(String(option));
  const pair = Math.floor(disc / 2), priorDiscs = new Set<number>();
  if (p.scores.x !== undefined) priorDiscs.add(0);
  p.scores.resource.forEach((r, i) => { if (r) priorDiscs.add(i + 1); });
  p.scores.monk.forEach((used, i) => { if (used) priorDiscs.add(i + 6); });
  if (category === 'A') next.scores.x = Number(option);
  else if (category === 'C') next.scores.resource[next.scores.resource.indexOf(null)] = option as Resource;
  else next.scores.monk[monkNames.indexOf(String(option))] = true;

  const trigger: { tile: Tile; side?: 'sun' | 'shade' }[] = [];
  next.board.forEach((cell, i) => {
    const tile = cell.tile;
    if (!tile) return;
    if (category === 'A' && tile.kind === 'resource' && tile.value === Number(option)) trigger.push({ tile, side: cell.side });
    if (category === 'C' && tile.resource === option) trigger.push({ tile, side: cell.side });
    if (category === 'B' && tile.kind === 'monk' && tile.monk === option) {
      neighbors(i).forEach(j => { const neighbor = next.board[j]; if (neighbor.tile) trigger.push({ tile: neighbor.tile, side: neighbor.side }); });
    }
  });
  trigger.forEach(item => activate(next, item.tile, item.side));

  let value = evaluate(next, G.round, G.maxRounds) - before;
  const pairWasCompleted = p.privilegePairs[pair] === null && priorDiscs.has(disc % 2 === 0 ? disc + 1 : disc - 1);
  if (pairWasCompleted && next.privileges.length) {
    value += Math.max(...next.privileges.map(card => privilegeGain(next, card, pair, G.round, G.maxRounds, G)));
  }
  return value + (difficulty === 'normal' ? Math.random() * .12 : .35);
}

function privilegeGain(p: PlayerState, card: string, pair: number, round: number, maxRounds: number, G?: AleState) {
  const before = evaluate(p, round, maxRounds), next = clonePlayer(p);
  let endgameValue = 0;
  next.privilegePairs[pair] = card;
  if (card === 'A') {
    const options = resources.map(resource => {
      const count = p.board.filter(c => c.tile?.resource === resource).length;
      const candidate = clonePlayer(p);
      advanceTrack(candidate, resource, count);
      return { resource, count, value: evaluate(candidate, round, maxRounds) };
    }).filter(x => x.count > 0);
    const choice = options.sort((a, b) => b.value - a.value)[0];
    if (!choice) return -Infinity;
    advanceTrack(next, choice.resource, choice.count);
  } else if (card === 'B') {
    const steps = p.scores.resource.filter(Boolean).length + p.scores.monk.filter(Boolean).length + (p.scores.x !== undefined ? 1 : 0);
    const lowest = [...lowestResources(p)].sort((a, b) => {
      const av = clonePlayer(next), bv = clonePlayer(next);
      advanceTrack(av, a, steps); advanceTrack(bv, b, steps);
      return evaluate(bv, round, maxRounds) - evaluate(av, round, maxRounds);
    })[0];
    if (lowest) advanceTrack(next, lowest, steps);
    // The one-time advance above is based on the purple markers present now.
  } else if (card === 'C') {
    // Its bonus is scored only at game end. Estimate expected barrels owned
    // then; do not treat this as a repeated turn-by-turn reward.
    const futureBarrels = G ? Math.min(G.barrels.filter(b => b.remaining > 0).length, Math.ceil((maxRounds - round) * .7)) : 0;
    endgameValue += futureBarrels * (round === 1 ? .72 : round === 2 ? .48 : .2);
  } else if (card === 'D') {
    next.coins += 12;
    if (G) {
      const seat = G.players.findIndex(player => player.color === p.color);
      const riskBefore = seat < 0 ? 0 : economyRisk(G, seat);
      const afterCash = { ...G, players: G.players.map((player, i) => i === seat ? next : player) };
      const riskAfter = seat < 0 ? 0 : economyRisk(afterCash, seat);
      // Immediate money matters most when it removes a near-term purchase
      // shortfall. The base evaluation alone smooths coins too aggressively.
      const urgency = Math.max(0, riskBefore - riskAfter);
      return evaluate(next, round, maxRounds) - before + urgency + liquidityPurchaseValue(G, p);
    }
  }
  else if (card === 'E') next.brewer = Math.min(20, next.brewer + 5);
  return evaluate(next, round, maxRounds) - before + endgameValue;
}

function bestScore(p: PlayerState, G: AleState, scoreType: 'A' | 'B' | 'C' | 'ABC', difficulty: BotDifficulty) {
  const categories = scoreType === 'ABC' ? ['A', 'B', 'C'] as const : [scoreType] as const;
  const options = categories.flatMap(category => scoreChoices(p, category).map(option => ({ category, option, value: bestScoreChoice(p, G, category, option, difficulty) })));
  options.sort((a, b) => b.value - a.value);
  return options[0];
}

function actionValue(G: AleState, p: PlayerState, index: number, difficulty: BotDifficulty) {
  const space = G.track[index];
  let extensionValue = 0;
  if (G.expansionEnabled && G.expansion) {
    const expansion = G.expansion, playerIndex = G.players.indexOf(p), board = expansion.players[playerIndex];
    const pile = expansion.cargoByTrackSpace[index] ?? [];
    if (canTakeExpansionCargo(G, p, index) && board) {
      extensionValue += planExpansionCargoCollection(G, p, board, pile).value;
    }
    if (board && expansion.cartDieSpace === index && validCartLoadChoices(board, expansion.cartDieValue + board.cartStepBonus).length)
      extensionValue += 2.2 + Math.min(3, board.cartBarrels + storedCargoCount(board, 'barrel')) * .8;
  }
  if (space.type === 'resource' || space.type === 'monk') {
    const market = space.type === 'resource' ? G.resources[space.sourceIndex ?? -1] || [] : G.monks[space.sourceIndex ?? -1] || [];
    if (!market.length || !canBuyFrom(p, market, space.sourceIndex)) return extensionValue > 0 ? extensionValue : null;
    const hypothetical = clonePlayer(p), supply = [...market];
    let total = 0, purchases = 0;
    while (supply.length) {
      const candidates = supply.flatMap(tile => placementCandidates(G, hypothetical, tile, space.sourceIndex ?? 0, difficulty)
        .map(place => ({ tile, ...place })));
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (!best || best.score <= 0) break;
      const spot = gardenCells[best.index], cost = tileBaseCost(best.tile, space.sourceIndex) * (spot.side === 'sun' ? 2 : 1);
      total += best.score * (purchases === 0 ? 1 : purchases === 1 ? .48 : .2);
      hypothetical.coins -= cost;
      hypothetical.board[best.index].tile = best.tile;
      hypothetical.board[best.index].side = spot.side;
      supply.splice(supply.findIndex(t => t.id === best.tile.id), 1);
      purchases++;
    }
    return purchases ? 1.15 + total + extensionValue : extensionValue > 0 ? extensionValue : null;
  }
  if (space.type === 'score') {
    if (!G.scores[space.sourceIndex ?? -1] || !canScore(p, space.scoreType)) return null;
    return 1.05 + (bestScore(p, G, space.scoreType || 'ABC', difficulty)?.value || 0) + Math.min(Math.max(0,12-p.coins),reachableIncome(G,p,index))*.35 + extensionValue;
  }
  if (space.type === 'barrel') {
    const ids = availableBarrelIds(G, p);
    if (!ids.length) return null;
    const points = ids.reduce((sum, id) => sum + ((G.barrels.find(b => b.id === id)?.remaining ?? 1) === 2 ? 4 : 2), 0);
    return 1.5 + points * .55 + extensionValue;
  }
  return space.type === 'start' ? -100 : extensionValue > 0 ? extensionValue : null;
}

function chooseShedGroup(choice: ShedChoice, p: PlayerState, G: AleState) {
  const size = choice.activateCount, groups: number[][] = [];
  const build = (start: number, picked: number[]) => {
    if (picked.length === size) {
      const trial = { ...choice, selected: picked };
      if (validShedSelection(trial) && choice.selected.every(i => picked.includes(i))) groups.push(picked);
      return;
    }
    for (let i = start; i < choice.candidates.length; i++) build(i + 1, [...picked, choice.candidates[i]]);
  };
  build(0, []);
  const best = groups.map(group => ({ group, value: group.reduce((sum, i) => {
    const tile = p.board[i].tile;
    return sum + (tile ? activationValue(p, tile, p.board[i].side, G.round, G.maxRounds) : -100);
  }, 0) })).sort((a, b) => b.value - a.value)[0]?.group;
  return best;
}

// During expansion setup, the robot plans the whole tile-to-hut allocation.
// Huts with more shade-side neighbours are cheaper to surround, so valuable
// effects are reserved for the huts the bot expects to complete earlier.
const storeTileValue: Record<number, number> = { 1: 2.7, 2: 3.5, 3: 3.1, 4: 3.8, 5: 2.8, 6: 3.5, 7: 3.2 };
const expansionHutIndices = gardenCells.flatMap((cell, index) => cell.hut ? [index] : []);
const hutAccessibilityCache = new Map<number, number>();
function hutSetupAccessibility(slot: number) {
  const cached = hutAccessibilityCache.get(slot);
  if (cached !== undefined) return cached;
  const hutIndex = expansionHutIndices[slot];
  if (hutIndex === undefined) return 0;
  const ring = neighbors(hutIndex);
  const shadeCount = ring.filter(index => gardenCells[index].side === 'shade').length;
  const sunCount = ring.filter(index => gardenCells[index].side === 'sun').length;
  const value = 1 + shadeCount * .09 - sunCount * .025;
  hutAccessibilityCache.set(slot, value);
  return value;
}
function planExpansionStoreLayout(G: AleState, playerIndex: number) {
  const board = G.expansion?.players[playerIndex];
  if (!board) return null;
  const emptySlots = board.hutStoreTiles.flatMap((tile, slot) => tile === null ? [slot] : []);
  const remainingTiles = Array.from({ length: 7 }, (_, index) => index + 1).filter(tile => !board.hutStoreTiles.includes(tile));
  if (emptySlots.length !== 7 || remainingTiles.length !== 7) return null;
  const player = G.players[playerIndex];
  const publicMarketKey = G.resources.flatMap(pile => pile.map(tile => tile.id)).slice(0, 18).join('|');
  const variationSeed = `${publicMarketKey}:${playerIndex}:${player.startSlot ?? -1}:${G.startPlayer}`;
  const stableNoise = (value: string) => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return ((hash >>> 0) / 0xffffffff - .5) * .34;
  };
  const tilePriority = (tileId: number) => {
    const frontValue = storeTileSetupFrontValue(G, player, board, tileId);
    const backValue = board.storageExtensions.some(extension => extension === null) ? storageExpansionValue(G, player, board) : -Infinity;
    // Give priority to the stronger actual use of each tile instead of mostly
    // following the old fixed ranking. A small public-state keyed tie break
    // keeps equally good openings from always looking like the same script.
    const optionValue = Math.max(frontValue, backValue);
    const dynamicValue = Number.isFinite(optionValue) ? optionValue : 0;
    return dynamicValue + storeTileValue[tileId] * .24 + stableNoise(`${variationSeed}:tile:${tileId}`);
  };
  const slots = [...emptySlots].sort((a, b) => {
    const aScore = hutSetupAccessibility(a) + stableNoise(`${variationSeed}:hut:${a}`) * .18;
    const bScore = hutSetupAccessibility(b) + stableNoise(`${variationSeed}:hut:${b}`) * .18;
    return bScore - aScore || a - b;
  });
  const tiles = [...remainingTiles].sort((a, b) => tilePriority(b) - tilePriority(a) || a - b);
  const layout = Array(7).fill(0);
  slots.forEach((slot, index) => { layout[slot] = tiles[index]; });
  return layout.every(tileId => tileId >= 1 && tileId <= 7) ? layout : null;
}
function expansionSetupPotential(G: AleState, playerIndex: number) {
  const board = G.expansion?.players[playerIndex];
  if (!board) return 0;
  const unspent = board.hutStoreTiles.flatMap((tile, slot) => tile !== null && !board.hutStoreUsed[slot] ? [storeTileValue[tile] * hutSetupAccessibility(slot)] : []);
  // The setup plan is most useful in the opening; fade this heuristic as huts
  // are consumed so it does not distort late-game score comparisons.
  const roundWeight = Math.max(.08, 1 - (G.round - 1) / Math.max(1, G.maxRounds));
  return unspent.reduce((sum, value) => sum + value, 0) * .22 * roundWeight;
}

function cartMoveValue(board: ExpansionPlayerBoard, steps: number, loadCount: number) {
  const initiallyLoaded = loadCount;
  let position = board.cartPosition, cartBarrels = board.cartBarrels, remaining = steps, deliveredScore = 0;
  const startingCartValue = cartBarrels * (cartRoute[position]?.score ?? 0);
  while (remaining > 0) {
    const next = (position + 1) % cartRoute.length;
    const gate = cartGateBeforeLocation[next];
    if (gate === 'load') {
      if (loadCount === 0) { position = 0; break; }
      cartBarrels += loadCount;
      loadCount = 0;
    } else if (gate === 'deliver-one' && cartBarrels > 0) {
      const brewery = (cartRoute[next].brewery ?? 1) - 1;
      cartBarrels--;
      deliveredScore += board.breweryScores[brewery];
    } else if (gate === 'deliver-all') {
      deliveredScore += cartBarrels * board.breweryScores[2];
      cartBarrels = 0;
    }
    position = next;
    remaining--;
  }
  // Loaded barrels turn stored inventory into delivery points; straw has a
  // modest opportunity cost because it is required to load on a later trip.
  const loadedCount = Math.min(initiallyLoaded, storedCargoCount(board, 'barrel'));
  return deliveredScore + cartBarrels * (cartRoute[position]?.score ?? 0) - startingCartValue
    - loadedCount * .5 - loadedCount * .45;
}

function bestCartMoveValue(G: AleState, board: ExpansionPlayerBoard, steps: number, choices = validCartLoadChoices(board, steps)) {
  return Math.max(-2, ...choices.map(load => cartMoveValue(board, steps, load)));
}

function futureBreweryDeliveries(G: AleState, board: ExpansionPlayerBoard) {
  const rounds = Math.max(0, G.maxRounds - G.round);
  const expectedTrips = rounds * .85 + .15;
  const canLoad = Math.max(storedCargoCount(board, 'barrel'), storedCargoCount(board, 'straw'), board.cartBarrels) > 0;
  return [
    expectedTrips * (canLoad ? .9 : .45),
    expectedTrips * (storedCargoCount(board, 'barrel') >= 2 && storedCargoCount(board, 'straw') >= 2 ? .7 : .4),
  ];
}

function storageExpansionValue(G: AleState, p: PlayerState, board: ExpansionPlayerBoard) {
  const free = emptyExpansionStorageSlots(board).length;
  const rounds = Math.max(0, G.maxRounds - G.round);
  const congestion = free === 0 ? 4.1 : free === 1 ? 3.3 : free === 2 ? 2.5 : free === 3 ? 1.7 : 1.1;
  const stockPressure = Math.max(0, storedCargoCount(board, 'barrel') + storedCargoCount(board, 'straw') - 1) * .35;
  return (congestion + stockPressure) * (.35 + .65 * rounds / Math.max(1, G.maxRounds - 1))
    + (p.coins < 8 ? .35 : 0);
}

function expansionCargoInventoryValue(G: AleState, board: ExpansionPlayerBoard) {
  const barrels = storedCargoCount(board, 'barrel'), straw = storedCargoCount(board, 'straw');
  const matchedPairs = Math.min(barrels, straw);
  const unpairedBarrels = barrels - matchedPairs, unpairedStraw = straw - matchedPairs;
  const remainingRounds = Math.max(0, G.maxRounds - G.round + 1);
  const deliveryChance = Math.min(.9, .3 + remainingRounds * .2);
  const averageDelivery = board.breweryScores.reduce((sum, score) => sum + score, 0) / board.breweryScores.length;
  return barrels * .5 + matchedPairs * averageDelivery * deliveryChance + unpairedBarrels * .45 + unpairedStraw * .3;
}

function expansionCargoPickupValue(G: AleState, p: PlayerState, board: ExpansionPlayerBoard, playerIndex: number, kind: ExpansionCargo, slot: number) {
  const before = expansionCargoInventoryValue(G, board);
  const nextBoard = { ...board, storage: [...board.storage] };
  if (slot === -1) {
    if (nextBoard.temporaryStorage || p.coins < 4) return -Infinity;
    nextBoard.temporaryStorage = kind;
  } else {
    if (nextBoard.storage[slot] !== null || !nextBoard.storageUnlocked[slot]) return -Infinity;
    nextBoard.storage[slot] = kind;
  }
  let value = expansionCargoInventoryValue(G, nextBoard) - before;
  if (slot === -1) {
    const afterCash = clonePlayer(p);
    afterCash.coins -= 4;
    const afterCashState = { ...G, players: G.players.map((player, index) => index === playerIndex ? afterCash : player) };
    value -= evaluate(p, G.round, G.maxRounds) - evaluate(afterCash, G.round, G.maxRounds);
    value -= economyRisk(afterCashState, playerIndex) - economyRisk(G, playerIndex);
  } else {
    const freeSlots = emptyExpansionStorageSlots(board).length;
    const futureWeight = Math.max(0, G.maxRounds - G.round + 1) / Math.max(1, G.maxRounds);
    value -= (freeSlots <= 1 ? .72 : freeSlots === 2 ? .36 : .12) * futureWeight;
  }
  return value;
}

function planExpansionCargoCollection(G: AleState, p: PlayerState, board: ExpansionPlayerBoard, pile: ExpansionCargo[]) {
  const simBoard = { ...board, storage: [...board.storage] }, simPlayer = clonePlayer(p), remaining = [...pile];
  const picks: { kind: ExpansionCargo; slot: number; value: number }[] = [];
  let totalValue = 0;
  for (let pick = 0; pick < 8 && remaining.length; pick++) {
    const regularSlots = emptyExpansionStorageSlots(simBoard);
    const destinations = [
      ...(regularSlots.length ? [regularSlots[0]] : []),
      ...(!simBoard.temporaryStorage && simPlayer.coins >= 4 ? [-1] : []),
    ];
    if (!destinations.length) break;
    const playerIndex = G.players.indexOf(p);
    const candidates = [...new Set(remaining)].flatMap(kind => destinations.map(slot => ({ kind, slot, value: expansionCargoPickupValue(G, simPlayer, simBoard, playerIndex, kind, slot) })));
    candidates.sort((a, b) => b.value - a.value || (a.kind === 'barrel' ? -1 : 1));
    const best = candidates[0];
    if (!best || best.value <= .05 && picks.length > 0) break;
    if (best.slot === -1) { simBoard.temporaryStorage = best.kind; simPlayer.coins -= 4; }
    else simBoard.storage[best.slot] = best.kind;
    remaining.splice(remaining.indexOf(best.kind), 1);
    picks.push(best); totalValue += best.value;
  }
  return { picks, value: totalValue };
}

function bestStoreTile7Front(G: AleState, p: PlayerState, board: ExpansionPlayerBoard) {
  const expansion = G.expansion;
  if (!expansion) return null;
  const regularSlots = emptyExpansionStorageSlots(board);
  const tempAvailable = !board.temporaryStorage && p.coins >= 4;
  const destinations = [...regularSlots.slice(0, 2)];
  if (destinations.length < 2 && tempAvailable) destinations.push(-1);
  const cargoKinds: ExpansionCargo[][] = [];
  if (expansion.barrelSupply > 0) cargoKinds.push(['barrel']);
  if (expansion.strawSupply > 0) cargoKinds.push(['straw']);
  if (expansion.barrelSupply > 0 && expansion.strawSupply > 0) cargoKinds.push(['barrel', 'straw']);
  let best: { cargo: ExpansionCargo[]; destinations: number[]; value: number } | null = null;
  for (const cargo of cargoKinds) {
    if (cargo.length > destinations.length) continue;
    const ordered = cargo.length === 2 && storedCargoCount(board, 'barrel') > storedCargoCount(board, 'straw') ? ['straw', 'barrel'] as ExpansionCargo[] : cargo;
    const assigned = ordered.map((_, index) => destinations[index]);
    const coinCost = assigned.filter(slot => slot === -1).length * 4;
    const barrelCount = storedCargoCount(board, 'barrel'), strawCount = storedCargoCount(board, 'straw');
    const value = ordered.reduce((sum, kind) => sum + (kind === 'barrel'
      ? 2.3 + (barrelCount < strawCount ? 1.1 : 0)
      : 2.3 + (strawCount < barrelCount ? 1.1 : 0)), 0)
      - coinCost * (p.coins < 8 ? .9 : p.coins < 14 ? .55 : .3);
    if (!best || value > best.value) best = { cargo: ordered, destinations: assigned, value };
  }
  return best;
}

function storeTileSetupFrontValue(G: AleState, p: PlayerState, board: ExpansionPlayerBoard, tileId: number) {
  const roundsLeft = Math.max(0, G.maxRounds - G.round);
  if (tileId === 1 || tileId === 2) {
    const bonus = tileId === 1 ? 2 : 3;
    let improvement = 0;
    for (let die = 1; die <= 6; die++) improvement += bestCartMoveValue(G, board, die + board.cartStepBonus + bonus) - bestCartMoveValue(G, board, die + board.cartStepBonus);
    return Math.max(0, improvement / 6) * (roundsLeft * .9 + .25);
  }
  if (tileId === 3 || tileId === 4) {
    const score = tileId === 3 ? 5 : 6;
    const deliveries = futureBreweryDeliveries(G, board);
    return Math.max(0, ...[0, 1].filter(index => board.breweryUpgradeTiles[index] === null).map(index => (score - board.breweryScores[index]) * deliveries[index]));
  }
  if (tileId === 5 || tileId === 6) {
    const steps = tileId === 5 ? 4 : 6;
    return Math.max(0, bestCartMoveValue(G, board, steps));
  }
  return tileId === 7 ? Math.max(0, bestStoreTile7Front(G, p, board)?.value ?? 0) : 0;
}

function chooseStoreTileUse(G: AleState, p: PlayerState, board: ExpansionPlayerBoard, tileId: number) {
  const extensionSlotAvailable = board.storageExtensions.some(extension => extension === null);
  const storageBackAvailable = STORAGE_UNLOCK_ORDER.some(slot => board.storageExtensions[UNLOCKABLE_STORAGE_SLOTS.indexOf(slot)] === null);
  const backValue = storageBackAvailable ? storageExpansionValue(G, p, board) : -Infinity;
  let frontValue = -Infinity, frontArgs: unknown[] = [];
  const remainingRounds = Math.max(0, G.maxRounds - G.round);
  if ((tileId === 1 || tileId === 2) && extensionSlotAvailable) {
    const bonus = tileId === 1 ? 2 : 3;
    let improvement = 0;
    for (let die = 1; die <= 6; die++) {
      improvement += bestCartMoveValue(G, board, die + board.cartStepBonus + bonus)
        - bestCartMoveValue(G, board, die + board.cartStepBonus);
    }
    frontValue = Math.max(.3, improvement / 6) * (remainingRounds * .9 + .25);
  } else if (tileId === 3 || tileId === 4) {
    const score = tileId === 3 ? 5 : 6;
    const targets = [0, 1].filter(index => board.breweryUpgradeTiles[index] === null);
    const deliveries = futureBreweryDeliveries(G, board);
    const target = targets.sort((a, b) => (score - board.breweryScores[b]) * deliveries[b] - (score - board.breweryScores[a]) * deliveries[a])[0];
    if (target !== undefined) {
      frontValue = (score - board.breweryScores[target]) * deliveries[target];
      frontArgs = [[], [], target];
    }
  } else if (tileId === 5 || tileId === 6) {
    const steps = tileId === 5 ? 4 : 6, choices = validCartLoadChoices(board, steps);
    if (choices.length) frontValue = bestCartMoveValue(G, board, steps, choices);
  } else if (tileId === 7) {
    const cargo = bestStoreTile7Front(G, p, board);
    if (cargo) { frontValue = cargo.value; frontArgs = [cargo.cargo, cargo.destinations]; }
  }
  if (frontValue > backValue) return { side: 'front' as const, args: frontArgs };
  if (storageBackAvailable) return { side: 'back' as const, args: [] };
  return frontValue > -Infinity ? { side: 'front' as const, args: frontArgs } : null;
}

export function chooseBotMove(G: AleState, currentPlayer: string, difficulty: BotDifficulty): BotMove | null {
  const player = G.players[Number(currentPlayer)];
  if (!player || G.phase === 'finished') return null;
  // Setup placements are rejected while the preceding start choice is awaiting confirmation.
  // Resolve confirmations first so expansion setup bots cannot repeatedly submit an ignored move.
  if (G.confirmationKind && !G.privilegePrompts.length) return { name: 'confirmAction', args: [] };
  if (G.phase === 'setup' && G.setupStage === 'expansion-stores' && G.expansion) {
    const board = G.expansion.players[Number(currentPlayer)];
    if (!board || G.expansion.storeSetupReady[Number(currentPlayer)]) return null;
    const layout = planExpansionStoreLayout(G, Number(currentPlayer));
    if (layout) return { name: 'assignExpansionStoreLayout', args: [layout] };
    return { name: 'finishExpansionStoreSetup', args: [] };
  }
  if (G.expansion?.storePrompts?.[0]?.playerIndex === Number(currentPlayer)) {
    const prompt = G.expansion.storePrompts[0], board = G.expansion.players[Number(currentPlayer)];
    const use = chooseStoreTileUse(G, player, board, prompt.tileId);
    if (!use) return null;
    return { name: 'resolveExpansionStore', args: [use.side, ...use.args] };
  }
  if (G.expansion?.cartMovement && G.expansion.cartMovement.nextLocation >= 0 && G.expansion.cartMovement.playerIndex === Number(currentPlayer)) {
    const movement = G.expansion.cartMovement, board = G.expansion.players[Number(currentPlayer)];
    if (!board) return null;
    const choices = movement.loadChoices;
    const load = [...choices].sort((a, b) => cartMoveValue(board, movement.remaining, b) - cartMoveValue(board, movement.remaining, a) || a - b)[0];
    return { name: 'chooseExpansionCartLoad', args: [load] };
  }
  if (G.pending?.player === currentPlayer && G.pending.baseDone && G.pending.cargoDone === false && G.expansion) {
    const board = G.expansion.players[Number(currentPlayer)], pile = G.expansion.cargoByTrackSpace[G.pending.space] ?? [];
    const canSkipCargo = (G.pending.cargoTaken ?? 0) > 0 || canUseExpansionCart(G, player, G.pending.space);
    const plan = planExpansionCargoCollection(G, player, board, pile);
    if (plan.picks.length && (!canSkipCargo || plan.value > .2)) {
      if (plan.picks.length > 1) return { name: 'takeExpansionCargoBatch', args: [plan.picks.map(({ kind, slot }) => ({ kind, storageSlot: slot }))] };
      const pick = plan.picks[0];
      if (pick) return { name: 'takeExpansionCargo', args: [pick.kind, pick.slot] };
    }
    return { name: 'finishExpansionCargo', args: [] };
  }
  if (G.pending?.player === currentPlayer && G.pending.baseDone && G.pending.cargoDone && G.pending.cartDone === false)
    return { name: 'useExpansionCart', args: [] };
  if (G.startChoice) {
    const resource = bestTrackResource(player, resources, 2, G.round, G.maxRounds);
    return { name: 'chooseStartResource', args: [resource] };
  }
  if (G.shedChoices.length) {
    const choice = G.shedChoices[0];
    if (validShedSelection(choice)) return { name: 'completeShedChoice', args: [] };
    const group = chooseShedGroup(choice, player, G);
    return group ? { name: 'completeShedChoice', args: [group] } : { name: 'completeShedChoice', args: [] };
  }
  if (G.privilegePrompts.length) {
    const prompt = G.privilegePrompts[0];
    if (prompt.playerIndex !== undefined && prompt.playerIndex !== Number(currentPlayer)) return null;
    const cards = player.privileges.filter(card => card !== 'A' || player.board.some(cell => !!cell.tile?.resource)).sort((a, b) =>
      privilegeGain(player, b, prompt.pairIndex, G.round, G.maxRounds, G) - privilegeGain(player, a, prompt.pairIndex, G.round, G.maxRounds, G));
    const card = cards[0];
    if (!card) return { name: 'choosePrivilege', args: ['skip'] };
    if (card === 'A') {
      const options = resources.map(resource => ({ resource, count: player.board.filter(cell => cell.tile?.resource === resource).length })).filter(x => x.count > 0);
      const target = options.map(x => {
        const next = clonePlayer(player), before = evaluate(player, G.round, G.maxRounds);
        advanceTrack(next, x.resource, x.count);
        return { ...x, value: evaluate(next, G.round, G.maxRounds) - before };
      }).sort((a, b) => b.value - a.value)[0]?.resource;
      return { name: 'choosePrivilege', args: [card, target] };
    }
    if (card === 'B') return { name: 'choosePrivilege', args: [card, bestTrackResource(player, lowestResources(player), scoreDiscCount(player), G.round, G.maxRounds)] };
    return { name: 'choosePrivilege', args: [card] };
  }
  if (G.pending) {
    const space = G.track[G.pending.space];
    if (G.pending.type === 'start') {
      const available = [0, 1, 2, 3].filter(slot => !G.players.some(p => p.startSlot === slot));
      const lastToReturn = G.players.every(other => other === player || other.retired);
      if (lastToReturn && !G.players.some(other => other.startSlot === 0) && available.includes(0)) return { name: 'chooseStartSlot', args: [0] };
      const slot = available.sort((a, b) => {
        const val = (n: number) => n === 0 ? 7 + (G.round === G.maxRounds ? 2 : 0) : n === 1 ? (player.coins < 8 ? 7 : 4) : n === 2 ? (player.brewer < 20 ? 5 : 1) : 6;
        return val(b) - val(a);
      })[0];
      return slot === undefined ? null : { name: 'chooseStartSlot', args: [slot] };
    }
    if (G.pending.type === 'score') {
      const choice = bestScore(player, G, space.scoreType || 'ABC', difficulty);
      return choice ? { name: 'takeScore', args: [choice.category, choice.option] } : { name: 'confirmAction', args: [] };
    }
    if (G.pending.type === 'resource' || G.pending.type === 'monk') {
      const market = G.pending.type === 'resource' ? G.resources[space.sourceIndex ?? -1] || [] : G.monks[space.sourceIndex ?? -1] || [];
      const choices = market.flatMap(tile => placementCandidates(G, player, tile, space.sourceIndex ?? 0, difficulty).map(place => ({ tile, ...place })));
      choices.sort((a, b) => b.score - a.score);
      const best = choices[0];
      return best && (best.score > 0 || (G.pending.purchases ?? 0) < 1) ? { name: 'buyTile', args: [best.tile.id, best.index] } : { name: 'finishPurchase', args: [] };
    }
  }
  if (G.phase === 'setup') {
    const available = [1, 2, 3].filter(slot => !G.players.some(p => p.startSlot === slot));
    const slot = available.sort((a, b) => {
      const value = (n: number) => n === 1 ? (player.coins < 10 ? 7 : 4) : n === 2 ? (player.brewer < 20 ? 5 : 1) : 6;
      return value(b) - value(a);
    })[0];
    return slot === undefined ? null : { name: 'chooseStartSlot', args: [slot] };
  }
  const possible = G.track.flatMap((_space, index) => {
    if (index <= player.position) return [];
    const value = actionValue(G, player, index, difficulty);
    if (value === null || value <= 0) return [];
    const distance = index - player.position;
    return [{ index, utility: value, distance }];
  }).sort((a, b) => b.utility - a.utility);
  const planned = possible.map(candidate => {
    const skipped = possible.filter(other => other.index > player.position && other.index < candidate.index);
    const opportunityCost = skipped.reduce((sum, other) => sum + other.utility, 0) * (difficulty === 'expert' ? .63 : .36);
    const travelCost = candidate.distance * (difficulty === 'expert' ? .025 : .015);
    const followUp = possible.filter(other => other.index > candidate.index)
      .reduce((best, other) => Math.max(best, other.utility - (other.index - candidate.index) * .025), 0);
    const lookahead = followUp * (difficulty === 'expert' ? .28 : .08);
    const noise = difficulty === 'normal' ? Math.random() * .16 : 0;
    return { index: candidate.index, value: candidate.utility + lookahead - opportunityCost - travelCost + noise };
  }).sort((a, b) => b.value - a.value);
  if (planned[0]) return { name: 'moveTo', args: [planned[0].index] };
  const start = G.track.findIndex((space, index) => index > player.position && space.type === 'start');
  return start >= 0 ? { name: 'moveTo', args: [start] } : null;
}

// Search candidates are legal rule actions. Keep positional diversity while
// limiting the branching factor of resource placements.
export function searchMoves(G: AleState, playerID: string, fast = false): BotMove[] {
  const p = G.players[Number(playerID)];
  const free = G.phase === 'play' && !G.pending && !G.startChoice && !G.confirmationKind && !G.shedChoices.length && !G.privilegePrompts.length;
  const preferred = fast && free ? null : chooseBotMove(G, playerID, 'expert');
  if (!preferred && !free) return [];
  if (G.phase === 'setup' || G.startChoice || G.shedChoices.length || G.privilegePrompts.length || G.confirmationKind || (G.expansion?.storePrompts?.length ?? 0) > 0 || (G.expansion?.cartMovement?.nextLocation ?? -1) >= 0 || G.pending?.baseDone)
    return preferred ? [preferred] : [];
  let alternatives: BotMove[] = [];
  if (G.pending?.type === 'resource' || G.pending?.type === 'monk') {
    const space = G.track[G.pending.space];
    const market = G.pending.type === 'resource' ? G.resources[space.sourceIndex ?? -1] : G.monks[space.sourceIndex ?? -1];
    const ranked = market.flatMap(tile => placementCandidates(G, p, tile, space.sourceIndex ?? 0, 'expert').map(place => ({ ...place, tile }))).sort((a,b) => b.score-a.score);
    const candidates = [...ranked.slice(0, 6)];
    for (const side of ['sun', 'shade']) for (const tile of market) {
      const candidate = ranked.find(c => c.tile.id === tile.id && gardenCells[c.index].side === side);
      if (candidate) candidates.push(candidate);
    }
    alternatives = candidates.map(c => ({ name: 'buyTile', args: [c.tile.id, c.index] }));
    if ((G.pending.purchases ?? 0) > 0) alternatives.push({ name: 'finishPurchase', args: [] });
  } else if (G.pending?.type === 'score') {
    const kind = G.track[G.pending.space].scoreType || 'ABC';
    alternatives = (kind === 'ABC' ? ['A','B','C'] as const : [kind]).flatMap(c => scoreChoices(p, c).map(o => ({ name: 'takeScore', args: [c,o] })));
  } else if (G.pending?.type === 'start') {
    const slots = [0, 1, 2, 3].filter(s => !G.players.some(other => other.startSlot === s));
    const forced = G.players.every(other => other === p || other.retired) && slots.includes(0);
    alternatives = (forced ? [0] : slots).map(s => ({ name: 'chooseStartSlot', args: [s] }));
  } else if (!p.retired) {
    alternatives = G.track.flatMap((_space, i) => canMoveTo(G,p,i) ? [{ name: 'moveTo', args: [i] }] : []);
    if (p.coins < 8) alternatives.push(...p.privileges.map(c => ({ name: 'discardPrivilege', args: [c] })));
  }
  return [...new Map([...(preferred ? [preferred] : []), ...alternatives].map(m => [JSON.stringify(m), m])).values()];
}
export function searchValueHeuristic(G: AleState, player: number) {
  const p = G.players[player];
  if (G.phase === 'finished' || (p.retired && G.round === G.maxRounds)) return scoreBreakdown(p, G.expansionEnabled ? G.expansion?.players[player] : undefined).total;
  const expansionValue = G.expansionEnabled ? scoreBreakdown(p, G.expansion?.players[player]).expansionBarrelScore : 0;
  return evaluate(p, G.round, G.maxRounds) + expansionValue + expansionSetupPotential(G, player) - economyRisk(G, player);
}

export function searchValue(G: AleState, player: number, valueModel?: BotValueModel | null) {
  const base = searchValueHeuristic(G, player);
  if (G.phase === 'finished' || G.players[player]?.retired && G.round === G.maxRounds) return base;
  const model = valueModel === undefined ? getActiveBotValueModel() : valueModel;
  if (!model || model.blend <= 0) return base;
  // The network only learns a correction to the hand-built estimate. The
  // training script enables it only after held-out matches show lower error.
  // Self-play labels can still correlate higher cash with worse positions, so
  // take a monotone envelope over lower cash levels. This prevents the learned
  // residual from making a coin itself reduce a player's evaluated position.
  const state = G.players[player];
  const probePlayers = [...G.players];
  const probePlayer = { ...state };
  probePlayers[player] = probePlayer;
  const probeG = { ...G, players: probePlayers };
  let bestLowerValue = -Infinity;
  for (let coins = 0; coins < state.coins; coins++) {
    probePlayer.coins = coins;
    const probeBase = searchValueHeuristic(probeG, player);
    const probeCorrection = predictBotValueCorrection(extractBotValueFeatures(probeG, player, probeBase), model);
    bestLowerValue = Math.max(bestLowerValue, probeBase + probeCorrection);
  }
  const correction = predictBotValueCorrection(extractBotValueFeatures(G, player, base), model);
  return Math.max(base + correction, bestLowerValue);
}


/** Irrecoverable opportunities lost by moving past a public action space.
 * Charge only skipped legal actions, not the destination or empty supplies. */
export function skippedOpportunityCost(G: AleState, playerID: string, move: BotMove) {
  if (move.name !== 'moveTo') return 0;
  const p=G.players[Number(playerID)], destination=Number(move.args[0]);
  let cost=0;
  for (let i=p.position+1;i<destination;i++) {
    const space=G.track[i];
    if (space.type==='resource' || space.type==='monk') {
      const market=space.type==='resource'?G.resources[space.sourceIndex ?? -1]:G.monks[space.sourceIndex ?? -1];
      if (!market?.length || !canBuyFrom(p,market,space.sourceIndex)) continue;
      const cheap=Math.min(...market.map(t=>tileBaseCost(t,space.sourceIndex)));
      cost += .75 + (cheap<=3?.55:.15);
    } else if(space.type==='score' && G.scores[space.sourceIndex ?? -1]>0 && canScore(p,space.scoreType)) {
      cost += .65 + Math.min(3, reachableIncome(G,p,i)*.25);
    } else if(space.type==='barrel' && availableBarrelIds(G,p).length) cost+=1.5;
  }
  // Earlier rounds need more visits to build a reusable economy.
  return cost * (G.round===1?1.4:1);
}
function scoreIncome(p: PlayerState, category: 'A'|'B'|'C', option: string | number) {
  let income=0;
  const add=(index:number)=>{const cell=p.board[index]; if(cell.side==='shade' && cell.tile?.resource) income+=cell.tile.value;};
  p.board.forEach((cell,i)=> {
    const tile=cell.tile; if(!tile) return;
    if(category==='A' && tile.resource && tile.value===Number(option)) add(i);
    if(category==='C' && tile.resource===option) add(i);
    if(category==='B' && tile.kind==='monk' && tile.monk===option) neighbors(i).forEach(add);
  });
  return income;
}
function reachableIncome(G: AleState,p: PlayerState, index: number) {
  const kind=G.track[index].scoreType;
  if(!kind) return 0;
  const categories=kind==='ABC'?['A','B','C'] as const:[kind];
  return Math.max(0,...categories.flatMap(c=>scoreChoices(p,c).map(o=>scoreIncome(p,c,o))));
}
export function economyRisk(G: AleState, playerID: number) {
  const p=G.players[playerID];
  if(p.retired || G.phase!=='play') return 0;
  const purchases=G.track.flatMap((space,index)=> {
    if(index<=p.position || (space.type!=='resource' && space.type!=='monk')) return [];
    const market=space.type==='resource'?G.resources[space.sourceIndex ?? -1]:G.monks[space.sourceIndex ?? -1];
    return market?.length?[Math.min(...market.map(t=>tileBaseCost(t,space.sourceIndex)))]:[];
  });
  if(!purchases.length) return 0;
  const reserve=Math.min(12,purchases.slice(0,3).reduce((sum,c)=>sum+c,0));
  const income=G.track.reduce((best,space,i)=>i>p.position && space.type==='score' && G.scores[space.sourceIndex ?? -1]>0 ? Math.max(best,reachableIncome(G,p,i)):best,0);
  // Income is a plan, not cash: discount it until the score action is taken.
  const shortage=Math.max(0,reserve-p.coins-income*.45);
  return shortage*(G.round===1?.65:.45);
}
