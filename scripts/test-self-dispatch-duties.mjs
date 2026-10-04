import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateDailyDuties, nextDutyTrip, checkDutyTripOrder, planDutyLater, reportDutyBlocked,
  offerDutyHandover, acceptDutyHandover, declineDutyHandover, completeDutyFromEvidence,
  dailyCoverageSummary, reconcileDutyDemand, projectMandatoryWork,
} from '../src/lib/self-dispatch-duties.ts';
const now=new Date('2026-10-04T10:00:00Z');
const duty=(id,overrides={})=>({id,machineId:id,machineName:id,serviceDate:'2026-10-04',priority:'today',
  requiredAt:'2026-10-04T09:00:00Z',dueAt:'2026-10-04T16:00:00Z',visitMinutes:45,
  ownerId:null,ownerName:null,assignedBy:null,state:'required',plannedAt:null,routeId:null,
  blocker:null,handover:null,completedAt:null,receiptId:null,revision:0,events:[],...overrides});
const operator=(id,overrides={})=>({id,name:id,active:true,eligibleMachineIds:['A','B','C'],availableFrom:now.toISOString(),
  availableUntil:'2026-10-04T18:00:00Z',availableMinutes:360,...overrides});
const rules=['A','B','C'].map(machineId=>({machineId,primaryId:'Noury',backupIds:['Basheer']}));
const mine=(id,overrides={})=>duty(id,{ownerId:'Noury',ownerName:'Noury',assignedBy:'primary',...overrides});
const isCode=code=>error=>error.code===code;
const evidence={machineId:'A',routeId:'r1',receiptId:'receipt1',operatorId:'Noury',completedAt:now.toISOString(),status:'verified',unresolvedLanes:0,underfilledLanes:0};

test('daily workload assigns all three machines even when next trip is only one',()=>{
  const input=['A','B','C'].map(id=>duty(id));const before=JSON.stringify(input);
  const day=allocateDailyDuties(input,[operator('Noury'),operator('Basheer')],rules,now);
  assert.deepEqual(day.duties.map(d=>d.ownerId),['Noury','Noury','Noury']);
  const trip=nextDutyTrip(day.duties,'Noury',1);
  assert.deepEqual(trip.selectedDutyIds,['A']);assert.deepEqual(trip.stillResponsibleFor,['B','C']);
  assert.equal(dailyCoverageSummary(day.duties,now).remaining,3);assert.equal(JSON.stringify(input),before);
});
test('limited capacity routes the rest of today’s responsibilities to approved backup',()=>{
  const day=allocateDailyDuties(['A','B','C'].map(id=>duty(id)),[operator('Noury',{availableMinutes:45}),operator('Basheer')],rules,now);
  assert.deepEqual(day.duties.map(d=>d.ownerId),['Noury','Basheer','Basheer']);
  assert.equal(day.uncoveredDutyIds.length,0);
});
test('both operators being full leaves visible uncovered work, not a false assignment',()=>{
  const day=allocateDailyDuties(['A','B','C'].map(id=>duty(id)),[operator('Noury',{availableMinutes:45}),operator('Basheer',{availableMinutes:45})],rules,now);
  assert.deepEqual(day.uncoveredDutyIds,['C']);assert.ok(day.notices.some(n=>n.reason==='no_capacity'));
});
test('missing machine roster never guesses a daily owner',()=>{
  const result=allocateDailyDuties([duty('A')],[operator('Noury')],[],now);
  assert.equal(result.duties[0].ownerId,null);assert.equal(result.notices[0].reason,'no_rule');
});
test('closed shift and out-of-scope operators do not receive work',()=>{
  for (const overrides of [{active:false},{eligibleMachineIds:[]},{availableUntil:'2026-10-04T10:01:00Z'},{availableMinutes:NaN}]) {
    const x=allocateDailyDuties([duty('A')],[operator('Noury',overrides)],rules,now);assert.equal(x.duties[0].ownerId,null);
  }
});
test('workload fits actual deadline, not only a daily stop count',()=>{
  const day=allocateDailyDuties(['A','B','C'].map(id=>duty(id,{dueAt:'2026-10-04T11:00:00Z'})),[operator('Noury'),operator('Basheer')],rules,now);
  assert.equal(day.uncoveredDutyIds.length,1);
});
test('existing assigned work consumes time before new obligations',()=>{
  const day=allocateDailyDuties([mine('A'),duty('B')],[operator('Noury',{availableMinutes:45}),operator('Basheer')],rules,now);
  assert.equal(day.duties.find(d=>d.id==='B').ownerId,'Basheer');
});
test('refresh never steals a duty from its current owner even when unavailable',()=>{
  const day=allocateDailyDuties([mine('A')],[operator('Noury',{active:false}),operator('Basheer')],rules,now);
  assert.equal(day.duties[0].ownerId,'Noury');assert.equal(day.notices[0].reason,'owner_unavailable');
});
test('duplicate machine obligations and invalid deadlines are rejected',()=>{
  assert.throws(()=>allocateDailyDuties([duty('A'),duty('other',{machineId:'A'})],[],rules,now));
  assert.throws(()=>allocateDailyDuties([duty('A',{dueAt:'invalid'})],[],rules,now));
});
test('higher urgency and tighter deadline appear first',()=>{
  const duties=[mine('A'),mine('B',{priority:'urgent'}),mine('C',{priority:'immediate'})];
  assert.deepEqual(nextDutyTrip(duties,'Noury',1).selectedDutyIds,['C']);
});
test('a lower priority cannot be cherry-picked while required earlier work remains',()=>{
  assert.throws(()=>checkDutyTripOrder([mine('A'),mine('B',{priority:'immediate'})],'Noury',['A']),isCode('conflict'));
});
test('a blocked stop stays the operator’s responsibility while safe work continues',()=>{
  const blocked=reportDutyBlocked(mine('A'),0,'Noury','event1','Site temporarily inaccessible',now);
  const trip=nextDutyTrip([blocked,mine('B')],'Noury',1);
  assert.deepEqual(trip.selectedDutyIds,['B']);assert.deepEqual(trip.stillResponsibleFor,['A']);assert.deepEqual(trip.needsHelp,['A']);
});
test('planning later retains daily owner, deadline and required status',()=>{
  const x=planDutyLater(mine('A'),0,'Noury','e1','2026-10-04T13:00:00Z',now);
  assert.equal(x.ownerId,'Noury');assert.equal(x.state,'required');assert.equal(x.dueAt,mine('A').dueAt);assert.equal(x.routeId,null);
});
test('later cannot move work past deadline or into tomorrow',()=>{
  for (const at of ['2026-10-04T15:30:00Z','2026-10-05T08:00:00Z']) {
    assert.throws(()=>planDutyLater(mine('A'),0,'Noury','e1',at,now));
  }
});
test('operator cannot edit someone else’s responsibility',()=>{
  assert.throws(()=>planDutyLater(mine('A'),0,'Basheer','e1','2026-10-04T12:00:00Z',now),isCode('forbidden'));
  assert.throws(()=>reportDutyBlocked(mine('A'),0,'Basheer','e1','No time',now),isCode('forbidden'));
});
test('handover request does not release the original operator',()=>{
  const offer=offerDutyHandover(mine('A'),0,'Noury','e1',operator('Basheer'),'Cannot cover this visit',now);
  assert.equal(offer.ownerId,'Noury');assert.equal(offer.handover.toId,'Basheer');
  assert.equal(dailyCoverageSummary([offer],now).remaining,1);
});
test('only recipient acceptance transfers responsibility; original deadline survives',()=>{
  const offer=offerDutyHandover(mine('A'),0,'Noury','e1',operator('Basheer'),'Cannot cover this visit',now);
  assert.throws(()=>acceptDutyHandover(offer,1,operator('SomeoneElse'),'e2',now),isCode('forbidden'));
  const result=acceptDutyHandover(offer,1,operator('Basheer'),'e2',now);
  assert.equal(result.ownerId,'Basheer');assert.equal(result.dueAt,offer.dueAt);assert.equal(result.handover,null);
});
test('acceptance with changed availability or stale revision cannot take over',()=>{
  const offer=offerDutyHandover(mine('A'),0,'Noury','e1',operator('Basheer'),'Cannot cover this visit',now);
  assert.throws(()=>acceptDutyHandover(offer,0,operator('Basheer'),'e2',now),isCode('conflict'));
  assert.throws(()=>acceptDutyHandover(offer,1,operator('Basheer',{availableMinutes:0}),'e2',now),isCode('conflict'));
});
test('declined handover remains an unresolved duty of its original operator',()=>{
  const offer=offerDutyHandover(mine('A'),0,'Noury','e1',operator('Basheer'),'Cannot cover this visit',now);
  const x=declineDutyHandover(offer,1,'Basheer','e2','Vehicle unavailable',now);
  assert.equal(x.ownerId,'Noury');assert.equal(x.state,'blocked');assert.equal(dailyCoverageSummary([x],now).remaining,1);
});
test('picked-up or active route work cannot use a duty-only handover',()=>{
  assert.throws(()=>offerDutyHandover(mine('A',{routeId:'r1'}),0,'Noury','e1',operator('Basheer'),'Cannot continue',now),isCode('conflict'));
});
test('deadline warnings appear early enough to arrange backup',()=>{
  const x=dailyCoverageSummary([mine('A',{dueAt:'2026-10-04T11:00:00Z'})],now);
  assert.equal(x.needsAttention.length,1);assert.equal(x.overdue,0);
});
test('unfinished duties carry over with original overdue deadline and owner',()=>{
  const old=mine('A',{serviceDate:'2026-10-03',requiredAt:'2026-10-03T09:00:00Z',dueAt:'2026-10-03T16:00:00Z'});
  const next=reconcileDutyDemand([old],[duty('new-A',{machineId:'A'})]);
  assert.equal(next.length,1);assert.equal(next[0].dueAt,old.dueAt);assert.equal(next[0].ownerId,'Noury');
  assert.equal(dailyCoverageSummary(next,now).overdue,1);
});
test('healthier, missing or stale snapshots cannot erase a recorded must-do job',()=>{
  assert.deepEqual(reconcileDutyDemand([mine('A')],[]),[mine('A')]);
});
test('new urgency can tighten but never relax a recorded service deadline',()=>{
  const x=reconcileDutyDemand([mine('A')],[duty('n',{machineId:'A',priority:'immediate',dueAt:'2026-10-04T11:00:00Z'})]);
  assert.equal(x[0].priority,'immediate');assert.equal(x[0].dueAt,'2026-10-04T11:00:00Z');
});
test('pending, skipped or partial service is not verified completion',()=>{
  for (const e of [{...evidence,status:'pending'},{...evidence,status:'partial'},{...evidence,status:'skipped'},
    {...evidence,unresolvedLanes:1},{...evidence,underfilledLanes:2},{...evidence,receiptId:''},{...evidence,routeId:'other'},
    {...evidence,operatorId:'Basheer'},{...evidence,completedAt:'2026-10-03T10:00:00Z'}]) {
    assert.throws(()=>completeDutyFromEvidence(mine('A',{routeId:'r1'}),0,e,'done',now),isCode('conflict'));
  }
});
test('trusted completion closes only the matching duty; two others remain',()=>{
  const done=completeDutyFromEvidence(mine('A',{routeId:'r1'}),0,evidence,'done',now);
  const day=dailyCoverageSummary([done,mine('B'),mine('C')],now);
  assert.equal(day.completed,1);assert.equal(day.remaining,2);assert.equal(day.allCompleted,false);
});
test('completed duties do not reappear from old detection snapshots',()=>{
  const done=completeDutyFromEvidence(mine('A',{routeId:'r1'}),0,evidence,'done',now);
  assert.equal(reconcileDutyDemand([done],[duty('new-A',{machineId:'A'})]).length,1);
});
test('stock, routes and quantities are absent from duty assignment effects',()=>{
  const x=allocateDailyDuties([duty('A')],[operator('Noury')],rules,now);
  assert.equal(x.duties[0].routeId,null);assert.equal('pickup' in x,false);assert.equal('reservedStock' in x,false);
});
const card=(id,assignments=[],overrides={})=>({machineId:id,name:id,priority:'today',openToday:true,unknown:0,assignments,...overrides});
test('mandatory board cannot hide two unselected machines',()=>{
  const rows=['A','B','C'].map(id=>card(id));const result=projectMandatoryWork(rows,now);
  assert.equal(result.total,3);assert.equal(result.uncovered,3);assert.equal(result.coordinatorEnabled,false);
});
test('projection shows real route owner but never invents a deadline or duty assignment',()=>{
  const result=projectMandatoryWork([card('A',[{operatorName:'Noury',operatorAssigned:true,mine:true,routeId:'r1',routeDate:'2026-10-04'}]),card('B')],now);
  assert.equal(result.rows[0].responsible,'Noury');assert.equal(result.rows[0].deadline,null);
  assert.equal(result.rows[1].responsible,null);assert.equal(result.uncovered,1);
});
test('closed required machines and duplicate assignments remain visible as exceptions',()=>{
  const assigned={operatorName:'Noury',operatorAssigned:true,mine:false,routeId:null,routeDate:'2026-10-04'};
  const x=projectMandatoryWork([card('A',[],{openToday:false}),card('B',[assigned,assigned])],now);
  assert.equal(x.blocked,2);assert.equal(x.rows[1].state,'conflict');
});

test('overdue unowned work is assigned for recovery without resetting its missed deadline',()=>{
  const old=duty('A',{serviceDate:'2026-10-03',requiredAt:'2026-10-03T09:00:00Z',dueAt:'2026-10-03T16:00:00Z'});
  const x=allocateDailyDuties([old],[operator('Noury')],rules,now);
  assert.equal(x.duties[0].ownerId,'Noury');assert.equal(x.duties[0].dueAt,old.dueAt);
  assert.ok(x.notices.some(n=>n.reason==='past_deadline'));
});

test('a reserved draft with no operator is not counted as human coverage',()=>{
  const x=projectMandatoryWork([card('A',[{operatorName:'Assigned route',operatorAssigned:false,mine:false,routeId:null,routeDate:'2026-10-04'}])],now);
  assert.equal(x.uncovered,1);assert.equal(x.rows[0].responsible,null);
});
