import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {isTeamCreateRequestId,sameTeamCreatePayload} from "../src/lib/team-create-request.ts";

const id="86b0755d-023c-4097-8abf-e99b550eb78f";
const saved={full_name:"Test Employee",email:"staff@example.invalid",phone:null,
  role:"crm",roles:["crm"],crm_focus:"office",can_add_products:false,active_status:"active"};

test("team create IDs are actual UUIDs, not names, and saved details are verified before replay",()=>{
  assert.equal(isTeamCreateRequestId(id),true);
  for(const value of ["staff@example.invalid","Test Employee",null,0,"",undefined]){
    assert.equal(isTeamCreateRequestId(value),false);
  }
  assert.equal(sameTeamCreatePayload(saved,{...saved}),true);
  assert.equal(sameTeamCreatePayload({...saved,roles:null},{...saved,roles:[]}),true,
    "Legacy roleless rows are normalized before comparison");
  for(const different of [
    {...saved,full_name:"Other Employee"},
    {...saved,email:"someone-else@example.invalid"},
    {...saved,phone:"0900000"},
    {...saved,role:"operator",roles:["operator"]},
    {...saved,crm_focus:"field"},
    {...saved,can_add_products:true},
    {...saved,active_status:"inactive"},
  ]) assert.equal(sameTeamCreatePayload(saved,different),false,JSON.stringify(different));
});

test("team server rejects duplicate UUID before any new login creation or password reset",()=>{
  const action=readFileSync("src/lib/team-actions.ts","utf8");
  const page=readFileSync("src/app/team/new/page.tsx","utf8");
  const form=readFileSync("src/components/TeamMemberForm.tsx","utf8");
  assert.match(page,/createRequestId=\{randomUUID\(\)\}/);
  assert.match(form,/name="client_create_id" value=\{createRequestId \?\? ""\}/);
  const section=action.slice(action.indexOf("export async function createTeamMember("),
    action.indexOf("export async function updateTeamMember("));
  assert.match(section,/isTeamCreateRequestId\(clientCreateId\)/);
  assert.match(section,/\.insert\(\{id: clientCreateId,\.\.\.payload\}\)/);
  assert.match(section,/error\?\.code === "23505"/);
  assert.match(section,/sameTeamCreatePayload\(prior\.data, payload\)/);
  assert.match(section,/Review the saved record and login access/);
  assert.match(section,/idempotencyKey:.*create-team-member/);
  assert.ok(section.indexOf('if (error?.code === "23505")')<section.indexOf('createOrResetAuthUser(data.id'),
    "Reject duplicate before making an Auth user, changing roles, or resetting passwords");
  assert.doesNotMatch(section,/\.upsert\(\{/);
  assert.match(form,/FormSubmitButton pendingLabel="Saving team member/);
});
