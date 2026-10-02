import { useState } from "react";
import { getGradeImportEvidence,type GradeImportEvidence } from "../../native";
export function GradeEvidence({gradeId}:{gradeId:string}){
 const [evidence,setEvidence]=useState<GradeImportEvidence[]|null>(null),[error,setError]=useState(false);
 const load=()=>{void getGradeImportEvidence(gradeId).then(setEvidence).catch(()=>setError(true));};
 return <details onToggle={e=>{if(e.currentTarget.open&&evidence===null&&!error)load();}}><summary>Grade source evidence</summary>{error?<p role="alert">Evidence could not be loaded. <button className="text-button" onClick={()=>{setError(false);load();}}>Retry evidence</button></p>:evidence===null?<p>Loading evidence…</p>:evidence.length?evidence.map((r,i)=><div key={i}><small>{r.fileName} · {r.locator} · {Math.round(r.confidence*100)}% extraction confidence</small><blockquote>{r.evidence}</blockquote>{(()=>{const row=JSON.parse(r.reviewedRow);return <p>Approved: {row.title} · {row.score??"Blank"}/{row.pointsPossible} · {row.status}</p>;})()}{r.sourceImage&&<img className="grade-source-image" src={r.sourceImage} alt="Original gradebook source"/>}</div>):<p>Student-entered grade; no imported source is recorded.</p>}</details>;
}
