import { FileUp, Pencil, Search, Star, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  setStudyMaterialCourses,
  updateStudyMaterial,
  type StudyMaterial,
  type StudyMaterialInput,
  type StudyMaterialType,
} from "../../native";
import type { StudyViewModel } from "./studyModel";

const materialTypes: Array<{ value: StudyMaterialType; label: string }> = [
  { value: "textbook", label: "Textbooks" },
  { value: "slides", label: "Slides" },
  { value: "notes", label: "Notes" },
  { value: "syllabus", label: "Syllabus" },
  { value: "assignment_instructions", label: "Assignment instructions" },
  { value: "lab_instructions", label: "Lab instructions" },
  { value: "study_guide", label: "Study guides" },
  { value: "practice_exam", label: "Practice exams" },
  { value: "previous_quiz", label: "Previous quizzes" },
  { value: "previous_exam", label: "Previous exams" },
  { value: "worksheet", label: "Worksheets" },
  { value: "reference_sheet", label: "Reference sheets" },
  { value: "article", label: "Articles" },
  { value: "video", label: "Videos" },
  { value: "website", label: "Websites" },
  { value: "dataset", label: "Datasets" },
  { value: "other", label: "Other" },
];

const typeLabel = (value: string) => materialTypes.find((item) => item.value === value)?.label ?? value.replaceAll("_", " ");
const editInput = (material: StudyMaterial): StudyMaterialInput => ({
  documentId: material.id,
  title: material.title,
  materialType: material.materialType,
  courseIds: material.courseIds,
  topics: material.topics ?? [],
  relatedTargetId: material.relatedTargetId,
  source: material.source,
  favorite: material.favorite,
  teacherProvided: material.teacherProvided,
});

export function StudyMaterials({ vm }: { vm: StudyViewModel }) {
  const { act, busy, courses, study, tasks } = vm;
  const [query, setQuery] = useState("");
  const [courseFilter, setCourseFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<StudyMaterialInput | null>(null);
  const courseName = (id: string) => courses.find((course) => course.id === id)?.code || courses.find((course) => course.id === id)?.title || "Course";
  const groups = useMemo(() => {
    const filtered = study?.materials.filter((material) => {
      const haystack = `${material.title} ${material.materialType} ${material.source} ${(material.topics ?? []).join(" ")}`.toLowerCase();
      const matchesCourse = courseFilter === "all" || (courseFilter === "unclassified" ? material.courseIds.length === 0 : material.courseIds.includes(courseFilter));
      return haystack.includes(query.toLowerCase()) && matchesCourse && (typeFilter === "all" || material.materialType === typeFilter) && (statusFilter === "all" || material.extractionStatus === statusFilter) && (!favoritesOnly || material.favorite);
    }) ?? [];
    const grouped = new Map<string, StudyMaterial[]>();
    for (const material of filtered.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title))) {
      const coursesLabel = material.courseIds.length ? material.courseIds.map(courseName).join(" + ") : "Unclassified inbox";
      const key = `${coursesLabel} · ${typeLabel(material.materialType)}`;
      grouped.set(key, [...(grouped.get(key) ?? []), material]);
    }
    return [...grouped.entries()];
  }, [study, query, courseFilter, typeFilter, statusFilter, favoritesOnly, courses]);
  const extractionStatuses = [...new Set(study?.materials.map((material) => material.extractionStatus) ?? [])].sort();

  return (
    <section className="workspace-panel study-materials-panel">
      <div className="section-head"><div><h2>Course materials</h2><p>Organize each encrypted source by course and category. Only assigned courses can use it.</p></div></div>
      <div className="study-material-filters">
        <label className="scholarship-search"><Search /><input aria-label="Search materials" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, topics, and sources" /></label>
        <label className="field">Course<select value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)}><option value="all">All courses</option><option value="unclassified">Unclassified inbox</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.code || course.title}</option>)}</select></label>
        <label className="field">Type<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">All types</option>{materialTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
        <label className="field">Extraction<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option>{extractionStatuses.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</select></label>
        <label className="material-favorite-filter"><input type="checkbox" checked={favoritesOnly} onChange={(event) => setFavoritesOnly(event.target.checked)} /><Star /> Pinned only</label>
      </div>
      {groups.length ? <div className="material-groups">{groups.map(([group, materials]) => <section className="material-group" key={group}><h3>{group}</h3><div className="material-list">{materials.map((material) => {
        const editing = editingId === material.id && draft;
        const relatedTasks = tasks.filter((task) => !material.courseIds.length || !task.courseId || material.courseIds.includes(task.courseId));
        return <article className="material-row" key={material.id}>
          <div className="material-row-head"><div><strong>{material.title}</strong><small>{material.segmentCount} cited section{material.segmentCount === 1 ? "" : "s"} · {material.extractionStatus.replaceAll("_", " ")} · {material.source}</small>{material.topics?.length ? <small>{material.topics.join(" · ")}</small> : null}</div><div className="material-row-actions"><button className={material.favorite ? "icon-button active" : "icon-button"} aria-label={material.favorite ? `Unpin ${material.title}` : `Pin ${material.title}`} aria-pressed={material.favorite} disabled={busy} onClick={() => void act(() => updateStudyMaterial({...editInput(material),favorite:!material.favorite}), `${material.title} ${material.favorite ? "unpinned" : "pinned"}.`)}><Star /></button><button className="outline" onClick={() => { setEditingId(material.id); setDraft(editInput(material)); }}><Pencil /> Edit details</button></div></div>
          <fieldset className="course-chip-list"><legend>Course access</legend>{courses.map((course) => <label key={course.id}><input type="checkbox" checked={material.courseIds.includes(course.id)} disabled={busy} onChange={(event) => { const next = event.target.checked ? [...material.courseIds, course.id] : material.courseIds.filter((id) => id !== course.id); void act(() => setStudyMaterialCourses(material.id, next), `${material.fileName} course access updated.`); }} />{course.code || course.title}</label>)}</fieldset>
          {editing && <div className="material-editor"><div className="material-editor-head"><strong>Edit material details</strong><button className="icon-button" aria-label="Close material editor" onClick={() => {setEditingId(null);setDraft(null);}}><X /></button></div><div className="form-grid"><label className="field full">Title<input value={draft.title} maxLength={200} onChange={(event) => setDraft({...draft,title:event.target.value})}/></label><label className="field">Type<select value={draft.materialType} onChange={(event) => setDraft({...draft,materialType:event.target.value as StudyMaterialType})}>{materialTypes.map((type) => <option value={type.value} key={type.value}>{type.label}</option>)}</select></label><label className="field">Source<input value={draft.source} maxLength={120} onChange={(event) => setDraft({...draft,source:event.target.value})} placeholder="Teacher, publisher, self…" /></label><label className="field full">Topics<input value={draft.topics.join(", ")} onChange={(event) => setDraft({...draft,topics:event.target.value.split(",").map((topic)=>topic.trim()).filter(Boolean)})} placeholder="Cell biology, biomolecules" /></label><label className="field full">Related assignment or exam<select value={draft.relatedTargetId ?? ""} onChange={(event) => setDraft({...draft,relatedTargetId:event.target.value||undefined})}><option value="">None</option>{relatedTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div><div className="material-editor-flags"><label><input type="checkbox" checked={draft.teacherProvided} onChange={(event) => setDraft({...draft,teacherProvided:event.target.checked})}/> Teacher provided</label><label><input type="checkbox" checked={draft.favorite} onChange={(event) => setDraft({...draft,favorite:event.target.checked})}/> Pin this material</label></div><div className="modal-actions"><button className="outline" onClick={() => {setEditingId(null);setDraft(null);}}>Cancel</button><button className="solid" disabled={busy||!draft.title.trim()||!draft.source.trim()} onClick={() => void act(async () => {const result=await updateStudyMaterial(draft);setEditingId(null);setDraft(null);return result;},`${draft.title} details saved.`)}>Save details</button></div></div>}
        </article>;
      })}</div></section>)}</div> : <div className="empty-state"><FileUp /><strong>{study?.materials.length ? "No materials match these filters." : "No imported materials yet."}</strong><p>{study?.materials.length ? "Clear a filter or check the unclassified inbox." : "Use Bring in my schedule or the document vault to import a PDF, Word file, slides, image, or text."}</p></div>}
    </section>
  );
}
