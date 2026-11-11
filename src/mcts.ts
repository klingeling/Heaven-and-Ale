import { CreateGameReducer } from 'boardgame.io/internal';
import type { State } from 'boardgame.io';
import { HeavenAle, type AleState } from './game';
import { chooseBotMove, searchMoves, searchValue, skippedOpportunityCost, type BotMove, type BotDifficulty } from './bot';

type SearchState = State<AleState>;
type Node = { move?: BotMove; visits: number; values: number[]; children: Node[] };
const reducer = CreateGameReducer({ game: HeavenAle, isClient: false });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function step(state: SearchState, move: BotMove): SearchState {
  const next = reducer(state, { type: 'MAKE_MOVE', payload: { type: move.name, args: move.args, playerID: state.ctx.currentPlayer } }) as SearchState;
  // UI history is irrelevant to search and can otherwise grow at every ply.
  return { ...next, G: { ...next.G, log: [] }, _undo: [], _redo: [] };
}
function seededRandom(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], random: () => number) {
  for (let i=items.length-1;i>0;i--) { const j=Math.floor(random()*(i+1)); [items[i],items[j]]=[items[j],items[i]]; }
}
function determinize(source: SearchState, random: () => number): SearchState {
  const state = copy(source);
  state._undo=[]; state._redo=[]; state.G.log=[];
  // Only unseen future rounds are randomized; public supplies stay unchanged.
  for (const decks of [state.G.resourceDecks, state.G.monkDecks]) {
    const pool=decks.slice(state.G.round).flat();
    shuffle(pool,random);
    let offset=0;
    for (let round=state.G.round;round<decks.length;round++) {
      const count=decks[round].length; decks[round]=pool.slice(offset,offset+count); offset+=count;
    }
  }
  return state;
}
// Each tree edge resolves a complete player's action, including purchases,
// shed rewards, privileges and confirmation. These are not separate horizons.
function completeAction(state: SearchState, first: BotMove, policy: (state: SearchState) => BotMove | null, costs: number[]): SearchState {
  const turn = state.ctx.turn;
  costs[Number(state.ctx.currentPlayer)] += skippedOpportunityCost(state.G,state.ctx.currentPlayer,first);
  let next = step(state, first);
  for (let i=0;i<36 && next.ctx.turn===turn && next.G.phase!=='finished';i++) {
    const move = policy(next);
    if (!move) break;
    costs[Number(next.ctx.currentPlayer)] += skippedOpportunityCost(next.G,next.ctx.currentPlayer,move);
    const after=step(next,move);
    if (after._stateID===next._stateID) break;
    next=after;
  }
  return next;
}
export function searchBotMove(source: SearchState, difficulty: BotDifficulty, budgetOverride?: number, onProgress?: (iterations: number) => void) {
  // Seed from public state only. Repeated decisions from the same position
  // get the same sampling stream; hidden future deck order never seeds search.
  const publicState = JSON.stringify({ G: { ...source.G, resourceDecks: undefined, monkDecks: undefined, log: undefined, undoSnapshot: undefined }, currentPlayer: source.ctx.currentPlayer });
  let seed=2166136261;
  for (let i=0;i<publicState.length;i++) seed=Math.imul(seed^publicState.charCodeAt(i),16777619);
  const random=seededRandom(seed);
  const policyCache = new Map<string, BotMove | null>();
  const policy = (state: SearchState) => {
    const { resourceDecks: _r, monkDecks: _m, log: _l, undoSnapshot, ...publicState } = state.G;
    const key = state.ctx.currentPlayer + JSON.stringify({ ...publicState, undoSnapshot: !!undoSnapshot });
    if (policyCache.has(key)) return policyCache.get(key)!;
    const move = chooseBotMove(state.G,state.ctx.currentPlayer,'expert');
    policyCache.set(key,move); return move;
  };
  const root: Node={visits:0,values:source.G.players.map(()=>0),children:[]};
  const baseline=source.G.players.map((_,i)=>searchValue(source.G,i));
  const deadline=performance.now()+(budgetOverride ?? (difficulty==='expert'?12000:3000));
  const treeDepth=difficulty==='expert'?12:8;
  const rolloutTurns=difficulty==='expert'?5:3;
  const initial=searchMoves(source.G,source.ctx.currentPlayer);
  if (initial.length<=1) return { move: initial[0] ?? null, iterations:0 };
  let iterations=0;
  while (performance.now()<deadline || iterations===0) {
    let state=determinize(source,random), node=root;
    const costs=baseline.map(()=>0);
    const path=[node];
    let depth=0;
    while (!state.ctx.gameover && state.G.phase!=='finished' && depth<treeDepth) {
      // Supplies and score spaces may change after any simulated player's
      // action. Recompute legality from this exact simulated state each visit.
      const legal=searchMoves(state.G,state.ctx.currentPlayer);
      if (!legal.length) break;
      const keys=new Set(legal.map(m=>JSON.stringify(m)));
      const unexplored=legal.filter(m=>!node.children.some(c=>JSON.stringify(c.move)===JSON.stringify(m)));
      let child: Node;
      if (unexplored.length && node.children.length < Math.max(2, Math.ceil(1.5 * Math.sqrt(node.visits + 1)))) {
        // Prefer the heuristic proposal first, then explore all alternatives.
        const move=unexplored[0];
        child={move,visits:0,values:baseline.map(()=>0),children:[]};
        node.children.push(child);
      } else {
        const actor=Number(state.ctx.currentPlayer);
        const viable=node.children.filter(c=>keys.has(JSON.stringify(c.move)));
        if (!viable.length) break;
        child=viable.reduce((best,c)=> {
          const uct=(n:Node)=>n.values[actor]/Math.max(1,n.visits)+.5*Math.sqrt(Math.log(node.visits+1)/Math.max(1,n.visits));
          return uct(c)>uct(best)?c:best;
        });
      }
      const next=completeAction(state,child.move!,policy,costs);
      if (next._stateID===state._stateID) break;
      state=next; node=child; path.push(node); depth++;
      if (node.visits===0) break;
    }
    // Follow a competent policy for several full turns, not random nearby
    // spaces. Do not cut an iteration halfway through its evaluation horizon.
    for (let turn=0;turn<rolloutTurns && !state.ctx.gameover && state.G.phase!=='finished';turn++) {
      const move=policy(state);
      if (!move) break;
      const next=completeAction(state,move,policy,costs);
      if (next._stateID===state._stateID) break;
      state=next;
    }
    const gains=baseline.map((base,i)=>searchValue(state.G,i)-base-costs[i]);
    const rewards=gains.map((gain,i)=> {
      const others=gains.filter((_,j)=>i!==j);
      const rival=others.reduce((sum,v)=>sum+v,0)/Math.max(1,others.length);
      return Math.tanh((gain-rival*.45)/18);
    });
    for (const visited of path) { visited.visits++; rewards.forEach((v,i)=>visited.values[i]+=v); }
    iterations++;
    onProgress?.(iterations);
  }
  const best=[...root.children].sort((a,b)=>b.visits-a.visits || b.values[Number(source.ctx.currentPlayer)]/Math.max(1,b.visits)-a.values[Number(source.ctx.currentPlayer)]/Math.max(1,a.visits))[0];
  return { move:best?.move ?? initial[0],iterations,
    candidates: root.children.map(c=>({move:c.move,visits:c.visits,value:c.values[Number(source.ctx.currentPlayer)]/Math.max(1,c.visits)})) };
}
