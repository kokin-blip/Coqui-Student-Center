import { WorkspaceRouteProps, WorkspaceView } from "./WorkspaceView";

export function WorkView(props: WorkspaceRouteProps) {
  return <WorkspaceView {...props} mode="assignments" />;
}
