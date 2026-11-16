import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InitializeGame, CreateGameReducer } from 'boardgame.io/internal';
import { HeavenAle, scoreBreakdown } from '../src/game';
import { chooseBotMove, searchMoves, type BotMove } from '../src/bot';
import { searchBotMove } from '../src/mcts';
import { botValueModel as currentModel } from '../src/bot-value-model';
import { botValueModel as previousModel } from './fixtures/bot-value-model-60-games';
import type { BotValueModel } from '../src/bot-value-network';

const newer = currentModel as BotValueModel;
const older = previousModel as BotValueModel;
const seedCount = Number(process.env.BOT_EVAL_SEEDS || 8);
const seedOffset = Number(process.env.BOT_EVAL_SEED_OFFSET || 0);
const iterations = Number(process.env.BOT_EVAL_ITERATIONS || 16);
const treeDepth = Number(process.env.BOT_EVAL_TREE_DEPTH || 4);
const rolloutTurns = Number(process.env.BOT_EVAL_ROLLOUT_TURNS || 1);
const outputDirectory = process.env.BOT_EVAL_LOG_DIR || 'training-logs';
const outputPath = join(process.cwd(), outputDirectory, `model-h2h-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
const game = HeavenAle;
const reducer = CreateGameReducer({ game, isClient: false });

type PairGameResult = { newScore: number; oldScore: number; winner: 'new' | 'old' | 'draw'; plies: number };
type SeedResult = { seed: number; games: PairGameResult[]; scoreDifference: number; points: number };

function playGame(seed: number, modelForSeat: [BotValueModel, BotValueModel]): PairGameResult {
  let state: any = InitializeGame({ game, numPlayers: 2, seed: `h2h-${seed}` });
  for (let ply = 0; ply < 900 && state.G.phase !== 'finished' && !state.ctx.gameover; ply++) {
    const playerIndex = Number(state.ctx.currentPlayer);
    const freeTurn = state.G.phase === 'play' && !state.G.pending && !state.G.startChoice && !state.G.confirmationKind &&
      !state.G.shedChoices.length && !state.G.privilegePrompts.length && !state.G.expansion?.cartMovement && !state.G.expansion?.storePrompts?.length;
    let move: BotMove | null;
    if (freeTurn) {
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
  const scores = state.G.players.map((player: any) => scoreBreakdown(player).total);
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
writeFileSync(outputPath, `旧模型 vs 新模型\n游戏：基础版双人局\n种子组：${seedOffset}–${seedOffset + seedCount - 1}\n每步搜索：至少 ${iterations} 次模拟，并确保覆盖所有合法根动作；树深 ${treeDepth}，后续模拟 ${rolloutTurns} 个回合\n每组两局：交换玩家座位\n旧模型训练局数：${older.trainingGames}\n新模型训练局数：${newer.trainingGames}\n\n`, 'utf8');
console.log(`Running seed pairs ${seedOffset}–${seedOffset + seedCount - 1} (${seedCount * 2} games), at least ${iterations} MCTS iterations per decision, depth ${treeDepth}, rollout ${rolloutTurns}; ${outputPath}`);
const results: SeedResult[] = [];
for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
  const seed = seedOffset + seedIndex;
  const first = playGame(seed, [newer, older]);
  const second = playGame(seed, [older, newer]);
  const games = [first, second];
  const scoreDifference = games.reduce((sum, result) => sum + result.newScore - result.oldScore, 0) / games.length;
  const points = games.reduce((sum, result) => sum + (result.winner === 'new' ? 1 : result.winner === 'draw' ? .5 : 0), 0) / games.length;
  const row = { seed, games, scoreDifference, points };
  results.push(row);
  appendFileSync(outputPath, `seed ${seed}: A 新先手 ${first.newScore}-${first.oldScore} (${first.winner}), B 换座 ${second.newScore}-${second.oldScore} (${second.winner}); 配对VP差 ${scoreDifference.toFixed(2)}, 得分 ${(points * 100).toFixed(0)}%\n`, 'utf8');
  console.log(`Seed pairs: ${seed - seedOffset + 1}/${seedCount} complete (seed ${seed})`);
}
const scoreCI = interval(results.map(result => result.scoreDifference), 81023);
const pointsCI = interval(results.map(result => result.points), 81024);
const newWins = results.reduce((sum, result) => sum + result.games.filter(gameResult => gameResult.winner === 'new').length, 0);
const oldWins = results.reduce((sum, result) => sum + result.games.filter(gameResult => gameResult.winner === 'old').length, 0);
const draws = results.reduce((sum, result) => sum + result.games.filter(gameResult => gameResult.winner === 'draw').length, 0);
const summary = `\n汇总：新模型 ${newWins} 胜，旧模型 ${oldWins} 胜，平局 ${draws}；新模型配对得分 ${(pointsCI.mean * 100).toFixed(1)}% (95% bootstrap CI ${(pointsCI.low * 100).toFixed(1)}–${(pointsCI.high * 100).toFixed(1)}%)；平均VP差 ${scoreCI.mean.toFixed(2)} (95% bootstrap CI ${scoreCI.low.toFixed(2)}–${scoreCI.high.toFixed(2)})。\n`;
appendFileSync(outputPath, summary, 'utf8');
console.log(summary.trim());
console.log(`Detailed results saved to ${outputPath}`);
