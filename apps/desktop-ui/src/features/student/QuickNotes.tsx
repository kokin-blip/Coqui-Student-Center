import { useEffect, useRef, useState } from "react";
import { StickyNote } from "lucide-react";
import { Modal } from "../../components/Modal";
import { getLocalWorkspace, type WorkspaceSnapshot } from "../../native";
import { workflowApi, type NoteInput, type QuickNote } from "./workflowApi";
import "./student.css";
export function QuickNotes({close, courseId, taskId}:{close:()=>void;courseId?:string;taskId?:string}) {
  const captureRef=useRef<HTMLTextAreaElement>(null);
  const empty = (): NoteInput => ({content:"",courseId:courseId??null,taskId:taskId??null,pinned:false,expectedRevision:0});
  const [notes,setNotes]=useState<QuickNote[]>([]), [draft,setDraft]=useState<NoteInput>(empty), [workspace,setWorkspace]=useState<WorkspaceSnapshot|null>(null);
  const [query,setQuery]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[deleting,setDeleting]=useState<QuickNote|null>(null),[notice,setNotice]=useState("");
  const load=async()=>{try {const [n,w]=await Promise.all([workflowApi.notes(),getLocalWorkspace()]);setNotes(n);setWorkspace(w);}catch(e){setError(String(e));}};
  useEffect(()=>{void load();},[]);
  const run=async(action:()=>Promise<QuickNote[]>)=>{setBusy(true);setError("");try{setNotes(await action());return true;}catch(e){setError(String(e));return false;}finally{setBusy(false);}};
  const save=async()=>{if(await run(()=>workflowApi.saveNote(draft))){setDraft(empty());captureRef.current?.focus();setNotice("Note saved locally.");}};
  const edit=(n:QuickNote)=>{setDraft({id:n.id,expectedRevision:n.revision,content:n.content,courseId:n.courseId,taskId:n.taskId,pinned:n.pinned});setDeleting(null);captureRef.current?.focus();};
  return <Modal className="quick-notes-dialog" title="Quick notes" subtitle="Short thoughts, kept on this device. Use course Materials for longer notes." close={close}>
    {error&&<p role="alert" className="error-summary">{error} <button onClick={()=>void load()}>Reload notes</button></p>}
    {notice&&<p role="status" className="quick-notes-notice">{notice}</p>}
    <div className="quick-notes-workspace">
      <form className="quick-note-editor" onSubmit={e=>{e.preventDefault();void save();}} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault();void save();}}}>
        <div className="quick-note-capture"><label className="field">{draft.id?"Edit note":"Capture a thought"}<textarea ref={captureRef} rows={7} maxLength={4000} placeholder="What would you like to remember?" aria-describedby="quick-note-help" value={draft.content} onChange={e=>setDraft({...draft,content:e.target.value})}/></label>
        <div id="quick-note-help" className="quick-note-help"><span>{draft.content.length.toLocaleString()}/4,000</span><span>Ctrl/⌘ Enter to save</span></div></div>
        <div className="form-grid quick-note-links">
          <label className="field">Course<select value={draft.courseId??""} onChange={e=>setDraft({...draft,courseId:e.target.value||null})}><option value="">Unassigned</option>{draft.courseId&&workspace&&!workspace.courses.some(c=>c.id===draft.courseId)&&<option value={draft.courseId}>Course unavailable — choose Unassigned</option>}{workspace?.courses.map(c=><option key={c.id} value={c.id}>{c.code||c.title}</option>)}</select></label>
          <label className="field">Task<select value={draft.taskId??""} onChange={e=>setDraft({...draft,taskId:e.target.value||null})}><option value="">None</option>{draft.taskId&&workspace&&!workspace.tasks.some(t=>t.id===draft.taskId)&&<option value={draft.taskId}>Task unavailable — choose None</option>}{workspace?.tasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        </div>
        <div className="quick-note-footer"><label className="check-row"><input type="checkbox" checked={draft.pinned} onChange={e=>setDraft({...draft,pinned:e.target.checked})}/> Pin note</label>
        <div className="record-actions"><button type="button" className="text-button" onClick={()=>{setDraft(empty());captureRef.current?.focus();}}>New note</button><button className="solid" disabled={busy||!draft.content.trim()}>Save note</button></div></div>
      </form>
      <section className="quick-notes-library" aria-label="Saved quick notes"><h3>Saved notes</h3><label className="field"><span className="sr-only">Search quick notes</span><input type="search" placeholder="Search your notes…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
        {!notes.length&&<div className="empty-state"><StickyNote aria-hidden="true"/><strong>No quick notes yet</strong><p>Capture a thought to get started.</p></div>}
        {notes.length>0&&!notes.some(n=>n.content.toLowerCase().includes(query.toLowerCase()))&&<div className="empty-state"><strong>No matching notes</strong><p>No notes match. Try another search.</p></div>}
        {notes.filter(n=>n.content.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt)).map(n=><article key={n.id} className="quick-note">
          <p className="note-content">{n.content}</p><small>{n.pinned?"Pinned · ":""}{workspace?.courses.find(c=>c.id===n.courseId)?.code??(n.courseId?"Course unavailable":"Unassigned")}{n.taskId?` · ${workspace?.tasks.find(t=>t.id===n.taskId)?.title??"Task unavailable"}`:""}</small>
          <div className="record-actions"><button className="outline" onClick={()=>edit(n)}>Edit note</button><button className="outline" disabled={busy} onClick={()=>void run(()=>workflowApi.saveNote({...n,expectedRevision:n.revision,pinned:!n.pinned}))}>{n.pinned?"Unpin":"Pin"}</button><button className="text-button danger" onClick={()=>setDeleting(n)}>Delete note</button></div>
          {deleting?.id===n.id&&<div role="group" aria-label="Confirm note deletion"><p>Delete this note? This cannot be undone.</p><button className="outline danger" disabled={busy} onClick={()=>void run(()=>workflowApi.deleteNote(n.id,n.revision)).then(ok=>{if(ok){setDeleting(null);if(draft.id===n.id)setDraft(empty());}})}>Confirm delete</button><button className="text-button" onClick={()=>setDeleting(null)}>Keep note</button></div>}
        </article>)}
      </section>
    </div>
  </Modal>;
}
