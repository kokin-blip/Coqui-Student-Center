import { createElement } from "react";
import type { ReactNode } from "react";
import { defineCustomElement as defineProgressBar } from "@ionic/core/components/ion-progress-bar.js";

defineProgressBar();

export function CoquiProgress({value,label}:{value:number;label:string}){
  return (
    <span className="coqui-progress" aria-label={label}>
      {createElement("ion-progress-bar", {
        value: Math.max(0, Math.min(1, value)),
      })}
    </span>
  );
}

/** A restrained, reduced-motion-safe adaptation of React Bits' content reveal. */
export function AnimatedContent({children,className=""}:{children:ReactNode;className?:string}){
  return <div className={`coqui-animated-content ${className}`.trim()}>{children}</div>;
}
