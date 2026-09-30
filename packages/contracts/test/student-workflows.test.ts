import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckinSettings, QuickNoteInput, PreparedStudyConsent, StudyNoteInput, CheckinResponse } from "../src/student-workflows.js";
const id="00000000-0000-4000-8000-000000000100";
test("workflow contracts require explicit consent, valid local times and bounded revision-checked content",()=>{
 assert.equal(CheckinSettings.safeParse({enabled:true,time:"24:00",followRhythm:true,offerDismissed:false,streakVisible:true}).success,false);
 const note={expectedRevision:0,content:"sticky",courseId:null,taskId:null,pinned:false};assert.equal(QuickNoteInput.safeParse(note).success,true);assert.equal(QuickNoteInput.safeParse({...note,taskId:`study-review-${id}`}).success,true);assert.equal(QuickNoteInput.safeParse({...note,content:" ",revision:1}).success,false);
 assert.equal(PreparedStudyConsent.safeParse({preparedId:id,expectedProvider:"openai",expectedModel:"model",consent:false}).success,false);
 assert.equal(CheckinResponse.safeParse({day:"2026-09-29",taskId:id,action:"complete",expectedVersion:1,completedAt:"2026-09-29T18:00:00-07:00"}).success,true);
 assert.equal(CheckinResponse.safeParse({day:"2026-09-29",taskId:`study-review-${id}`,action:"in_progress",expectedVersion:1,completedAt:null}).success,true);
 assert.equal(StudyNoteInput.safeParse({expectedRevision:0,courseId:id,kind:"slides",title:"Draft",content:"# Slide 1",tags:[],pinned:false,sourceIds:[]}).success,true);
});
