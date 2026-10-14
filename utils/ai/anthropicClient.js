const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;

let client = null;

// Lazily constructed so the bot still boots when ANTHROPIC_API_KEY is missing.
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ maxRetries: 2, timeout: 60_000 });
  return client;
}

module.exports = { Anthropic, getClient };
