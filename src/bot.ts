import {
  availableBarrelIds, canBuyFrom, canMoveTo, canScore, canSelectShedCell, gardenCells, lowestResources,
  monkNames, resources, scoreBreakdown, scoreChoices, shedProductionProgress, tileBaseCost,
  validShedSelection, type AleState, type PlayerState, type Resource, type ShedChoice, type Tile,
} from './game';

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
      engine += tile.value * activations * (cell.side === 'sun' ? .28 : (.25 + Math.max(0,12-p.coins)/12*.25));
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
  if (category === 'A') next.scores.x = 0;
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
  if (space.type === 'resource' || space.type === 'monk') {
    const market = space.type === 'resource' ? G.resources[space.sourceIndex ?? -1] || [] : G.monks[space.sourceIndex ?? -1] || [];
    if (!market.length || !canBuyFrom(p, market, space.sourceIndex)) return null;
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
    return purchases ? 1.15 + total : null;
  }
  if (space.type === 'score') {
    if (!G.scores[space.sourceIndex ?? -1] || !canScore(p, space.scoreType)) return null;
    return 1.05 + (bestScore(p, G, space.scoreType || 'ABC', difficulty)?.value || 0) + Math.min(Math.max(0,12-p.coins),reachableIncome(G,p,index))*.35;
  }
  if (space.type === 'barrel') {
    const ids = availableBarrelIds(G, p);
    if (!ids.length) return null;
    const points = ids.reduce((sum, id) => sum + ((G.barrels.find(b => b.id === id)?.remaining ?? 1) === 2 ? 4 : 2), 0);
    return 1.5 + points * .55;
  }
  return space.type === 'start' ? -100 : null;
}

function chooseCellForShed(choice: ShedChoice, p: PlayerState, G: AleState) {
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
  return best?.find(i => !choice.selected.includes(i));
}

export function chooseBotMove(G: AleState, currentPlayer: string, difficulty: BotDifficulty): BotMove | null {
  const player = G.players[Number(currentPlayer)];
  if (!player || G.phase === 'finished') return null;
  if (G.startChoice) {
    const resource = bestTrackResource(player, resources, 2, G.round, G.maxRounds);
    return { name: 'chooseStartResource', args: [resource] };
  }
  if (G.confirmationKind) return { name: 'confirmAction', args: [] };
  if (G.shedChoices.length) {
    const choice = G.shedChoices[0];
    if (validShedSelection(choice)) return { name: 'completeShedChoice', args: [] };
    const cell = chooseCellForShed(choice, player, G);
    return cell === undefined ? { name: 'completeShedChoice', args: [] } : { name: 'toggleShedChoice', args: [cell] };
  }
  if (G.privilegePrompts.length) {
    const prompt = G.privilegePrompts[0];
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
  let alternatives: BotMove[] = [];
  if (G.startChoice) alternatives = resources.map(r => ({ name: 'chooseStartResource', args: [r] }));
  else if (G.confirmationKind) return preferred ? [preferred] : [];
  else if (G.shedChoices.length) {
    const choice = G.shedChoices[0];
    alternatives = validShedSelection(choice) ? (preferred ? [preferred] : []) : choice.candidates
      .filter(i => !choice.selected.includes(i) && canSelectShedCell(choice, i))
      .map(i => ({ name: 'toggleShedChoice', args: [i] }));
  } else if (G.privilegePrompts.length) {
    const prompt = G.privilegePrompts[0];
    alternatives = [{ name: 'choosePrivilege', args: ['skip'] }];
    for (const card of p.privileges) {
      const targets = card === 'A' ? resources.filter(r => p.board.some(c => c.tile?.resource === r)) : card === 'B' ? lowestResources(p) : [undefined];
      alternatives.push(...targets.map(r => ({ name: 'choosePrivilege', args: r === undefined ? [card] : [card, r] })));
    }
  } else if (G.pending?.type === 'resource' || G.pending?.type === 'monk') {
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
  } else if (G.phase === 'setup' || G.pending?.type === 'start') {
    const slots = (G.phase === 'setup' ? [1,2,3] : [0,1,2,3]).filter(s => !G.players.some(other => other.startSlot === s));
    const forced = G.phase !== 'setup' && G.players.every(other => other === p || other.retired) && slots.includes(0);
    alternatives = (forced ? [0] : slots).map(s => ({ name: 'chooseStartSlot', args: [s] }));
  } else if (!p.retired) {
    alternatives = G.track.flatMap((_space, i) => canMoveTo(G,p,i) ? [{ name: 'moveTo', args: [i] }] : []);
    if (p.coins < 8) alternatives.push(...p.privileges.map(c => ({ name: 'discardPrivilege', args: [c] })));
  }
  return [...new Map([...(preferred ? [preferred] : []), ...alternatives].map(m => [JSON.stringify(m), m])).values()];
}
export function searchValue(G: AleState, player: number) {
  const p = G.players[player];
  if (G.phase === 'finished' || (p.retired && G.round === G.maxRounds)) return scoreBreakdown(p).total;
  return evaluate(p, G.round, G.maxRounds) - economyRisk(G, player);
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
