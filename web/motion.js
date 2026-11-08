/** Interruptible motion with immediate results when reduced motion is preferred. */
const running = new WeakMap();
const preference = matchMedia("(prefers-reduced-motion: reduce)");

export async function animate(node, frames, duration = 180) {
  running.get(node)?.cancel();
  if (preference.matches || !node.animate) {
    running.delete(node);
    return true;
  }
  const animation = node.animate(frames, {
    duration,
    easing: "cubic-bezier(.2,.8,.2,1)",
  });
  running.set(node, animation);
  const finish = () => animation.finish();
  preference.addEventListener("change", finish, { once: true });
  try {
    await animation.finished;
    return running.get(node) === animation;
  } catch {
    return false;
  } finally {
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
    const open = !(details.dataset.animating ? details.dataset.expanded === "true" : details.open);
    if (!open && beforeClose && !(await beforeClose())) return;
    const from = details.getBoundingClientRect().height;
    details.dataset.animating = "true";
    details.dataset.expanded = String(open);
    details.open = true;
    reflect(open);
    const border = parseFloat(getComputedStyle(details).borderTopWidth) * 2;
    const to = summary.offsetHeight + (open ? body.offsetHeight : 0) + border;
    if (await animate(details, [{ height: `${from}px` }, { height: `${to}px` }], 220)) {
      details.open = open;
      delete details.dataset.animating;
      delete details.dataset.expanded;
    }
  });
}
