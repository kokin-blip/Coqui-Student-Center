import {afterEach,expect,test,vi} from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { previewScheduleImport,previewGradeImport,pastedScheduleImage } from "../src/native";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
afterEach(()=>{delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;vi.clearAllMocks();});
test("the actual selected-file wrapper sends bytes and a Unicode basename to the dedicated native command",async()=>{
 Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});vi.mocked(invoke).mockResolvedValue({documentId:"doc",candidates:[]});
 const file=new File([new Uint8Array([137,80,78,71])],"schedule-大学.PNG",{type:""});Object.defineProperty(file,"arrayBuffer",{value:async()=>new Uint8Array([137,80,78,71]).buffer});
 await previewScheduleImport(file);expect(invoke).toHaveBeenCalledWith("preview_schedule_import",{path:null,fileName:"schedule-大学.PNG",bytes:new Uint8Array([137,80,78,71])});
 vi.mocked(invoke).mockClear();await previewScheduleImport("/tmp/schedule.pdf");expect(invoke).toHaveBeenCalledWith("preview_schedule_import",{path:"/tmp/schedule.pdf",fileName:null,bytes:null});
});
test("size validation precedes byte reading and grade images use their own reader",async()=>{
 Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});const file=new File([],"empty.png");await expect(previewScheduleImport(file)).rejects.toThrow("non-empty");expect(invoke).not.toHaveBeenCalled();
 const grade=new File(["grade"],"grade.png");Object.defineProperty(grade,"arrayBuffer",{value:async()=>new Uint8Array([1,2,3]).buffer});await previewGradeImport("course",grade);expect(invoke).toHaveBeenCalledWith("preview_grade_import",expect.objectContaining({courseId:"course",fileName:"grade.png"}));
});
test("paste into an input remains a paste rather than an import",()=>{const target=document.createElement("textarea");expect(pastedScheduleImage({target,clipboardData:{files:[new File(["image"],"image.png",{type:"image/png"})]}} as unknown as ClipboardEvent)).toBeNull();});
