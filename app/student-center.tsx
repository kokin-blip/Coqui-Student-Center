"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bell, BookOpen, Brain, BriefcaseBusiness, CalendarDays, Check, ChevronRight,
  CircleHelp, FileUp, GraduationCap, Home, Inbox, LayoutGrid,
  ListChecks, Menu, MoreHorizontal, Play, RefreshCw, Search,
  Settings, Sparkles, Upload, WandSparkles, X, Zap
} from "lucide-react";

type EventItem = { id:string; time:string; title:string; meta:string; type:"class"|"study"|"work"; done?:boolean; duration:number };
type Modal = "import"|"review"|"replan"|"assistant"|null;

const initialEvents: EventItem[] = [
  { id:"stats", time:"9:00 AM", title:"Statistics 201", meta:"Science Hall 214 · 50 min", type:"class", done:true, duration:50 },
  { id:"reading", time:"10:30 AM", title:"Read Chapter 6: Social Influence", meta:"Psychology 101 · 35 min", type:"study", duration:35 },
  { id:"lunch", time:"12:00 PM", title:"Lunch + reset", meta:"Student Union · 45 min", type:"study", duration:45 },
  { id:"writing", time:"1:00 PM", title:"Draft research paper introduction", meta:"English 102 · Focus block · 45 min", type:"study", duration:45 },
  { id:"work", time:"3:30 PM", title:"Campus library shift", meta:"Work · 3 hr", type:"work", duration:180 },
];

const candidates = [
  { title:"Research paper: Social media and identity", meta:"English 102 · Due Friday, Aug 14 at 11:59 PM", confidence:"98%" },
  { title:"Statistics problem set 4", meta:"Statistics 201 · Due Monday, Aug 17 at 9:00 AM", confidence:"96%" },
  { title:"Chapter 6 response", meta:"Psychology 101 · Due Tuesday, Aug 18 at 5:00 PM", confidence:"91%" },
];

export function StudentCenter() {
  const [events,setEvents]=useState(initialEvents);
  const [modal,setModal]=useState<Modal>(null);
  const [imported,setImported]=useState(false);
  const [toast,setToast]=useState("");
  const [replanReason,setReplanReason]=useState("I woke up late");
  const [started,setStarted]=useState(false);

  useEffect(()=>{ if(!toast)return; const timer=setTimeout(()=>setToast(""),2800); return()=>clearTimeout(timer); },[toast]);
  useEffect(()=>{ if("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>undefined); },[]);

  const remaining=useMemo(()=>events.filter(event=>!event.done).reduce((sum,event)=>sum+event.duration,0),[events]);
  const complete=(id:string)=>{ setEvents(items=>items.map(item=>item.id===id?{...item,done:!item.done}:item)); setToast("Progress saved — your plan is up to date."); };
  const replan=()=>{ setEvents(items=>items.map(item=>item.id==="reading"?{...item,time:"11:15 AM"}:item.id==="writing"?{...item,time:"1:30 PM"}:item)); setModal(null); setToast(`Plan rebuilt for “${replanReason}” — fixed commitments stayed put.`); };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><GraduationCap size={20}/></span><span>Student Center</span></div>
      <div className="nav-label">Today</div>
      <nav className="nav" aria-label="Main navigation">
        <button className="nav-item active"><Home/><span>My Day</span></button>
        <button className="nav-item"><CalendarDays/><span>Calendar</span></button>
        <button className="nav-item"><BookOpen/><span>Academics</span></button>
        <button className="nav-item"><Inbox/><span>Inbox</span></button>
      </nav>
      <div className="nav-label">Plan ahead</div>
      <nav className="nav" aria-label="Future navigation">
        <button className="nav-item"><GraduationCap/><span>Future</span></button>
        <button className="nav-item"><BriefcaseBusiness/><span>Career</span></button>
      </nav>
      <div className="sidebar-foot">
        <button className="nav-item"><Settings/><span>Settings</span></button>
        <div className="student-chip"><div className="avatar">AM</div><div className="student-meta"><strong>Alex Morgan</strong><span>Fall semester</span></div></div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="crumb"><LayoutGrid size={15}/><span>My Day</span><ChevronRight size={13}/><span>Overview</span></div>
        <div className="status-actions"><span className="sync"><i className="sync-dot"/>All changes saved</span><button className="icon-btn" aria-label="Search"><Search/></button><button className="icon-btn" aria-label="Notifications"><Bell/></button><button className="icon-btn" aria-label="More"><MoreHorizontal/></button></div>
      </header>

      <div className="content">
        <div className="page-head"><div><div className="eyebrow">Wednesday, August 12</div><h1>Good morning, Alex.</h1><p className="subtitle">Your day has breathing room. Let’s keep it that way.</p></div><div className="date-pill"><CalendarDays size={15}/> Week 3 · Fall semester</div></div>

        <div className="hero-grid">
          <section className="next-card" aria-labelledby="next-title">
            <div className="next-top"><span className="next-label"><Zap size={14}/> Your next best action</span><span className="time-chip">35 minutes</span></div>
            <h2 id="next-title">Read Chapter 6: Social Influence</h2>
            <p>This fits the window before lunch and prepares you for tomorrow’s Psychology 101 discussion.</p>
            <div className="next-actions"><button className="primary" onClick={()=>{setStarted(!started);setToast(started?"Session paused. Your progress is safe.":"Focus session started — you’ve got this.");}}><Play/>{started?"Pause session":"Start this now"}</button><button className="ghost" onClick={()=>setModal("replan")}>Choose another</button><span className="why"><CircleHelp/> Why this action?</span></div>
          </section>
          <aside className="capacity-card"><span className="card-kicker">Today’s capacity</span><div className="capacity-line"><strong>{Math.floor(remaining/60)}h {remaining%60}m</strong><span>planned</span></div><div className="meter"><span style={{width:`${Math.min(100,Math.round(remaining/510*100))}%`}}/></div><div className="capacity-detail"><div><strong>2h 10m</strong><span>focused work</span></div><div><strong>1h 35m</strong><span>open buffer</span></div></div></aside>
        </div>

        <div className="section-head"><h2>Today’s plan</h2><button className="text-btn" onClick={()=>setModal("replan")}><RefreshCw/> Replan my day</button></div>
        <div className="timeline-layout">
          <section className="timeline" aria-label="Today’s timeline">
            {events.map((event,index)=><div key={event.id}>
              {index===1&&<div className="timeline-row" style={{minHeight:20}}><div/><div className="now-marker">NOW</div></div>}
              <div className="timeline-row"><div className="timeline-time">{event.time}</div><div className="rail"><i className="dot"/></div><article className={`event ${event.type} ${event.done?"done":""}`}><div><div className="event-title">{event.title}</div><div className="event-meta"><span>{event.meta}</span></div></div><div style={{display:"flex",alignItems:"center",gap:8}}><span className="event-tag">{event.type}</span><button className="check" aria-label={`Mark ${event.title} ${event.done?"incomplete":"complete"}`} onClick={()=>complete(event.id)}>{event.done&&<Check/>}</button></div></article></div>
            </div>)}
          </section>

          <aside className="side-stack">
            <section className="small-card"><div className="small-head"><h3>Coming up</h3><span className="badge">3 deadlines</span></div><div className="due-list"><Due day="14" month="Aug" title="Research paper outline" meta="English 102 · Friday"/><Due day="17" month="Aug" title="Problem set 4" meta="Statistics 201 · Monday"/><Due day="18" month="Aug" title="Discussion response" meta="Psychology 101 · Tuesday"/></div><div className="progress-row"><span>Week prepared</span><strong>72%</strong></div></section>
            <section className="small-card"><div className="small-head"><h3>Quick capture</h3></div><div className="quick-grid"><button className="quick" onClick={()=>setModal("import")}><FileUp/> Import work</button><button className="quick" onClick={()=>setModal("assistant")}><Brain/> Brain dump</button><button className="quick" onClick={()=>setToast("New task ready for details.")}><ListChecks/> Add a task</button><button className="quick" onClick={()=>setModal("replan")}><WandSparkles/> Adjust day</button></div></section>
          </aside>
        </div>
      </div>
    </main>

    <button className="fab" onClick={()=>setModal("assistant")}><Sparkles/><span>Ask Student Center</span></button>
    <nav className="mobile-nav" aria-label="Mobile navigation"><button className="active"><Home/>My Day</button><button><CalendarDays/>Calendar</button><button><BookOpen/>Academics</button><button onClick={()=>setModal("assistant")}><Sparkles/>AI</button><button><Menu/>More</button></nav>

    {modal==="import"&&<ModalShell title="Bring in your student life" description="Upload a syllabus, calendar, image, or Office file. Nothing changes until you review it." close={()=>setModal(null)}><div className="dropzone"><Upload/><strong>Choose a file or drop it here</strong><span>PDF, image, ICS, Word, Excel, CSV, or PowerPoint · up to 25 MB</span></div><div className="modal-actions"><button className="outline" onClick={()=>setModal(null)}>Cancel</button><button className="solid" onClick={()=>setModal("review")}>Use sample syllabus</button></div></ModalShell>}
    {modal==="review"&&<ModalShell title="Review what we found" description="Every item is linked to its source. Confirm the details before adding them to your plan." close={()=>setModal(null)}><div className="candidate-list">{candidates.map(candidate=><label className="candidate" key={candidate.title}><input type="checkbox" defaultChecked/><span><strong>{candidate.title}</strong><span>{candidate.meta}</span></span><span className="confidence">{candidate.confidence} match</span></label>)}</div><div className="modal-actions"><button className="outline" onClick={()=>setModal("import")}>Back</button><button className="solid" onClick={()=>{setImported(true);setModal(null);setToast("3 assignments imported and included in your plan.");}}>Approve 3 items</button></div></ModalShell>}
    {modal==="replan"&&<ModalShell title="What changed?" description="Completed work and fixed commitments will stay exactly where they are." close={()=>setModal(null)}><div className="replan-options">{["I woke up late","This took longer","I have less energy","Replan everything after now"].map(reason=><button key={reason} className={`replan-option ${replanReason===reason?"active":""}`} onClick={()=>setReplanReason(reason)}>{reason}</button>)}</div><div className="modal-actions"><button className="outline" onClick={()=>setModal(null)}>Keep current plan</button><button className="solid" onClick={replan}>Build a realistic plan</button></div></ModalShell>}
    {modal==="assistant"&&<ModalShell title="Tell me what’s on your mind" description="I’ll turn a messy brain dump into proposed tasks and commitments for you to review." close={()=>setModal(null)}><label style={{display:"block",fontSize:11,fontWeight:800,marginBottom:7}} htmlFor="brain-dump">Brain dump</label><textarea id="brain-dump" defaultValue="I need to finish my paper outline, pick up groceries after work, and I want to be asleep by 11." style={{width:"100%",minHeight:130,border:"1px solid var(--line)",borderRadius:14,padding:13,resize:"vertical",font:"inherit"}}/><div className="modal-actions"><button className="outline" onClick={()=>setModal(null)}>Cancel</button><button className="solid" onClick={()=>{setModal(null);setToast("Brain dump structured into 3 reviewable actions.");}}>Structure my day</button></div></ModalShell>}
    {toast&&<div className="toast" role="status"><span className="confetti">✦</span> {toast}</div>}
    {imported&&<span className="sr-only">Sample syllabus imported</span>}
  </div>;
}

function Due({day,month,title,meta}:{day:string;month:string;title:string;meta:string}) { return <div className="due"><div className="datebox"><strong>{day}</strong><span>{month}</span></div><div><div className="due-title">{title}</div><div className="due-meta">{meta}</div></div></div>; }
function ModalShell({title,description,close,children}:{title:string;description:string;close:()=>void;children:React.ReactNode}) { return <div className="overlay" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)close();}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-head"><div><h2 id="modal-title">{title}</h2><p>{description}</p></div><button className="close" onClick={close} aria-label="Close"><X size={18}/></button></div>{children}</section></div>; }
