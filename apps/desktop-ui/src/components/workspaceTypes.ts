import type { CanvasConnection, Dashboard } from "../native";

export type WorkspaceRouteProps = {
  onDashboard: (dashboard: Dashboard) => void;
  onImport: () => void;
  onStudy: () => void;
  onConnections?: () => void;
  canvasConnections?: CanvasConnection[];
};
