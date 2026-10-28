import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function mount(path, exportName, props, options = {}) {
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const refs = [];
  const states = [];
  let cursor = 0;
  let refreshed = 0;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!refs[index]) refs[index] = { current: initial };
      return refs[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!states[index]) states[index] = { value: typeof initial === "function" ? initial() : initial };
      return [states[index].value, (next) => {
        states[index].value = typeof next === "function" ? next(states[index].value) : next;
      }];
    },
    useEffect() {},
  };
  const exports = {};
  const importer = (name) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "react") return react;
    if (name === "react-dom") return { useFormStatus: () => ({ pending: false }) };
    if (name === "next/navigation") return { useRouter: () => ({ refresh() { refreshed++; } }) };
    if (name === "@/lib/buying-sources") return { sourcePriceText: () => "Price from recorded history" };
    if (name.endsWith(".module.css")) return { default: {} };
    throw Error("Unexpected import in isolated save test: " + name);
  };
  vm.runInNewContext(compiled, {
    exports,
    require: importer,
    fetch: options.fetch,
    window: { setTimeout() {} },
    FormData,
    console,
  }, { filename: path });
  const render = () => {
    cursor = 0;
    return exports[exportName](props);
  };
  return { render, get refreshed() { return refreshed; } };
}

function findNode(root, type) {
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = findNode(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!root || typeof root !== "object") return null;
  if (root.type === type) return root;
  return findNode(root.props?.children, type);
}

function deferredFetch() {
  let resolve;
  let calls = 0;
  const payloads = [];
  return {
    fetch: async (...args) => {
      calls++;
      payloads.push(args);
      return new Promise(r => { resolve = r; });
    },
    resolve: data => resolve({ ok:true, json:async()=>data }),
    get calls(){ return calls; },
    payloads,
  };
}

function monthForm() {
  const data = new FormData();
  data.set("rent_amount","500");
  data.set("agreement_type","fixed_rent");
  data.set("frequency","monthly");
  data.set("next_due_date","2026-11-01");
  data.set("recurring","yes");
  data.set("notice_days","7");
  return data;
}

test("real rent schedule form submits once on two immediate clicks and rejects an identical confirmed save", async()=>{
  const remote=deferredFetch();
  const view=mount("src/components/CrmLocationPaymentScheduleForm.tsx","CrmLocationPaymentScheduleForm",{
    locationId:"location-test",rentAmount:500,agreementType:"fixed_rent",frequency:"monthly",
    nextDueDate:"2026-11-01",recurring:true,noticeDays:7,ar:false,
  }, {fetch:remote.fetch});
  const form=findNode(view.render(),"form");
  assert.ok(form);
  const data=monthForm();
  const first=form.props.action(data);
  const second=form.props.action(data);
  assert.equal(remote.calls,1,"Synchronous in-flight guard prevents duplicate rent schedule RPCs");
  await second;
  remote.resolve({ok:true});
  await first;
  assert.equal(view.refreshed,1,"Refresh only after confirmed save");
  await form.props.action(data);
  assert.equal(remote.calls,1,"Repeated identical confirmed payload must not re-create rent obligation");
  const changed=monthForm(); changed.set("rent_amount","750");
  const next=form.props.action(changed);
  assert.equal(remote.calls,2,"A genuine change remains editable");
  remote.resolve({ok:true});
  await next;
});

test("real CRM obligation form submits once on two immediate clicks and retains stale version protection",async()=>{
  const remote=deferredFetch();
  const view=mount("src/components/CrmObligationAdminForm.tsx","CrmObligationAdminForm",{
    obligationId:"obligation-test",assignedTo:"staff-1",periodStart:"2026-10-01",
    periodEnd:"2026-12-01",version:"2026-10-28T10:00:00Z",directory:[{id:"staff-1",name:"Staff"}],
    ar:false,
  },{fetch:remote.fetch});
  const form=findNode(view.render(),"form");
  assert.ok(form);
  const data=new FormData();
  data.set("assigned_to","staff-1");
  data.set("period_start","2026-10");
  data.set("period_end","2026-12");
  const first=form.props.action(data);
  const second=form.props.action(data);
  assert.equal(remote.calls,1);
  await second;
  const request=JSON.parse(remote.payloads[0][1].body);
  assert.equal(request.version,"2026-10-28T10:00:00Z");
  remote.resolve({ok:true});
  await first;
  await form.props.action(data);
  assert.equal(remote.calls,1,"Same confirmed obligation assignment is not sent again");
});

test("real buying store instructions allow only one pending save and permit a later change",async()=>{
  let complete;
  const payloads=[];
  const save=payload=>{
    payloads.push(payload);
    return new Promise(resolve=>{complete=resolve;});
  };
  const view=mount("src/components/BuyingSourceEditor.tsx","BuyingSourceEditor",{
    item:{product_id:"product-test",units_per_box:24},
    source:{primary:{supplier_id:"supplier-a",name:"Store A"},alternative:null,note:""},
    sources:{options:[],stores:[{id:"supplier-a",name:"Store A"}]},ar:false,disabled:false,save,
  });
  const form=findNode(view.render(),"form");
  assert.ok(form);
  const event={preventDefault(){}};
  const first=form.props.onSubmit(event);
  const second=form.props.onSubmit(event);
  assert.equal(payloads.length,1);
  await second;
  assert.equal(payloads[0].primary_supplier_id,"supplier-a");
  complete();
  await first;
  const later=form.props.onSubmit(event);
  assert.equal(payloads.length,2,"Allow later edits after the prior request resolves");
  complete();
  await later;
});

test("actual shared Save button blocks a second tap synchronously before pending UI renders",()=>{
  const view=mount("src/components/FormSubmitButton.tsx","FormSubmitButton",{
    children:"Save", pendingLabel:"Saving...",disabled:false,
  });
  const button=findNode(view.render(),"button");
  assert.ok(button);
  function event(){
    let blocked=false;
    return {
      currentTarget:{form:{checkValidity:()=>true}},
      preventDefault(){ blocked=true; },
      get blocked(){return blocked;},
    };
  }
  const first=event();
  const second=event();
  button.props.onClick(first);
  button.props.onClick(second);
  assert.equal(first.blocked,false);
  assert.equal(second.blocked,true,"Second tap is blocked via ref, even before React rerender");
});
