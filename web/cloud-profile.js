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

/** Use the same modal motion as Settings; app.js owns Escape/backdrop dismissal. */
export function createCloudProfile({ trigger, panel, closeButton, primary, secondary, openDialog, closeDialog }) {
  const close = () => closeDialog(panel);
  trigger.addEventListener("click", () => {
    openDialog(panel);
    trigger.setAttribute("aria-expanded", "true");
  });
  panel.addEventListener("close", () => {
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus({ preventScroll: true });
  });
  closeButton.addEventListener("click", () => close());
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
