import { Component, type ReactNode } from "react";

/** Keep navigation available when a destination or lazy chunk fails. */
export class WorkspaceBoundary extends Component<{
  children: ReactNode;
  onRecover?: () => void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="content workspace-panel" role="alert">
      <h2>This view could not open</h2>
      <p>Your saved records are still on this device. Try opening the view again, or return to Today.</p>
      <div className="record-actions">
        <button className="solid" onClick={() => this.setState({ failed: false })}>Try again</button>
        {this.props.onRecover && <button className="outline" onClick={this.props.onRecover}>Return to Today</button>}
      </div>
    </section>;
  }
}
