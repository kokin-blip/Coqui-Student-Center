import type { ReactNode } from "react";
import { IonProgressBar } from "@ionic/react";

export function CoquiProgress({value,label}:{value:number;label:string}){
  return <span className="coqui-progress" aria-label={label}><IonProgressBar value={Math.max(0,Math.min(1,value))}/></span>;
}

/** A restrained, reduced-motion-safe adaptation of React Bits' content reveal. */
export function AnimatedContent({children,className=""}:{children:ReactNode;className?:string}){
  return <div className={`coqui-animated-content ${className}`.trim()}>{children}</div>;
}
