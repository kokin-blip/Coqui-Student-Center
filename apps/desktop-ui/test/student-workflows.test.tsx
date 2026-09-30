import axe from "axe-core";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as native from "../src/native";
import { StudentCenter } from "../src/StudentCenter";
import { CourseGrades } from "../src/features/courses/CourseGrades";
import { StudyView } from "../src/components/StudyView";
import { WorkspaceBoundary } from "../src/components/WorkspaceBoundary";
import { QuickNotes } from "../src/features/student/QuickNotes";
import { DailyReview } from "../src/features/student/DailyReview";
import { workflowApi, defaultCheckinSettings, type WorkflowState } from "../src/features/student/workflowApi";
import { revealPlanBlock } from "../src/features/shell/revealPlanBlock";
import { TaskDetailsSession } from "../src/features/tasks/TaskDetailsSession";
import { CoursesView } from "../src/components/CoursesView";
import { WorkView } from "../src/components/WorkView";
import { CalendarView } from "../src/components/CalendarView";
const emptyStudy:native.StudyWorkspace={materials:[],artifacts:[],reviews:[],gradeCategories:[],gradeItems:[],courseGrades:[],gradingScales:[],gpaProjection:null};
beforeEach(()=>{window.history.replaceState({},"","/?demo");window.matchMedia=(query:string)=>({matches:false,media:query,onchange:null,addListener:()=>{},removeListener:()=>{},addEventListener:()=>{},removeEventListener:()=>{},dispatchEvent:()=>true});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test("native null grade values render both entry points and preserve zero",async()=>{
 const workspace=await native.getLocalWorkspace();const course=workspace.courses[0];
 const study={...emptyStudy,courseGrades:[{courseId:course.id,currentPercent:null,missingWorkImpact:0,projectedLetter:undefined,creditHours:3}]};
 const {rerender,unmount}=render(<CourseGrades study={study} courseId={course.id} onStudy={vi.fn()}/>);
 expect(screen.getByText("No grades yet")).toBeVisible();
 const withScore={...study,courseGrades:[{...study.courseGrades[0],currentPercent:0}],gradeItems:[{id:"grade-zero",courseId:course.id,title:"Quiz zero",score:0,pointsPossible:10,status:"graded" as const}]};
 rerender(<CourseGrades study={withScore} courseId={course.id} onStudy={vi.fn()}/>);expect(screen.getByText("0.0%")).toBeVisible();unmount();
 vi.spyOn(native,"getStudyWorkspace").mockResolvedValue(study);render(<StudyView onOpenAssistant={vi.fn()} initialTab="grades" initialCourseId={course.id}/>);
 expect(await screen.findByRole("heading",{name:"Grades and what-if planning"})).toBeVisible();expect(screen.queryByText(/Projected GPA/)).not.toBeInTheDocument();expect(screen.getByText(/No grades yet/)).toBeVisible();
});
test("native-shaped grades retain editing drafts on rejected save",async()=>{
 const workspace=await native.getLocalWorkspace();const course=workspace.courses[0];
 vi.spyOn(native,"getStudyWorkspace").mockResolvedValue({...emptyStudy,gradeItems:[{id:"grade",courseId:course.id,title:"Quiz",score:0,pointsPossible:10,status:"graded"}]});
 const save=vi.spyOn(native,"saveGradeItem").mockRejectedValueOnce(new Error("Save rejected"));const user=userEvent.setup();render(<StudyView onOpenAssistant={vi.fn()} initialTab="grades" initialCourseId={course.id}/>);
 await user.click(await screen.findByRole("button",{name:"Edit Quiz"}));await user.clear(screen.getByLabelText("Grade score"));await user.type(screen.getByLabelText("Grade score"),"5");await user.click(screen.getByRole("button",{name:"Save grade edits"}));expect(await screen.findByRole("alert")).toHaveTextContent("Save rejected");expect(screen.getByLabelText("Grade score")).toHaveValue(5);expect(save).toHaveBeenCalledWith(expect.objectContaining({id:"grade",score:5}));
});
test("no-course grades give a clear setup state",async()=>{
 const workspace=await native.getLocalWorkspace();vi.spyOn(native,"getLocalWorkspace").mockResolvedValue({...workspace,courses:[]});vi.spyOn(native,"getStudyWorkspace").mockResolvedValue(emptyStudy);render(<StudyView onOpenAssistant={vi.fn()} initialTab="grades"/>);expect(await screen.findByRole("heading",{name:"No courses yet"})).toBeVisible();
});
test("destination boundary exposes recovery without removing navigation",async()=>{
 const consoleError=vi.spyOn(console,"error").mockImplementation(()=>{});let failed=true;function Broken(){if(failed)throw new Error("render failure");return <p>Recovered content</p>;}
 const user=userEvent.setup();const recover=vi.fn();render(<><nav>Workspace navigation</nav><WorkspaceBoundary onRecover={recover}><Broken/></WorkspaceBoundary></>);
 expect(screen.getByRole("alert")).toHaveTextContent("This view could not open");expect(screen.getByText("Workspace navigation")).toBeVisible();failed=false;await user.click(screen.getByRole("button",{name:"Try again"}));expect(screen.getByText("Recovered content")).toBeVisible();consoleError.mockRestore();
});
test("deep-link reveal waits for lazy content and reports unavailable targets",async()=>{
 vi.useFakeTimers();const missing=vi.fn();const stop=revealPlanBlock("late",missing);const node=document.createElement("div");node.id="plan-block-late";document.body.append(node);await act(async()=>{});expect(node.classList.contains("deep-link-target")).toBe(true);stop();node.remove();revealPlanBlock("missing",missing);await act(async()=>vi.advanceTimersByTime(5000));expect(missing).toHaveBeenCalledOnce();
});
test("quick notes support local capture, search, pin, edit and confirmed deletion",async()=>{
 const user=userEvent.setup();render(<QuickNotes close={vi.fn()}/>);await screen.findByText("No quick notes yet");await user.type(screen.getByLabelText("Capture a thought"),"Remember the lab question");await user.click(screen.getByRole("button",{name:"Save note"}));expect(await screen.findByText("Remember the lab question")).toBeVisible();expect(screen.getByLabelText("Capture a thought")).toHaveFocus();expect((await axe.run(screen.getByRole("dialog",{name:"Quick notes"}),{rules:{"color-contrast":{enabled:false}}})).violations).toEqual([]);await user.click(screen.getByRole("button",{name:"Pin",exact:true}));await screen.findByRole("button",{name:"Unpin",exact:true});await user.type(screen.getByLabelText("Search quick notes"),"unmatched");expect(screen.getByText("No notes match. Try another search.")).toBeVisible();await user.clear(screen.getByLabelText("Search quick notes"));await user.click(screen.getByRole("button",{name:"Edit note"}));expect(screen.getByLabelText("Edit note")).toHaveValue("Remember the lab question");await user.click(screen.getByRole("button",{name:"Delete note"}));expect(within(screen.getByRole("region",{name:"Saved quick notes"})).getByText("Remember the lab question")).toBeVisible();await user.click(screen.getByRole("button",{name:"Confirm delete"}));expect(await screen.findByText("No quick notes yet")).toBeVisible();
});
const reviewState:WorkflowState={timezone:"America/Phoenix",settings:{...defaultCheckinSettings,enabled:true},checkin:{day:"2026-09-28",timezone:"America/Phoenix",dueAt:"2026-09-29T03:00:00Z",items:[{taskId:"t",title:"Biology paper",response:null,completed:false,unavailable:false,taskVersion:3}]},streak:{count:0,entries:[]}};
test("check-in changes task completion only after student confirmation, and reschedule opens the editor",async()=>{
 vi.spyOn(workflowApi,"state").mockResolvedValue(reviewState);const respond=vi.spyOn(workflowApi,"respond").mockResolvedValue(await native.getDashboard());const edit=vi.fn();const user=userEvent.setup();render(<DailyReview suppressed={false} onDashboard={vi.fn()} onEditTask={edit}/>);
 await user.click(await screen.findByRole("button",{name:"Review / reschedule"}));expect(edit).toHaveBeenCalledWith("t");expect(respond).not.toHaveBeenCalled();await user.click(screen.getByRole("button",{name:"Completed earlier"}));await user.type(screen.getByLabelText("Actual completion time (include timezone offset)"),"2026-09-28T18:00:00-07:00");expect(respond).not.toHaveBeenCalled();await user.click(screen.getByRole("button",{name:"Confirm completion time"}));expect(respond).toHaveBeenCalledWith(expect.objectContaining({expectedVersion:3,completedAt:"2026-09-28T18:00:00-07:00",action:"complete"}));
});
test("snooze and dismiss persist through the check-in API; suppressed surfaces never offer prompts",async()=>{
 const state=vi.spyOn(workflowApi,"state").mockResolvedValue(reviewState);const control=vi.spyOn(workflowApi,"control").mockResolvedValue();const user=userEvent.setup();const {rerender}=render(<DailyReview suppressed onDashboard={vi.fn()} onEditTask={vi.fn()}/>);expect(state).not.toHaveBeenCalled();rerender(<DailyReview suppressed={false} onDashboard={vi.fn()} onEditTask={vi.fn()}/>);await user.click(await screen.findByRole("button",{name:"Snooze 30 minutes"}));expect(control).toHaveBeenCalledWith("2026-09-28","snooze");await user.click(screen.getByRole("button",{name:"Dismiss this day"}));expect(control).toHaveBeenCalledWith("2026-09-28","dismiss");
});
test.each(["Courses","Study","Work","Calendar"])("%s load rejection stays visible and recoverable",async(destination)=>{
 vi.spyOn(native,"getLocalWorkspace").mockRejectedValue(new Error("Local records temporarily unavailable"));vi.spyOn(native,"getStudyWorkspace").mockRejectedValue(new Error("Local records temporarily unavailable"));vi.spyOn(native,"getCalendarAgenda").mockRejectedValue(new Error("Local records temporarily unavailable"));
 const props={onDashboard:vi.fn(),onImport:vi.fn(),onStudy:vi.fn()};render(<TaskDetailsSession>{destination==="Courses"?<CoursesView {...props}/>:destination==="Study"?<StudyView onOpenAssistant={vi.fn()}/>:destination==="Work"?<WorkView {...props}/>:<CalendarView {...props} canvasConnections={[]}/>}</TaskDetailsSession>);expect(await screen.findByText(/Local records temporarily unavailable/)).toBeVisible();
});

test("organized notes remain editable when optional AI status fails, with tags and offline templates",async()=>{
 const workspace=await native.getLocalWorkspace(),course=workspace.courses[0];
 vi.spyOn(native,"getStudyWorkspace").mockResolvedValue(emptyStudy);vi.spyOn(native,"listAiProviders").mockRejectedValue(new Error("AI status unavailable"));
 const save=vi.spyOn(native,"saveStudyNote").mockRejectedValueOnce(new Error("Revision changed"));const user=userEvent.setup();
 render(<StudyView onOpenAssistant={vi.fn()} initialTab="materials" initialCourseId={course.id}/>);
 await user.click(await screen.findByRole("button",{name:"Write a note"}));await user.type(screen.getByLabelText("Note title"),"Transcript outline");await user.selectOptions(screen.getByLabelText("Note format"),"outline");await user.click(screen.getByRole("button",{name:"Insert manual template"}));await user.type(screen.getByLabelText("Note tags"),"lecture, cells");await user.click(screen.getByRole("button",{name:"Save note"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("Revision changed");expect(screen.getByLabelText("Note title")).toHaveValue("Transcript outline");expect((screen.getByLabelText("Note content") as HTMLTextAreaElement).value).toContain("# Topic");expect(save).toHaveBeenCalledWith(expect.objectContaining({tags:["lecture","cells"],kind:"outline",expectedRevision:0}));
});

test("grounded drafts reset consent when inputs change and save edited previews only on explicit Save",async()=>{
 const workspace=await native.getLocalWorkspace(),course=workspace.courses[0];
 const material:native.StudyMaterial={id:"source",fileName:"meeting.txt",title:"Meeting",mime:"text/plain",courseIds:[course.id],segmentCount:1,materialType:"notes",topics:[],dateAdded:"2026-09-29T01:00:00Z",extractionStatus:"complete",source:"Student import",favorite:false,teacherProvided:false};
 vi.spyOn(native,"getStudyWorkspace").mockResolvedValue({...emptyStudy,materials:[material]});vi.spyOn(native,"listAiProviders").mockResolvedValue([{provider:"openai",model:"reviewed-model",connected:true,healthy:true,capabilities:["source_qa"],disclosureUrl:"https://example.invalid"}]);
 const prepared:native.PreparedStudyRequest={id:"prepared",provider:"openai",model:"reviewed-model",input:{kind:"notes",courseIds:[course.id],documentIds:["source"],prompt:"Organize ideas",title:""},sources:[{id:"section",locator:"Section 1",text:"Exact transcript"}],fingerprint:"scope",requestText:"Exact request instructions and SOURCE_JSON: Exact transcript"};
 vi.spyOn(native,"prepareStudyRequest").mockResolvedValue(prepared);
 const preview:native.StudyPreview={previewId:"preview",courseId:course.id,kind:"notes",title:"Meeting notes",content:"Generated draft",citations:[{sourceId:"section",locator:"Section 1",quote:"Exact transcript"}],sourceIds:["source"],provider:"openai",model:"reviewed-model"};
 const generate=vi.spyOn(native,"generateGroundedStudyArtifact").mockResolvedValue(preview),save=vi.spyOn(native,"saveStudyNote").mockResolvedValue(emptyStudy);const user=userEvent.setup();
 render(<StudyView onOpenAssistant={vi.fn()} initialCourseId={course.id}/>);await user.click(await screen.findByRole("checkbox",{name:"meeting.txt"}));await user.type(screen.getByLabelText("Request"),"Organize ideas");
 const consent=screen.getByRole("checkbox",{name:/I approve this request/});expect(consent).not.toBeChecked();await user.click(screen.getByRole("button",{name:"Review exact request"}));await waitFor(()=>expect(consent).toBeEnabled());await user.click(consent);await user.type(screen.getByLabelText("Request")," please");expect(consent).not.toBeChecked();expect(consent).toBeDisabled();expect(generate).not.toHaveBeenCalled();
 await user.click(screen.getByRole("button",{name:"Review exact request"}));await waitFor(()=>expect(consent).toBeEnabled());await user.click(consent);await user.click(screen.getByRole("button",{name:"Create cited result"}));await screen.findByLabelText("Editable draft");expect(save).not.toHaveBeenCalled();expect(consent).not.toBeChecked();await user.clear(screen.getByLabelText("Editable draft"));await user.type(screen.getByLabelText("Editable draft"),"Student-reviewed notes");await user.click(screen.getByRole("button",{name:"Save reviewed draft"}));await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({content:"Student-reviewed notes",previewId:"preview",sourceIds:["source"]})));
});

test("native-shaped empty grades remain usable across every course and Study section",async()=>{
 const workspace=await native.getLocalWorkspace(),course=workspace.courses[0];
 vi.spyOn(native,"getStudyWorkspace").mockResolvedValue({...emptyStudy,courseGrades:workspace.courses.map(c=>({courseId:c.id,currentPercent:null,missingWorkImpact:0,creditHours:3}))});
 const user=userEvent.setup();const {unmount}=render(<TaskDetailsSession><CoursesView onDashboard={vi.fn()} onImport={vi.fn()} onStudy={vi.fn()}/></TaskDetailsSession>);
 await screen.findByRole("heading",{name:"Courses",level:2});for(const name of ["Overview","Work","Schedule","Materials","Grades"]){await user.click(screen.getByRole("tab",{name,exact:true}));expect(screen.getByRole("tab",{name,exact:true})).toHaveAttribute("aria-selected","true");expect(screen.queryByText("This view could not open")).not.toBeInTheDocument();}unmount();
 render(<StudyView onOpenAssistant={vi.fn()} initialCourseId={course.id}/>);const sections=await screen.findByRole("navigation",{name:"Study sections"});for(const name of ["Learn","Materials","Grades"]){await user.click(within(sections).getByRole("button",{name,exact:true}));expect(within(sections).getByRole("button",{name,exact:true})).toHaveAttribute("aria-pressed","true");expect(screen.getByRole("heading",{name:"Study",exact:true})).toBeVisible();}expect(screen.getByText(/No grades yet/)).toBeVisible();
});

test("Study loading has a visible state and rejected local data can be retried",async()=>{
 let reject!:(e:Error)=>void;vi.spyOn(native,"getStudyWorkspace").mockImplementationOnce(()=>new Promise((_resolve,r)=>{reject=r;})).mockResolvedValue(emptyStudy);const user=userEvent.setup();render(<StudyView onOpenAssistant={vi.fn()}/>);expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();await act(async()=>reject(new Error("Local source unavailable")));expect(await screen.findByRole("alert")).toHaveTextContent("Local source unavailable");await user.click(screen.getByRole("button",{name:"Try again"}));expect(await screen.findByRole("heading",{name:"Ask selected materials"})).toBeVisible();
});


test("plan-block deep links leave Work, reset a browsed Today date, and close quick notes",async()=>{
 let notify!:()=>void;let target:native.NavigationTarget|null=null;
 vi.spyOn(native,"isDesktop").mockReturnValue(true);vi.spyOn(native,"takePendingNavigation").mockImplementation(async()=>target);vi.spyOn(native,"listenForNavigation").mockImplementation(async(handler)=>{notify=handler;return ()=>{};});vi.spyOn(workflowApi,"state").mockResolvedValue({settings:{...defaultCheckinSettings,offerDismissed:true},checkin:null,streak:{count:0,entries:[]}});
 const user=userEvent.setup();render(<StudentCenter/>);const nav=await screen.findByRole("navigation",{name:"Primary navigation"},{timeout:8000});await waitFor(()=>expect(notify).toBeDefined());await user.click(within(nav).getByRole("button",{name:"Work",exact:true}));await screen.findByRole("heading",{name:"Assignments & exams"});
 target={view:"plan-block",blockId:"read-6"};await act(async()=>notify());await waitFor(()=>expect(document.getElementById("plan-block-read-6")).toHaveClass("deep-link-target"));expect(within(nav).getByRole("button",{name:"Today",exact:true})).toHaveClass("active");
 await user.click(screen.getByRole("button",{name:"Previous day"}));await user.click(screen.getByRole("button",{name:"Quick notes",exact:true}));expect(await screen.findByRole("dialog",{name:"Quick notes"})).toBeVisible();await act(async()=>notify());await waitFor(()=>expect(document.getElementById("plan-block-read-6")).toHaveClass("deep-link-target"));expect(screen.queryByRole("dialog",{name:"Quick notes"})).not.toBeInTheDocument();
 await user.click(screen.getByRole("button",{name:"Show list"}));expect(document.getElementById("plan-block-read-6")).toBeInTheDocument();await act(async()=>notify());await waitFor(()=>expect(document.getElementById("plan-block-read-6")).toHaveFocus());
});


test("quick notes retain deleted associations visibly and let the student clear them before saving",async()=>{
 const workspace=await native.getLocalWorkspace();vi.spyOn(native,"getLocalWorkspace").mockResolvedValue({...workspace,courses:[],tasks:[]});
 const note={id:"00000000-0000-4000-8000-000000000999",content:"Keep this thought",courseId:"removed-course",taskId:"study-review-removed",pinned:false,revision:1,createdAt:"2026-09-29T00:00:00Z",updatedAt:"2026-09-29T00:00:00Z"};vi.spyOn(workflowApi,"notes").mockResolvedValue([note]);const save=vi.spyOn(workflowApi,"saveNote").mockResolvedValue([{...note,courseId:null,taskId:null,revision:2}]);
 const user=userEvent.setup();render(<QuickNotes close={vi.fn()}/>);await user.click(await screen.findByRole("button",{name:"Edit note"}));expect(screen.getByRole("option",{name:/Course unavailable/})).toHaveAttribute("value","removed-course");expect(screen.getByRole("option",{name:/Task unavailable/})).toHaveAttribute("value","study-review-removed");await user.selectOptions(screen.getByLabelText("Course"),"");await user.selectOptions(screen.getByLabelText("Task"),"");await user.click(screen.getByRole("button",{name:"Save note"}));await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({id:note.id,courseId:null,taskId:null,content:note.content,expectedRevision:1})));
});
