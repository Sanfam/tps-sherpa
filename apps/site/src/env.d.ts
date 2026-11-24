declare namespace App {
  interface Locals {
    /** The User's group slugs, for Access; empty for a Viewer. Never rendered back to anyone. */
    groups: string[];
    /** The User's live Discord role IDs, for Index visibility; empty for a Viewer. Never rendered back to anyone. */
    roles: string[];
    /**
     * The signed-in User, on every server-rendered page; absent for a Viewer.
     * Not `user`: EmDash keeps its editor there.
     */
    signedIn?: {
      /** Discord's display name, or the username when they have none. */
      displayName: string;
      /** Discord CDN URL; null until a session from before 2026-11-19 signs in again. */
      avatar: string | null;
      username: string;
      /** When the session ends unless a visit extends it. */
      expiresAt: Date;
    };
  }
}
