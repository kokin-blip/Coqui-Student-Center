import { WorkspaceRouteProps, WorkspaceView } from "./WorkspaceView";

export function CalendarView(props: WorkspaceRouteProps) {
  return <WorkspaceView {...props} mode="timetable" />;
}
