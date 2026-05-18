/**
 * Claude provider container config — passes ANTHROPIC_BASE_URL and
 * credentials into the container when a custom endpoint is configured.
 *
 * When ANTHROPIC_AUTH_TOKEN is set in .env (3rd-party hosting), the real
 * token is passed as ANTHROPIC_API_KEY and NO_PROXY bypasses OneCLI so
 * the request reaches the custom endpoint directly.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    if (dotenv.ANTHROPIC_AUTH_TOKEN) {
      env.ANTHROPIC_API_KEY = dotenv.ANTHROPIC_AUTH_TOKEN;
      const hostname = new URL(dotenv.ANTHROPIC_BASE_URL).hostname;
      env.NO_PROXY = hostname;
      env.no_proxy = hostname;
    } else {
      env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
    }
  }
  return { env };
});
