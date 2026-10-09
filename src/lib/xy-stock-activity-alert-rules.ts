/**
 * Snacky XY machine-specific activity anomaly rules.
 * INVENTORY REDUCTIONS are only a proxy for possible sales.
 * No paid XY sales API / transaction data is claimed or synthesized here.
 */
export type XySiteKind = "hospital" | "mall" | "university" | "school";
export type XyActivityHour = {
  day: string;
  hour: number;
  batches: number;
  slots: number;
  events: number;
  units: number;
};
export type XyActivityHistory = {
  machine_id: string;
  last_observed_at: string | null;
  last_decrease_at: string | null;
  recent_slots: number;
  recent_stocked_slots: number;
  hourly: XyActivityHour[];
};
export type XyActivityProfile = {
  kind: XySiteKind;
  label: string;
  // Local Tripoli time; weekdays use JS 0=Sunday .. 6=Saturday.
  open: Partial<Record<number, readonly [number, number]>>;
  minimumHours: number;
  maximumHours: number;
  historyDays: number;
  minComparableDays: number;
  minTypicalUnits: number;
  minActiveFraction: number;
  compareSameWeekday: boolean;
  // Owner-supplied exceptional closure dates (YYYY-MM-DD).
  closedDates?: readonly string[];
  pausedUntil?: string | null;
};
export type XyActivityDecision =
  | { outcome: "attention"; hours: number; usualUnits: number; evidenceDays: number; activeDayRatio: number; lastDecreaseAt: string | null; kind: XySiteKind }
  | { outcome: "skip"; reason: "not_configured" | "closed" | "paused" | "no_reliable_stock" | "recent_inventory_change" | "insufficient_history" | "normal_quiet_period" };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const always: XyActivityProfile["open"] = {
  0:[0,24],1:[0,24],2:[0,24],3:[0,24],4:[0,24],5:[0,24],6:[0,24],
};
const campus: XyActivityProfile["open"] = {
  0:[8,18],1:[8,18],2:[8,18],3:[8,18],4:[8,18],
};
const school: XyActivityProfile["open"] = {
  0:[8,16],1:[8,16],2:[8,16],3:[8,16],4:[8,16],
};
const mall: XyActivityProfile["open"] = {
  0:[12,24],1:[12,24],2:[12,24],3:[12,24],4:[12,24],
  5:[16,24],6:[13,24],
};
const hospitalProfile: Omit<XyActivityProfile, "label" | "minTypicalUnits"> = {
  kind:"hospital",open:always,minimumHours:4,maximumHours:8,
  historyDays:14,minComparableDays:7,minActiveFraction:0.65,compareSameWeekday:false,
};
const mallProfile: Omit<XyActivityProfile,"label" | "minTypicalUnits"> = {
  kind:"mall",open:mall,minimumHours:3,maximumHours:8,
  historyDays:28,minComparableDays:3,minActiveFraction:0.75,compareSameWeekday:true,
};
const campusProfile: Omit<XyActivityProfile,"label" | "minTypicalUnits"> = {
  kind:"university",open:campus,minimumHours:3,maximumHours:6,
  historyDays:28,minComparableDays:2,minActiveFraction:0.75,compareSameWeekday:true,
};
const schoolProfile: Omit<XyActivityProfile,"label" | "minTypicalUnits"> = {
  kind:"school",open:school,minimumHours:3,maximumHours:5,
  historyDays:28,minComparableDays:2,minActiveFraction:0.75,compareSameWeekday:true,
};

/** Explicit XY machine IDs, never inferred from translated display names.
 * Weekend/holiday and venue hours may be corrected by owner as site policies change.
 */
export const XY_MACHINE_ACTIVITY_PROFILES: Readonly<Record<string,XyActivityProfile>> = {
  "2411000046": {...hospitalProfile,label:"Almouasafat Hospital",minTypicalUnits:3},
  "2509000369": {...hospitalProfile,label:"Istiklal Hospital",minTypicalUnits:2},
  "2509000371": {...mallProfile,label:"HT Mall",minTypicalUnits:6},
  "2503000217": {...mallProfile,label:"Diplomacy Mall",minTypicalUnits:4},
  "2503000216": {...mallProfile,label:"HT Land",minTypicalUnits:5},
  "2509000370": {...campusProfile,label:"Attahadi University",minTypicalUnits:4},
  "2510001719": {...campusProfile,label:"Khalij University",minTypicalUnits:5},
  "2511001702": {...schoolProfile,label:"Elite Future School",minTypicalUnits:5},
};

function utcDateMs(day: string) { return Date.parse(day + "T00:00:00Z"); }
function dateFromMs(ms: number) { return new Date(ms).toISOString().slice(0,10); }
function weekday(day: string) { return new Date(day+"T12:00:00Z").getUTCDay(); }
function localTime(at: number) {
  const parts = new Intl.DateTimeFormat("en-CA",{
    timeZone:"Africa/Tripoli",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",hourCycle:"h23",
  }).formatToParts(new Date(at));
  const values = new Map(parts.map(part=>[part.type,part.value]));
  return {
    day: values.get("year")+"-"+values.get("month")+"-"+values.get("day"),
    hour: Number(values.get("hour")),
  };
}
function scheduled(profile: XyActivityProfile, local: {day:string;hour:number}) {
  if(profile.closedDates?.includes(local.day)) return false;
  const interval=profile.open[weekday(local.day)];
  return !!interval && local.hour>=interval[0] && local.hour<interval[1];
}
function median(numbers:number[]) {
  if(!numbers.length) return 0;
  const ordered=numbers.slice().sort((a,b)=>a-b);
  const middle=Math.floor(ordered.length/2);
  return ordered.length%2 ? ordered[middle] : (ordered[middle-1]+ordered[middle])/2;
}
function reliable(hour:XyActivityHour|undefined) {
  return !!hour && hour.batches>=2 && hour.slots>=8
    && Number.isFinite(hour.units) && hour.units>=0;
}

/** Run only from protected server cron. A warning requires live inventory,
 * no reductions throughout an OPEN local-time window, and a historically
 * demonstrated expectation of reductions during that SAME time window.
 */
export function assessXyMachineActivity(input: {
  nowMs: number;
  profile: XyActivityProfile | undefined;
  history: XyActivityHistory;
}): XyActivityDecision {
  const {nowMs,profile,history}=input;
  if(!profile) return {outcome:"skip",reason:"not_configured"};
  if(profile.pausedUntil && Date.parse(profile.pausedUntil)>nowMs) return {outcome:"skip",reason:"paused"};
  if(!scheduled(profile,localTime(nowMs))) return {outcome:"skip",reason:"closed"};
  const latest=Date.parse(String(history.last_observed_at??""));
  if(!Number.isFinite(latest) || latest>nowMs+5*60*1000
    || nowMs-latest>25*60*1000
    || history.recent_slots<8 || history.recent_stocked_slots<4) {
    return {outcome:"skip",reason:"no_reliable_stock"};
  }

  const byHour=new Map(history.hourly.map(hour=>[hour.day+":"+hour.hour,hour]));
  const completedHourMs=Math.floor(nowMs/HOUR)*HOUR-HOUR;
  const pastHours: Array<{day:string;hour:number;dateOffset:number;data:XyActivityHour}>=[];
  let baselineKey="";
  for(let offset=0;offset<profile.maximumHours;offset++) {
    const local=localTime(completedHourMs-offset*HOUR);
    if(!scheduled(profile,local)) break;
    const data=byHour.get(local.day+":"+local.hour);
    if(!reliable(data)) return {outcome:"skip",reason:"no_reliable_stock"};
    if(!baselineKey) baselineKey=local.day;
    pastHours.push({
      ...local,dateOffset:Math.round((utcDateMs(local.day)-utcDateMs(baselineKey))/DAY),
      data:data!,
    });
  }
  if(pastHours.length<profile.minimumHours) {
    return {outcome:"skip",reason:"closed"};
  }
  // A single observed decrement in the shortest eligible window establishes
  // recent activity; longer windows cannot be a zero-change interval either.
  if(pastHours.slice(0,profile.minimumHours).some(h=>h.data.units>0)) {
    return {outcome:"skip",reason:"recent_inventory_change"};
  }

  let insufficient=false;
  for(let size=profile.minimumHours;size<=pastHours.length;size++) {
    const window=pastHours.slice(0,size);
    if(window.some(h=>h.data.units>0)) return {outcome:"skip",reason:"recent_inventory_change"};

    const historical:number[]=[];
    for(let daysAgo=1;daysAgo<=profile.historyDays;daysAgo++) {
      const day=dateFromMs(utcDateMs(baselineKey)-daysAgo*DAY);
      if(profile.compareSameWeekday && weekday(day)!==weekday(baselineKey)) continue;
      if(profile.closedDates?.includes(day)) continue;
      const samples=window.map(hour=>{
        const matchingDay=dateFromMs(utcDateMs(day)+hour.dateOffset*DAY);
        return byHour.get(matchingDay+":"+hour.hour);
      });
      if(samples.every(reliable)) {
        historical.push(samples.reduce((sum,row)=>sum+(row?.units??0),0));
      }
    }
    if(historical.length<profile.minComparableDays) {insufficient=true;continue;}
    const typical=median(historical);
    const busyShare=historical.filter(value=>value>0).length/historical.length;
    if(typical >=profile.minTypicalUnits && busyShare>=profile.minActiveFraction) {
      return {
        outcome:"attention",hours:size,usualUnits:typical,
        evidenceDays:historical.length,activeDayRatio:busyShare,
        lastDecreaseAt:history.last_decrease_at,kind:profile.kind,
      };
    }
  }
  return {outcome:"skip",reason:insufficient?"insufficient_history":"normal_quiet_period"};
}
