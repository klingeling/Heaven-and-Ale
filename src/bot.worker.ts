import { searchBotMove } from './mcts';
self.onmessage = event => {
  const { state, difficulty, requestID } = event.data;
  try { self.postMessage({ requestID, ...searchBotMove(state, difficulty, undefined, iterations => self.postMessage({ requestID, progress: iterations })) }); }
  catch (error) { self.postMessage({ requestID, error: String(error) }); }
};
