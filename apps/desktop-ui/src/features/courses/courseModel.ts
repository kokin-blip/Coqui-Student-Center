import type {
  CourseInput,
  CourseRecord,
  InstructorRecord,
  ClassMeetingSeriesRecord,
} from "../../native";
export type CourseTab =
  | "overview"
  | "work"
  | "schedule"
  | "materials"
  | "grades";
export const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export const emptyInstructor = () => ({
  courseId: "",
  name: "",
  email: "",
  officeLocation: "",
  officeHours: "",
});
export const emptyMeeting = () => ({
  courseId: "",
  weekdays: [1, 3, 5],
  startsAtLocal: "09:00",
  endsAtLocal: "09:50",
  component: "lecture",
  location: "",
  modality: "",
  rotationIntervalWeeks: 1,
  rotationOffsetWeeks: 0,
});
export function createCourseSession() {
  return {
    selectedId: "",
    tab: "overview" as CourseTab,
    editorOpen: false,
    course: { title: "", code: "" } as CourseInput,
    courseEdit: null as CourseRecord | null,
    people: new Map<
      string,
      {
        form: ReturnType<typeof emptyInstructor>;
        edit: InstructorRecord | null;
      }
    >(),
    schedules: new Map<
      string,
      {
        form: ReturnType<typeof emptyMeeting>;
        edit: ClassMeetingSeriesRecord | null;
      }
    >(),
  };
}
