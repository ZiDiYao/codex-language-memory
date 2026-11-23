/** Reuse the desktop personal center while retaining the web's own SSO actions. */
export function cloudProfileMarkup(html) {
  const shared = html.match(/<!-- profile-shared:start -->([\s\S]*?)<!-- profile-shared:end -->/);
  if (!shared) throw new Error("Shared profile markup is missing");
  return shared[1]
    .replace(/\s*<!-- desktop-auth:start -->[\s\S]*?<!-- desktop-auth:end -->/g, "")
    .replaceAll("local-profile-dialog", "cloud-profile")
    .replaceAll("local-profile-disconnect", "cloud-logout")
    .replaceAll("local-profile-", "cloud-profile-")
    .replace('id="cloud-profile-status"', 'id="cloud-profile-status" data-i18n="accountSignedIn"')
    .replace(/(<footer\b[^>]*\bid="cloud-profile-footer"[^>]*?)\s+hidden\b/, "$1")
    .replace(/(<button\b[^>]*\bid="cloud-logout"[^>]*?)\s+hidden\b/, "$1")
    .replaceAll(" data-account-action", "");
}
