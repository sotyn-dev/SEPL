const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const library=()=>import(pathToFileURL(path.join(__dirname,'../../../client/src/utils/scorecardSelection.js')).href);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('switching an applied range to adjacent weeks displays each selected weekly DPR amount',async()=>{
  const {createLatestScorecardRequest,selectScorecardWeek,selectedScorecard}=await library();
  const state={viewUserId:7,weekStart:'2026-10-05',scorecard:null,rangeApplied:{from:'2026-09-28',to:'2026-10-10'},
    periodCard:{user_id:7,from:'2026-09-28',to:'2026-10-05',kpis:[{actual:22073.35}]},rangeStat:{n:2}};
  const responses=new Map([
    ['2026-09-28',{user_id:7,week_start:'2026-09-28',kpis:[{actual:12000}]}],
    ['2026-10-05',{user_id:7,week_start:'2026-10-05',kpis:[{actual:10073.35}]}],
  ]);
  const requested=[];
  const weekly=createLatestScorecardRequest(async week=>{requested.push(week);return responses.get(week);},card=>{state.scorecard=card;});
  const period=createLatestScorecardRequest(async()=>state.periodCard,card=>{state.periodCard=card;});
  const controls={weekly,period,...Object.fromEntries(['Scorecard','PeriodCard','RangeApplied','RangeStat','WeekStart']
    .map(name=>['set'+name,value=>{state[name[0].toLowerCase()+name.slice(1)]=value;}]))};
  assert.equal(selectedScorecard(state).kpis[0].actual,22073.35);
  selectScorecardWeek('2026-09-28',controls);
  assert.equal(state.rangeApplied,null);assert.equal(state.periodCard,null);assert.equal(selectedScorecard(state),null);
  await weekly.load(state.weekStart);assert.equal(selectedScorecard(state).kpis[0].actual,12000);
  selectScorecardWeek('2026-10-05',controls);await weekly.load(state.weekStart);
  assert.equal(selectedScorecard(state).kpis[0].actual,10073.35);
  assert.deepEqual(requested,['2026-09-28','2026-10-05']);
});
test('late responses from a prior week or applied range cannot overwrite the newly selected week',async()=>{
  const {createLatestScorecardRequest,selectScorecardWeek,selectedScorecard}=await library();
  const state={viewUserId:7,weekStart:'2026-09-28',scorecard:null,periodCard:null,rangeApplied:{from:'2026-09-01',to:'2026-09-30'}};
  const previous=deferred(),current=deferred(),oldPeriod=deferred();
  const weekly=createLatestScorecardRequest(week=>week==='2026-09-28'?previous.promise:current.promise,card=>{state.scorecard=card;});
  const period=createLatestScorecardRequest(()=>oldPeriod.promise,card=>{state.periodCard=card;});
  const oldWeekLoad=weekly.load('2026-09-28'),periodLoad=period.load('range');
  selectScorecardWeek('2026-10-05',{weekly,period,...Object.fromEntries(['Scorecard','PeriodCard','RangeApplied','RangeStat','WeekStart']
    .map(name=>['set'+name,value=>{state[name[0].toLowerCase()+name.slice(1)]=value;}]))});
  const currentLoad=weekly.load('2026-10-05');
  current.resolve({user_id:7,week_start:'2026-10-05',kpis:[{actual:3500}]});await currentLoad;
  previous.resolve({user_id:7,week_start:'2026-09-28',kpis:[{actual:999}]});oldPeriod.resolve({user_id:7,kpis:[{actual:22073.35}]});
  await Promise.all([oldWeekLoad,periodLoad]);
  assert.equal(selectedScorecard(state).kpis[0].actual,3500);assert.equal(state.periodCard,null);
  assert.equal(selectedScorecard({...state,viewUserId:8}),null);
});

test('period cards match the applied normalized bounds and can render without a weekly response',async()=>{
  const {normalizeScorecardRange,selectedScorecard}=await library();
  const periodCard={user_id:7,from:'2026-10-05',to:'2026-10-12',template:{name:'DPR'},kpis:[{actual:3500}]};
  const applied={from:'2026-10-06',to:'2026-10-18'};
  const state={viewUserId:7,weekStart:'2026-10-05',scorecard:null,periodCard,rangeApplied:applied};
  assert.deepEqual(normalizeScorecardRange(applied),{from:'2026-10-05',to:'2026-10-12'});
  assert.equal(selectedScorecard(state),periodCard,'period view has its own render/print data even while weekly response is absent');
  assert.equal(selectedScorecard({...state,rangeApplied:{from:'2026-10-18',to:'2026-10-06'}}),periodCard,'reversed bounds agree with API normalization');
  assert.equal(selectedScorecard({...state,rangeApplied:{from:'2026-10-06',to:'2026-10-25'}}),null,'old period cannot appear beneath newly applied dates');
  assert.equal(selectedScorecard({...state,viewUserId:8}),null);
  assert.equal(normalizeScorecardRange({from:'2026-02-31',to:'2026-10-18'}),null);
  // Merely typing different inputs does not alter the previously applied snapshot.
  assert.equal(selectedScorecard({...state,rangeFrom:'2026-09-01',rangeTo:'2026-09-30'}),periodCard);
});

test('a delayed save cannot reload a departed week or user over the current card',async()=>{
  const {createLatestScorecardRequest,saveSelectedScorecard,selectedScorecard}=await library();
  for(const next of [{userId:7,weekStart:'2026-10-05'},{userId:8,weekStart:'2026-09-28'}]){
    const save=deferred(),original={userId:7,weekStart:'2026-09-28'};
    let current={...original},reloads=0;
    const state={viewUserId:7,weekStart:original.weekStart,scorecard:null,periodCard:null,rangeApplied:null};
    const requests=createLatestScorecardRequest(async selection=>({user_id:selection.userId,week_start:selection.weekStart,kpis:[{actual:selection.userId===8?900:3500}]}),card=>{state.scorecard=card;});
    const saving=saveSelectedScorecard(original,()=>save.promise,()=>current,()=>{reloads++;return requests.load(original);});
    current={...next};state.viewUserId=next.userId;state.weekStart=next.weekStart;
    await requests.load(next);
    const expected=selectedScorecard(state);
    save.resolve({saved:true});await saving;
    assert.equal(reloads,0,'post-save reload belongs only to the still-selected week and user');
    assert.equal(selectedScorecard(state),expected);
  }
});

test('saving the currently selected week still reloads its automatic totals',async()=>{
  const {saveSelectedScorecard}=await library();
  const selected={userId:7,weekStart:'2026-10-05'},save=deferred();let reloads=0;
  const pending=saveSelectedScorecard(selected,()=>save.promise,()=>({...selected}),async()=>{reloads++;});
  assert.equal(reloads,0);
  save.resolve({saved:true});assert.deepEqual(await pending,{saved:true});
  assert.equal(reloads,1);
});

test('a same-week delayed save refreshes the newly applied range rather than its captured range',async()=>{
  const {createLatestScorecardRequest,createScorecardSelection,saveSelectedScorecard,selectedScorecard}=await library();
  const save=deferred(),selection={userId:7,weekStart:'2026-10-05'};
  const oldRange={from:'2026-09-28',to:'2026-10-10'},newRange={from:'2026-10-05',to:'2026-10-17'};
  const current=createScorecardSelection({...selection,rangeApplied:oldRange});let actual=100;
  const state={viewUserId:7,weekStart:selection.weekStart,scorecard:null,periodCard:null,rangeApplied:oldRange};
  const requested=[];
  const period=createLatestScorecardRequest(async range=>{
    requested.push(range);
    return {user_id:7,from:'2026-10-05',to:'2026-10-12',kpis:[{actual}]};
  },card=>{state.periodCard=card;});
  const pending=saveSelectedScorecard(selection,()=>save.promise,()=>current.get(),selected=>period.load(selected.rangeApplied));
  current.set({...selection,rangeApplied:newRange});state.rangeApplied=newRange;
  await period.load(newRange);assert.equal(selectedScorecard(state).kpis[0].actual,100);
  actual=250;save.resolve({saved:true});await pending;
  assert.deepEqual(requested,[newRange,newRange],'reload reads the current applied snapshot');
  assert.equal(selectedScorecard(state).kpis[0].actual,250);
});

test('weekday and Sunday selections use the containing Monday and invalidate the old period',async()=>{
  const {selectScorecardWeek}=await library();
  for(const [date,monday] of [['2026-10-08','2026-10-05'],['2026-10-11','2026-10-05'],['2026-10-15','2026-10-12']]){
    const state={weekStart:'2026-09-28',scorecard:{},periodCard:{},rangeApplied:{from:'2026-09-01',to:'2026-09-30'},rangeStat:{}};
    let invalidations=0;
    const controls={weekly:{invalidate(){invalidations++;}},period:{invalidate(){invalidations++;}},
      ...Object.fromEntries(['Scorecard','PeriodCard','RangeApplied','RangeStat','WeekStart']
        .map(name=>['set'+name,value=>{state[name[0].toLowerCase()+name.slice(1)]=value;}]))};
    assert.equal(selectScorecardWeek(date,controls),monday);
    assert.equal(state.weekStart,monday);assert.equal(invalidations,2);
    assert.equal(state.rangeApplied,null);assert.equal(state.periodCard,null);assert.equal(state.scorecard,null);
    assert.equal(selectScorecardWeek('2026-02-31',controls),null);assert.equal(invalidations,2,'invalid dates leave the current selection intact');
  }
});

test('selecting Thursday of the same week exits the period and refreshes weekly totals',async()=>{
  const {createLatestScorecardRequest,selectScorecardWeek,selectedScorecard}=await library();
  const state={viewUserId:7,weekStart:'2026-10-05',scorecard:null,periodCard:{user_id:7,from:'2026-09-28',to:'2026-10-05',kpis:[{actual:900}]},rangeApplied:{from:'2026-09-28',to:'2026-10-10'},rangeStat:{}};
  const requested=[];
  const weekly=createLatestScorecardRequest(async week=>{requested.push(week);return {user_id:7,week_start:week,kpis:[{actual:3500}]};},card=>{state.scorecard=card;});
  const previousWeek=state.weekStart;
  const selectedWeek=selectScorecardWeek('2026-10-08',{weekly,period:{invalidate(){}},
    ...Object.fromEntries(['Scorecard','PeriodCard','RangeApplied','RangeStat','WeekStart']
      .map(name=>['set'+name,value=>{state[name[0].toLowerCase()+name.slice(1)]=value;}]))});
  if(selectedWeek===previousWeek) await weekly.load(selectedWeek);
  assert.deepEqual(requested,['2026-10-05']);assert.equal(state.rangeApplied,null);
  assert.equal(selectedScorecard(state).kpis[0].actual,3500,'unchanged normalized week must reload after clearing the prior period');
});
