import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InitializeGame, CreateGameReducer } from 'boardgame.io/internal';
import { HeavenAle, scoreBreakdown, type AleState } from '../src/game';
import { chooseBotMove, searchMoves, searchValueHeuristic, type BotMove } from '../src/bot';
import { searchBotMove } from '../src/mcts';
import { botValueModel } from '../src/bot-value-model';
import { BOT_VALUE_FEATURE_COUNT, extractBotValueFeatures, predictBotValueCorrection, type BotValueModel } from '../src/bot-value-network';

type TrainingRow = { game: number; playerIndex: number; heuristic: number; features: number[]; target: number };
const outputPath = new URL('../src/bot-value-model.ts', import.meta.url);
const samples = Number(process.env.BOT_TRAIN_GAMES || 200);
const seedOffset = Number(process.env.BOT_TRAIN_SEED || 0);
const logDirectory = process.env.BOT_TRAIN_LOG_DIR || 'training-logs';
const mctsEvery = Math.max(1, Number(process.env.BOT_TRAIN_MCTS_EVERY || 4));
const mctsIterations = Math.max(4, Number(process.env.BOT_TRAIN_MCTS_ITERATIONS || 24));
const logPath = join(process.cwd(), logDirectory, `bot-selfplay-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
const hiddenSize = 16;
const epochs = 30;
const random = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
  value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
};
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
function readableGameLog(line: string) {
  const turn = line.match(/^\[\[TURN:(\d+):(\d+)\]\]$/);
  if (turn) return `—— 第 ${turn[1]} 轮 · 第 ${turn[2]} 回合 ——`;
  return line.replace(/\[\[MONK:([A-D])\]\]/g, '僧侣图标');
}

function generateGames(gameCount: number): TrainingRow[] {
  const rows: TrainingRow[] = [];
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(logPath, `天堂与美酒机器人自战记录\n训练局数：${gameCount}\n随机种子起点：${seedOffset}\n策略：每 ${mctsEvery} 个自由行动混入一次 MCTS（至少 ${mctsIterations} 次模拟，并确保覆盖所有合法根行动；深度 4）\n格式：每局汇总 + 引擎行动日志\n`, 'utf8');
  for (let gameIndex = 0; gameIndex < gameCount; gameIndex++) {
    const numPlayers = [2, 3, 4][gameIndex % 3];
    const expansionEnabled = gameIndex % 2 === 1;
    const seed = seedOffset + gameIndex;
    const game = { ...HeavenAle, setup: (args: any) => HeavenAle.setup(args, { expansionEnabled }) };
    let state: any = InitializeGame({ game, numPlayers, seed: `value-${seed}` });
    const reducer = CreateGameReducer({ game, isClient: false });
    const gameRows: TrainingRow[] = [];
    const actionLog: string[] = [];
    let freeDecisionCount = 0;
    for (let ply = 0; ply < 1200 && state.G.phase !== 'finished' && !state.ctx.gameover; ply++) {
      const playerIndex = Number(state.ctx.currentPlayer);
      const freeTurn = state.G.phase === 'play' && !state.G.pending && !state.G.startChoice && !state.G.confirmationKind && !state.G.privilegePrompts.length && !state.G.shedChoices.length && !state.G.expansion?.cartMovement && !state.G.expansion?.storePrompts?.length;
      if (freeTurn) {
        const heuristic = searchValueHeuristic(state.G, playerIndex);
        const features = extractBotValueFeatures(state.G, playerIndex, heuristic);
        if (features.length !== BOT_VALUE_FEATURE_COUNT) throw new Error(`Feature width changed: expected ${BOT_VALUE_FEATURE_COUNT}, got ${features.length}`);
        gameRows.push({ game: gameIndex, playerIndex, heuristic, features, target: 0 });
      }
      let move: BotMove | null = null;
      if (freeTurn && ++freeDecisionCount % mctsEvery === (seed % mctsEvery)) {
        move = searchBotMove(state, 'expert', undefined, undefined, undefined, {
          // MCTS gives each root move an initial visit, so cover all legal
          // actions before adding the configured extra search budget.
          maxIterations: Math.max(mctsIterations, searchMoves(state.G, playerIndex).length), treeDepth: 4, rolloutTurns: 1,
        }).move;
      }
      move ??= chooseBotMove(state.G, String(playerIndex), gameIndex % 4 === 0 ? 'expert' : 'normal');
      if (!move) throw new Error(`Bot stalled in training game ${gameIndex}, ply ${ply}, phase ${state.G.phase}`);
      const next = reducer(state, { type: 'MAKE_MOVE', payload: { type: move.name, args: move.args, playerID: String(playerIndex) } });
      if (next._stateID === state._stateID) throw new Error(`Illegal bot move in training game ${gameIndex}, ply ${ply}: ${move.name}`);
      const logged = Array.isArray(next.G.log) ? [...next.G.log].reverse().map(readableGameLog) : [];
      if (logged.length) actionLog.push(...logged);
      else actionLog.push(`第${state.G.round}轮 玩家${playerIndex + 1} ${move.name} ${JSON.stringify(move.args)}`);
      state = { ...next, G: { ...next.G, log: [] }, _undo: [], _redo: [] };
    }
    if (state.G.phase !== 'finished') throw new Error(`Training game ${gameIndex} did not finish`);
    for (const row of gameRows) {
      const finalScore = scoreBreakdown(state.G.players[row.playerIndex], state.G.expansionEnabled ? state.G.expansion?.players[row.playerIndex] : undefined).total;
      row.target = finalScore - row.heuristic;
    }
    rows.push(...gameRows);
    const results = state.G.players.map((player: any, index: number) => ({ name: player.name, score: scoreBreakdown(player, state.G.expansionEnabled ? state.G.expansion?.players[index] : undefined).total }));
    const highScore = Math.max(...results.map((result: { score: number }) => result.score));
    const winners = results.flatMap((result: { name: string; score: number }) => result.score === highScore ? [result.name] : []);
    const details = [
      `\n第 ${gameIndex + 1} 局 | ${numPlayers} 人 | ${expansionEnabled ? '扩展' : '基础'} | seed ${seed}`,
      `结果：${results.map((result: { name: string; score: number }) => `${result.name} ${result.score}分`).join(' · ')} | 获胜：${winners.join('、')}`,
      ...actionLog.map(line => `  ${line}`),
    ];
    appendFileSync(logPath, `${details.join('\n')}\n`, 'utf8');
    if ((gameIndex + 1) % 10 === 0) console.log(`Self-play games: ${gameIndex + 1}/${gameCount}`);
  }
  return rows;
}

function initModel(inputSize: number, seed: number) {
  const rand = random(seed), scale = Math.sqrt(2 / inputSize);
  return {
    inputWeights: Array.from({ length: inputSize * hiddenSize }, () => (rand() * 2 - 1) * scale),
    inputBias: Array(hiddenSize).fill(0),
    outputWeights: Array.from({ length: hiddenSize }, () => (rand() * 2 - 1) * .05),
    outputBias: 0,
  };
}

function predict(model: ReturnType<typeof initModel>, features: number[]) {
  const hidden = Array.from({ length: hiddenSize }, (_, index) => {
    let value = model.inputBias[index];
    const offset = index * features.length;
    for (let j = 0; j < features.length; j++) value += model.inputWeights[offset + j] * features[j];
    return Math.tanh(value);
  });
  return { hidden, value: model.outputBias + hidden.reduce((sum, value, index) => sum + value * model.outputWeights[index], 0) };
}

function fit(rows: TrainingRow[]) {
  const gameIDs = [...new Set(rows.map(row => row.game))];
  const validationGames = new Set(gameIDs.filter((_, index) => index % 5 === 0));
  const train = rows.filter(row => !validationGames.has(row.game));
  const validation = rows.filter(row => validationGames.has(row.game));
  const active = botValueModel as BotValueModel;
  // Fine-tune from the deployed evaluator instead of throwing away what the
  // existing 120-game model learned. This makes small training batches safe.
  const model = active?.inputSize === BOT_VALUE_FEATURE_COUNT && active.hiddenSize === hiddenSize
    ? { inputWeights: [...active.inputWeights], inputBias: [...active.inputBias], outputWeights: [...active.outputWeights], outputBias: active.outputBias }
    : initModel(BOT_VALUE_FEATURE_COUNT, 20261116);
  const parameters = [model.inputWeights, model.inputBias, model.outputWeights, [model.outputBias]];
  const firstMoments = parameters.map(parameter => parameter.map(() => 0));
  const secondMoments = parameters.map(parameter => parameter.map(() => 0));
  let step = 0, bestWeights = structuredClone(model), bestLoss = Infinity, stale = 0;
  const batchSize = 64, learningRate = .0015;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const shuffleRandom = random(20261116 + epoch);
    for (let i = train.length - 1; i > 0; i--) {
      const j = Math.floor(shuffleRandom() * (i + 1));
      [train[i], train[j]] = [train[j], train[i]];
    }
    for (let start = 0; start < train.length; start += batchSize) {
      const batch = train.slice(start, start + batchSize), grads = parameters.map(parameter => parameter.map(() => 0));
      for (const row of batch) {
        const { hidden, value } = predict(model, row.features), error = value - row.target, scale = 2 * error / batch.length;
        grads[3][0] += scale;
        const inputOffset = grads[0];
        for (let h = 0; h < hiddenSize; h++) {
          grads[2][h] += scale * hidden[h];
          const hiddenGradient = scale * model.outputWeights[h] * (1 - hidden[h] * hidden[h]);
          grads[1][h] += hiddenGradient;
          const offset = h * row.features.length;
          for (let f = 0; f < row.features.length; f++) inputOffset[offset + f] += hiddenGradient * row.features[f];
        }
      }
      step++;
      for (let group = 0; group < parameters.length; group++) for (let i = 0; i < parameters[group].length; i++) {
        const gradient = grads[group][i] + parameters[group][i] * 1e-5;
        firstMoments[group][i] = .9 * firstMoments[group][i] + .1 * gradient;
        secondMoments[group][i] = .999 * secondMoments[group][i] + .001 * gradient * gradient;
        const m = firstMoments[group][i] / (1 - .9 ** step), v = secondMoments[group][i] / (1 - .999 ** step);
        parameters[group][i] -= learningRate * m / (Math.sqrt(v) + 1e-8);
      }
      model.outputBias = parameters[3][0];
    }
    const loss = validation.reduce((sum, row) => sum + (predict(model, row.features).value - row.target) ** 2, 0) / Math.max(1, validation.length);
    if (loss < bestLoss) { bestLoss = loss; bestWeights = structuredClone(model); stale = 0; }
    else if (++stale >= 10) break;
    if ((epoch + 1) % 5 === 0) console.log(`Training epoch ${epoch + 1}, validation residual MSE ${loss.toFixed(3)}`);
  }
  return { model: bestWeights, train, validation, rawValidationMSE: bestLoss };
}

function calibration(rows: TrainingRow[], model: ReturnType<typeof initModel>) {
  const points = rows.map(row => ({ target: row.target, prediction: predict(model, row.features).value }));
  const covariance = points.reduce((sum, point) => sum + point.target * point.prediction, 0);
  const variance = points.reduce((sum, point) => sum + point.prediction ** 2, 0);
  const blend = clamp(variance ? covariance / variance : 0, 0, 1);
  const baselineMSE = points.reduce((sum, point) => sum + point.target ** 2, 0) / Math.max(1, points.length);
  const calibratedMSE = points.reduce((sum, point) => sum + (point.target - blend * point.prediction) ** 2, 0) / Math.max(1, points.length);
  return { blend, baselineMSE, calibratedMSE, improvement: baselineMSE > 0 ? (baselineMSE - calibratedMSE) / baselineMSE : 0 };
}

function existingModelMSE(rows: TrainingRow[]) {
  return rows.reduce((sum, row) => sum + (row.target - predictBotValueCorrection(row.features)) ** 2, 0) / Math.max(1, rows.length);
}

console.log(`Generating ${samples} self-play games; log: ${logPath}`);
const rows = generateGames(samples);
const { model, validation } = fit(rows);
const metrics = calibration(validation, model);
const oldMSE = existingModelMSE(validation);
appendFileSync(logPath, `\n训练汇总 | 新模型留出误差 ${metrics.calibratedMSE.toFixed(3)} | 原模型留出误差 ${oldMSE.toFixed(3)} | 零修正误差 ${metrics.baselineMSE.toFixed(3)} | 改善 ${(metrics.improvement * 100).toFixed(1)}%\n`);
console.log(`Held-out residual MSE: new ${metrics.calibratedMSE.toFixed(3)}, current ${oldMSE.toFixed(3)}, no-network ${metrics.baselineMSE.toFixed(3)}; improvement ${(metrics.improvement * 100).toFixed(1)}%`);
if (metrics.improvement < .02 || metrics.blend <= 0 || metrics.calibratedMSE >= oldMSE) {
  console.log('New model did not beat the current model on held-out games; current model remains active.');
  process.exit(0);
}
const result: BotValueModel = { version: 1, inputSize: BOT_VALUE_FEATURE_COUNT, hiddenSize,
  inputWeights: model.inputWeights.map(value => Number(value.toFixed(7))), inputBias: model.inputBias.map(value => Number(value.toFixed(7))),
  outputWeights: model.outputWeights.map(value => Number(value.toFixed(7))), outputBias: Number(model.outputBias.toFixed(7)),
  blend: Number(metrics.blend.toFixed(5)), validationImprovement: Number(metrics.improvement.toFixed(5)), trainingGames: samples };
writeFileSync(outputPath, `// Generated by scripts/train-bot-value.ts after held-out self-play validation.\nexport const botValueModel = ${JSON.stringify(result)} as const;\n`, 'utf8');
console.log(`Installed residual value model (${result.validationImprovement * 100 | 0}% held-out improvement).`);
