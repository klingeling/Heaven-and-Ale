import assert from 'node:assert/strict';
import { InitializeGame, CreateGameReducer } from 'boardgame.io/internal';
import { HeavenAle, gardenCells, canMoveTo } from '../src/game';
import { chooseBotMove, searchMoves, searchValue, skippedOpportunityCost, economyRisk } from '../src/bot';
import { searchBotMove } from '../src/mcts';
let state:any=InitializeGame({game:{...HeavenAle,seed:'economy-regression'},numPlayers:2});
const reducer=CreateGameReducer({game:HeavenAle,isClient:false});
for(let i=0;i<3;i++) { const m=chooseBotMove(state.G,state.ctx.currentPlayer,'expert')!; state=reducer(state,{type:'MAKE_MOVE',payload:{type:m.name,args:m.args,playerID:state.ctx.currentPlayer}}); }
const id=Number(state.ctx.currentPlayer);
const bState:any=structuredClone(state);
const bG=structuredClone(bState.G), bPlayer=bG.players[0];
bG.phase='play'; bPlayer.privileges=bPlayer.privileges.filter((card:string)=>card!=='B'); bPlayer.privilegePairs[0]='B';
const aIndex=bG.track.findIndex((space:any)=>space.type==='score' && (space.scoreType==='A'||space.scoreType==='ABC') && bG.scores[space.sourceIndex]>0);
assert(aIndex>=0,'Need an available A scoring space');
bG.pending={space:aIndex,type:'score',player:'0'};
const tracksBefore={...bPlayer.tracks};
const afterScore:any=reducer({...bState,G:bG},{type:'MAKE_MOVE',payload:{type:'takeScore',args:['A',1],playerID:'0'}});
assert.deepEqual(afterScore.G.players[0].tracks,tracksBefore,'Placed privilege B must not trigger on a later scoring action');
assert(!afterScore.G.log.some((line:string)=>line.includes('特权卡 B：')),'No repeated privilege B activation log is expected');
const urgentCash=structuredClone(state.G), urgentPlayer=urgentCash.players[id];
urgentCash.phase='play'; urgentCash.privilegePrompts=[{kind:'pair',pairIndex:0}];
urgentPlayer.privileges=['D','E']; urgentPlayer.coins=3;
assert.equal(chooseBotMove(urgentCash,String(id),'expert')?.args[0],'D','Early cash shortage should prioritize the immediate 12-coin card');
const legality=structuredClone(state.G); legality.phase='play'; legality.players[id].position=-1; legality.pending=null; legality.confirmationKind=null;
const resourceSpace=legality.track.findIndex((space:any)=>space.type==='resource');
const resourceIndex=legality.track[resourceSpace].sourceIndex;
legality.resources[resourceIndex]=[];
assert.equal(canMoveTo(legality,legality.players[id],resourceSpace),false,'Empty resource spaces are not legal moves');
const scoreSpace=legality.track.findIndex((space:any)=>space.type==='score');
legality.scores[legality.track[scoreSpace].sourceIndex]=0;
assert.equal(canMoveTo(legality,legality.players[id],scoreSpace),false,'Exhausted score spaces are not legal moves');
let shedState:any=structuredClone(state); const shedG=shedState.G, shedPlayer=shedG.players[id];
shedG.confirmationKind=null; shedG.pending=null;
const hutIndex=gardenCells.findIndex(cell=>cell.hut), hut=gardenCells[hutIndex];
const neighbors=gardenCells.flatMap((cell,i)=>{const dx=Math.abs(cell.x-hut.x),dz=Math.abs(cell.z-hut.z);return i!==hutIndex&&Math.abs(cell.row-hut.row)<=1&&((dz<.05&&Math.abs(dx-1.77)<.12)||(dz>1.4&&dz<1.65&&Math.abs(dx-.88)<.12))?[i]:[];});
for(const [i,cell] of neighbors.entries()) shedPlayer.board[cell].tile={id:'shed-'+cell,kind:'resource',resource:'wood',value:i+1};
shedG.shedChoices=[{hutIndex,value:20,brewerAdvance:1,activateCount:3,mode:'nonAdjacent',candidates:neighbors,selected:[]}];
for(let n=0;n<4&&shedState.G.shedChoices.length;n++) {
 const currentG=shedState.G, selected=[...currentG.shedChoices[0].selected];
 const candidates=searchMoves(currentG,String(id));
 assert(!candidates.some((move:any)=>move.name==='toggleShedChoice'&&selected.includes(move.args[0])),'Bot search must not deselect an already chosen shed tile');
 const move=chooseBotMove(currentG,String(id),'expert')!;
 const next:any=reducer(shedState,{type:'MAKE_MOVE',payload:{type:move.name,args:move.args,playerID:String(id)}});
 assert(next._stateID>shedState._stateID,'Shed choice must make progress');
 shedState=next;
}
assert.equal(shedState.G.shedChoices.length,0,'Expert bot should resolve a 3 non-adjacent tile shed reward');
const cashValues=[];
for(let coins=0;coins<=30;coins++) {const g=structuredClone(state.G);g.players[id].coins=coins;cashValues.push(searchValue(g,id));}
for(let i=1;i<cashValues.length;i++) assert(cashValues[i]>=cashValues[i-1]-1e-8,`Cash ${i-1}->${i} lost value`);
const dry=structuredClone(state.G); dry.players[id].coins=2;
const funded=structuredClone(dry); funded.players[id].coins=12;
assert(economyRisk(dry,id)>economyRisk(funded,id),'Low liquidity must have a cost');
const income=structuredClone(dry);
const shade=gardenCells.findIndex(c=>c.side==='shade');
income.players[id].board[shade].tile={id:'test-income',kind:'resource',resource:'wood',value:5};
assert(economyRisk(income,id)<economyRisk(dry,id),'Reachable shade activation must improve the cash plan');
const far=state.G.track.findIndex((s:any)=>s.type==='start');
assert(skippedOpportunityCost(state.G,state.ctx.currentPlayer,{name:'moveTo',args:[far]})>0);
const result=searchBotMove(state,'expert');

assert(result.move?.name==='moveTo');
assert(Number(result.move.args[0])<8,'Opening skipped too many spaces');
let searches=1;
for(let i=0;i<500 && state.G.phase!=='finished';i++) {
 const useSearch= i<12 || i%29===0;
 const m=useSearch?searchBotMove(state,'normal',30).move:chooseBotMove(state.G,state.ctx.currentPlayer,'expert');
 if(useSearch) searches++;
 assert(m,'No decision');
 const next:any=reducer(state,{type:'MAKE_MOVE',payload:{type:m!.name,args:m!.args,playerID:state.ctx.currentPlayer}});
 assert(next._stateID>state._stateID,JSON.stringify(m));
 state={...next,G:{...next.G,log:[]},_undo:[],_redo:[]};
}
assert.equal(state.G.phase,'finished');
console.log('PASS: continuous cash value, lost opportunities, expert opening, complete mixed-policy game',searches);
