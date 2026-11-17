import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InitializeGame, CreateGameReducer } from 'boardgame.io/internal';
import { HeavenAle, scoreBreakdown } from '../src/game';
import { chooseBotMove, searchMoves, type BotMove } from '../src/bot';
import { searchBotMove } from '../src/mcts';
import { botValueModel as currentModel } from '../src/bot-value-model';
import { botValueModel as previousModel } from './fixtures/bot-value-model-120-games';
import type { BotValueModel } from '../src/bot-value-network';

const newer = currentModel as BotValueModel;
const older = previousModel as BotValueModel;
const seedCount = Number(process.env.BOT_EVAL_SEEDS || 8);
const seedOffset = Number(process.env.BOT_EVAL_SEED_OFFSET || 0);
const iterations = Number(process.env.BOT_EVAL_ITERATIONS || 16);
const treeDepth = Number(process.env.BOT_EVAL_TREE_DEPTH || 4);
const rolloutTurns = Number(process.env.BOT_EVAL_ROLLOUT_TURNS || 1);
const mctsEvery = Math.max(1, Number(process.env.BOT_EVAL_MCTS_EVERY || 4));
const outputDirectory = process.env.BOT_EVAL_LOG_DIR || 'training-logs';
const outputPath = join(process.cwd(), outputDirectory, `model-h2h-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
type PairGameResult = { newScore: number; oldScore: number; winner: 'new' | 'old' | 'draw'; plies: number };
type SeedResult = { seed: number; expansionEnabled: boolean; games: PairGameResult[]; scoreDifference: number; points: number };

function playGame(seed: number, expansionEnabled: boolean, modelForSeat: [BotValueModel, BotValueModel]): PairGameResult {
  const game = expansionEnabled ? { ...HeavenAle, setup: (args: any) => HeavenAle.setup(args, { expansionEnabled: true }) } : HeavenAle;
  const reducer = CreateGameReducer({ game, isClient: false });
  let state: any = InitializeGame({ game, numPlayers: 2, seed: `h2h-${expansionEnabled ? 'exp' : 'base'}-${seed}` });
  let freeDecisionCount = 0;
  for (let ply = 0; ply < 900 && state.G.phase !== 'finished' && !state.ctx.gameover; ply++) {
    const playerIndex = Number(state.ctx.currentPlayer);
    const freeTurn = state.G.phase === 'play' && !state.G.pending && !state.G.startChoice && !state.G.confirmationKind &&
      !state.G.shedChoices.length && !state.G.privilegePrompts.length && !state.G.expansion?.cartMovement && !state.G.expansion?.storePrompts?.length;
    let move: BotMove | null = null;
    if (freeTurn && ++freeDecisionCount % mctsEvery === 0) {
      // MCTS seeds one visit per legal root action. Fewer iterations can end
      // before the later candidates are searched, biasing results by ordering.
      const rootCandidates = searchMoves(state.G, playerIndex).length;
      move = searchBotMove(state, 'expert', undefined, undefined, modelForSeat[playerIndex], {
        maxIterations: Math.max(iterations, rootCandidates), treeDepth, rolloutTurns,
      }).move;
    } else move = null;
    move ??= chooseBotMove(state.G, String(playerIndex), 'expert');
    if (!move) throw new Error(`No move: seed ${seed}, ply ${ply}, player ${playerIndex}, phase ${state.G.phase}`);
    const next = reducer(state, { type: 'MAKE_MOVE', payload: { type: move.name, args: move.args, playerID: String(playerIndex) } });
    if (next._stateID === state._stateID) throw new Error(`Rejected action ${move.name} at seed ${seed}, ply ${ply}`);
    state = { ...next, G: { ...next.G, log: [] }, _undo: [], _redo: [] };
  }
  if (state.G.phase !== 'finished') throw new Error(`Game did not finish: seed ${seed}`);
  const scores = state.G.players.map((player: any, index: number) => scoreBreakdown(
    player,
    state.G.expansionEnabled ? state.G.expansion?.players[index] : undefined,
  ).total);
  const newerSeat = modelForSeat[0] === newer ? 0 : 1;
  const oldSeat = 1 - newerSeat;
  const newScore = scores[newerSeat], oldScore = scores[oldSeat];
  return { newScore, oldScore, winner: newScore > oldScore ? 'new' : newScore < oldScore ? 'old' : 'draw', plies: state.ctx.turn };
}

function seededRandom(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function interval(values: number[], seed: number) {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const random = seededRandom(seed), estimates = Array.from({ length: 4000 }, () => {
    let total = 0;
    for (let n = 0; n < values.length; n++) total += values[Math.floor(random() * values.length)];
    return total / Math.max(1, values.length);
  }).sort((a, b) => a - b);
  return { mean, low: estimates[Math.floor(estimates.length * .025)], high: estimates[Math.floor(estimates.length * .975)] };
}

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputPath, `旧模型 vs 新模型\n游戏：基础版双人局 + 扩展版双人局\n种子组：${seedOffset}–${seedOffset + seedCount - 1}\n每 ${mctsEvery} 个自由行动进行一次搜索；搜索至少 ${iterations} 次模拟并确保覆盖所有合法根动作；树深 ${treeDepth}，后续模拟 ${rolloutTurns} 个回合\n每个模式、每组种子两局：交换玩家座位\n旧模型训练局数：${older.trainingGames}\n新模型训练局数：${newer.trainingGames}\n\n`, 'utf8');
console.log(`Running ${seedCount * 4} paired games across base and expansion, seeds ${seedOffset}–${seedOffset + seedCount - 1}; MCTS every ${mctsEvery} free decisions; ${outputPath}`);
const results: SeedResult[] = [];
for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
  const seed = seedOffset + seedIndex;
  for (const expansionEnabled of [false, true]) {
    const first = playGame(seed, expansionEnabled, [newer, older]);
    const second = playGame(seed, expansionEnabled, [older, newer]);
    const games = [first, second];
    const scoreDifference = games.reduce((sum, result) => sum + result.newScore - result.oldScore, 0) / games.length;
    const points = games.reduce((sum, result) => sum + (result.winner === 'new' ? 1 : result.winner === 'draw' ? .5 : 0), 0) / games.length;
    results.push({ seed, expansionEnabled, games, scoreDifference, points });
    appendFileSync(outputPath, `${expansionEnabled ? '扩展' : '基础'} seed ${seed}: A 新先手 ${first.newScore}-${first.oldScore} (${first.winner}), B 换座 ${second.newScore}-${second.oldScore} (${second.winner}); 配对VP差 ${scoreDifference.toFixed(2)}, 得分 ${(points * 100).toFixed(0)}%\n`, 'utf8');
  }
  console.log(`Seed pairs: ${seed - seedOffset + 1}/${seedCount} complete (seed ${seed}, base + expansion)`);
}
for (const expansionEnabled of [false, true]) {
  const subset = results.filter(result => result.expansionEnabled === expansionEnabled);
  const scoreCI = interval(subset.map(result => result.scoreDifference), 81023 + Number(expansionEnabled));
  const pointsCI = interval(subset.map(result => result.points), 81024 + Number(expansionEnabled));
  const newWins = subset.reduce((sum, result) => sum + result.games.filter(gameResult => gameResult.winner === 'new').length, 0);
  const oldWins = subset.reduce((sum, result) => sum + result.games.filter(gameResult => gameResult.winner === 'old').length, 0);
  const draws = subset.reduce((sum, result) => sum + result.games.filter(gameResult => gameResult.winner === 'draw').length, 0);
  const summary = `${expansionEnabled ? '扩展' : '基础'}：新模型 ${newWins} 胜，旧模型 ${oldWins} 胜，平局 ${draws}；新模型配对得分 ${(pointsCI.mean * 100).toFixed(1)}% (95% bootstrap CI ${(pointsCI.low * 100).toFixed(1)}–${(pointsCI.high * 100).toFixed(1)}%)；平均VP差 ${scoreCI.mean.toFixed(2)} (95% bootstrap CI ${scoreCI.low.toFixed(2)}–${scoreCI.high.toFixed(2)})。`;
  appendFileSync(outputPath, `${summary}\n`, 'utf8');
  console.log(summary);
}
console.log(`Detailed results saved to ${outputPath}`);
