import { createLabyrinthClient } from "./client.js";
import type { LabyrinthClientOptions } from "./client.js";
export { proxyLabyrinthRequest, useLabyrinthServiceBinding } from "./proxy.js";
export type { LabyrinthServiceBinding } from "./proxy.js";
export type { LabyrinthClientOptions } from "./client.js";
/** Real Cumulus ID token required; static product/Access credentials are not client identities. */
export const createArchitectLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("architect", options);
