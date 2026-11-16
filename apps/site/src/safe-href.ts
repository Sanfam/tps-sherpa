/** A CMS link kept only if it is a web link, a site path or an anchor, as EmDash's own link sanitising allows. */
export const safeHref = (h: unknown) =>
  typeof h === "string" && /^(https?:\/\/|\/(?![/\\])|#)/i.test(h) ? h : undefined;
