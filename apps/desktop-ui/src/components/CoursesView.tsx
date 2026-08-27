import { WorkspaceRouteProps, WorkspaceView } from "./WorkspaceView";

export function CoursesView(props: WorkspaceRouteProps) {
  return <WorkspaceView {...props} mode="courses" />;
}
