import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read=(file)=>readFileSync(file,"utf8");

test("Explicit denied and conflict replies are NOT described as uncertain saves",()=>{
 const api=read("src/app/api/cash-handling/route.ts");
 const ui=read("src/components/cash/CashReceiveWorkspace.tsx");
 assert.match(api,/const denied = \(\) => json\(\{ ok: false, code: 'denied', retryable: false \}/);
 assert.match(api,/retryable: code === 'uncertain' \|\| code === 'unavailable'/);
 assert.match(ui,/\["denied","conflict","invalid","photo"\]\.includes\(firstCode\)/);
 assert.match(ui,/\[400,403,409\]\.includes\(reply\.status\)/);
 assert.match(ui,/if\(code==="denied" \|\| reply\.status===403\)/);
 assert.match(ui,/if\(code==="conflict" \|\| reply\.status===409\)/);
 assert.match(ui,/if\(code==="invalid" \|\| reply\.status===400\)/);
 assert.doesNotMatch(ui,/const retryable=result\.retryable!==false/);
});

test("Only a true uncertain response may be retried, with the SAME request and cached reference",()=>{
 const ui=read("src/components/cash/CashReceiveWorkspace.tsx");
 assert.match(ui,/function requestKey\(id:string,action:string\)/);
 assert.match(ui,/sessionStorage\.setItem\(key,JSON\.stringify\(command\)\)/);
 assert.match(ui,/sessionStorage\.getItem\(key\)/);
 assert.match(ui,/const submitSameRequest=async\(\)/);
 assert.match(ui,/JSON\.stringify\(command\)/);
 assert.match(ui,/!definitelyRejected && !cashReceiptMatches\(command,reply\.body\)/);
 assert.match(ui,/reply\.body\.retryable!==false/);
 assert.match(ui,/try\{reply=await submitSameRequest\(\);\}catch/);
 assert.match(ui,/sessionStorage\.removeItem\(key\)/);
 assert.match(ui,/cashReceiptMatches\(command,result\)/);
 assert.match(ui,/if\(!physical\)/);
 assert.match(ui,/لا تنشئ عملية سحب أخرى ولا تدخل مبلغًا في Finance يدويًا/);
 assert.match(ui,/تحقّق من حالة الكيس الحالية/);
});

test("Server records safe rejection diagnostics without leaking user cash amounts",()=>{
 const api=read("src/app/api/cash-handling/route.ts");
 assert.match(api,/Cash command rejected: browser origin does not match request origin/);
 assert.match(api,/Existing request lookup refused/);
 assert.match(api,/Cash command was not committed/);
 assert.match(api,/errorCode: error\.code \?\? 'unknown'/);
 assert.match(api,/if \(!cashSameOrigin\(request\)\)/);
 assert.match(api,/snacky_cash_handover_receipt_v1/);
 assert.match(api,/snacky_cash_handover_command_v1/);
 assert.doesNotMatch(api,/console\.(log|warn|error)\(\s*JSON\.stringify\(command\)/i);
});

test("Existing physical cash-and-Finance integrity remains server-side and idempotent",()=>{
 const api=read("src/app/api/cash-handling/route.ts");
 const safe=read("src/lib/cash-handover.ts");
 assert.match(api,/snacky_cash_handover_receipt_v1/);
 assert.match(api,/if \(saved\.data\) return cashReceiptMatches\(command, saved\.data\)/);
 assert.match(safe,/r\.finance_posted === true/);
 assert.match(safe,/cashCents\(r\.amount\) === cashCents\(String\(command\.payload\.amount\)\)/);
 assert.doesNotMatch(api,/\.from\(['"]financial_transactions['"]\)\.insert/);
 assert.doesNotMatch(api,/service_role|set_config\('request\.jwt/);
});


test("A rejected stale request is replaced only AFTER a live custody-stage read, uncertain retries remain intact",()=>{
 const ui=read("src/components/cash/CashReceiveWorkspace.tsx");
 assert.match(ui,/async function verifyCurrentBoxStatus/);
 assert.match(ui,/\/api\/cash-handling\?id=\$\{encodeURIComponent\(selected\)\}&status=all/);
 assert.match(ui,/latest\.actions\.includes\(previousAction\) && wasDefinitivelyRejected/);
 assert.match(ui,/sessionStorage\.removeItem\(requestKey\(selected,previousAction\)\)/);
 assert.match(ui,/const wasDefinitivelyRejected=\["denied","invalid","conflict","photo"\]/);
 assert.match(ui,/else if\(latest\.actions\.includes\("count"\)\)/);
 assert.match(ui,/else if\(latest\.state==="counted"\)/);
 assert.match(ui,/void verifyCurrentBoxStatus\(\)/);
});
