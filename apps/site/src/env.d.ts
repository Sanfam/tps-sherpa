declare namespace App {
  interface Locals {
    /** The User's group slugs, for Access. Never rendered back to anyone. */
    groups: string[];
    /** The User's live Discord role IDs, for Index visibility. Never rendered back to anyone. */
    roles: string[];
  }
}
