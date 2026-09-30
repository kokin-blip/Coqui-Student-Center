/** Wait for a lazy destination to mount, and never search a different route. */
export function revealPlanBlock(blockId: string, unavailable: () => void, revealed?: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => reveal());
  const stop = () => { stopped = true; observer.disconnect(); if (timer) clearTimeout(timer); };
  const reveal = () => {
    if (stopped) return false;
    const element = document.getElementById(`plan-block-${blockId}`);
    if (!element) return false;
    stop();
    element.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth", block: "center" });
    (element instanceof HTMLButtonElement ? element : element.querySelector<HTMLButtonElement>("button"))?.focus({preventScroll:true});
    element.classList.add("deep-link-target");
    setTimeout(() => element.classList.remove("deep-link-target"), 2400);
    revealed?.(); return true;
  };
  if (!reveal()) { observer.observe(document.body, {childList:true,subtree:true});timer=setTimeout(()=>{stop();unavailable();},5000); }
  return stop;
}
