import { WorkspaceRouteProps, WorkspaceView } from "./WorkspaceView";

export function AcademicSettingsView(props: WorkspaceRouteProps) {
  return <WorkspaceView {...props} mode="settings" />;
}
