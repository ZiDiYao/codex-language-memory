/** Interruptible motion with immediate results when reduced motion is preferred. */
const running = new WeakMap();
const preference = matchMedia("(prefers-reduced-motion: reduce)");

export async function animate(node, frames, duration = 180, onFrame) {
  running.get(node)?.cancel();
  if (preference.matches || !node.animate) {
    running.delete(node);
    onFrame?.(1);
    return true;
  }
  const animation = node.animate(frames, {
    duration,
    easing: "cubic-bezier(.2,.8,.2,1)",
  });
  running.set(node, animation);
  let frame;
  const follow = () => {
    if (running.get(node) !== animation) return;
    onFrame(animation.effect.getComputedTiming().progress ?? 0);
    frame = requestAnimationFrame(follow);
  };
  if (onFrame) frame = requestAnimationFrame(follow);
  const finish = () => animation.finish();
  preference.addEventListener("change", finish, { once: true });
  try {
    await animation.finished;
    if (running.get(node) === animation) onFrame?.(1);
    return running.get(node) === animation;
  } catch {
    return false;
  } finally {
    cancelAnimationFrame(frame);
    preference.removeEventListener("change", finish);
    if (running.get(node) === animation) running.delete(node);
  }
}

export function enter(node, distance = 6, duration = 180) {
  return animate(node, [
    { opacity: 0, transform: `translateY(${distance}px)` },
    { opacity: 1, transform: "translateY(0)" },
  ], duration);
}

export async function reveal(node) {
  const wasHidden = node.hidden;
  const opacity = wasHidden ? 0 : getComputedStyle(node).opacity;
  const transform = wasHidden ? "translateY(-4px)" : getComputedStyle(node).transform;
  node.hidden = false;
  node.inert = false;
  return animate(node, [{ opacity, transform }, { opacity: 1, transform: "translateY(0)" }], 140);
}

export async function conceal(node) {
  if (node.hidden) return;
  node.inert = true;
  const style = getComputedStyle(node);
  if (await animate(node, [
    { opacity: style.opacity, transform: style.transform },
    { opacity: 0, transform: "translateY(-3px)" },
  ], 100)) node.hidden = true;
}

export function openDialog(dialog) {
  delete dialog.dataset.closing;
  if (!dialog.open) dialog.showModal();
  enter(dialog, 10, 220);
}

export async function closeDialog(dialog) {
  if (!dialog.open || dialog.dataset.closing) return;
  dialog.dataset.closing = "true";
  const style = getComputedStyle(dialog);
  if (await animate(dialog, [
    { opacity: style.opacity, transform: style.transform },
    { opacity: 0, transform: "translateY(6px) scale(.985)" },
  ], 140)) {
    dialog.close();
    delete dialog.dataset.closing;
  }
}

export function disclosure(details, summary, body, onChange, beforeClose) {
  let revision = 0;
  let scrollSpace;
  const reflect = (open) => {
    summary.setAttribute("aria-expanded", String(open));
    body.inert = !open;
    onChange(open);
  };
  reflect(details.open);
  details.addEventListener("toggle", () => {
    if (!details.dataset.animating) reflect(details.open);
  });
  summary.addEventListener("click", async (event) => {
    event.preventDefault();
    const request = ++revision;
    const open = !(details.dataset.animating ? details.dataset.expanded === "true" : details.open);
    if (!open && beforeClose && !(await beforeClose())) return;
    if (request !== revision) return;
    const from = details.getBoundingClientRect().height;
    const documentHeight = Math.max(window.innerHeight, document.body.offsetHeight);
    const scrollStart = window.scrollY;
    // Hold the current size while the summary and editor change their layout.
    details.style.height = `${from}px`;
    details.dataset.animating = "true";
    details.dataset.expanded = String(open);
    details.open = true;
    reflect(open);
    const border = parseFloat(getComputedStyle(details).borderTopWidth) * 2;
    const to = summary.offsetHeight + (open ? body.offsetHeight : 0) + border;
    const scrollEnd = Math.min(scrollStart, Math.max(0, documentHeight - from + to - window.innerHeight));
    const input = new AbortController();
    let following = !open && scrollEnd < scrollStart;
    if (following) {
      // A short final page cannot accommodate the old scroll offset. Reserve that
      // space until both transitions finish, including when the motion reverses.
      if (!scrollSpace) {
        scrollSpace = document.createElement("div");
        scrollSpace.className = "disclosure-scroll-space";
        scrollSpace.setAttribute("aria-hidden", "true");
        document.body.append(scrollSpace);
      }
      scrollSpace.style.height = `${Math.ceil(window.innerHeight + scrollStart)}px`;
      // Give scrolling back immediately if the user interacts during the transition.
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
        window.addEventListener(type, () => { following = false; }, { passive: true, signal: input.signal });
      }
    }
    const finished = animate(details, [{ height: `${from}px` }, { height: `${to}px` }], 280, following ? (progress) => {
      if (following) window.scrollTo({ top: scrollStart + (scrollEnd - scrollStart) * progress, behavior: "instant" });
    } : undefined);
    // The final size must also be the underlying style when the animation finishes.
    details.style.height = `${to}px`;
    const completed = await finished;
    input.abort();
    if (completed) {
      details.open = open;
      details.style.removeProperty("height");
      scrollSpace?.remove();
      scrollSpace = null;
      delete details.dataset.animating;
      delete details.dataset.expanded;
    }
  });
}
