// Narrow plugin-sdk surface for the bundled outlier-playground plugin.
// Keep this list additive and scoped to symbols used under extensions/outlier-playground.

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { OpenClawPluginApi, ProviderAuthContext } from "../plugins/types.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
