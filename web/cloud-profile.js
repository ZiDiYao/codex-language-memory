/** Cloud account controls. Display only profile fields already supplied by the SDK. */
export function profileDetails(user) {
  const clean = (value, maximum) => typeof value === "string" && value.trim() && value.trim().length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : null;
  const name = clean(user?.name, 160);
  const email = clean(user?.email, 254);
  const visibleName = name && name !== user?.sub ? name : null;
  const visibleEmail = email && email !== user?.sub && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
  return { primary: visibleName || visibleEmail, secondary: visibleName && visibleEmail && visibleName !== visibleEmail ? visibleEmail : null };
}

export function loginRedirectOptions(mode = "login") {
  return { appState: { returnTo: "/" }, ...(mode === "signup" ? { authorizationParams: { screen_hint: "signup" } } : {}) };
}

/** Native auto-popover provides light dismissal; add explicit focus and positioning. */
export function createCloudProfile({ trigger, panel, closeButton, primary, secondary, document: document_ = document, window: window_ = window }) {
  const isOpen = () => panel.matches(":popover-open");
  let returnFocus = false;
  function position() {
    const bounds = trigger.getBoundingClientRect();
    panel.style.right = `${Math.max(12, window_.innerWidth - bounds.right)}px`;
    panel.style.top = `${Math.max(12, Math.min(bounds.bottom + 8, window_.innerHeight - panel.offsetHeight - 12))}px`;
  }
  function close(focus = true) {
    if (isOpen()) panel.hidePopover();
    if (focus) trigger.focus({ preventScroll: true });
  }
  panel.addEventListener("beforetoggle", (event) => {
    if (event.newState === "closed") returnFocus = panel.contains(document_.activeElement);
  });
  panel.addEventListener("toggle", (event) => {
    const open = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      position();
      closeButton.focus({ preventScroll: true });
    } else if (returnFocus && (document_.activeElement === document_.body || panel.contains(document_.activeElement))) {
      trigger.focus({ preventScroll: true });
    }
  });
  closeButton.addEventListener("click", () => close());
  document_.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    close();
  });
  window_.addEventListener("resize", () => { if (isOpen()) position(); });
  window_.addEventListener("scroll", () => { if (isOpen()) position(); }, { passive: true });
  return {
    close,
    setUser(user) {
      const details = profileDetails(user);
      primary.textContent = details.primary || "";
      secondary.textContent = details.secondary || "";
      primary.hidden = !details.primary;
      secondary.hidden = !details.secondary;
    },
  };
}
